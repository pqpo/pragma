import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { type PragmaLoggerProvider, type RuntimeResolver } from "@pragma/core";
import {
  SKILL_EVALUATION_EXPERT_REF,
  SKILL_REVISION_EXPERT_REF,
  builtInAgentFingerprint,
  compileBuiltInAgent,
  createBuiltInSkillAgents,
} from "@pragma/built-in-agents";
import { withFileLock } from "@pragma/context-filesystem";
import type { CompiledResource, InvocableResource } from "@pragma/interpreter";
import type { SkillPackage } from "@pragma/shared";
import { z } from "zod";

import {
  ContextStoreRevisionProfileSchema,
  SkillEvaluationProfileSchema,
  UpdateSkillEvaluationProfileSchema,
  type ContextStoreRevisionProfile,
  type SkillEvaluationProfile,
  type SkillEvaluationSnapshot,
  type UpdateSkillEvaluationProfile,
} from "../../../shared/contracts/index.ts";
import { resolveSystemExpertRuntimeDefaults } from "../experts/system-expert-runtime.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import { MissionStoreError, type MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { SkillRevisionEvaluator, SkillRevisionGenerator } from "./skill-revision-service.ts";

export interface SkillEvaluationProfileStore {
  get(): Promise<SkillEvaluationProfile>;
  update(input: UpdateSkillEvaluationProfile): Promise<SkillEvaluationProfile>;
}

