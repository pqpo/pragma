import {
  createLocalHostMissionExecutionService,
  collectMissionExecutionIds,
  type LocalHostMissionExecutionService,
  type LocalHostMissionExecutionServiceOptions,
  type LocalHostMissionExecutionContextResources,
} from "@pragma/local-host";
import { type MissionDeletionService } from "@pragma/local-host";
import {
  KnowledgeRevisionToolError,
  STORE_REVISION_EXPERT_REF,
  type KnowledgeRevisionSubmissionPort,
  type PragmaManagementToolPorts,
} from "@pragma/built-in-agents";
import {
  FileSystemContextStore,
  LEGACY_EXECUTION_OUTPUT_NAMESPACE,
  LegacyExecutionOutputContextStore,
} from "@pragma/context-filesystem";
import {
  createPragmaLogger,
  encodePragmaPathSegment,
  error,
  ok,
  PragmaPaths,
  readExecutionRunScope,
  ReadOnlyContextStore,
  StaticContextStore,
  type DurableExecutionStore,
  type ExpertAgentAutomaticHumanInteractionHandler,
  type ExpertAgentContextStoreRegistrationInput,
  type HostContextBindingsResolver,
  type McpToolRegistryPool,
  type RuntimeResolver,
} from "@pragma/core";
import type {
  PragmaAdapterHost,
  PragmaInvocableResource,
  PragmaResource,
} from "@pragma/interpreter";
import {
  createMissionBoard,
  createLocalHostMissionCompileService,
  type LocalHostMissionCompileScope,
  type LocalHostSystemExecutorSource,
  type MissionOwnerScope,
} from "@pragma/local-host";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ContextStoreIdSchema,
  isUserFacingMissionOrigin,
  type DesktopToolPermissionMode,
  type Mission,
} from "../../../shared/contracts/index.ts";
import {
  parseDesktopCapabilityBindingRef,
  parseLegacyDesktopCapabilityBindingRef,
} from "../../platform/bindings/desktop-binding-ref.ts";
import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { ContextStoreRevisionService } from "../context-stores/context-store-revision-service.ts";
import {
  withContextStoreRevisionLocks,
  type ContextStoreStore,
} from "../context-stores/context-store-store.ts";
import { DynamicContextStore } from "../context-stores/dynamic-context-store.ts";
import { createDesktopKnowledgeRevisionSubmissionPort } from "../context-stores/knowledge-revision-capability.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import {
  withOpenPragmaProjectRevision,
  type PragmaProjectStore,
} from "../projects/pragma-project-store.ts";
import type { DesktopUsageStore } from "../usage/usage-store.ts";
import { createDesktopAdapterHost } from "./mission-adapter-host.ts";
import { createMissionBranchContext } from "./mission-branch-context.ts";
import { MissionStatusService } from "./mission-status-service.ts";
import type { MissionStore } from "./mission-store.ts";

export { readMissionConversationSnapshot } from "./mission-runner-contracts.ts";
export type {
  MissionChatNotification,
  MissionCommandOutcomeNotification,
  MissionRunner,
  MissionSurfaceAudience,
  MissionWorkNotification,
} from "./mission-runner-contracts.ts";

interface ExecutorMetadata {
  readonly names: ReadonlyMap<string, string>;
  readonly avatarIds: ReadonlyMap<string, string>;
}

export interface MissionExecutorPresentationMetadata {
  readonly id: string;
  readonly name: string;
  readonly avatarId?: string | undefined;
}

export function missionKnowledgeNamespace(storeId: string): string {
  return `mission-knowledge:${storeId}`;
}

export function missionKnowledgeDraftNamespace(draftId: string): string {
  return `mission-knowledge-draft:${draftId}`;
}

export function activeMissionKnowledgeDraftNamespace(storeId: string): string {
  return `mission-knowledge-draft:${storeId}`;
}

export function mergeMissionExecutorMetadata(
  projectMetadata: ExecutorMetadata,
  systemMetadata: readonly MissionExecutorPresentationMetadata[],
): ExecutorMetadata {
  const names = new Map(projectMetadata.names);
  const avatarIds = new Map(projectMetadata.avatarIds);
  for (const executor of systemMetadata) {
    names.set(executor.id, executor.name);
    if (executor.avatarId !== undefined) avatarIds.set(executor.id, executor.avatarId);
  }
  return { names, avatarIds };
}

