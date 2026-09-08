import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { withFileLock, type PragmaLoggerProvider, type RuntimeResolver } from "@pragma/core";
import {
  STORE_REVISION_EXPERT_REF,
  builtInAgentFingerprint,
  compileBuiltInAgent,
} from "@pragma/built-in-agents";
import type {
  CompiledResource,
  InvocableResource,
  PragmaAdapterHost,
  PragmaExpertResource,
  PragmaResource,
} from "@pragma/interpreter";
import { z } from "zod";

import type { ContextStoreRevisionProfile } from "../../../shared/contracts/index.ts";
import { resolveSystemExpertRuntimeDefaults } from "../experts/system-expert-runtime.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import { MissionStoreError, type MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { ContextStoreRevisionGenerator } from "./context-store-revision-service.ts";
import type { ContextStoreRevisionService } from "./context-store-revision-service.ts";

export interface DesktopStoreRevisionAgent {
  readonly generator: ContextStoreRevisionGenerator;
  compile(input: {
    readonly profile: ContextStoreRevisionProfile;
    readonly runtimes?: RuntimeResolver | undefined;
    readonly adapterHost?: PragmaAdapterHost | undefined;
    readonly expertResource?: PragmaExpertResource | undefined;
    readonly additionalResources?: readonly PragmaResource[] | undefined;
  }): Promise<CompiledResource<InvocableResource>>;
  fingerprint(profile: ContextStoreRevisionProfile): Promise<string>;
  recoverOrphans(): Promise<number>;
}

export function createDesktopStoreRevisionAgent(options: {
  readonly revisions: Pick<ContextStoreRevisionService, "list" | "attachMission" | "detachMission">;
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly project: PragmaProjectStore;
  readonly runtimes: RuntimeResolver;
  readonly pragmaHome: string;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly onMissionCreated?:
    ((input: { readonly jobId: string; readonly missionId: string }) => Promise<void>) | undefined;
  readonly isDraftSubmitted?: ((jobId: string) => Promise<boolean>) | undefined;
}): DesktopStoreRevisionAgent {
  const isolatedWorkspace = join(options.pragmaHome, "tmp", "store-revision-agent");
  const registryPath = join(
    options.pragmaHome,
    "state",
    "context-store-revisions",
    "agent-missions.json",
  );
  const resolveRuntime = async (
    profile: ContextStoreRevisionProfile,
    resolver: RuntimeResolver = options.runtimes,
  ) => {
    const defaults = await resolveSystemExpertRuntimeDefaults(
      resolver,
      profile.mode === "pinned" ? profile.model : undefined,
      undefined,
    );
    await resolver.bind({
      runtimeId: defaults.runtimeId,
      ...(defaults.modelSelection === undefined ? {} : { modelSelection: defaults.modelSelection }),
    });
    return defaults;
  };

  const generator: ContextStoreRevisionGenerator = {
    async generate(input) {
      const project = await options.project.ensurePublished();
      await mkdir(isolatedWorkspace, { recursive: true, mode: 0o700 });
      const mission = await options.missions.create({
        workspace: { path: isolatedWorkspace, basename: basename(isolatedWorkspace) },
        goal: [
          input.request.prompt,
          `The sparse revision draft ${input.draftId} is mounted as Mission Knowledge.`,
          "Edit the mission-knowledge-draft namespace with its native Context tools, then submit the draft for review.",
        ].join("\n\n"),
        title: `Revise knowledge base ${input.request.storeId.slice(0, 8)}`,
        project: { id: project.projectId, revision: project.revision },
        executor: {
          kind: "expert",
          ref: STORE_REVISION_EXPERT_REF,
          name: "Store Revision Agent",
        },
        origin: {
          type: "system-store-revision",
          jobId: input.jobId,
          storeId: input.request.storeId,
        },
        toolPermissionMode: "request-approval",
        contextMounts: [
          {
            kind: "context-store-draft",
            draftId: input.draftId,
            revisionJobId: input.jobId,
          },
        ],
      });
      await registerAgentMission(registryPath, mission.id, input.jobId, input.request.storeId);
      await options.onMissionCreated?.({ jobId: input.jobId, missionId: mission.id });
      await options.runner.run(mission.id);
      await waitForMission(options.missions, mission.id);
      const finished = await options.missions.get(mission.id);
      if (finished.execution?.status !== "succeeded") {
        throw new Error(`store_revision_agent_failed:${finished.execution?.error ?? "unknown"}`);
      }
      if ((await options.isDraftSubmitted?.(input.jobId)) === true) {
        await options.missions.markComplete(mission.id);
      }
      return undefined;
    },
  };

  const agent: DesktopStoreRevisionAgent = {
    async compile(input) {
      const runtime = await resolveRuntime(input.profile, input.runtimes);
      return await compileBuiltInAgent({
        ref: STORE_REVISION_EXPERT_REF,
        environmentId: "desktop-store-revision",
        definitionStateRoot: join(options.pragmaHome, "cache", "built-in-agents", "definitions"),
        workspace: isolatedWorkspace,
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
        ...(input.expertResource === undefined ? {} : { expertResource: input.expertResource }),
        additionalResources: input.additionalResources,
        adapterHost: {
          environmentId: input.adapterHost?.environmentId ?? "desktop-store-revision",
          projectRoot: isolatedWorkspace,
          async resolveBinding(ref) {
            return await input.adapterHost?.resolveBinding(ref);
          },
          async resolveArtifact(source) {
            if (input.adapterHost !== undefined) {
              return await input.adapterHost.resolveArtifact(source);
            }
            throw new Error(`Unexpected Store Revision artifact: ${JSON.stringify(source)}`);
          },
          async resolveSecret(binding) {
            return await input.adapterHost?.resolveSecret(binding);
          },
          ...(input.adapterHost?.openFileContextStore === undefined
            ? {}
            : { openFileContextStore: input.adapterHost.openFileContextStore }),
        },
      });
    },

    async fingerprint(profile) {
      return createHash("sha256")
        .update(
          JSON.stringify({
            version: 2,
            profile,
            definition: builtInAgentFingerprint(STORE_REVISION_EXPERT_REF),
          }),
        )
        .digest("hex");
    },

    async recoverOrphans() {
      const entries = await readAgentMissionRegistry(registryPath);
      let recovered = 0;
      for (const job of (await options.revisions.list()).slice(0, 100)) {
        if (job.missionId === undefined) continue;
        try {
          const mission = await options.missions.get(job.missionId);
          if (job.state === "running") {
            await options.revisions.attachMission(job.id, job.missionId);
          }
          const claimed = mission.contextMounts.some(
            (mount) =>
              mount.kind === "context-store-draft" &&
              mount.draftId === job.draftId &&
              mount.revisionJobId === job.id,
          );
          if (claimed && (job.state === "merged" || job.state === "rejected")) {
            await options.missions.restoreManagedRevisionStore({
              id: mission.id,
              storeId: job.request.storeId,
              draftId: job.draftId,
              revisionJobId: job.id,
            });
            await options.revisions.detachMission(job.id, job.missionId);
            recovered += 1;
          } else if (
            !claimed &&
            job.state === "running" &&
            mission.executor.ref === STORE_REVISION_EXPERT_REF
          ) {
            if (
              mission.contextMounts.some(
                (mount) => mount.kind === "context-store" && mount.storeId === job.request.storeId,
              )
            ) {
              await options.missions.mountManagedRevisionDraft({
                id: mission.id,
                expectedExecutorRef: STORE_REVISION_EXPERT_REF,
                storeId: job.request.storeId,
                draftId: job.draftId,
                revisionJobId: job.id,
              });
            } else {
              await options.revisions.detachMission(job.id, job.missionId);
            }
            recovered += 1;
          }
        } catch (error) {
          if (error instanceof MissionStoreError && error.code === "mission_not_found") {
            await options.revisions.detachMission(job.id, job.missionId);
            recovered += 1;
            continue;
          }
          throw error;
        }
      }
      for (const entry of entries.slice(0, 100)) {
        try {
          await options.missions.get(entry.missionId);
        } catch (error) {
          if (error instanceof MissionStoreError && error.code === "mission_not_found") {
            await unregisterAgentMission(registryPath, entry.missionId);
            recovered += 1;
            continue;
          }
          continue;
        }
        // A valid registered Mission is durable user-visible history. Recovery only removes
        // registry entries whose Mission no longer exists.
      }
      return recovered;
    },

    generator,
  };
  return agent;
}