export function createSkillEvaluationProfileStore(path: string): SkillEvaluationProfileStore {
  const get = async () => {
    try {
      return SkillEvaluationProfileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return SkillEvaluationProfileSchema.parse({
        schemaVersion: "pragma.skill-evaluation-profile/v1",
        revision: 0,
        mode: "inherit-default",
        updatedAt: new Date(0).toISOString(),
      });
    }
  };
  return {
    get,
    async update(rawInput) {
      const input = UpdateSkillEvaluationProfileSchema.parse(rawInput);
      const current = await get();
      if (current.revision !== input.expectedRevision)
        throw Object.assign(new Error("skill_evaluation_profile_conflict"), {
          code: "revision_conflict",
        });
      const next = SkillEvaluationProfileSchema.parse({
        schemaVersion: "pragma.skill-evaluation-profile/v1",
        revision: current.revision + 1,
        mode: input.mode,
        ...(input.model === undefined ? {} : { model: input.model }),
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(path, next);
      return next;
    },
  };
}

export interface DesktopSkillAgents {
  readonly revisionGenerator: SkillRevisionGenerator;
  readonly revisionEvaluator: SkillRevisionEvaluator;
  evaluateCandidate(input: {
    readonly candidateId: string;
    readonly package: SkillPackage;
    readonly replayCases: readonly {
      readonly objective: string;
      readonly requiredBehaviors: readonly string[];
      readonly forbiddenBehaviors: readonly string[];
    }[];
    readonly boundaryCase: {
      readonly objective: string;
      readonly requiredBehaviors: readonly string[];
      readonly forbiddenBehaviors: readonly string[];
    };
  }): Promise<SkillEvaluationSnapshot>;
  compile(input: {
    readonly kind: "revision" | "evaluation";
    readonly runtimes?: RuntimeResolver;
  }): Promise<CompiledResource<InvocableResource>>;
  fingerprint(kind: "revision" | "evaluation"): Promise<string>;
  recoverOrphans(): Promise<number>;
}

export function createDesktopSkillAgents(options: {
  readonly revisionProfiles: { getProfile(): Promise<ContextStoreRevisionProfile> };
  readonly evaluationProfiles: SkillEvaluationProfileStore;
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly project: PragmaProjectStore;
  readonly runtimes: RuntimeResolver;
  readonly pragmaHome: string;
  readonly loggerProvider?: PragmaLoggerProvider;
}): DesktopSkillAgents {
  const workspace = join(options.pragmaHome, "tmp", "skill-agents");
  const registryPath = join(options.pragmaHome, "state", "skill-agents", "missions.json");

  const resolveRuntime = async (
    profile: ContextStoreRevisionProfile | SkillEvaluationProfile,
    resolver = options.runtimes,
  ) => {
    const parsed =
      profile.schemaVersion === "pragma.context-store-revision-profile/v1"
        ? ContextStoreRevisionProfileSchema.parse(profile)
        : SkillEvaluationProfileSchema.parse(profile);
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
    readonly kind: "revision" | "evaluation";
    readonly jobId: string;
    readonly goal: string;
    readonly profile: ContextStoreRevisionProfile | SkillEvaluationProfile;
    readonly capabilityId?: string | undefined;
    readonly phase?: "subject" | "judge";
  }) => {
    const runtime = await resolveRuntime(input.profile);
    const project = await options.project.ensurePublished();
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const mission = await options.missions.create({
      workspace: { path: workspace, basename: basename(workspace) },
      goal: input.goal,
      title: input.kind === "revision" ? "Revise Skill Capability" : "Evaluate Skill Capability",
      project: { id: project.projectId, revision: project.revision },
      executor: {
        kind: "expert",
        ref: input.kind === "revision" ? SKILL_REVISION_EXPERT_REF : SKILL_EVALUATION_EXPERT_REF,
        name: input.kind === "revision" ? "Skill Revision Agent" : "Skill Evaluation Agent",
      },
      origin:
        input.kind === "revision"
          ? {
              type: "system-skill-revision",
              jobId: input.jobId,
              capabilityId: input.capabilityId!,
            }
          : { type: "system-skill-evaluation", jobId: input.jobId, phase: input.phase ?? "judge" },
      toolPermissionMode: "request-approval",
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
    await registerMission(registryPath, mission.id, input.jobId, input.kind);
    try {
      await options.runner.run(mission.id);
      await waitForMission(options.missions, mission.id);
      const finished = await options.missions.get(mission.id);
      if (finished.execution?.status !== "succeeded")
        throw new Error(`skill_agent_failed:${finished.execution?.error ?? "unknown"}`);
      const chat = await options.runner.getChat({ id: mission.id, limit: 100 });
      const output = chat.entries
        .filter((entry) => entry.kind === "assistant")
        .map((entry) => entry.content)
        .at(-1);
      if (output === undefined) throw new Error("skill_agent_output_missing");
      return {
        content: output,
        runtimeId: runtime.runtimeId,
        providerId: runtime.modelSelection?.model.providerId ?? "runtime-managed",
        modelId: runtime.modelSelection?.model.modelId ?? "runtime-default",
      };
    } finally {
      if (await cleanupMission(options.runner, mission.id)) {
        await unregisterMission(registryPath, mission.id).catch(() => undefined);
      }
    }
  };

  const reusableAgents = createBuiltInSkillAgents({
    revisionProfiles: options.revisionProfiles,
    evaluationProfiles: options.evaluationProfiles,
    revisionExecution: {
      async generate(input) {
        const result = await run({
          kind: "revision",
          jobId: input.jobId,
          goal: input.prompt,
          profile: input.profile,
          capabilityId: input.capabilityId,
        });
        return { content: result.content };
      },
    },
    evaluationExecution: {
      async runSubject(input) {
        return await run({
          kind: "evaluation",
          jobId: input.jobId,
          goal: input.prompt,
          profile: input.profile,
          phase: "subject",
        });
      },
      async runJudge(input) {
        return await run({
          kind: "evaluation",
          jobId: input.jobId,
          goal: input.prompt,
          profile: input.profile,
          phase: "judge",
        });
      },
    },
  });

  const api: DesktopSkillAgents = {
    revisionGenerator: reusableAgents.revisionGenerator,
    revisionEvaluator: reusableAgents.revisionEvaluator,
    evaluateCandidate: async (input) => await reusableAgents.evaluateCandidate(input),
    async compile(input) {
      const profile =
        input.kind === "revision"
          ? await options.revisionProfiles.getProfile()
          : await options.evaluationProfiles.get();
      const runtime = await resolveRuntime(profile, input.runtimes);
      return await compileBuiltInAgent({
        ref: input.kind === "revision" ? SKILL_REVISION_EXPERT_REF : SKILL_EVALUATION_EXPERT_REF,
        environmentId: "desktop",
        definitionStateRoot: join(options.pragmaHome, "cache", "built-in-agents", "definitions"),
        workspace,
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
      });
    },
    async fingerprint(kind) {
      const profile =
        kind === "revision"
          ? await options.revisionProfiles.getProfile()
          : await options.evaluationProfiles.get();
      return createHash("sha256")
        .update(
          JSON.stringify({
            version: 2,
            kind,
            profile,
            definition: builtInAgentFingerprint(
              kind === "revision" ? SKILL_REVISION_EXPERT_REF : SKILL_EVALUATION_EXPERT_REF,
            ),
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
async function registerMission(
  path: string,
  missionId: string,
  jobId: string,
  kind: "revision" | "evaluation",
): Promise<void> {
  await updateMissionRegistry(path, (entries) => [
    ...entries.filter((entry) => entry.missionId !== missionId).slice(-999),
    { missionId, jobId, kind, createdAt: new Date().toISOString() },
  ]);
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
