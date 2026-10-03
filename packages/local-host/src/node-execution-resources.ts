import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  PragmaPaths,
  ReadOnlyContextStore,
  StaticContextStore,
  type ExpertAgentContextStoreRegistrationInput,
  type HostContextBindingsResolver,
  type PragmaLoggerProvider,
  type RuntimeResolver,
  type UsageSink,
} from "@pragma/core";
import { BUILT_IN_AGENT_REFS, builtInAgentResources } from "@pragma/built-in-agents";
import { createIntegrationError } from "@pragma/shared/integration";
import type { Mission } from "@pragma/shared";
import type { LocalHostNodeMissionCompiler } from "./node-mission-compiler.ts";
import type { createLocalHostRunMemory } from "./run-memory.ts";
import { createLocalHostMissionBoardBindings } from "./mission-board.ts";
import {
  collectMissionExecutionIds,
  missionKnowledgeNamespace,
} from "./missions/execution-service.ts";
import { createLocalHostContextStoreReader } from "./resources/context-store-reader.ts";
import type { MissionStore } from "./missions/repository/mission-store.ts";
import { createMissionBranchContext } from "./missions/mission-branch-context.ts";
import {
  LEGACY_EXECUTION_OUTPUT_NAMESPACE,
  LegacyExecutionOutputContextStore,
} from "@pragma/context-filesystem";
import type { LocalHostMissionExecutionResourcePorts } from "./missions/execution-service.ts";