export interface DesktopMissionRunnerOptions {
  readonly missions: MissionStore;
  readonly missionStatus?: MissionStatusService | undefined;
  readonly project: PragmaProjectStore;
  readonly capabilityStore: CapabilityStore;
  readonly capabilityCredentials: CapabilityCredentialStore;
  readonly capabilitiesPath: string;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
  readonly pragmaHome: string;
  readonly executionStore?: DurableExecutionStore | undefined;
  readonly contextStores?: ContextStoreStore | undefined;
  readonly contextStoreRevisions?: ContextStoreRevisionService | undefined;
  readonly knowledgeRevisionMountResources?: (() => readonly PragmaResource[]) | undefined;
  readonly hostContextStores?:
    | readonly ExpertAgentContextStoreRegistrationInput[]
    | ((
        mission: Mission,
        bindingId: string,
      ) => Promise<readonly ExpertAgentContextStoreRegistrationInput[]>)
    | undefined;
  readonly plugins?: PluginStore | undefined;
  readonly resolveSecret?: ((ref: string) => Promise<string | undefined>) | undefined;
  readonly secretFingerprint?: ((ref: string) => Promise<string>) | undefined;
  readonly runtimes: RuntimeResolver;
  readonly usage?: DesktopUsageStore | undefined;
  readonly loggerProvider?: import("@pragma/core").PragmaLoggerProvider | undefined;
  readonly runtimesForToolPermissionMode?:
    ((mode: DesktopToolPermissionMode) => RuntimeResolver) | undefined;
  readonly automaticHumanInteractionHandler?:
    ExpertAgentAutomaticHumanInteractionHandler | undefined;
  readonly automaticHumanInteractionHandlerForToolPermissionMode?:
    ((mode: DesktopToolPermissionMode) => ExpertAgentAutomaticHumanInteractionHandler) | undefined;
  readonly systemExecutorSource?:
    | ((input: {
        readonly mission: Mission;
        readonly runtimes: RuntimeResolver;
        readonly purpose: "execute" | "stop";
        readonly adapterHost: PragmaAdapterHost;
        readonly knowledgeRevisions?: KnowledgeRevisionSubmissionPort | undefined;
      }) => Promise<LocalHostSystemExecutorSource | undefined>)
    | undefined;
  readonly getSystemExecutorFingerprint?:
    ((ref: string) => string | undefined | Promise<string | undefined>) | undefined;
  readonly getSystemExecutorMetadata?:
    (() => readonly MissionExecutorPresentationMetadata[]) | undefined;
  readonly getSystemExecutorResource?:
    ((ref: string) => PragmaInvocableResource | undefined) | undefined;
  readonly getSystemDependencyResource?: ((ref: string) => PragmaResource | undefined) | undefined;
  readonly pragmaManagementPorts?:
    (() => Omit<PragmaManagementToolPorts, "knowledgeRevisions">) | undefined;
  readonly registerExecutionDelivery?:
    | ((mission: Mission, executionId: string, requestId: string) => void | Promise<void>)
    | undefined;
  readonly deferTerminalProjection?: boolean | undefined;
  readonly wakeExecutionDelivery?: (() => void) | undefined;
  readonly assertExecutorReady?:
    | ((ref: string, scope?: LocalHostMissionCompileScope<Mission>) => void | Promise<void>)
    | undefined;
  readonly deletionService?: MissionDeletionService | undefined;
  readonly onStorageTrashed?: (() => void) | undefined;
  /** Stop owner consumers and settle accounting before acquiring Execution locks. */
  readonly prepareOwnerDeletion?:
    | ((input: {
        readonly mission: Mission;
        readonly executionIds: readonly string[];
      }) => Promise<void>)
    | undefined;
  /** Delete transient state while canonical delivery and Execution writes are fenced. */
  readonly onOwnerDeleting?:
    | ((input: {
        readonly mission: Mission;
        readonly executionIds: readonly string[];
      }) => Promise<void>)
    | undefined;
  readonly onExecutionLinked?:
    | ((input: {
        readonly mission: Mission;
        readonly executionId: string;
        readonly requestId: string;
      }) => Promise<void>)
    | undefined;
  readonly onExecutionContextLinked?:
    | ((input: {
        readonly mission: Mission;
        readonly executionId: string;
        readonly requestId: string;
      }) => Promise<void>)
    | undefined;
  readonly onPromptAdmitting?: LocalHostMissionExecutionServiceOptions["onPromptAdmitting"];
  readonly onMissionActivity?:
    ((input: { readonly mission: Mission }) => Promise<void>) | undefined;
  readonly invalidateRuntimeReadiness?: (() => void) | undefined;
  readonly commitExecutionTerminal?: LocalHostMissionExecutionServiceOptions["commitExecutionTerminal"];
  readonly onExecutionTerminal?:
    | ((input: {
        readonly mission: Mission;
        readonly executionId: string;
        readonly status: "succeeded" | "failed" | "cancelled";
        readonly result?: unknown;
        readonly error?: unknown;
      }) => Promise<void>)
    | undefined;
  readonly adapterHostForMission?:
    ((mission: Mission, defaultHost: PragmaAdapterHost) => PragmaAdapterHost) | undefined;
  /** Shared Local Host controller scope for Inbox commands and semantic writes. */
  readonly ownerScope?: MissionOwnerScope | undefined;
}

