import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { withFileLock } from "@pragma/context-filesystem";
import { type PragmaLoggerProvider, type RuntimeResolver } from "@pragma/core";
import {
  STORE_REVISION_EXPERT_REF,
  STORE_REVISION_TARGET_BINDING_REF,
  builtInAgentFingerprint,
  compileBuiltInAgent,
  createBuiltInStoreRevisionGenerator,
  readOnlyContextStore,
} from "@pragma/built-in-agents";
import type { CompiledResource, InvocableResource } from "@pragma/interpreter";
import { z } from "zod";

import type { ContextStoreRevisionProfile } from "../../../shared/contracts/index.ts";
import { resolveSystemExpertRuntimeDefaults } from "../experts/system-expert-runtime.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import { MissionStoreError, type MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { ContextStoreRevisionGenerator } from "./context-store-revision-service.ts";
import type { ContextStoreStore } from "./context-store-store.ts";

export interface DesktopStoreRevisionAgent {
  readonly generator: ContextStoreRevisionGenerator;
  compile(input: {
    readonly storeId: string;
    readonly profile: ContextStoreRevisionProfile;
    readonly runtimes?: RuntimeResolver | undefined;
  }): Promise<CompiledResource<InvocableResource>>;
  fingerprint(profile: ContextStoreRevisionProfile): Promise<string>;
  recoverOrphans(): Promise<number>;
}

export function createDesktopStoreRevisionAgent(options: {
  readonly profiles: { getProfile(): Promise<ContextStoreRevisionProfile> };
  readonly contextStores: ContextStoreStore;
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly project: PragmaProjectStore;
  readonly runtimes: RuntimeResolver;
  readonly pragmaHome: string;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
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

  const generator = createBuiltInStoreRevisionGenerator({
    execution: {
      async generate(input) {
        const runtime = await resolveRuntime(input.profile);
        const project = await options.project.ensurePublished();
        await mkdir(isolatedWorkspace, { recursive: true, mode: 0o700 });
        const mission = await options.missions.create({
          workspace: { path: isolatedWorkspace, basename: basename(isolatedWorkspace) },
          goal: input.prompt,
          title: input.title,
          project: { id: project.projectId, revision: project.revision },
          executor: {
            kind: "expert",
            ref: STORE_REVISION_EXPERT_REF,
            name: "Store Revision Agent",
          },
          origin: {
            type: "system-store-revision",
            jobId: input.jobId,
            storeId: input.storeId,
          },
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
        await registerAgentMission(registryPath, mission.id, input.jobId, input.storeId);
        try {
          await options.runner.run(mission.id);
          await waitForMission(options.missions, mission.id);
          const finished = await options.missions.get(mission.id);
          if (finished.execution?.status !== "succeeded") {
            throw new Error(
              `store_revision_agent_failed:${finished.execution?.error ?? "unknown"}`,
            );
          }
          const chat = await options.runner.getChat({ id: mission.id, limit: 100 });
          const output = chat.entries
            .filter((entry) => entry.kind === "assistant")
            .map((entry) => entry.content)
            .at(-1);
          if (output === undefined) throw new Error("store_revision_agent_output_missing");
          return { content: output };
        } finally {
          if (await cleanupAgentMission(options.runner, mission.id)) {
            await unregisterAgentMission(registryPath, mission.id).catch(() => undefined);
          }
        }
      },
    },
  });

  const agent: DesktopStoreRevisionAgent = {
    async compile(input) {
      const runtime = await resolveRuntime(input.profile, input.runtimes);
      const resolved = await options.contextStores.resolve(input.storeId);
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
        adapterHost: {
          environmentId: "desktop-store-revision",
          projectRoot: isolatedWorkspace,
          async resolveBinding(ref) {
            if (ref !== STORE_REVISION_TARGET_BINDING_REF) return undefined;
            return {
              ref,
              revision: resolved.revision,
              fingerprint: createHash("sha256").update(resolved.revision).digest("hex"),
              value: { store: readOnlyContextStore(resolved.store) },
            };
          },
          async resolveArtifact(source) {
            throw new Error(`Unexpected Store Revision artifact: ${JSON.stringify(source)}`);
          },
          async resolveSecret() {
            return undefined;
          },
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
      for (const entry of entries.slice(0, 100)) {
        try {
          await options.missions.get(entry.missionId);
        } catch (error) {
          if (error instanceof MissionStoreError && error.code === "mission_not_found") {
            await unregisterAgentMission(registryPath, entry.missionId);
            continue;
          }
          continue;
        }
        if (await cleanupAgentMission(options.runner, entry.missionId)) {
          await unregisterAgentMission(registryPath, entry.missionId);
          recovered += 1;
        }
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

async function cleanupAgentMission(runner: MissionRunner, missionId: string): Promise<boolean> {
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