const identityManifest = z
  .object({
    schemaVersion: z.literal("pragma.desktop-project-identity-migrations/v1"),
    projectId: z.string().min(1),
    migrations: z.array(
      z
        .object({
          kind: z.enum([
            "Expert",
            "ExpertTeam",
            "Flow",
            "Automation",
            "Capability",
            "ContextStore",
            "RuntimeProfile",
          ]),
          sourceId: z.string().min(1),
          targetId: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

/** Node resource adapters for the same Mission lifecycle used by Desktop. */
export function createLocalHostNodeExecutionResourcePorts(options: {
  readonly pragmaHome: string;
  readonly runtimes: RuntimeResolver;
  readonly compiler: LocalHostNodeMissionCompiler;
  readonly missions: MissionStore;
  readonly memory: ReturnType<typeof createLocalHostRunMemory>;
  readonly usageSink: UsageSink;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
}): LocalHostMissionExecutionResourcePorts {
  const paths = new PragmaPaths(options);
  const knowledge = createLocalHostContextStoreReader({ storesPath: paths.contextStoresRoot() });
  const withProject = async <T>(
    pin: Mission["project"],
    operation: (
      project: Awaited<ReturnType<LocalHostNodeMissionCompiler["reader"]["openRevision"]>>,
    ) => Promise<T>,
  ) => {
    const location = await options.compiler.reader.getRevision(pin.id, pin.revision);
    if (location === undefined)
      throw new Error(`Project Revision not found: ${pin.id}@${pin.revision}.`);
    if (options.compiler.reader.withOpenRevision !== undefined)
      return await options.compiler.reader.withOpenRevision(location, operation);
    const project = await options.compiler.reader.openRevision(location);
    try {
      return await operation(project);
    } finally {
      await project.dispose();
    }
  };
  return {
    createExecutionContextResources: async ({
      mission,
      executionStore,
      expertSessionStore,
      purpose,
      assertExecutionOwnership,
    }) => {
      if (purpose === "stop")
        return {
          runtimes: options.runtimes,
          appOptions: {
            pragmaHome: options.pragmaHome,
            executionStore,
            expertSessionStore,
            runtimes: options.runtimes,
            usageSink: options.usageSink,
            loggerProvider: options.loggerProvider,
          },
          setToolPermissionMode: () => {
            throw new Error("Cannot change tool permissions in a stop-only Mission context.");
          },
        };
      const memoryBindingId = randomUUID();
      let historyIds: Promise<ReadonlySet<string>> | undefined;
      const branchHistory = await options.missions.readBranchHistory(mission.id);
      const branchBindings: readonly ExpertAgentContextStoreRegistrationInput[] =
        branchHistory === undefined
          ? []
          : [
              {
                namespace: "branch-history",
                storeName: "Inherited Mission history",
                store: new StaticContextStore(createMissionBranchContext(branchHistory)),
                required: true,
                mutationApproval: "none",
              },
            ];
      const resolveHostContextBindings: HostContextBindingsResolver = async () => {
        await assertExecutionOwnership?.();
        const current = await options.missions.get(mission.id);
        const mounted = await Promise.all(
          current.contextMounts.map(async (mount) => {
            if (mount.kind !== "context-store")
              throw createIntegrationError({
                code: "DEPENDENCY_UNAVAILABLE",
                category: "dependency",
                message: "This Node Host has no Mission Knowledge draft adapter configured.",
                details: {
                  reason: "mission_knowledge_draft_adapter_unavailable",
                  mountKind: mount.kind,
                },
              });
            const resolved = await knowledge.resolve(mount.storeId);
            return {
              namespace: missionKnowledgeNamespace(mount.storeId),
              storeName: resolved.name,
              store: new ReadOnlyContextStore(resolved.store),
              required: true,
              mutationApproval: "none" as const,
            };
          }),
        );
        return [
          {
            namespace: LEGACY_EXECUTION_OUTPUT_NAMESPACE,
            store: new LegacyExecutionOutputContextStore({
              pragmaHome: options.pragmaHome,
              resolveVisibleExecutionIds: async () => [
                ...(await (historyIds ??= collectMissionExecutionIds(
                  options.missions,
                  mission.id,
                ))),
              ],
            }),
            required: false,
          },
          ...branchBindings,
          ...(await createLocalHostMissionBoardBindings({
            pragmaHome: options.pragmaHome,
            missionId: mission.id,
          })),
          ...(await options.memory.bindings({
            missionId: mission.id,
            bindingId: memoryBindingId,
            goal: mission.goal,
            projectId: mission.project.id,
          })),
          ...mounted,
        ];
      };
      return {
        runtimes: options.runtimes,
        appOptions: {
          pragmaHome: options.pragmaHome,
          executionStore,
          expertSessionStore,
          runtimes: options.runtimes,
          usageSink: options.usageSink,
          loggerProvider: options.loggerProvider,
          hostContextBindings: await resolveHostContextBindings(),
          resolveHostContextBindings,
        },
        setToolPermissionMode: (mode) => {
          if (mode !== mission.toolPermissionMode)
            throw createIntegrationError({
              code: "COMMAND_REJECTED",
              category: "conflict",
              message: "Changing tool permissions requires a Node Runtime permission adapter.",
            });
        },
      };
    },
    createCompileService: () => ({
      ...options.compiler.service,
      createRequestScope: (mission, revision) => ({
        ...options.compiler.service.createRequestScope(mission, revision),
        request: mission,
      }),
    }),
    readProjectResources: async (pin) =>
      pin.id === "built_in"
        ? BUILT_IN_AGENT_REFS.flatMap(builtInAgentResources)
        : await withProject(pin, async (project) => project.listResources()),
    readIdentityMigrations: async (pin) => {
      if (pin.id === "built_in") return [];
      let value: unknown;
      try {
        value = JSON.parse(
          await readFile(join(paths.projectsRoot(), pin.id, "identity-migrations.json"), "utf8"),
        );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      }
      const manifest = identityManifest.parse(value);
      if (manifest.projectId !== pin.id)
        throw new Error("Project identity migration index belongs to another Project.");
      return manifest.migrations;
    },
    withContextMountLocks: async (ids, operation) => {
      const ordered = [...new Set(ids)].toSorted();
      const lock = async (index: number): Promise<Awaited<ReturnType<typeof operation>>> => {
        const id = ordered[index];
        if (id === undefined) return await operation();
        return await knowledge.withRevisionLock(id, async () => await lock(index + 1));
      };
      return await lock(0);
    },
    assertContextMountAvailable: async (mount) => {
      if (mount.kind === "context-store") {
        await knowledge.resolve(mount.storeId);
        return;
      }
      throw createIntegrationError({
        code: "DEPENDENCY_UNAVAILABLE",
        category: "dependency",
        message: "This Node Host has no Mission Knowledge draft adapter configured.",
        details: { reason: "mission_knowledge_draft_adapter_unavailable", mountKind: mount.kind },
      });
    },
    releaseMissionClaim: async () => {
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "This Node Host has no Mission Knowledge revision adapter configured.",
      });
    },
  };
}