async function waitForMission(missions: MissionStore, id: string): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const mission = await missions.get(id);
    if (
      mission.execution !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(mission.execution.status)
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("store_revision_agent_timeout");
}

const AgentMissionRegistrySchema = z
  .object({
    schemaVersion: z.literal("pragma.store-revision-agent-missions/v1"),
    entries: z
      .array(
        z.object({
          missionId: z.string().uuid(),
          jobId: z.string().uuid(),
          storeId: z.string().uuid(),
          createdAt: z.string().datetime(),
        }),
      )
      .max(1_000),
  })
  .strict();

type AgentMissionEntry = z.infer<typeof AgentMissionRegistrySchema>["entries"][number];

async function readAgentMissionRegistry(path: string): Promise<readonly AgentMissionEntry[]> {
  try {
    return AgentMissionRegistrySchema.parse(JSON.parse(await readFile(path, "utf8"))).entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function updateAgentMissionRegistry(
  path: string,
  update: (entries: readonly AgentMissionEntry[]) => readonly AgentMissionEntry[],
): Promise<void> {
  await withFileLock(`${path}.lock`, async () => {
    const entries = update(await readAgentMissionRegistry(path));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(
          AgentMissionRegistrySchema.parse({
            schemaVersion: "pragma.store-revision-agent-missions/v1",
            entries,
          }),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

async function registerAgentMission(
  path: string,
  missionId: string,
  jobId: string,
  storeId: string,
): Promise<void> {
  await updateAgentMissionRegistry(path, (entries) => [
    ...entries.filter((entry) => entry.missionId !== missionId).slice(-999),
    { missionId, jobId, storeId, createdAt: new Date().toISOString() },
  ]);
}

async function unregisterAgentMission(path: string, missionId: string): Promise<void> {
  await updateAgentMissionRegistry(path, (entries) =>
    entries.filter((entry) => entry.missionId !== missionId),
  );
}
