import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { withFileLock } from "@pragma/context-filesystem";
import {
  ContextSystem,
  defineExpert,
  error,
  type ExpertAgentContextStore,
  type PragmaLoggerProvider,
  type RuntimeModelSelection,
  type RuntimeResolver,
} from "@pragma/core";
import type { CompiledResource, InvocableResource } from "@pragma/interpreter";
import { z } from "zod";

import {
  ContextStoreChangeSetSchema,
  type ContextStoreRevisionProfile,
} from "../../../shared/contracts/index.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import { MissionStoreError, type MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import {
  STORE_REVISION_EXPERT_ID,
  STORE_REVISION_EXPERT_REF,
  type ContextStoreRevisionGenerator,
} from "./context-store-revision-service.ts";
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
    const runtimeId =
      profile.mode === "pinned" && profile.model !== undefined
        ? profile.model.runtimeId
        : await resolver.getDefaultRuntimeId();
    const modelSelection: RuntimeModelSelection | undefined =
      profile.mode === "pinned" && profile.model !== undefined
        ? {
            model: {
              providerId: profile.model.providerId,
              modelId: profile.model.modelId,
            },
            ...(profile.model.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: profile.model.thinkingLevel }),
          }
        : undefined;
    await resolver.bind({
      runtimeId,
      ...(modelSelection === undefined ? {} : { modelSelection }),
    });
    return { runtimeId, modelSelection };
  };

  const agent: DesktopStoreRevisionAgent = {
    async compile(input) {
      const runtime = await resolveRuntime(input.profile, input.runtimes);
      const resolved = await options.contextStores.resolve(input.storeId);
      const contextSystem = new ContextSystem({
        stores: { "target-store": readOnlyStore(resolved.store) },
        roots: [{ namespace: "target-store" }],
      });
      const expert = await defineExpert({
        schemaVersion: "pragma.expert/v1",
        id: STORE_REVISION_EXPERT_ID,
        name: "Store Revision Agent",
        description: "Hidden system Expert that proposes structured Context Store revisions.",
        scope: "system-store-revision",
        tags: ["system", "context-store", "revision"],
        instructions: STORE_REVISION_INSTRUCTIONS,
        workspace: isolatedWorkspace,
        pragmaHome: options.pragmaHome,
        defaultRuntimeId: runtime.runtimeId,
        ...(runtime.modelSelection === undefined
          ? {}
          : { models: { default: runtime.modelSelection } }),
        contextSystem,
        tools: [],
        loggerProvider: options.loggerProvider,
      });
      const fingerprint = await agent.fingerprint(input.profile);
      return {
        ref: STORE_REVISION_EXPERT_REF,
        value: expert,
        fingerprint,
        projectFingerprint: fingerprint,
        environmentFingerprint: {
          environmentId: "desktop",
          projectFingerprint: fingerprint,
          value: fingerprint,
          resources: [],
          plugins: [],
        },
        rootRuntimeId: runtime.runtimeId,
        dependencies: [],
      };
    },

    async fingerprint(profile) {
      return createHash("sha256")
        .update(JSON.stringify({ version: 1, profile, instructions: STORE_REVISION_INSTRUCTIONS }))
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

    generator: {
      async generate(input) {
        const runtime = await resolveRuntime(input.profile);
        const project = await options.project.ensurePublished();
        await mkdir(isolatedWorkspace, { recursive: true, mode: 0o700 });
        const mission = await options.missions.create({
          workspace: { path: isolatedWorkspace, basename: basename(isolatedWorkspace) },
          goal: renderRevisionPrompt(input),
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
        await registerAgentMission(registryPath, mission.id, input.jobId, input.request.storeId);
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
          return ContextStoreChangeSetSchema.parse(JSON.parse(extractJson(output)));
        } finally {
          if (await cleanupAgentMission(options.runner, mission.id)) {
            await unregisterAgentMission(registryPath, mission.id).catch(() => undefined);
          }
        }
      },
    },
  };
  return agent;
}

const STORE_REVISION_INSTRUCTIONS = [
  "You are the hidden Pragma Store Revision Agent.",
  "The target-store Context is the only store you may inspect. It is read-only.",
  "Return exactly one pragma.context-store-change-set/v1 JSON object without Markdown fences.",
  "Never replace the store with one giant document.",
  "Preserve progressive disclosure: guide.md is always_on and at most 2 KiB; overview.md is model_decision and at most 6 KiB; index.md and indexes/** are bounded navigation; detailed knowledge belongs in multiple items/** files.",
  "Make the smallest coherent revision that satisfies the prompt. Preserve unrelated knowledge.",
].join("\n");

function renderRevisionPrompt(
  input: Parameters<ContextStoreRevisionGenerator["generate"]>[0],
): string {
  return [
    "Prepare a reviewable revision of the target Context Store.",
    `Store id: ${input.request.storeId}`,
    `Base revision: ${input.snapshot.revision}`,
    `Base snapshot hash: ${input.snapshot.snapshotHash}`,
    "Use target-store list/search/read to inspect only what is needed.",
    "Revision request:",
    input.request.prompt,
    "Required JSON shape:",
    '{"schemaVersion":"pragma.context-store-change-set/v1","storeId":"...","baseRevision":1,"baseSnapshotHash":"64 hex","summary":"...","operations":[{"operation":"upsert","id":"items/example.md","content":"...","metadata":{"trigger":"model_decision","priority":"normal"}},{"operation":"rename","id":"old.md","nextId":"new.md"},{"operation":"delete","id":"obsolete.md"}]}',
  ].join("\n\n");
}

function readOnlyStore(store: ExpertAgentContextStore): ExpertAgentContextStore {
  const denied = async () => error("permission_denied", "The Store Revision Agent is read-only.");
  return {
    listContext: async (input) => await store.listContext(input),
    readContext: async (input) => await store.readContext(input),
    searchContext: async (input) => await store.searchContext(input),
    addContext: denied,
    editContext: denied,
    deleteContext: denied,
  };
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

function extractJson(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
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
