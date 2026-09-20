import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { withFileLock, type PragmaLoggerProvider, type RuntimeResolver } from "@pragma/core";
import {
  SKILL_REVISION_EXPERT_REF,
  builtInAgentFingerprint,
  compileBuiltInAgent,
} from "@pragma/built-in-agents";
import type {
  CompiledResource,
  InvocableResource,
  PragmaCompileOptions,
  PragmaExpertResource,
  PragmaResource,
} from "@pragma/interpreter";
import { z } from "zod";

import {
  ContextStoreRevisionProfileSchema,
  type ContextStoreRevisionProfile,
} from "../../../shared/contracts/index.ts";
import { resolveSystemExpertRuntimeDefaults } from "../experts/system-expert-runtime.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import { MissionStoreError, type MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { SkillRevisionGenerator } from "./skill-revision-service.ts";

export interface DesktopSkillAgents {
  readonly revisionGenerator: SkillRevisionGenerator;
  compile(input: {
    readonly runtimes?: RuntimeResolver;
    readonly workspace?: string;
    readonly adapterHost?: PragmaCompileOptions["adapterHost"];
    readonly expertResource?: PragmaExpertResource;
    readonly additionalResources?: readonly PragmaResource[];
  }): Promise<CompiledResource<InvocableResource>>;
  fingerprint(): Promise<string>;
  recoverOrphans(): Promise<number>;
}

export function createDesktopSkillAgents(options: {
  readonly revisionProfiles: { getProfile(): Promise<ContextStoreRevisionProfile> };
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly project: PragmaProjectStore;
  readonly runtimes: RuntimeResolver;
  readonly pragmaHome: string;
  readonly loggerProvider?: PragmaLoggerProvider;
  readonly resolveDraftWorkspace: (draftId: string) => Promise<string>;
  readonly onMissionCreated?:
    ((input: { readonly jobId: string; readonly missionId: string }) => Promise<void>) | undefined;
  readonly isDraftSubmitted?: ((jobId: string) => Promise<boolean>) | undefined;
}): DesktopSkillAgents {
  const workspace = join(options.pragmaHome, "tmp", "skill-agents");
  const registryPath = join(options.pragmaHome, "state", "skill-agents", "missions.json");

  const resolveRuntime = async (
    profile: ContextStoreRevisionProfile,
    resolver = options.runtimes,
  ) => {
    const parsed = ContextStoreRevisionProfileSchema.parse(profile);
    const defaults = await resolveSystemExpertRuntimeDefaults(
      resolver,
      parsed.mode === "pinned" ? parsed.model : undefined,
      undefined,
    );
    await resolver.bind({
      runtimeId: defaults.runtimeId,
      ...(defaults.modelSelection === undefined ? {} : { modelSelection: defaults.modelSelection }),
    });
    return defaults;
  };

  const run = async (input: {
    readonly jobId: string;
    readonly draftId: string;
    readonly goal: string;
    readonly profile: ContextStoreRevisionProfile;
    readonly capabilityId?: string | undefined;
  }) => {
    const runtime = await resolveRuntime(input.profile);
    const project = await options.project.ensurePublished();
    const draftWorkspace = await options.resolveDraftWorkspace(input.draftId);
    const mission = await options.missions.create({
      workspace: { path: draftWorkspace, basename: basename(draftWorkspace) },
      goal: input.goal,
      title: "Revise Skill Capability",
      project: { id: project.projectId, revision: project.revision },
      executor: {
        kind: "expert",
        ref: SKILL_REVISION_EXPERT_REF,
        name: "Skill Revision Agent",
      },
      origin: {
        type: "system-skill-revision",
        jobId: input.jobId,
        capabilityId: input.capabilityId!,
      },
      toolPermissionMode: "request-approval",
      contextMounts: [
        {
          kind: "skill-revision-draft",
          draftId: input.draftId,
          revisionJobId: input.jobId,
          capabilityId: input.capabilityId!,
        },
      ],
      ...(runtime.modelSelection === undefined
        ? {}
        : {
            modelOverride: {
              providerId: runtime.modelSelection.model.providerId,
              modelId: runtime.modelSelection.model.modelId,
              ...(runtime.modelSelection.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: runtime.modelSelection.thinkingLevel }),
            },
          }),
    });
    await options.onMissionCreated?.({ jobId: input.jobId, missionId: mission.id });
    await options.runner.run(mission.id);
    await waitForMission(options.missions, mission.id);
    const finished = await options.missions.get(mission.id);
    if (finished.execution?.status !== "succeeded") {
      throw new Error(`skill_agent_failed:${finished.execution?.error ?? "unknown"}`);
    }
    if ((await options.isDraftSubmitted?.(input.jobId)) !== true) {
      throw new Error("skill_revision_agent_did_not_submit");
    }
    await options.missions.markComplete(mission.id);
  };

  const api: DesktopSkillAgents = {
    revisionGenerator: {
      async generate(input) {
        const profile = await options.revisionProfiles.getProfile();
        await run({
          jobId: input.jobId,
          draftId: input.draftId,
          goal: [
            input.request.prompt,
            `The managed Skill draft ${input.draftId} is already mounted and writable.`,
            "Inspect and edit this draft directly. Submit it for review, repair every synchronous validation diagnostic in this same Mission, and resubmit until it passes.",
          ].join("\n\n"),
          profile,
          capabilityId: input.request.capabilityId,
        });
        return undefined;
      },
    },
    async compile(input) {
      const profile = await options.revisionProfiles.getProfile();
      const runtime = await resolveRuntime(profile, input.runtimes);
      return await compileBuiltInAgent({
        ref: SKILL_REVISION_EXPERT_REF,
        environmentId: "desktop",
        definitionStateRoot: join(options.pragmaHome, "cache", "built-in-agents", "definitions"),
        workspace: input.workspace ?? workspace,
        pragmaHome: options.pragmaHome,
        runtimes: input.runtimes ?? options.runtimes,
        rootExecutionOverride: {
          runtimeId: runtime.runtimeId,
          ...(runtime.modelSelection === undefined
            ? {}
            : { modelSelection: runtime.modelSelection }),
        },
        ...(runtime.modelSelection === undefined
          ? {}
          : { defaultModelSelection: runtime.modelSelection }),
        loggerProvider: options.loggerProvider,
        ...(input.adapterHost === undefined ? {} : { adapterHost: input.adapterHost }),
        ...(input.expertResource === undefined ? {} : { expertResource: input.expertResource }),
        ...(input.additionalResources === undefined
          ? {}
          : { additionalResources: input.additionalResources }),
      });
    },
    async fingerprint() {
      const profile = await options.revisionProfiles.getProfile();
      return createHash("sha256")
        .update(
          JSON.stringify({
            version: 2,
            kind: "revision",
            profile,
            definition: builtInAgentFingerprint(SKILL_REVISION_EXPERT_REF),
          }),
        )
        .digest("hex");
    },
    async recoverOrphans() {
      let recovered = 0;
      for (const entry of (await readMissionRegistry(registryPath)).slice(0, 100)) {
        try {
          await options.missions.get(entry.missionId);
        } catch (error) {
          if (error instanceof MissionStoreError && error.code === "mission_not_found")
            await unregisterMission(registryPath, entry.missionId);
          continue;
        }
        if (await cleanupMission(options.runner, entry.missionId)) {
          await unregisterMission(registryPath, entry.missionId);
          recovered += 1;
        }
      }
      return recovered;
    },
  };
  return api;
}