export function createMissionRunner(
  options: DesktopMissionRunnerOptions,
): LocalHostMissionExecutionService {
  const logger = createPragmaLogger(options.loggerProvider, {
    component: "desktop.mission-resources",
  });
  const runtimeResolverForToolPermissionMode = (mode: DesktopToolPermissionMode) =>
    options.runtimesForToolPermissionMode?.(mode) ?? options.runtimes;
  const automaticHumanInteractionHandlerForToolPermissionMode = (mode: DesktopToolPermissionMode) =>
    options.automaticHumanInteractionHandlerForToolPermissionMode?.(mode) ??
    options.automaticHumanInteractionHandler;

  return createLocalHostMissionExecutionService({
    ...options,
    resourcePorts: {
      createExecutionContextResources: async ({
        mission,
        purpose,
        assertExecutionOwnership,
        executionStore,
        expertSessionStore,
      }) => {
        const systemMission = !isUserFacingMissionOrigin(mission.origin);
        let toolPermissionMode = mission.toolPermissionMode;
        const runtimes: RuntimeResolver = {
          getDefaultRuntimeId: async () =>
            await runtimeResolverForToolPermissionMode(toolPermissionMode).getDefaultRuntimeId(),
          bind: async (request) =>
            await runtimeResolverForToolPermissionMode(toolPermissionMode).bind(request),
          resolve: async (request) =>
            await runtimeResolverForToolPermissionMode(toolPermissionMode).resolve(request),
        };
        if (purpose === "stop")
          return {
            runtimes,
            appOptions: {
              pragmaHome: options.pragmaHome,
              runtimes,
              executionStore,
              expertSessionStore,
              loggerProvider: options.loggerProvider?.withScope({ missionId: mission.id }),
            },
            setToolPermissionMode: (mode) => {
              toolPermissionMode = mode;
            },
          };
        const missionRoot =
          options.missions.storagePath?.(mission.id) ??
          join(
            new PragmaPaths({ pragmaHome: options.pragmaHome }).missionsRoot(),
            encodePragmaPathSegment(mission.id),
          );
        const authorizeBoard = async (input: {
          readonly operation: "list" | "read" | "search" | "add" | "edit" | "delete";
          readonly ids: readonly string[];
        }): Promise<readonly string[]> => {
          if (["list", "read", "search"].includes(input.operation)) return input.ids;
          const current = await options.missions.get(mission.id);
          return current.lifecycleStatus === "active" ? input.ids : [];
        };
        const board = systemMission
          ? { bindings: [] as readonly ExpertAgentContextStoreRegistrationInput[] }
          : await createMissionBoard({
              ownerId: mission.id,
              openSharedStore: async () => {
                const rootDir = join(missionRoot, "board", "shared");
                await mkdir(rootDir, { recursive: true });
                return new FileSystemContextStore({
                  rootDir,
                  include: ["*.md", "**/*.md", "*.json", "**/*.json", "*.txt", "**/*.txt"],
                  authorize: authorizeBoard,
                });
              },
              openPrivateStore: async (_ownerId, contextId) => {
                const rootDir = join(
                  missionRoot,
                  "board",
                  "private",
                  encodePragmaPathSegment(contextId),
                );
                await mkdir(rootDir, { recursive: true });
                return new FileSystemContextStore({
                  rootDir,
                  include: ["*.md", "**/*.md", "*.json", "**/*.json", "*.txt", "**/*.txt"],
                  authorize: authorizeBoard,
                });
              },
            });
        let historicalExecutionIds: Promise<ReadonlySet<string>> | undefined;
        const legacyExecutionOutputBindings: readonly ExpertAgentContextStoreRegistrationInput[] =
          systemMission
            ? []
            : [
                {
                  namespace: LEGACY_EXECUTION_OUTPUT_NAMESPACE,
                  store: new LegacyExecutionOutputContextStore({
                    pragmaHome: options.pragmaHome,
                    resolveVisibleExecutionIds: async () => [
                      ...(await (historicalExecutionIds ??= collectMissionExecutionIds(
                        options.missions,
                        mission.id,
                      ))),
                    ],
                  }),
                  required: false,
                },
              ];
        const resolveMissionKnowledgeBindings = async (): Promise<
          readonly ExpertAgentContextStoreRegistrationInput[]
        > => {
          const current = await options.missions.get(mission.id);
          return (
            await Promise.all(
              current.contextMounts.map(async (mount) => {
                if (mount.kind === "context-store") {
                  if (options.contextStores === undefined) {
                    throw new Error(`Mission Knowledge Store is unavailable: ${mount.storeId}`);
                  }
                  const resolved = await options.contextStores.resolve(mount.storeId);
                  return {
                    namespace: missionKnowledgeNamespace(mount.storeId),
                    storeName: resolved.name,
                    store: new ReadOnlyContextStore(resolved.store),
                    required: true,
                    mutationApproval: "none" as const,
                  };
                }
                if (mount.kind === "skill-revision-draft") return undefined;
                if (options.contextStoreRevisions === undefined) {
                  throw new Error(`Mission Knowledge Draft is unavailable: ${mount.draftId}`);
                }
                if (mount.revisionJobId !== undefined) {
                  return undefined;
                }
                const resolved = await options.contextStoreRevisions.resolveDraft(mount.draftId);
                return {
                  namespace: missionKnowledgeDraftNamespace(mount.draftId),
                  storeName: resolved.name,
                  store: new ReadOnlyContextStore(resolved.store),
                  required: true,
                  mutationApproval: "none" as const,
                };
              }),
            )
          ).filter((binding): binding is NonNullable<typeof binding> => binding !== undefined);
        };
        // Pre-register draft namespaces so a tool can claim a target and edit it in the
        // same Invocation. The resolver below enforces the durable owner on every call.
        const resolveActiveKnowledgeRevisionBindings = async (): Promise<
          readonly ExpertAgentContextStoreRegistrationInput[]
        > => {
          if (options.contextStoreRevisions === undefined) return [];
          const createActiveDraftStore = (storeId: string) =>
            new DynamicContextStore(async (operation, runContext) => {
              const currentMission = await options.missions.get(mission.id);
              const claimedMounts = currentMission.contextMounts.filter(
                (
                  mount,
                ): mount is Extract<
                  Mission["contextMounts"][number],
                  { kind: "context-store-draft" }
                > => mount.kind === "context-store-draft" && mount.revisionJobId !== undefined,
              );
              const activeMounts = (
                await Promise.all(
                  claimedMounts.map(async (mount) => ({
                    mount,
                    storeId: (await options.contextStoreRevisions!.getDraft(mount.draftId)).storeId,
                  })),
                )
              ).filter((candidate) => candidate.storeId === storeId);
              if (activeMounts.length === 0 && (operation === "list" || operation === "search")) {
                return ok(new StaticContextStore([]));
              }
              if (activeMounts.length !== 1) {
                return error(
                  "store_unavailable",
                  activeMounts.length === 0
                    ? "Start a knowledge revision for this knowledge base before using its draft namespace."
                    : "The Mission has more than one active draft for the same knowledge base.",
                );
              }
              const mount = activeMounts[0]!.mount;
              const [job, draft, resolved] = await Promise.all([
                options.contextStoreRevisions!.get(mount.revisionJobId!),
                options.contextStoreRevisions!.getDraft(mount.draftId),
                options.contextStoreRevisions!.resolveDraft(mount.draftId),
              ]);
              if (
                job.state !== "running" ||
                job.draftId !== mount.draftId ||
                job.missionId !== mission.id ||
                draft.activeMissionId !== mission.id
              ) {
                return error(
                  "permission_denied",
                  "The active knowledge revision draft is not owned by this Mission.",
                );
              }
              const scope = readExecutionRunScope(runContext);
              const caller =
                scope.executionId === undefined || scope.invocationId === undefined
                  ? undefined
                  : await executionStore.getInvocation(scope.executionId, scope.invocationId);
              const provenance = job.request.provenance;
              const owner =
                provenance === undefined
                  ? undefined
                  : await executionStore.getInvocation(
                      provenance.executionId,
                      provenance.invocationId,
                    );
              const ownsDraft =
                caller !== undefined &&
                (mission.executor.ref === STORE_REVISION_EXPERT_REF
                  ? caller.parentInvocationId === undefined
                  : owner !== undefined &&
                    (caller.contextId === owner.contextId ||
                      (owner.parentInvocationId === undefined &&
                        caller.parentInvocationId === undefined)));
              if (!ownsDraft) {
                if (operation === "list" || operation === "search")
                  return ok(new StaticContextStore([]));
                return error(
                  "permission_denied",
                  "This revision draft belongs to another Runtime Context.",
                );
              }
              if (["add", "edit", "delete"].includes(operation) && draft.state !== "editing") {
                return error(
                  "permission_denied",
                  `The active knowledge revision draft cannot be edited while it is ${draft.state}.`,
                );
              }
              return ok(resolved.store);
            });
          const currentMission = await options.missions.get(mission.id);
          const claimedDraftStoreIds = await Promise.all(
            currentMission.contextMounts
              .filter(
                (
                  mount,
                ): mount is Extract<
                  Mission["contextMounts"][number],
                  { kind: "context-store-draft" }
                > => mount.kind === "context-store-draft" && mount.revisionJobId !== undefined,
              )
              .map(
                async (mount) =>
                  (await options.contextStoreRevisions!.getDraft(mount.draftId)).storeId,
              ),
          );
          const revisionTargetStoreIds = [
            ...new Set([
              ...((await options.contextStores?.list()) ?? []).map((store) => store.id),
              ...claimedDraftStoreIds,
            ]),
          ];
          const namespacePrefix = activeMissionKnowledgeDraftNamespace("");
          return [
            {
              namespace: namespacePrefix,
              storeName: "Active Mission Knowledge draft",
              resolveStore: (namespace) => {
                const storeId = namespace.slice(namespacePrefix.length);
                const parsed = ContextStoreIdSchema.safeParse(storeId);
                return parsed.success ? createActiveDraftStore(parsed.data) : undefined;
              },
              required: false,
              mutationApproval: "none" as const,
            },
            ...revisionTargetStoreIds.map((storeId) => ({
              namespace: activeMissionKnowledgeDraftNamespace(storeId),
              storeName: "Active Mission Knowledge draft",
              store: createActiveDraftStore(storeId),
              required: false,
              mutationApproval: "none" as const,
            })),
          ];
        };
        const branchHistory = await options.missions.readBranchHistory(mission.id);
        const branchHistoryBindings: readonly ExpertAgentContextStoreRegistrationInput[] =
          branchHistory === undefined
            ? []
            : [
                {
                  namespace: "branch-history",
                  storeName: "Inherited Mission history",
                  store: new StaticContextStore(createMissionBranchContext(branchHistory)),
                  required: true,
                  mutationApproval: "none" as const,
                },
              ];
        const memoryBindingId = randomUUID();
        const resolveConfiguredHostContextBindings = async (): Promise<
          readonly ExpertAgentContextStoreRegistrationInput[]
        > => {
          if (systemMission || options.hostContextStores === undefined) return [];
          return typeof options.hostContextStores === "function"
            ? await options.hostContextStores(mission, memoryBindingId)
            : options.hostContextStores;
        };
        const resolveHostContextBindings: HostContextBindingsResolver = async () => {
          await assertExecutionOwnership?.();
          return [
            ...(await resolveConfiguredHostContextBindings()),
            ...legacyExecutionOutputBindings,
            ...branchHistoryBindings,
            ...board.bindings,
            ...(await resolveMissionKnowledgeBindings()),
            ...(await resolveActiveKnowledgeRevisionBindings()),
          ];
        };
        const hostContextBindings = await resolveHostContextBindings();
        const seenNamespaces = new Set<string>();
        for (const binding of hostContextBindings) {
          if (seenNamespaces.has(binding.namespace)) {
            throw new Error(`Mission Context namespace already exists: ${binding.namespace}`);
          }
          seenNamespaces.add(binding.namespace);
        }
        const context: LocalHostMissionExecutionContextResources = {
          runtimes,
          appOptions: {
            pragmaHome: options.pragmaHome,
            runtimes,
            executionStore,
            expertSessionStore,
            hostContextBindings,
            resolveHostContextBindings,
            loggerProvider: options.loggerProvider?.withScope({ missionId: mission.id }),
            automaticHumanInteractionHandler: async (request) => {
              if (
                ["system-store-revision", "system-skill-revision"].includes(mission.origin.type) &&
                request.kind === "tool_approval"
              ) {
                return { kind: "tool_approval", approved: false, updatedInput: request.input };
              }
              return await automaticHumanInteractionHandlerForToolPermissionMode(
                toolPermissionMode,
              )?.(request);
            },
            usageSink:
              options.usage === undefined
                ? undefined
                : {
                    record: async (observation) => {
                      if (options.deferTerminalProjection) {
                        options.wakeExecutionDelivery?.();
                        return;
                      }
                      const currentMission = await options.missions.get(mission.id);
                      const names = await withOpenPragmaProjectRevision(
                        options.project,
                        currentMission.project.revision,
                        async (project) =>
                          new Map(
                            project
                              .listResources()
                              .map(
                                (resource) =>
                                  [resource.metadata.id, resource.metadata.name] as const,
                              ),
                          ),
                      );
                      names.set(currentMission.executor.ref, currentMission.executor.name);
                      await options.usage!.record(observation, {
                        mission: { id: currentMission.id, title: currentMission.title },
                        invocations: await executionStore.listInvocations(observation.executionId),
                        names,
                      });
                    },
                  },
          },
          setToolPermissionMode: (mode: DesktopToolPermissionMode) => {
            toolPermissionMode = mode;
          },
        };
        return context;
      },
      createCompileService: ({ executionStore, executionOwner, invalidateContextBindings }) => {
        const sessionService = executionOwner;
        const lifecycleService = executionOwner;
        const knowledgeRevisionsByAdapter = new WeakMap<
          PragmaAdapterHost,
          KnowledgeRevisionSubmissionPort
        >();
        const createMissionAdapterHost = async (
          mission: Mission,
          purpose: "execute" | "stop",
        ): Promise<PragmaAdapterHost> => {
          const knowledgeRevisions =
            purpose === "stop" ||
            options.contextStores === undefined ||
            options.contextStoreRevisions === undefined
              ? undefined
              : createDesktopKnowledgeRevisionSubmissionPort({
                  project: options.project,
                  contextStores: options.contextStores,
                  revisions: options.contextStoreRevisions,
                  additionalMountResources: options.knowledgeRevisionMountResources,
                  inlineMission: {
                    id: mission.id,
                    assertOwnership: async (job, input) => {
                      const provenance = job.request.provenance;
                      const [owner, caller] = await Promise.all([
                        provenance === undefined
                          ? undefined
                          : executionStore.getInvocation(
                              provenance.executionId,
                              provenance.invocationId,
                            ),
                        executionStore.getInvocation(input.executionId, input.invocationId),
                      ]);
                      const ownsDraft =
                        caller !== undefined &&
                        (mission.executor.ref === STORE_REVISION_EXPERT_REF
                          ? caller.parentInvocationId === undefined
                          : job.missionId === mission.id &&
                            owner !== undefined &&
                            (caller.contextId === owner.contextId ||
                              (owner.parentInvocationId === undefined &&
                                caller.parentInvocationId === undefined)));
                      if (!ownsDraft) {
                        throw new KnowledgeRevisionToolError(
                          "revision_conflict",
                          "knowledge_revision_owned_by_another_context",
                          false,
                        );
                      }
                    },
                    activeRevisionJobIdForStore: async (storeId) =>
                      (
                        await options.contextStoreRevisions!.getMissionActiveJob({
                          missionId: mission.id,
                          storeId,
                        })
                      )?.id,
                    writableNamespaceForStore: activeMissionKnowledgeDraftNamespace,
                    mountDraft: async ({ storeId, draftId, revisionJobId, previousMissionId }) => {
                      sessionService.beginContextBindingChange(mission.id);
                      if (previousMissionId !== undefined) {
                        sessionService.beginContextBindingChange(previousMissionId);
                      }
                      let previousRestored = false;
                      let mountedHere = false;
                      try {
                        const session = sessionService.session(mission.id);
                        const queued = (await session?.getPromptQueue())?.some(
                          (prompt) => prompt.status === "queued",
                        );
                        if (queued === true) {
                          throw new KnowledgeRevisionToolError(
                            "already_attached",
                            "Remove or finish queued Mission messages before starting a knowledge revision.",
                            false,
                          );
                        }
                        if (previousMissionId !== undefined) {
                          const previousMission = await options.missions.get(previousMissionId);
                          const previousSession = sessionService.session(previousMissionId);
                          const previousHasQueuedPrompts = (
                            (await previousSession?.getPromptQueue()) ?? []
                          ).some(
                            (prompt) => prompt.status === "queued" || prompt.status === "running",
                          );
                          if (
                            lifecycleService.hasActive(previousMissionId) ||
                            previousHasQueuedPrompts ||
                            (previousMission.execution !== undefined &&
                              ["queued", "running", "waiting"].includes(
                                previousMission.execution.status,
                              ))
                          ) {
                            throw new KnowledgeRevisionToolError(
                              "already_attached",
                              "knowledge_revision_previous_mission_active",
                              false,
                            );
                          }
                          const previousOwnsDraft = previousMission.contextMounts.some(
                            (mount) =>
                              mount.kind === "context-store-draft" &&
                              mount.draftId === draftId &&
                              mount.revisionJobId === revisionJobId,
                          );
                          if (!previousOwnsDraft) {
                            throw new KnowledgeRevisionToolError(
                              "unavailable",
                              "knowledge_revision_previous_claim_invalid",
                              false,
                            );
                          }

                          await options.missions.restoreManagedRevisionStore({
                            id: previousMissionId,
                            storeId,
                            draftId,
                            revisionJobId,
                          });
                          previousRestored = true;
                          await options.contextStoreRevisions!.detachMission(
                            revisionJobId,
                            previousMissionId,
                          );
                          await options.contextStoreRevisions!.attachMission(
                            revisionJobId,
                            mission.id,
                          );
                        } else {
                          await options.contextStoreRevisions!.attachMission(
                            revisionJobId,
                            mission.id,
                          );
                        }
                        const beforeMount = await options.missions.get(mission.id);
                        const preserveSession = !beforeMount.contextMounts.some(
                          (mount) =>
                            mount.kind === "context-store-draft" &&
                            mount.draftId === draftId &&
                            mount.revisionJobId === undefined,
                        );
                        await options.missions.mountManagedRevisionDraft({
                          id: mission.id,
                          preserveSession,
                          expectedExecutorRef: mission.executor.ref,
                          storeId,
                          allowUnmountedTarget: true,
                          draftId,
                          revisionJobId,
                        });
                        mountedHere = true;
                        const [attachedJob, attachedDraft, attachedMission] = await Promise.all([
                          options.contextStoreRevisions!.get(revisionJobId),
                          options.contextStoreRevisions!.getDraft(draftId),
                          options.missions.get(mission.id),
                        ]);
                        const claimMounted = attachedMission.contextMounts.some(
                          (mount) =>
                            mount.kind === "context-store-draft" &&
                            mount.draftId === draftId &&
                            mount.revisionJobId === revisionJobId,
                        );
                        if (
                          !claimMounted ||
                          attachedJob.state !== "running" ||
                          attachedJob.missionId !== mission.id ||
                          attachedDraft.activeMissionId !== mission.id
                        ) {
                          throw new KnowledgeRevisionToolError(
                            "unavailable",
                            "knowledge_revision_mount_incomplete",
                            false,
                          );
                        }
                        await options.contextStoreRevisions!.completeMissionClaimMount({
                          missionId: mission.id,
                          storeId,
                          jobId: revisionJobId,
                          draftId,
                        });
                        if (!preserveSession) await invalidateContextBindings(mission.id);
                        if (previousMissionId !== undefined) {
                          await invalidateContextBindings(previousMissionId);
                        }
                        return {
                          writableNamespace: activeMissionKnowledgeDraftNamespace(storeId),
                        };
                      } catch (error) {
                        if (mountedHere) {
                          await options.missions.restoreManagedRevisionStore({
                            id: mission.id,
                            storeId,
                            draftId,
                            revisionJobId,
                          });
                        }
                        if (previousMissionId !== undefined && previousRestored) {
                          let current = await options.contextStoreRevisions!.get(revisionJobId);
                          if (current.missionId === mission.id) {
                            await options.contextStoreRevisions!.detachMission(
                              revisionJobId,
                              mission.id,
                            );
                            current = await options.contextStoreRevisions!.get(revisionJobId);
                          }
                          if (current.missionId === undefined) {
                            await options.contextStoreRevisions!.attachMission(
                              revisionJobId,
                              previousMissionId,
                            );
                            current = await options.contextStoreRevisions!.get(revisionJobId);
                          }
                          if (current.missionId === previousMissionId) {
                            await options.missions.mountManagedRevisionDraft({
                              id: previousMissionId,
                              expectedExecutorRef: (await options.missions.get(previousMissionId))
                                .executor.ref,
                              storeId,
                              draftId,
                              revisionJobId,
                            });
                          }
                        }
                        throw error;
                      } finally {
                        sessionService.finishContextBindingChange(mission.id);
                        if (previousMissionId !== undefined) {
                          sessionService.finishContextBindingChange(previousMissionId);
                        }
                      }
                    },
                  },
                });
          const pragmaManagement = {
            ...options.pragmaManagementPorts?.(),
            ...(knowledgeRevisions === undefined ? {} : { knowledgeRevisions }),
          } satisfies PragmaManagementToolPorts;
          const desktopAdapterHost = createDesktopAdapterHost(
            {
              ...options,
              purpose,
              pragmaManagementScope: {
                missionId: mission.id,
                workspacePath: mission.workspace.path,
              },
              ...(Object.keys(pragmaManagement).length === 0 ? {} : { pragmaManagement }),
            },
            mission.workspace.path,
          );
          const adapterHost = desktopAdapterHost;
          if (knowledgeRevisions !== undefined)
            knowledgeRevisionsByAdapter.set(adapterHost, knowledgeRevisions);
          return adapterHost;
        };

        const compileService = createLocalHostMissionCompileService<Mission>({
          onPhase: ({ requestId, phase, elapsedMs }) =>
            logger.info("mission.performance", "Mission phase completed", {
              missionId: requestId,
              phase,
              elapsedMs,
            }),
          environmentId: "desktop",
          pragmaHome: options.pragmaHome,
          loggerProvider: options.loggerProvider,
          revisionSource: {
            getRevision: async (projectId, revision) => {
              if (projectId !== options.project.projectId)
                throw new Error(`Mission project is unavailable: ${projectId}`);
              return await options.project.getRevision(revision);
            },
            withProject: async (pin, operation) => {
              if (pin.id !== options.project.projectId)
                throw new Error(`Mission project is unavailable: ${pin.id}`);
              const project = await options.project.openRevision(pin.revision);
              try {
                return await operation(project);
              } finally {
                await project.dispose();
              }
            },
          },
          adapterHost: createMissionAdapterHost,
          secretFingerprint: options.secretFingerprint,
          adaptAdapterHost: options.adapterHostForMission,
          capabilityAuthority: {
            getCapabilityId: (binding) =>
              parseDesktopCapabilityBindingRef(binding) ??
              parseLegacyDesktopCapabilityBindingRef(binding)?.id,
            resolve: async (capabilityId) => {
              const capability = await options.capabilityStore.resolveActive(capabilityId);
              const credentials = await options.capabilityCredentials.fingerprint(
                capability.manifest.id,
              );
              return {
                capabilityId: capability.manifest.id,
                resolvedRevision: capability.manifest.latestRevision,
                fingerprint: createHash("sha256")
                  .update(JSON.stringify({ definition: capability.definition, credentials }))
                  .digest("hex"),
              };
            },
          },
          systemExecutors: {
            getResource: options.getSystemExecutorResource,
            getDependencyResource: options.getSystemDependencyResource,
            fingerprint: options.getSystemExecutorFingerprint,
            prepare: async (mission, runtimes, purpose, adapterHost) =>
              await options.systemExecutorSource?.({
                mission,
                runtimes,
                purpose,
                adapterHost,
                knowledgeRevisions: knowledgeRevisionsByAdapter.get(adapterHost),
              }),
          },
          ...(options.plugins === undefined
            ? {}
            : {
                plugins: {
                  inspect: async ({ binding }) =>
                    await options.plugins!.inspect({
                      ref: binding.ref,
                      config: binding.config,
                      secretBindings: binding.secretBindings,
                    }),
                  resolve: async ({ binding }) =>
                    await options.plugins!.resolve({
                      ref: binding.ref,
                      config: binding.config,
                      secretBindings: binding.secretBindings,
                    }),
                },
              }),
        });
        return compileService;
      },
      readProjectResources: async (pin) =>
        await withOpenPragmaProjectRevision(options.project, pin.revision, async (project) =>
          project.listResources(),
        ),
      readIdentityMigrations: async () => await options.project.readIdentityMigrations(),
      withContextMountLocks: async (ids, operation) =>
        await withContextStoreRevisionLocks(options.contextStores, ids, operation),
      assertContextMountAvailable: async (mount) => {
        if (mount.kind === "context-store") {
          if (options.contextStores === undefined)
            throw new Error("Mission Knowledge Stores are unavailable.");
          await options.contextStores.resolve(mount.storeId);
        } else if (mount.kind === "context-store-draft") {
          if (options.contextStoreRevisions === undefined)
            throw new Error("Mission Knowledge Drafts are unavailable.");
          await options.contextStoreRevisions.resolveDraft(mount.draftId);
        }
      },
      releaseMissionClaim: async (input) => {
        await options.contextStoreRevisions?.releaseMissionClaim(input);
      },
    },
  });
}

export {
  compactExpertSessionContext,
  persistMissionExecutionProjection,
  missionProjectionAddsUserVisibleOutput,
  listPendingHumanInteractions,
  toDesktopHumanRequest,
} from "@pragma/local-host";