async function waitForMission(missions: MissionStore, id: string): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const mission = await missions.get(id);
    if (
      mission.execution !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(mission.execution.status)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("skill_agent_timeout");
}
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

const SkillAgentMissionRegistrySchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-agent-missions/v1"),
    entries: z
      .array(
        z
          .object({
            missionId: z.string().uuid(),
            jobId: z.string().uuid(),
            kind: z.enum(["revision", "evaluation"]),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();
type SkillAgentMissionEntry = z.infer<typeof SkillAgentMissionRegistrySchema>["entries"][number];
async function readMissionRegistry(path: string): Promise<readonly SkillAgentMissionEntry[]> {
  try {
    return SkillAgentMissionRegistrySchema.parse(JSON.parse(await readFile(path, "utf8"))).entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function updateMissionRegistry(
  path: string,
  update: (entries: readonly SkillAgentMissionEntry[]) => readonly SkillAgentMissionEntry[],
): Promise<void> {
  await withFileLock(`${path}.lock`, async () => {
    const entries = update(await readMissionRegistry(path));
    await writeJsonAtomic(
      path,
      SkillAgentMissionRegistrySchema.parse({
        schemaVersion: "pragma.skill-agent-missions/v1",
        entries,
      }),
    );
  });
}
async function unregisterMission(path: string, missionId: string): Promise<void> {
  await updateMissionRegistry(path, (entries) =>
    entries.filter((entry) => entry.missionId !== missionId),
  );
}
async function cleanupMission(runner: MissionRunner, missionId: string): Promise<boolean> {
  try {
    await runner.delete(missionId);
    return true;
  } catch {
    await runner.interrupt(missionId).catch(() => undefined);
    return await runner
      .delete(missionId)
      .then(() => true)
      .catch(() => false);
  }
}
