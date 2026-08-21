import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createPragma,
  createPragmaLogger,
  createFileExecutionStore,
  createFileExpertSessionStore,
  ExecutionWorkHistoryReader,
  ExpertAgentHumanRequestSchema,
  fingerprintExpertExecutionDefinition,
  isRuntimeContextCompactionNotNeededError,
  isExpertTeam,
  StoredExecutionView,
  PragmaPaths,
  readRuntimeSessionContextWindowUsage,
  readRuntimeSessionRecord,
  ReadOnlyContextStore,
  moveOwnedStorageToTrash,
  runtimeSessionDeletionSources,
  assertStorageWriteAllowed,
  encodePragmaPathSegment,
  isRuntimeContextCompactionStage,
  readRuntimeContextCompactionProgressData,
  RUNTIME_CONTEXT_COMPACTION_STAGES,
  type AgentMessageRecord,
  type ExecutionView,
  type ExecutionWorkRecord,
  type ExecutionOutputItem,
  type FileExecutionStore,
  type ExpertAgentAutomaticHumanInteractionHandler,
  type ExpertAgentHumanRequest,
  type ExpertAgentHumanResponse,
  type ExpertDefinition,
  type ExpertAgentContextStoreRegistrationInput,
  type HostContextBindingsResolver,
  type ExpertSession,
  type MutableExecution,
  type McpToolRegistryPool,
  type PragmaLogger,
  type RuntimeResolver,
  type RuntimeContextWindowUsage,
  type RuntimeModelSelection,
} from "@pragma/core";
import {
  FileSystemContextStore,
  LEGACY_EXECUTION_OUTPUT_NAMESPACE,
  LegacyExecutionOutputContextStore,
} from "@pragma/context-filesystem";
import { createMissionBoard } from "@pragma/mission-board";
import type {
  InvocableResource,
  CompiledResource,
  PragmaAdapterHost,
  PragmaBindingRecord,
} from "@pragma/interpreter";
import { createPragmaResourceIdentityMigrationIndex } from "@pragma/interpreter";
import type {
  HumanInteractionRequest,
  HumanInteractionResponse,
  ExpertAgentStreamEvent,
  ExpertPromptAttachment,
  AgentMessageUsage,
  ExecutionEvent,
  RuntimeContextRecord,
  RuntimeEnvironmentBinding,
} from "@pragma/shared";
import {
  BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS,
  ExpertAgentStreamEventSchema,
  InvocationOutputSchema,
  isFinalExecutionStatus,
  resolvePragmaAvatarId,
  RuntimeContextWindowUsageSchema,
  type ExpertSessionEvent,
  type PromptRequest,
} from "@pragma/shared";

import {
  isUserFacingMissionOrigin,
  type Mission,
  type MissionChatEntry,
  type MissionChatPatch,
  type MissionChatSnapshot,
  type MissionMessageAcceptance,
  type MissionChatUpdate,
  type MissionChatQuery,
  type MissionContextCompactionResult,
  type MissionContextWindowState,
  type MissionHumanInteraction,
  type MissionModelOverride,
  type MissionWorkConversationSnapshot,
  type MissionWorkRecord,
  type MissionWorkSnapshot,
  type MissionWorkUpdate,
  type GetMissionWorkConversation,
  type DesktopToolPermissionMode,
  type UpdateMissionOptions,
  type UpdateMissionContextStores,
} from "../../../shared/contracts/index.ts";
import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import { resolveExpertCapabilities } from "../experts/desktop-expert-factory.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import {
  parseDesktopCapabilityBindingRef,
  parseDesktopContextBindingRef,
} from "../../platform/bindings/desktop-binding-ref.ts";
import { MissionOperationError } from "./mission-operation-error.ts";
import {
  createMissionResumeOptions,
  shouldCreateSuccessorExpertSession,
} from "./mission-session-upgrade.ts";
import type { MissionStore, MissionTimelineTurn } from "./mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import type { DesktopUsageStore } from "../usage/usage-store.ts";

function readPersistedPromptQueueState(
  activeExecutionId: string | undefined,
  prompts: readonly PromptRequest[],
  events: readonly { readonly type: string; readonly data?: unknown }[],
): {
  readonly state: "idle" | "running" | "paused";
  readonly pendingCount: number;
  readonly pausedAfterRequestId?: string | undefined;
} {
  const pending = prompts.filter(
    (prompt) =>
      prompt.mode === "enqueue" && (prompt.status === "queued" || prompt.status === "running"),
  );
  const lastControl = [...events]
    .reverse()
    .find((event) =>
      ["prompt.queue-paused", "prompt.queue-resumed", "prompt.queue-cleared"].includes(event.type),
    );
  const paused =
    lastControl?.type === "prompt.queue-paused" &&
    pending.some((prompt) => prompt.status === "queued");
  const pausedRequestId = (lastControl?.data as { requestId?: unknown } | undefined)?.requestId;
  return {
    state: paused
      ? "paused"
      : activeExecutionId !== undefined || pending.length > 0
        ? "running"
        : "idle",
    pendingCount: pending.length,
    ...(paused && typeof pausedRequestId === "string"
      ? { pausedAfterRequestId: pausedRequestId }
      : {}),
  };
}

export type MissionSurfaceAudience = "user" | "internal";

export interface MissionChatNotification {
  readonly audience: MissionSurfaceAudience;
  readonly update: MissionChatUpdate;
}

export interface MissionWorkNotification {
  readonly audience: MissionSurfaceAudience;
  readonly update: MissionWorkUpdate;
}

export interface MissionRunner {
  reconcileUsage(): Promise<void>;
  invalidateEstimatedContextWindows(): Promise<void>;
  refreshMemoryContextBindings(): Promise<void>;
  run(id: string): Promise<Mission>;
  updateOptions(input: UpdateMissionOptions): Promise<Mission>;
  updateContextStores(input: UpdateMissionContextStores): Promise<Mission>;
  sendMessage(input: {
    readonly id: string;
    readonly content: string;
    readonly requestId: string;
    readonly attachments?: readonly ExpertPromptAttachment[] | undefined;
    readonly mode?: "enqueue" | "steer" | undefined;
  }): Promise<MissionMessageAcceptance>;
  steerQueuedMessage(input: { readonly id: string; readonly requestId: string }): Promise<Mission>;
  removeQueuedMessage(input: { readonly id: string; readonly requestId: string }): Promise<Mission>;
  getChat(input: MissionChatQuery): Promise<MissionChatSnapshot>;
  getTerminalRuntimeFailure(id: string): Promise<
    | {
        readonly message: string;
        readonly code?: string | undefined;
        readonly retryable?: boolean | undefined;
        readonly httpStatus?: number | undefined;
        readonly requestId?: string | undefined;
        readonly endpoint?: string | undefined;
        readonly failedAt: string;
      }
    | undefined
  >;
  getTerminalRuntimeOutputDiagnostic(id: string): Promise<
    | {
        readonly finishReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | undefined;
        readonly responseModel?: string | undefined;
        readonly usage?: AgentMessageUsage | undefined;
      }
    | undefined
  >;
  compactContext(id: string): Promise<MissionContextCompactionResult>;
  getRuntimeBinding(id: string): Promise<RuntimeEnvironmentBinding | undefined>;
  subscribeChat(listener: (notification: MissionChatNotification) => void): () => void;
  subscribeWork(listener: (notification: MissionWorkNotification) => void): () => void;
  interrupt(id: string): Promise<Mission>;
  resumeQueue(id: string): Promise<Mission>;
  getWork(id: string): Promise<MissionWorkSnapshot>;
  getWorkConversation(input: GetMissionWorkConversation): Promise<MissionWorkConversationSnapshot>;
  delete(id: string): Promise<void>;
  listHumanInteractions(id: string): Promise<readonly MissionHumanInteraction[]>;
  respondToHumanInteraction(input: {
    readonly missionId: string;
    readonly interactionId: string;
    readonly requestId: string;
    readonly response: HumanInteractionResponse;
  }): Promise<void>;
}

async function collectMissionExecutionIds(
  missions: MissionStore,
  missionId: string,
): Promise<ReadonlySet<string>> {
  const executionTurns: { readonly sequence: number; readonly executionId: string }[] = [];
  let beforeSequence: number | undefined;
  while (true) {
    const page = await missions.readTimelinePage(missionId, {
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      limit: 500,
    });
    for (const turn of page.turns) {
      if (turn.executionId !== undefined) {
        executionTurns.push({ sequence: turn.sequence, executionId: turn.executionId });
      }
    }
    if (page.nextBeforeSequence === undefined) {
      return new Set(
        executionTurns
          .toSorted((left, right) => left.sequence - right.sequence)
          .map((turn) => turn.executionId),
      );
    }
    beforeSequence = page.nextBeforeSequence;
  }
}

type PendingMissionOperation =
  | { readonly kind: "run"; readonly promise: Promise<Mission> }
  | { readonly kind: "options"; readonly promise: Promise<Mission> }
  | { readonly kind: "context-stores"; readonly promise: Promise<Mission> }
  | { readonly kind: "message"; readonly promise: Promise<MissionMessageAcceptance> }
  | { readonly kind: "queue-steer"; readonly promise: Promise<Mission> }
  | { readonly kind: "queue-remove"; readonly promise: Promise<Mission> }
  | { readonly kind: "resume"; readonly promise: Promise<Mission> }
  | { readonly kind: "compact"; readonly promise: Promise<MissionContextCompactionResult> }
  | { readonly kind: "interrupt"; readonly promise: Promise<Mission> }
  | { readonly kind: "delete"; readonly promise: Promise<void> };

interface ActiveMissionExecution {
  readonly handle: MutableExecution & { readonly result: Promise<unknown> };
  readonly settlement: Promise<void>;
  readonly audience: MissionSurfaceAudience;
}

function missionSurfaceAudience(mission: Pick<Mission, "origin">): MissionSurfaceAudience {
  return isUserFacingMissionOrigin(mission.origin) ? "user" : "internal";
}

export async function compactExpertSessionContext(
  session: Pick<ExpertSession, "canCompactRootContext" | "compactRootContext">,
): Promise<
  | { readonly outcome: "compacted"; readonly usage: RuntimeContextWindowUsage | undefined }
  | { readonly outcome: "not_needed" }
> {
  if ((await session.canCompactRootContext()) === false) return { outcome: "not_needed" };
  try {
    return { outcome: "compacted", usage: await session.compactRootContext() };
  } catch (error) {
    if (!isRuntimeContextCompactionNotNeededError(error)) throw error;
    return { outcome: "not_needed" };
  }
}

interface LiveMissionChat {
  readonly executionId: string;
  readonly entries: MissionChatEntry[];
  readonly messageOrdinals: Map<string, number>;
  close: () => Promise<void>;
  readDurableEntries: (timelineSequence: number) => Promise<readonly MissionChatEntry[]>;
}

type ExecutorNameResolver = (executorId: string) => string | undefined;
type ExecutorAvatarIdResolver = (executorId: string) => string | undefined;

interface ExecutorMetadata {
  readonly names: ReadonlyMap<string, string>;
  readonly avatarIds: ReadonlyMap<string, string>;
}

interface MissionExecutionContext {
  readonly app: ReturnType<typeof createPragma>;
  readonly runtimes: RuntimeResolver;
  readonly setToolPermissionMode: (mode: DesktopToolPermissionMode) => void;
}

export function missionKnowledgeNamespace(storeId: string): string {
  return `mission-knowledge:${storeId}`;
}

const MISSION_CHAT_ERROR_MAX_LENGTH = 10_000;

export function createMissionRunner(options: {
  readonly missions: MissionStore;
  readonly project: PragmaProjectStore;
  readonly capabilityStore: CapabilityStore;
  readonly capabilityCredentials: CapabilityCredentialStore;
  readonly capabilitiesPath: string;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
  readonly pragmaHome: string;
  readonly executionStore?: FileExecutionStore | undefined;
  readonly contextStores?: ContextStoreStore | undefined;
  readonly hostContextStores?:
    readonly ExpertAgentContextStoreRegistrationInput[] | HostContextBindingsResolver | undefined;
  readonly plugins?: PluginStore | undefined;
  readonly runtimes: RuntimeResolver;
  readonly usage?: DesktopUsageStore | undefined;
  readonly loggerProvider?: import("@pragma/core").PragmaLoggerProvider | undefined;
  readonly runtimesForToolPermissionMode?:
    ((mode: DesktopToolPermissionMode) => RuntimeResolver) | undefined;
  readonly automaticHumanInteractionHandler?:
    ExpertAgentAutomaticHumanInteractionHandler | undefined;
  readonly automaticHumanInteractionHandlerForToolPermissionMode?:
    ((mode: DesktopToolPermissionMode) => ExpertAgentAutomaticHumanInteractionHandler) | undefined;
  readonly compileSystemExecutor?:
    | ((input: {
        readonly mission: Mission;
        readonly runtimes: RuntimeResolver;
      }) => Promise<CompiledResource<InvocableResource> | undefined>)
    | undefined;
  readonly getSystemExecutorFingerprint?:
    ((mission: Mission) => string | undefined | Promise<string | undefined>) | undefined;
  readonly assertStorageWriteAllowed?: (() => Promise<void>) | undefined;
  readonly assertExecutorReady?: ((ref: string) => void | Promise<void>) | undefined;
  readonly onStorageTrashed?: (() => void) | undefined;
  readonly onOwnerDeleting?:
    | ((input: {
        readonly mission: Mission;
        readonly executionIds: readonly string[];
      }) => Promise<void>)
    | undefined;
  readonly onExecutionLinked?:
    | ((input: { readonly mission: Mission; readonly executionId: string }) => Promise<void>)
    | undefined;
  readonly onMissionActivity?:
    ((input: { readonly mission: Mission }) => Promise<void>) | undefined;
  readonly onExecutionTerminal?:
    | ((input: { readonly mission: Mission; readonly executionId: string }) => Promise<void>)
    | undefined;
  readonly adapterHostForMission?:
    ((mission: Mission, defaultHost: PragmaAdapterHost) => PragmaAdapterHost) | undefined;
}): MissionRunner {
  const logger = createPragmaLogger(options.loggerProvider, {
    component: "desktop.mission-runner",
  });
  const executionStore =
    options.executionStore ?? createFileExecutionStore({ pragmaHome: options.pragmaHome });
  const notifyExecutionLinked = async (mission: Mission, executionId: string): Promise<void> => {
    try {
      await options.onExecutionLinked?.({ mission, executionId });
    } catch (error) {
      logger.warn(
        "mission.memory_subject_registration_failed",
        "Memory subject context could not be registered; the Mission will continue.",
        { error, missionId: mission.id, executionId },
      );
    }
  };
  const notifyMissionActivity = async (mission: Mission): Promise<void> => {
    try {
      await options.onMissionActivity?.({ mission });
    } catch (error) {
      logger.warn(
        "mission.memory_conversation_activity_failed",
        "Memory conversation activity could not be recorded; the Mission will continue.",
        { error, missionId: mission.id },
      );
    }
  };
  const expertSessionStore = createFileExpertSessionStore({
    executions: executionStore,
    pragmaHome: options.pragmaHome,
  });
  const workHistory = new ExecutionWorkHistoryReader(executionStore);
  const runtimeResolverForToolPermissionMode = (mode: DesktopToolPermissionMode) =>
    options.runtimesForToolPermissionMode?.(mode) ?? options.runtimes;
  const automaticHumanInteractionHandlerForToolPermissionMode = (mode: DesktopToolPermissionMode) =>
    options.automaticHumanInteractionHandlerForToolPermissionMode?.(mode) ??
    options.automaticHumanInteractionHandler;
  const executionContexts = new Map<string, Promise<MissionExecutionContext>>();
  const missionsRequiringSuccessorSession = new Set<string>();
  const executionContext = async (mission: Mission): Promise<MissionExecutionContext> => {
    const existing = executionContexts.get(mission.id);
    if (existing !== undefined) return await existing;
    const creating = createExecutionContext(mission);
    executionContexts.set(mission.id, creating);
    try {
      return await creating;
    } catch (error) {
      if (executionContexts.get(mission.id) === creating) executionContexts.delete(mission.id);
      throw error;
    }
  };
  const createExecutionContext = async (mission: Mission): Promise<MissionExecutionContext> => {
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
    const missionRoot =
      options.missions.storagePath?.(mission.id) ??
      join(new PragmaPaths({ pragmaHome: options.pragmaHome }).missionsRoot(), mission.id);
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
    const missionKnowledgeBindings: readonly ExpertAgentContextStoreRegistrationInput[] =
      await Promise.all(
        mission.contextStoreIds.map(async (storeId) => {
          if (options.contextStores === undefined) {
            throw new Error(`Mission Knowledge Store is unavailable: ${storeId}`);
          }
          const resolved = await options.contextStores.resolve(storeId);
          return {
            namespace: missionKnowledgeNamespace(storeId),
            storeName: resolved.name,
            store: new ReadOnlyContextStore(resolved.store),
            required: true,
            mutationApproval: "none" as const,
          };
        }),
      );
    const resolveConfiguredHostContextBindings = async (): Promise<
      readonly ExpertAgentContextStoreRegistrationInput[]
    > => {
      if (systemMission || options.hostContextStores === undefined) return [];
      return typeof options.hostContextStores === "function"
        ? await options.hostContextStores()
        : options.hostContextStores;
    };
    const resolveHostContextBindings: HostContextBindingsResolver = async () => [
      ...(await resolveConfiguredHostContextBindings()),
      ...legacyExecutionOutputBindings,
      ...board.bindings,
      ...missionKnowledgeBindings,
    ];
    const hostContextBindings = await resolveHostContextBindings();
    const seenNamespaces = new Set<string>();
    for (const binding of hostContextBindings) {
      if (seenNamespaces.has(binding.namespace)) {
        throw new Error(`Mission Context namespace already exists: ${binding.namespace}`);
      }
      seenNamespaces.add(binding.namespace);
    }
    const context = {
      runtimes,
      app: createPragma({
        pragmaHome: options.pragmaHome,
        runtimes,
        executionStore,
        expertSessionStore,
        hostContextBindings,
        resolveHostContextBindings,
        loggerProvider: options.loggerProvider?.withScope({ missionId: mission.id }),
        automaticHumanInteractionHandler: async (request) => {
          if (
            ["system-store-revision", "system-skill-revision", "system-skill-evaluation"].includes(
              mission.origin.type,
            ) &&
            request.kind === "tool_approval"
          ) {
            return { kind: "tool_approval", approved: false, updatedInput: request.input };
          }
          return await automaticHumanInteractionHandlerForToolPermissionMode(toolPermissionMode)?.(
            request,
          );
        },
        usageSink:
          options.usage === undefined
            ? undefined
            : {
                preview: async (observation) => {
                  const currentMission = await options.missions.get(mission.id);
                  const project = await options.project.openRevision(
                    currentMission.project.revision,
                  );
                  const names = new Map(
                    project
                      .listResources()
                      .map((resource) => [resource.metadata.id, resource.metadata.name] as const),
                  );
                  names.set(currentMission.executor.ref, currentMission.executor.name);
                  options.usage!.preview(observation, {
                    mission: { id: currentMission.id, title: currentMission.title },
                    invocations: await executionStore.listInvocations(observation.executionId),
                    names,
                  });
                },
                record: async (observation) => {
                  const currentMission = await options.missions.get(mission.id);
                  const project = await options.project.openRevision(
                    currentMission.project.revision,
                  );
                  const names = new Map(
                    project
                      .listResources()
                      .map((resource) => [resource.metadata.id, resource.metadata.name] as const),
                  );
                  names.set(currentMission.executor.ref, currentMission.executor.name);
                  options.usage!.record(observation, {
                    mission: { id: currentMission.id, title: currentMission.title },
                    invocations: await executionStore.listInvocations(observation.executionId),
                    names,
                  });
                },
                clearPreview: (observationId) => options.usage!.clearPreview(observationId),
              },
      }),
      setToolPermissionMode: (mode: DesktopToolPermissionMode) => {
        toolPermissionMode = mode;
      },
    };
    return context;
  };
  const active = new Map<string, ActiveMissionExecution>();
  const sessions = new Map<string, ExpertSession>();
  const sessionCompilationIdentities = new Map<string, string>();
  const sessionDefinitionFingerprints = new Map<string, string>();
  const memoryContextBindingsChanged = new Set<string>();
  const pendingOperations = new Map<string, PendingMissionOperation>();
  const chatListeners = new Set<(notification: MissionChatNotification) => void>();
  const chatRevisions = new Map<string, number>();
  const degradedChatSync = new Set<string>();
  const liveChats = new Map<string, LiveMissionChat>();
  const liveContextWindows = new Map<string, RuntimeContextWindowUsage>();
  const workListeners = new Set<(notification: MissionWorkNotification) => void>();
  const workRevisions = new Map<string, number>();
  const liveWorkOutputs = new Map<string, Map<string, LiveMissionChat>>();
  const executorMetadataCache = new Map<string, ExecutorMetadata>();

  const refreshMemoryContextBindings = async (): Promise<void> => {
    for (const [missionId, session] of sessions) {
      memoryContextBindingsChanged.add(missionId);
      if (active.has(missionId)) continue;
      try {
        await session.close("Memory policy changed.");
      } catch (error) {
        logger.warn(
          "mission.memory_context_refresh_failed",
          `Mission ${missionId} could not close its previous Expert Session after the Memory policy changed.`,
          { error, missionId },
        );
      } finally {
        sessions.delete(missionId);
        sessionCompilationIdentities.delete(missionId);
        sessionDefinitionFingerprints.delete(missionId);
      }
    }
  };

  const readExecutorMetadata = async (
    mission: Pick<Mission, "project">,
  ): Promise<ExecutorMetadata> => {
    const project = await options.project.openRevision(mission.project.revision);
    const resources = project.listResources();
    const avatarIds = new Map<string, string>();
    for (const resource of resources) {
      if (resource.kind === "Expert") {
        avatarIds.set(resource.metadata.id, resource.metadata.avatarId);
      }
    }
    return {
      names: new Map(
        resources.map((resource) => [resource.metadata.id, resource.metadata.name] as const),
      ),
      avatarIds,
    };
  };

  const getExecutorMetadata = async (
    mission: Pick<Mission, "project">,
  ): Promise<ExecutorMetadata> => {
    const projectKey = `${mission.project.id}:${mission.project.revision}`;
    const existing = executorMetadataCache.get(projectKey);
    if (existing !== undefined) return existing;
    const metadata = await readExecutorMetadata(mission);
    executorMetadataCache.set(projectKey, metadata);
    return metadata;
  };

  const getExecutorMetadataOrFallback = async (
    mission: Mission,
    surface: "live" | "historical" | "work",
  ): Promise<ExecutorMetadata> =>
    await getExecutorMetadata(mission).catch((error: unknown) => {
      logger.warn(
        "mission.executor_names_unavailable",
        `Mission ${mission.id} will use Expert IDs for ${surface} output labels.`,
        { error, missionId: mission.id },
      );
      return { names: new Map<string, string>(), avatarIds: new Map<string, string>() };
    });

  const trackOperation = (id: string, operation: PendingMissionOperation): void => {
    pendingOperations.set(id, operation);
    const clear = () => {
      if (pendingOperations.get(id) === operation) pendingOperations.delete(id);
    };
    void operation.promise.then(clear, clear);
  };

  const emitChatUpdate = (
    id: string,
    audience: MissionSurfaceAudience,
    update:
      | { readonly kind: "patch"; readonly patches: readonly MissionChatPatch[] }
      | { readonly kind: "invalidate" },
  ): void => {
    const revision = (chatRevisions.get(id) ?? 0) + 1;
    chatRevisions.set(id, revision);
    const notification: MissionChatUpdate =
      update.kind === "patch"
        ? { missionId: id, revision, kind: "patch", patches: [...update.patches] }
        : { missionId: id, revision, kind: "invalidate" };
    for (const listener of chatListeners) {
      try {
        listener({ audience, update: notification });
      } catch (error) {
        logger.error(
          "mission.chat_listener_failed",
          `Failed to notify Mission chat listeners for ${id}.`,
          error,
          { missionId: id },
        );
      }
    }
  };

  const emitChatPatches = (
    id: string,
    audience: MissionSurfaceAudience,
    patches: readonly MissionChatPatch[],
  ): void => {
    if (patches.length > 0) emitChatUpdate(id, audience, { kind: "patch", patches });
  };

  const invalidateChat = (id: string, audience: MissionSurfaceAudience): void =>
    emitChatUpdate(id, audience, { kind: "invalidate" });

  const invalidateWork = (id: string, audience: MissionSurfaceAudience): void => {
    const revision = (workRevisions.get(id) ?? 0) + 1;
    workRevisions.set(id, revision);
    const update: MissionWorkUpdate = { missionId: id, revision };
    for (const listener of workListeners) {
      try {
        listener({ audience, update });
      } catch (error) {
        logger.error(
          "mission.work_listener_failed",
          `Failed to notify Mission work listeners for ${id}.`,
          error,
          { missionId: id },
        );
      }
    }
  };

  async function attachNextSessionTurn(
    id: string,
    audience: MissionSurfaceAudience,
  ): Promise<void> {
    const session = sessions.get(id);
    if (session === undefined) return;
    while (true) {
      const [mission, state, queue] = await Promise.all([
        options.missions.get(id),
        session.getState(),
        session.getPromptQueue(),
      ]);
      let nextPrompt = queue.find(
        (prompt) =>
          prompt.mode === "enqueue" &&
          prompt.status === "running" &&
          prompt.executionId === state.activeExecutionId,
      );
      if (nextPrompt === undefined && state.activeExecutionId === undefined) {
        const queuedPrompt = queue.find((prompt) => prompt.status === "queued");
        if (queuedPrompt !== undefined) {
          const queueState = await session.getPromptQueueState();
          if (queueState.state === "paused") break;
        } else {
          const projectedIndex = queue.findIndex(
            (prompt) => prompt.executionId === mission.execution?.id,
          );
          if (projectedIndex >= 0) {
            nextPrompt = queue
              .slice(projectedIndex + 1)
              .find((prompt) => prompt.mode === "enqueue" && isFinalExecutionStatus(prompt.status));
          }
        }
      }
      if (nextPrompt !== undefined) {
        const turn = (await session.listTurns()).find(
          (candidate) => candidate.executionId === nextPrompt.executionId,
        );
        if (turn !== undefined) {
          const startedAt =
            nextPrompt.status === "running" ? nextPrompt.updatedAt : nextPrompt.createdAt;
          await options.missions.updateExecution(id, {
            id: turn.executionId,
            inputMessageId: nextPrompt.requestId,
            sessionId: session.sessionId,
            status: "running",
            startedAt,
          });
          trackExecution({
            mission,
            handle: turn,
            executorMetadata: await getExecutorMetadataOrFallback(mission, "live"),
            startedAt,
            inputMessageId: nextPrompt.requestId,
            sessionId: session.sessionId,
            onFinished: async () =>
              await waitForExpertTurnSettlement(session, nextPrompt.requestId),
          });
        }
        break;
      }
      if (!queue.some((prompt) => prompt.status === "queued")) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    invalidateChat(id, audience);
  }

  const forgetActive = async (
    id: string,
    executionId: string,
    audience: MissionSurfaceAudience,
  ): Promise<void> => {
    if (active.get(id)?.handle.executionId === executionId) active.delete(id);
    const live = liveChats.get(id);
    if (live?.executionId === executionId) {
      await live.close();
      liveChats.delete(id);
    }
    liveWorkOutputs.delete(id);
    liveContextWindows.delete(id);
    invalidateChat(id, audience);
    invalidateWork(id, audience);
    await attachNextSessionTurn(id, audience);
  };

  const compileMissionExecutor = async (
    mission: Mission,
    runtimes: RuntimeResolver,
  ): Promise<CompiledResource<InvocableResource>> => {
    const system = await options.compileSystemExecutor?.({ mission, runtimes });
    if (system !== undefined) return system;
    const compiled = await options.project.compile<InvocableResource>({
      projectId: mission.project.id,
      revision: mission.project.revision,
      ref: mission.executor.ref,
      workspace: mission.workspace.path,
      pragmaHome: options.pragmaHome,
      environmentId: "desktop",
      adapterHost:
        options.adapterHostForMission?.(
          mission,
          createDesktopAdapterHost(options, mission.workspace.path),
        ) ?? createDesktopAdapterHost(options, mission.workspace.path),
      runtimes,
      resolveExternalInvocable: async (ref) => {
        const compiled = await options.compileSystemExecutor?.({
          mission: {
            ...mission,
            executor: { kind: "expert", ref, name: ref },
          },
          runtimes,
        });
        return compiled?.value;
      },
      ...(mission.modelOverride === undefined
        ? {}
        : {
            rootModelSelectionOverride: toRuntimeModelSelection(mission.modelOverride),
          }),
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
    return compiled;
  };

  const compilationIdentity = async (mission: Mission): Promise<string> =>
    createHash("sha256")
      .update(
        JSON.stringify({
          project: mission.project,
          executor: mission.executor,
          systemExecutorFingerprint:
            (await options.getSystemExecutorFingerprint?.(mission)) ?? null,
          toolPermissionMode: mission.toolPermissionMode,
          modelOverride: mission.modelOverride ?? null,
        }),
      )
      .digest("hex");

  const rememberSessionCompilation = (
    missionId: string,
    identity: string,
    compiled: CompiledResource<InvocableResource>,
  ): void => {
    if ("kind" in compiled.value && compiled.value.kind === "flow") return;
    sessionCompilationIdentities.set(missionId, identity);
    sessionDefinitionFingerprints.set(
      missionId,
      fingerprintExpertExecutionDefinition(compiled.value),
    );
  };

  const readMissionRootContext = async (
    mission: Mission,
  ): Promise<RuntimeContextRecord | undefined> => {
    const sessionId = mission.execution?.sessionId;
    if (sessionId === undefined) return undefined;
    const record = await expertSessionStore.get(sessionId);
    return record?.contexts[record.rootContextId];
  };

  const createMissionExpertSession = async (
    compiled: CompiledResource<InvocableResource>,
    app: ReturnType<typeof createPragma>,
    input: {
      readonly modelSelection?: RuntimeModelSelection | undefined;
    } = {},
  ): Promise<ExpertSession> => {
    if ("kind" in compiled.value && compiled.value.kind === "flow") {
      throw new Error("Flow missions do not use ExpertSession.");
    }
    return await app.experts.createSession(compiled.value, {
      runtime: compiled.rootRuntimeId,
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
    });
  };

  const resumeMissionSession = async (
    mission: Mission,
    compiled: CompiledResource<InvocableResource>,
    app: ReturnType<typeof createPragma>,
    sessionId: string,
  ): Promise<ExpertSession> => {
    if ("kind" in compiled.value && compiled.value.kind === "flow") {
      throw new Error("Flow missions do not use ExpertSession.");
    }
    const record = await expertSessionStore.get(sessionId);
    const identityIndex = createPragmaResourceIdentityMigrationIndex({
      projectId: mission.project.id,
      migrations: await options.project.readIdentityMigrations(),
    });
    const request = createMissionResumeOptions({
      mission,
      compiled,
      sessionId,
      record,
      identityIndex,
    });
    return await app.experts.resumeSession(compiled.value, request);
  };

  const interruptSupersededMissionSession = async (mission: Mission): Promise<void> => {
    if (
      mission.execution?.sessionId === undefined ||
      !["queued", "running", "waiting"].includes(mission.execution.status)
    ) {
      return;
    }
    const now = new Date().toISOString();
    const execution = await executionStore.get(mission.execution.id);
    if (execution !== undefined && !isFinalExecutionStatus(execution.status)) {
      const invocations = await executionStore.listInvocations(execution.executionId);
      await executionStore.commit({
        commitId: randomUUID(),
        executionId: execution.executionId,
        executionPatch: { status: "interrupted" },
        invocationPatches: invocations
          .filter((invocation) => !isFinalExecutionStatus(invocation.status))
          .map((invocation) => ({
            invocationId: invocation.invocationId,
            patch: { status: "interrupted", updatedAt: now },
          })),
      });
    }
    await expertSessionStore.transact(mission.execution.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: {
        ...session,
        activeExecutionId:
          session.activeExecutionId === mission.execution!.id
            ? undefined
            : session.activeExecutionId,
        lastStatus: "interrupted",
        queuedRequestIds: session.queuedRequestIds.filter(
          (requestId) =>
            !prompts.some(
              (prompt) =>
                prompt.requestId === requestId && prompt.executionId === mission.execution!.id,
            ),
        ),
        updatedAt: now,
      },
      prompts: prompts.map((prompt) =>
        prompt.executionId === mission.execution!.id &&
        (prompt.status === "queued" || prompt.status === "running")
          ? { ...prompt, status: "interrupted" as const, updatedAt: now }
          : prompt,
      ),
    }));
  };

  const openMissionExpertSession = async (input: {
    readonly mission: Mission;
    readonly compiled: CompiledResource<InvocableResource>;
    readonly app: ReturnType<typeof createPragma>;
    readonly sessionId?: string | undefined;
    readonly modelSelection?: RuntimeModelSelection | undefined;
    readonly createSuccessorOnMismatch: boolean;
  }): Promise<ExpertSession> => {
    if (input.sessionId === undefined) {
      return await createMissionExpertSession(input.compiled, input.app, {
        modelSelection: input.modelSelection,
      });
    }
    try {
      return await resumeMissionSession(input.mission, input.compiled, input.app, input.sessionId);
    } catch (error) {
      if (!input.createSuccessorOnMismatch || !shouldCreateSuccessorExpertSession(error)) {
        throw error;
      }
      const successor = await createMissionExpertSession(input.compiled, input.app, {
        modelSelection: input.modelSelection,
      });
      await interruptSupersededMissionSession(input.mission);
      logger.warn(
        "mission.session_successor_created",
        `Created a successor ExpertSession for Mission ${input.mission.id} after an incompatible definition upgrade.`,
        { error, sessionId: successor.sessionId },
      );
      return successor;
    }
  };

  const trackExecution = (input: {
    readonly mission: Mission;
    readonly handle: MutableExecution & { readonly result: Promise<unknown> };
    readonly startedAt: string;
    readonly inputMessageId: string;
    readonly sessionId?: string | undefined;
    readonly executorMetadata: ExecutorMetadata;
    readonly acceptedAt?: number | undefined;
    readonly onFinished?: (() => void | Promise<void>) | undefined;
  }): void => {
    const missionId = input.mission.id;
    const audience = missionSurfaceAudience(input.mission);
    const resolveExecutorName = createMissionExecutorNameResolver(
      input.mission,
      input.executorMetadata.names,
    );
    const resolveExecutorAvatarId = createMissionExecutorAvatarIdResolver(
      input.executorMetadata.avatarIds,
    );
    let firstProjectionLogged = false;
    const humanWaitingObserver = observeMissionHumanWaitingStatus({
      missions: options.missions,
      missionId,
      execution: input.handle,
      startedAt: input.startedAt,
      inputMessageId: input.inputMessageId,
      sessionId: input.sessionId,
      logger,
    });
    const live = observeMissionChat(
      input.handle,
      (patches) => {
        emitChatPatches(missionId, audience, patches);
        if (
          !firstProjectionLogged &&
          input.acceptedAt !== undefined &&
          patches.some(isVisibleTextProjectionPatch)
        ) {
          firstProjectionLogged = true;
          logger.info(
            "mission.first_ui_projection",
            "Mission emitted its first UI-visible text projection",
            {
              missionId,
              executionId: input.handle.executionId,
              elapsedMs: elapsedMissionMs(input.acceptedAt),
            },
          );
        }
      },
      () => invalidateChat(missionId, audience),
      humanWaitingObserver.onEvent,
      humanWaitingObserver.resync,
      (channel, error) => {
        logger.warn(
          "mission.chat_subscription_failed",
          `Mission ${channel} subscription failed and will retry.`,
          { error, missionId, executionId: input.handle.executionId, channel },
        );
      },
      (item) => {
        if (item.channel === "telemetry" && item.parentInvocationId === undefined) {
          const payload = asRecord(item.value);
          if (readString(payload, "type") === "context-window.updated") {
            const usage = RuntimeContextWindowUsageSchema.safeParse(payload["usage"]);
            if (usage.success) {
              liveContextWindows.set(missionId, usage.data);
              emitChatPatches(missionId, audience, [
                { type: "context-window.update", usage: usage.data },
              ]);
            }
          }
        }
        const sessionId = item.source.sessionId;
        if (item.source.parentSessionId !== undefined && sessionId !== undefined) {
          const recordId = `runtime-agent:${sessionId}`;
          const byRecord = liveWorkOutputs.get(missionId) ?? new Map();
          const isNewRecord = !byRecord.has(recordId);
          const output =
            byRecord.get(recordId) ??
            ({
              executionId: item.executionId,
              entries: [],
              messageOrdinals: new Map(),
              close: async () => undefined,
              readDurableEntries: async () => [],
            } satisfies LiveMissionChat);
          byRecord.set(recordId, output);
          liveWorkOutputs.set(missionId, byRecord);
          if (item.channel !== "agent" && item.channel !== "progress") {
            consumeLiveChatOutput(output, item, {
              includeNestedSource: true,
              resolveExecutorName,
              resolveExecutorAvatarId,
            });
          }
          if (isNewRecord || item.channel === "agent") {
            invalidateWork(missionId, audience);
          }
        } else if (item.channel === "agent") {
          invalidateWork(missionId, audience);
        }
      },
      resolveExecutorName,
      resolveExecutorAvatarId,
    );
    liveChats.set(missionId, live);
    const settlement = observeExecution(
      options.missions,
      missionId,
      input.handle,
      input.startedAt,
      input.inputMessageId,
      async () => {
        await humanWaitingObserver.drain();
        await input.onFinished?.();
      },
      input.sessionId,
      logger,
      async () => {
        await persistMissionExecutionProjection(
          options.missions,
          executionStore,
          missionId,
          input.handle.executionId,
        );
        await options.onExecutionTerminal?.({
          mission: await options.missions.get(missionId),
          executionId: input.handle.executionId,
        });
      },
    )
      .then(() => {
        if (input.acceptedAt !== undefined) {
          logger.info("mission.final_result", "Mission execution reached a final result", {
            missionId,
            executionId: input.handle.executionId,
            elapsedMs: elapsedMissionMs(input.acceptedAt),
          });
        }
      })
      .finally(async () => await forgetActive(missionId, input.handle.executionId, audience));
    active.set(missionId, { handle: input.handle, settlement, audience });
    invalidateChat(missionId, audience);
    invalidateWork(missionId, audience);
    void settlement.catch((error: unknown) => {
      logger.error(
        "mission.execution_observer_failed",
        `Failed to observe Mission execution ${input.handle.executionId}.`,
        error,
        { missionId, executionId: input.handle.executionId },
      );
    });
  };

  const runMission = async (id: string): Promise<Mission> => {
    const acceptedAt = performance.now();
    logger.info("mission.message_accepted", "Mission request accepted", {
      missionId: id,
      kind: "initial",
    });
    const capacityCheckStartedAt = performance.now();
    await (options.assertStorageWriteAllowed?.() ??
      assertStorageWriteAllowed(new PragmaPaths({ pragmaHome: options.pragmaHome })));
    logMissionPhase(logger, id, "storage_capacity_check", capacityCheckStartedAt, acceptedAt);
    const mission = await options.missions.get(id);
    await options.assertExecutorReady?.(mission.executor.ref);
    if (active.has(mission.id)) return mission;
    if (mission.lifecycleStatus === "active") await notifyMissionActivity(mission);
    const { app, runtimes: baseRuntimes } = await executionContext(mission);
    const runtimes = withMissionRuntimeBinding(baseRuntimes, await readMissionRootContext(mission));
    let phaseStartedAt = performance.now();
    const compiled = await compileMissionExecutor(mission, runtimes);
    const compiledIdentity = await compilationIdentity(mission);
    logMissionPhase(logger, mission.id, "default_agent_compile", phaseStartedAt, acceptedAt);
    const executorMetadata = await getExecutorMetadataOrFallback(mission, "live");
    const modelSelection = toRuntimeModelSelection(mission.modelOverride);
    if (mission.modelOverride !== undefined && compiled !== undefined) {
      phaseStartedAt = performance.now();
      await runtimes.bind({
        runtimeId: requireRootRuntimeId(compiled),
        modelSelection,
      });
      logMissionPhase(
        logger,
        mission.id,
        "runtime_bind_model_validation",
        phaseStartedAt,
        acceptedAt,
      );
    }
    const startedAt = new Date().toISOString();

    if ("kind" in compiled.value && compiled.value.kind === "flow") {
      const runtime = compiled.rootRuntimeId;
      const recoverable =
        mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status);
      const inputMessageId = recoverable
        ? mission.execution!.inputMessageId
        : mission.execution === undefined
          ? mission.initialMessageId
          : randomUUID();
      if (!recoverable && mission.execution !== undefined) {
        await options.missions.appendUserMessage(mission.id, {
          id: inputMessageId,
          content: mission.goal,
          createdAt: startedAt,
        });
      }
      const executionStartedAt = recoverable ? mission.execution!.startedAt : startedAt;
      if (recoverable) {
        // Verify the durable Mission link before recover() starts the Flow again. Recovery keeps the
        // same Execution id, so the original timestamp makes this append idempotent.
        await options.missions.appendExecutionReference({
          missionId: mission.id,
          inputMessageId,
          executionId: mission.execution!.id,
          createdAt: executionStartedAt,
        });
        await notifyExecutionLinked(mission, mission.execution!.id);
      }
      const handle = recoverable
        ? await app.flows.recover(compiled.value, {
            executionId: mission.execution!.id,
            runtime,
          })
        : await app.flows.start(compiled.value, {
            input: mission.flowInput!,
            runtime,
          });
      if (!recoverable) {
        await options.missions.appendExecutionReference({
          missionId: mission.id,
          inputMessageId,
          executionId: handle.executionId,
          createdAt: executionStartedAt,
        });
        await notifyExecutionLinked(mission, handle.executionId);
      }
      const recoveredWaiting = recoverable && (await hasPendingHumanInteraction(handle));
      const running = await options.missions.updateExecution(mission.id, {
        id: handle.executionId,
        inputMessageId,
        status: recoveredWaiting ? "waiting" : "running",
        startedAt: executionStartedAt,
      });
      trackExecution({
        mission,
        handle,
        executorMetadata,
        startedAt: executionStartedAt,
        inputMessageId,
        acceptedAt,
      });
      return running;
    }

    const recoverable =
      mission.execution !== undefined &&
      mission.execution.sessionId !== undefined &&
      ["queued", "running", "waiting"].includes(mission.execution.status);
    phaseStartedAt = performance.now();
    const memoryBindingsChanged = memoryContextBindingsChanged.delete(mission.id);
    let session = sessions.get(mission.id);
    if (memoryBindingsChanged && session !== undefined) {
      await session.close("Memory policy changed.");
      sessions.delete(mission.id);
      sessionCompilationIdentities.delete(mission.id);
      sessionDefinitionFingerprints.delete(mission.id);
      session = undefined;
    }
    if (session === undefined) {
      session = memoryBindingsChanged
        ? await createMissionExpertSession(compiled, app, { modelSelection })
        : await openMissionExpertSession({
            mission,
            compiled,
            app,
            sessionId: recoverable ? mission.execution!.sessionId : undefined,
            modelSelection,
            createSuccessorOnMismatch: true,
          });
    }
    if (memoryBindingsChanged) {
      await interruptSupersededMissionSession(mission);
    }
    logMissionPhase(logger, mission.id, "expert_session_open", phaseStartedAt, acceptedAt, {
      cacheHit: sessions.has(mission.id),
    });
    sessions.set(mission.id, session);
    rememberSessionCompilation(mission.id, compiledIdentity, compiled);
    const recoveredPrompt = recoverable
      ? (await session.getPromptQueue()).find(
          (prompt) =>
            prompt.executionId === mission.execution!.id &&
            prompt.mode === "enqueue" &&
            prompt.status === "queued",
        )
      : undefined;
    const recoveredTurn =
      recoveredPrompt === undefined
        ? undefined
        : (await session.listTurns()).find(
            (candidate) => candidate.executionId === mission.execution!.id,
          );
    if (recoveredPrompt !== undefined && recoveredTurn === undefined) {
      throw new Error(`Recoverable Expert turn not found: ${mission.execution!.id}`);
    }
    const inputMessageId = recoverable
      ? mission.execution!.inputMessageId
      : mission.initialMessageId;
    const promptAttachments = recoverable ? [] : await options.missions.getAttachments(mission.id);
    phaseStartedAt = performance.now();
    const turn =
      recoveredTurn ??
      (await session.prompt(
        recoverable
          ? [
              "[Pragma mission recovery]",
              "The previous Desktop process ended before this mission finished.",
              "Continue the pinned mission from the restored ExpertSession context.",
              `Mission goal: ${mission.goal}`,
            ].join("\n")
          : mission.goal,
        {
          requestId: recoverable ? randomUUID() : inputMessageId,
          ...(promptAttachments.length === 0 ? {} : { attachments: promptAttachments }),
        },
      ));
    logMissionPhase(logger, mission.id, "expert_session_prompt", phaseStartedAt, acceptedAt);
    const executionStartedAt =
      recoveredTurn === undefined ? startedAt : mission.execution!.startedAt;
    await options.missions.appendExecutionReference({
      missionId: mission.id,
      inputMessageId,
      executionId: turn.executionId,
      createdAt: executionStartedAt,
    });
    await notifyExecutionLinked(mission, turn.executionId);
    const running = await options.missions.updateExecution(mission.id, {
      id: turn.executionId,
      inputMessageId,
      sessionId: session.sessionId,
      status: recoveredTurn === undefined ? "running" : "waiting",
      startedAt: executionStartedAt,
    });
    trackExecution({
      mission,
      handle: turn,
      executorMetadata,
      startedAt: executionStartedAt,
      inputMessageId,
      sessionId: session.sessionId,
      acceptedAt,
      onFinished: async () => await waitForExpertTurnSettlement(session, turn.requestId),
    });
    return running;
  };

  const sendMissionMessage = async (input: {
    readonly id: string;
    readonly content: string;
    readonly requestId: string;
    readonly attachments?: readonly ExpertPromptAttachment[] | undefined;
    readonly mode?: "enqueue" | "steer" | undefined;
  }): Promise<MissionMessageAcceptance> => {
    const acceptedAt = performance.now();
    logger.info("mission.message_accepted", "Mission request accepted", {
      missionId: input.id,
      requestId: input.requestId,
      kind: "followup",
    });
    const capacityCheckStartedAt = performance.now();
    await (options.assertStorageWriteAllowed?.() ??
      assertStorageWriteAllowed(new PragmaPaths({ pragmaHome: options.pragmaHome })));
    logMissionPhase(logger, input.id, "storage_capacity_check", capacityCheckStartedAt, acceptedAt);
    const mission = await options.missions.get(input.id);
    await options.assertExecutorReady?.(mission.executor.ref);
    if (mission.executor.kind === "flow") {
      throw new Error("Flow missions accept input through workflow steps, not chat messages.");
    }
    if (mission.lifecycleStatus !== "active") {
      throw new Error("Reopen this mission before sending another message.");
    }
    await notifyMissionActivity(mission);
    const { app, runtimes: baseRuntimes } = await executionContext(mission);
    const rootContext = await readMissionRootContext(mission);
    const runtimes = withMissionRuntimeBinding(baseRuntimes, rootContext);
    const desiredCompilationIdentity = await compilationIdentity(mission);
    let session = sessions.get(mission.id);
    let compiled: CompiledResource<InvocableResource> | undefined;
    let phaseStartedAt = performance.now();
    const compilationCacheHit =
      session !== undefined &&
      sessionCompilationIdentities.get(mission.id) === desiredCompilationIdentity;
    if (!compilationCacheHit) {
      compiled = await compileMissionExecutor(mission, runtimes);
    }
    logMissionPhase(logger, mission.id, "default_agent_compile", phaseStartedAt, acceptedAt, {
      cacheHit: compilationCacheHit,
    });
    const modelSelection = toRuntimeModelSelection(mission.modelOverride);
    if (mission.modelOverride !== undefined && compiled !== undefined) {
      phaseStartedAt = performance.now();
      await runtimes.bind({
        runtimeId: requireRootRuntimeId(compiled),
        modelSelection,
      });
      logMissionPhase(
        logger,
        mission.id,
        "runtime_bind_model_validation",
        phaseStartedAt,
        acceptedAt,
      );
    }
    let compiledExpert: ExpertDefinition | undefined;
    if (compiled !== undefined) {
      if ("kind" in compiled.value && compiled.value.kind === "flow") {
        throw new Error("Flow missions cannot receive chat messages.");
      }
      compiledExpert = compiled.value;
    }
    const executorMetadata = await getExecutorMetadataOrFallback(mission, "live");
    const rootExpert =
      compiledExpert === undefined
        ? undefined
        : isExpertTeam(compiledExpert)
          ? compiledExpert.coordinator
          : compiledExpert;
    const desiredModelSelection =
      mission.execution?.sessionId === undefined
        ? (modelSelection ?? rootExpert?.models?.default)
        : modelSelection;
    const promptModelSelection = matchesBoundModel(
      desiredModelSelection,
      rootContext?.modelSelection,
    )
      ? undefined
      : desiredModelSelection;
    let definitionChanged = false;
    const memoryBindingsChanged = memoryContextBindingsChanged.has(mission.id);
    const contextStoresChanged =
      missionsRequiringSuccessorSession.delete(mission.id) ||
      (memoryBindingsChanged && !active.has(mission.id));
    if (memoryBindingsChanged && !active.has(mission.id)) {
      memoryContextBindingsChanged.delete(mission.id);
    }
    if (compiledExpert !== undefined && session !== undefined) {
      const nextDefinitionFingerprint = fingerprintExpertExecutionDefinition(compiledExpert);
      const previousDefinitionFingerprint = sessionDefinitionFingerprints.get(mission.id);
      if (
        previousDefinitionFingerprint !== undefined &&
        previousDefinitionFingerprint !== nextDefinitionFingerprint
      ) {
        await session.close("Mission executor definition changed.");
        sessions.delete(mission.id);
        sessionCompilationIdentities.delete(mission.id);
        sessionDefinitionFingerprints.delete(mission.id);
        session = undefined;
        definitionChanged = true;
      }
    }
    if (contextStoresChanged && session !== undefined && !active.has(mission.id)) {
      await session.close("Mission context bindings changed.");
      sessions.delete(mission.id);
      sessionCompilationIdentities.delete(mission.id);
      sessionDefinitionFingerprints.delete(mission.id);
      session = undefined;
    }
    const sessionCacheHit = session !== undefined;
    phaseStartedAt = performance.now();
    if (session === undefined) {
      if (compiled === undefined) {
        throw new Error("Mission Session cache was unavailable without a compiled executor.");
      }
      if (definitionChanged || contextStoresChanged) {
        session = await createMissionExpertSession(compiled, app, { modelSelection });
        await interruptSupersededMissionSession(mission);
        logger.warn(
          "mission.session_successor_created",
          `Created a successor ExpertSession for Mission ${mission.id} after its execution context changed.`,
          {
            reason: definitionChanged ? "executor_definition_changed" : "context_stores_changed",
            sessionId: session.sessionId,
          },
        );
      } else {
        session = await openMissionExpertSession({
          mission,
          compiled,
          app,
          sessionId: mission.execution?.sessionId,
          modelSelection,
          createSuccessorOnMismatch: true,
        });
      }
    }
    logMissionPhase(logger, mission.id, "expert_session_open", phaseStartedAt, acceptedAt, {
      cacheHit: sessionCacheHit,
    });
    sessions.set(mission.id, session);
    if (compiled !== undefined) {
      rememberSessionCompilation(mission.id, desiredCompilationIdentity, compiled);
    }
    const userMessage = await options.missions.appendUserMessage(mission.id, {
      id: input.requestId,
      content: input.content,
      ...((input.attachments?.length ?? 0) === 0
        ? {}
        : { attachments: [...(input.attachments ?? [])] }),
      createdAt: new Date().toISOString(),
    });
    if (userMessage.kind !== "user") {
      throw new Error("Mission user message persistence returned an invalid timeline record.");
    }
    const promptAttachments = userMessage.attachments ?? [];
    phaseStartedAt = performance.now();
    const requestedMode = input.mode ?? "enqueue";
    const turn = await session.prompt(input.content, {
      requestId: input.requestId,
      mode: requestedMode,
      ...(requestedMode === "steer" ? { steerFallback: "enqueue" as const } : {}),
      ...(promptAttachments.length === 0 ? {} : { attachments: promptAttachments }),
      ...(promptModelSelection === undefined ? {} : { modelSelection: promptModelSelection }),
    });
    logMissionPhase(logger, mission.id, "expert_session_prompt", phaseStartedAt, acceptedAt);
    const startedAt = new Date().toISOString();
    await options.missions.appendExecutionReference({
      missionId: mission.id,
      inputMessageId: input.requestId,
      executionId: turn.executionId,
      createdAt: startedAt,
    });
    await notifyExecutionLinked(mission, turn.executionId);
    if (turn.effectiveMode === "steer") {
      invalidateChat(mission.id, missionSurfaceAudience(mission));
      return {
        mission: await options.missions.get(mission.id),
        requestId: input.requestId,
        requestedMode,
        effectiveMode: "steer",
      };
    }
    const hasCurrent = active.has(mission.id);
    const queuePaused = (await session.getPromptQueueState()).state === "paused";
    const running =
      hasCurrent || queuePaused
        ? await options.missions.get(mission.id)
        : await options.missions.updateExecution(mission.id, {
            id: turn.executionId,
            inputMessageId: input.requestId,
            sessionId: session.sessionId,
            status: "running",
            startedAt,
          });
    if (!hasCurrent && !queuePaused) {
      trackExecution({
        mission,
        handle: turn,
        executorMetadata,
        startedAt,
        inputMessageId: input.requestId,
        sessionId: session.sessionId,
        acceptedAt,
        onFinished: async () => await waitForExpertTurnSettlement(session, turn.requestId),
      });
    }
    invalidateChat(mission.id, missionSurfaceAudience(mission));
    return {
      mission: running,
      requestId: input.requestId,
      requestedMode,
      effectiveMode: turn.effectiveMode,
      ...(turn.fallbackReason === undefined ? {} : { fallbackReason: turn.fallbackReason }),
    };
  };

  const updateMissionOptions = async (input: UpdateMissionOptions): Promise<Mission> => {
    const mission = await options.missions.get(input.id);
    if (
      active.has(mission.id) ||
      (mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status))
    ) {
      throw new Error("Wait for the current execution before changing mission options.");
    }
    if (mission.executor.kind === "flow" && input.modelOverride !== null) {
      throw new Error("Flow missions do not support a model override.");
    }
    const prospective = { ...mission, toolPermissionMode: input.toolPermissionMode };
    if (input.modelOverride === null) delete prospective.modelOverride;
    else prospective.modelOverride = input.modelOverride;
    const baseRuntimes = runtimeResolverForToolPermissionMode(input.toolPermissionMode);
    const runtimes = withMissionRuntimeBinding(baseRuntimes, await readMissionRootContext(mission));
    const compiled = await compileMissionExecutor(prospective, runtimes);
    if (input.toolPermissionMode !== mission.toolPermissionMode) {
      await sessions.get(mission.id)?.refreshRuntimeSessions();
    }
    const updated = await options.missions.updateOptions(mission.id, {
      toolPermissionMode: input.toolPermissionMode,
      ...(prospective.modelOverride === undefined
        ? {}
        : { modelOverride: prospective.modelOverride }),
    });
    (await executionContexts.get(mission.id))?.setToolPermissionMode(input.toolPermissionMode);
    if (sessions.has(mission.id)) {
      rememberSessionCompilation(mission.id, await compilationIdentity(updated), compiled);
    }
    return updated;
  };

  const updateMissionContextStores = async (
    input: UpdateMissionContextStores,
  ): Promise<Mission> => {
    const mission = await options.missions.get(input.id);
    if (
      active.has(mission.id) ||
      (mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status))
    ) {
      throw new Error("Wait for the current execution before changing Mission Knowledge Stores.");
    }
    if (input.contextStoreIds.length > 0 && options.contextStores === undefined) {
      throw new Error("Mission Knowledge Stores are unavailable.");
    }
    await Promise.all(
      input.contextStoreIds.map(async (storeId) => await options.contextStores!.resolve(storeId)),
    );
    const sessionId = sessions.get(mission.id)?.sessionId ?? mission.execution?.sessionId;
    if (sessionId !== undefined) {
      const pendingPrompts = (await expertSessionStore.listPrompts(sessionId)).filter(
        (prompt) =>
          prompt.mode === "enqueue" && (prompt.status === "queued" || prompt.status === "running"),
      );
      if (pendingPrompts.length > 0) {
        throw new Error(
          "Remove or finish queued Mission messages before changing Mission Knowledge Stores.",
        );
      }
    }
    const updated = await options.missions.updateContextStores(mission.id, input.contextStoreIds);
    const session = sessions.get(mission.id);
    if (session !== undefined) {
      await session.close("Mission Knowledge Stores changed.");
      sessions.delete(mission.id);
      missionsRequiringSuccessorSession.add(mission.id);
    }
    sessionCompilationIdentities.delete(mission.id);
    sessionDefinitionFingerprints.delete(mission.id);
    executionContexts.delete(mission.id);
    return updated;
  };

  const deleteMission = async (id: string): Promise<void> => {
    if (active.has(id)) {
      throw new Error("Stop the active execution before deleting this mission.");
    }
    const mission = await options.missions.get(id);
    try {
      await reconcileMissionUsage(mission);
    } catch (error) {
      logger.warn(
        "mission.delete_usage_reconciliation_failed",
        `Usage reconciliation failed before deleting Mission ${mission.id}; deletion will continue.`,
        { error, missionId: mission.id },
      );
    }
    const executionIds = await collectMissionExecutionIds(options.missions, id);
    const sessionId = mission.execution?.sessionId;
    const session = sessions.get(id);
    if (session !== undefined) {
      await session.close("Mission deleted.");
      sessions.delete(id);
      sessionCompilationIdentities.delete(id);
      sessionDefinitionFingerprints.delete(id);
    }
    await options.onOwnerDeleting?.({ mission, executionIds: [...executionIds] });
    const paths = new PragmaPaths({ pragmaHome: options.pragmaHome });
    const sources = [
      ...[...executionIds].map((executionId) => ({
        label: `executions/${executionId}`,
        path: paths.executionRoot(executionId),
      })),
      ...[...executionIds].map((executionId) => ({
        label: `execution-archives/${executionId}.jsonl.gz`,
        path: paths.executionArchive(executionId),
      })),
      ...[...executionIds].map((executionId) => ({
        label: `memory-execution-activity/${executionId}`,
        path: paths.memoryExecutionActivityRoot(executionId),
      })),
      ...(sessionId === undefined
        ? []
        : [
            { label: `expert-sessions/${sessionId}`, path: paths.expertSessionRoot(sessionId) },
            ...(await runtimeSessionDeletionSources(paths, sessionId)),
          ]),
      ...(
        await Promise.all(
          [...executionIds].map(
            async (executionId) => await runtimeSessionDeletionSources(paths, executionId),
          ),
        )
      ).flat(),
      ...(options.missions.storagePath === undefined
        ? []
        : [{ label: "mission", path: options.missions.storagePath(id) }]),
    ];
    const uniqueSources = [
      ...new Map(sources.map((source) => [source.path, source] as const)).values(),
    ];
    await moveOwnedStorageToTrash({
      paths,
      owner: { type: "mission", id },
      sources: uniqueSources,
    });
    if (options.missions.storagePath === undefined) await options.missions.remove(id);
    else options.missions.forget?.(id);
    options.usage?.markSubjectDeleted("mission", id);
    executionContexts.delete(id);
    options.onStorageTrashed?.();
  };

  const getContextWindowState = async (
    mission: Mission,
    usageOverride?: RuntimeContextWindowUsage | undefined,
  ): Promise<MissionContextWindowState | undefined> => {
    if (mission.executor.kind === "flow") return undefined;
    const rootContext = await readMissionRootContext(mission);
    if (rootContext === undefined) return undefined;
    const { runtimes } = await executionContext(mission);
    const resolved = await runtimes
      .resolve({
        binding: rootContext.runtime,
        modelSelection: rootContext.modelSelection,
      })
      .catch(() => undefined);
    if (resolved === undefined) return undefined;
    const supportsInspection =
      resolved.adapter.descriptor.capabilities?.supportsContextWindowInspection === true;
    const supportsCompaction =
      resolved.adapter.descriptor.capabilities?.supportsManualCompaction === true;
    if (!supportsInspection && !supportsCompaction) return undefined;
    const executionBusy =
      active.has(mission.id) ||
      (mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status));
    let usage = usageOverride ?? liveContextWindows.get(mission.id);
    if (usage === undefined && rootContext.snapshot !== undefined) {
      if (!executionBusy) {
        usage = await sessions
          .get(mission.id)
          ?.getRootContextWindowUsage()
          .catch(() => undefined);
      }
      const sessionId = mission.execution?.sessionId;
      if (usage === undefined && sessionId !== undefined) {
        const paths = new PragmaPaths({ pragmaHome: options.pragmaHome });
        usage = await readRuntimeSessionRecord(
          paths,
          sessionId,
          rootContext.snapshot.systemSessionId,
        )
          .then(readRuntimeSessionContextWindowUsage)
          .catch(() => undefined);
      }
    }
    const runtimeCanCompact =
      supportsCompaction &&
      rootContext.snapshot !== undefined &&
      mission.lifecycleStatus === "active" &&
      !executionBusy
        ? await sessions
            .get(mission.id)
            ?.canCompactRootContext()
            .catch(() => undefined)
        : undefined;
    const canCompact =
      supportsCompaction &&
      rootContext.snapshot !== undefined &&
      mission.lifecycleStatus === "active" &&
      !executionBusy &&
      runtimeCanCompact !== false;
    const compactionBlockedReason =
      !supportsCompaction || canCompact
        ? undefined
        : rootContext.snapshot === undefined
          ? ("not_started" as const)
          : mission.lifecycleStatus !== "active"
            ? ("inactive" as const)
            : executionBusy
              ? ("busy" as const)
              : runtimeCanCompact === false
                ? ("not_ready" as const)
                : undefined;
    return {
      supportsInspection,
      supportsCompaction,
      canCompact,
      ...(compactionBlockedReason === undefined ? {} : { compactionBlockedReason }),
      ...(usage === undefined ? {} : { usage }),
    };
  };

  const compactMissionContext = async (id: string): Promise<MissionContextCompactionResult> => {
    await (options.assertStorageWriteAllowed?.() ??
      assertStorageWriteAllowed(new PragmaPaths({ pragmaHome: options.pragmaHome })));
    const mission = await options.missions.get(id);
    if (mission.executor.kind === "flow") {
      throw new Error("Flow missions do not expose a chat context to compact.");
    }
    if (mission.lifecycleStatus !== "active") {
      throw new Error("Reopen this mission before compacting its context.");
    }
    if (
      active.has(id) ||
      (mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status))
    ) {
      throw new Error("Wait for the current expert turn before compacting its context.");
    }
    const sessionId = mission.execution?.sessionId;
    if (sessionId === undefined)
      throw new Error("The mission Runtime context has not started yet.");
    const rootContext = await readMissionRootContext(mission);
    if (rootContext?.snapshot === undefined) {
      throw new Error("The mission Runtime context has not started yet.");
    }
    const { app, runtimes: baseRuntimes } = await executionContext(mission);
    const runtimes = withMissionRuntimeBinding(baseRuntimes, rootContext);
    let session = sessions.get(id);
    if (session === undefined) {
      const compiled = await compileMissionExecutor(mission, runtimes);
      if ("kind" in compiled.value && compiled.value.kind === "flow") {
        throw new Error("Flow missions do not expose a chat context to compact.");
      }
      session = await resumeMissionSession(mission, compiled, app, sessionId);
      rememberSessionCompilation(id, await compilationIdentity(mission), compiled);
    }
    sessions.set(id, session);
    const notNeededResult = async (): Promise<MissionContextCompactionResult> => {
      const state = await getContextWindowState(mission);
      if (state === undefined || !state.supportsCompaction) {
        throw new Error(
          `Runtime ${rootContext.runtime.runtimeId} does not support context compaction.`,
        );
      }
      return {
        outcome: "not_needed",
        contextWindow: {
          ...state,
          canCompact: false,
          compactionBlockedReason: "not_ready",
        },
      };
    };
    const compaction = await compactExpertSessionContext(session);
    if (compaction.outcome === "not_needed") return await notNeededResult();
    const { usage } = compaction;
    invalidateChat(id, missionSurfaceAudience(mission));
    const state = await getContextWindowState(mission, usage);
    if (state === undefined || !state.supportsCompaction) {
      throw new Error(
        `Runtime ${rootContext.runtime.runtimeId} does not support context compaction.`,
      );
    }
    return { outcome: "compacted", contextWindow: state };
  };

  const getChatSnapshot = async (input: MissionChatQuery): Promise<MissionChatSnapshot> => {
    const mission = await options.missions.get(input.id);
    const timeline = await options.missions.readTimelinePage(mission.id, input);
    const capturedLive = liveChats.get(mission.id);
    const history = await readMissionChatHistory(
      timeline.turns,
      executionStore,
      options.missions,
      mission.id,
      capturedLive,
    );
    const entries = history.entries;
    const syncIssues = [...history.syncIssues];

    const executorMetadata = await getExecutorMetadataOrFallback(mission, "historical");
    const current = active.get(mission.id);
    const pendingInteractions = await listMissionPendingHumanInteractions(mission).catch(() => {
      syncIssues.push(missionChatSyncIssue("pending_interactions"));
      return [];
    });

    // Keep using the projection captured before history was read. The execution may settle across
    // the awaits above; looking it up again would omit both durable history (which was skipped for
    // the captured live execution) and the live entries that were removed during settlement.
    if (input.beforeSequence === undefined && capturedLive !== undefined) {
      entries.push(...capturedLive.entries.map((entry) => ({ ...entry })));
    }
    // Mission execution state can change while history and executor metadata are being read. Read
    // it again immediately before the revision so a snapshot cannot pair a stale `running` state
    // with the terminal invalidation revision.
    const latestMission = await options.missions.get(mission.id);
    const contextWindow = await getContextWindowState(latestMission).catch(() => {
      syncIssues.push(missionChatSyncIssue("context_window"));
      return undefined;
    });
    const revision = chatRevisions.get(mission.id) ?? 0;
    const resolveExecutorName = createMissionExecutorNameResolver(mission, executorMetadata.names);
    const resolveExecutorAvatarId = createMissionExecutorAvatarIdResolver(
      executorMetadata.avatarIds,
    );
    // Durable recovery entries are appended before the live projection. Keep the live value for
    // stable IDs so richer streaming fields (for example the full tool error) win without
    // duplicating the row.
    const mergedEntries = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
    const presentedEntries = mergedEntries.map((entry) => {
      if (entry.executorId === undefined) return entry;
      const executorAvatarId = entry.executorAvatarId ?? resolveExecutorAvatarId(entry.executorId);
      if (entry.executorName !== undefined && entry.executorAvatarId !== undefined) return entry;
      return {
        ...entry,
        ...(entry.executorName === undefined
          ? { executorName: resolveExecutorName(entry.executorId) ?? entry.executorId }
          : {}),
        ...(executorAvatarId === undefined ? {} : { executorAvatarId }),
      };
    });
    const uniqueSyncIssues = [
      ...new Map(syncIssues.map((issue) => [issue.section, issue])).values(),
    ];
    if (uniqueSyncIssues.length > 0) {
      if (!degradedChatSync.has(mission.id)) {
        logger.warn(
          "mission.chat_sync_degraded",
          "Mission chat is using partial state while Execution data is unavailable.",
          {
            missionId: mission.id,
            executionId: latestMission.execution?.id,
            code: "execution_state_unavailable",
            retryable: true,
            sections: uniqueSyncIssues.map((issue) => issue.section),
          },
        );
      }
      degradedChatSync.add(mission.id);
    } else if (degradedChatSync.delete(mission.id)) {
      logger.info("mission.chat_sync_recovered", "Mission chat state synchronization recovered.", {
        missionId: mission.id,
        executionId: latestMission.execution?.id,
      });
    }
    const session = sessions.get(mission.id);
    const persistedSession =
      session === undefined && latestMission.execution?.sessionId !== undefined
        ? await expertSessionStore.get(latestMission.execution.sessionId)
        : undefined;
    let promptQueue: readonly PromptRequest[] = [];
    let queueState: {
      readonly state: "idle" | "running" | "paused";
      readonly pendingCount: number;
      readonly pausedAfterRequestId?: string | undefined;
    } = { state: "idle", pendingCount: 0 };
    let sessionEvents: readonly (ExpertSessionEvent | ExecutionEvent)[] = [];
    if (session !== undefined) {
      [promptQueue, queueState, sessionEvents] = await Promise.all([
        session.getPromptQueue(),
        session.getPromptQueueState(),
        (async () => {
          const events = [];
          let after: { readonly offset: number } | undefined;
          do {
            const page = await session.listEvents({ limit: 1_000, after });
            events.push(...page.items);
            after = page.nextCursor;
          } while (after !== undefined);
          return events;
        })(),
      ]);
    } else if (persistedSession !== undefined) {
      [promptQueue, sessionEvents] = await Promise.all([
        expertSessionStore.listPrompts(persistedSession.sessionId),
        expertSessionStore.listEvents(persistedSession.sessionId),
      ]);
      queueState = readPersistedPromptQueueState(
        persistedSession.activeExecutionId,
        promptQueue,
        sessionEvents,
      );
    }
    const promptByRequestId = new Map(promptQueue.map((prompt) => [prompt.requestId, prompt]));
    const removedPromptIds = new Set(
      sessionEvents.flatMap((event) => {
        if (event.type !== "prompt.removed") return [];
        const requestId = (event.data as { requestId?: unknown }).requestId;
        return typeof requestId === "string" ? [requestId] : [];
      }),
    );
    const queuedPrompts = promptQueue.filter(
      (prompt) => prompt.mode === "enqueue" && prompt.status === "queued",
    );
    const presentedUserEntries = new Map(
      presentedEntries.flatMap((entry) => (entry.kind === "user" ? [[entry.id, entry]] : [])),
    );
    let supportsSteer = false;
    const rootContext = await readMissionRootContext(latestMission);
    if (rootContext !== undefined) {
      const { runtimes } = await executionContext(latestMission);
      const resolved = await runtimes
        .resolve({ binding: rootContext.runtime, modelSelection: rootContext.modelSelection })
        .catch(() => undefined);
      supportsSteer = resolved?.adapter.descriptor.capabilities?.supportsSteer === true;
    }
    const steerFallbackByRequestId = new Map<string, string>();
    for (const event of sessionEvents) {
      if (event.type !== "prompt.steer-fallback") continue;
      const data = event.data as { requestId?: unknown; reason?: unknown };
      if (typeof data.requestId === "string" && typeof data.reason === "string") {
        steerFallbackByRequestId.set(data.requestId, data.reason);
      }
    }
    const entriesWithDelivery = presentedEntries.map((entry) => {
      if (entry.kind !== "user") return entry;
      const prompt = promptByRequestId.get(entry.id);
      if (prompt === undefined) return entry;
      const fallbackReason = steerFallbackByRequestId.get(entry.id);
      return {
        ...entry,
        delivery: {
          requestedMode: fallbackReason === undefined ? prompt.mode : "steer",
          effectiveMode: prompt.mode,
          status: prompt.status,
          ...(removedPromptIds.has(prompt.requestId) ? { removed: true } : {}),
          ...(fallbackReason === undefined ? {} : { fallbackReason }),
        },
      };
    });
    return {
      missionId: mission.id,
      revision,
      entries: entriesWithDelivery,
      page: {
        ...(timeline.oldestSequence === undefined
          ? {}
          : { oldestSequence: timeline.oldestSequence }),
        ...(timeline.newestSequence === undefined
          ? {}
          : { newestSequence: timeline.newestSequence }),
        ...(timeline.nextBeforeSequence === undefined
          ? {}
          : { nextBeforeSequence: timeline.nextBeforeSequence }),
      },
      pendingInteractions,
      queue: {
        ...queueState,
        supportsSteer,
        items: queuedPrompts.map((prompt) => ({
          requestId: prompt.requestId,
          content: prompt.content,
          hasAttachments:
            (presentedUserEntries.get(prompt.requestId)?.attachments?.length ?? 0) > 0,
        })),
      },
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(uniqueSyncIssues.length === 0 ? {} : { syncIssues: uniqueSyncIssues }),
      ...(latestMission.execution === undefined
        ? {}
        : {
            execution: {
              id: latestMission.execution.id,
              status: latestMission.execution.status,
              interruptible:
                current?.handle.executionId === latestMission.execution.id &&
                ["queued", "running", "waiting"].includes(latestMission.execution.status),
              ...(latestMission.execution.error === undefined
                ? {}
                : { error: latestMission.execution.error }),
            },
          }),
    };
  };

  const interruptMission = async (id: string): Promise<Mission> => {
    const mission = await options.missions.get(id);
    const session = sessions.get(id);
    if (session !== undefined) {
      await session.cancelPromptQueue("Stopped and cleared by user.");
      await active.get(id)?.settlement.catch(() => undefined);
      invalidateChat(id, missionSurfaceAudience(mission));
      return await options.missions.get(id);
    }
    const current = active.get(id);
    if (current === undefined || current.handle.executionId !== mission.execution?.id) {
      if (
        mission.execution === undefined ||
        !["queued", "running", "waiting"].includes(mission.execution.status)
      ) {
        return mission;
      }
      throw new Error("Resume this execution before interrupting it.");
    }
    await current.handle.cancel("Interrupted by user.");
    await current.settlement;
    return await options.missions.get(id);
  };

  const resumeMissionQueue = async (id: string): Promise<Mission> => {
    const mission = await options.missions.get(id);
    let session = sessions.get(id);
    if (session === undefined) {
      const sessionId = mission.execution?.sessionId;
      if (sessionId === undefined) throw new Error("This Mission has no prompt queue to resume.");
      const rootContext = await readMissionRootContext(mission);
      const { app, runtimes: baseRuntimes } = await executionContext(mission);
      const compiled = await compileMissionExecutor(
        mission,
        withMissionRuntimeBinding(baseRuntimes, rootContext),
      );
      if ("kind" in compiled.value && compiled.value.kind === "flow") {
        throw new Error("Flow missions do not use a prompt queue.");
      }
      session = await resumeMissionSession(mission, compiled, app, sessionId);
      sessions.set(id, session);
      rememberSessionCompilation(id, await compilationIdentity(mission), compiled);
    }
    await session.resumePromptQueue();
    await attachNextSessionTurn(id, missionSurfaceAudience(mission));
    invalidateChat(id, missionSurfaceAudience(mission));
    return await options.missions.get(id);
  };

  const openMissionSessionForQueueMutation = async (
    id: string,
  ): Promise<{
    readonly mission: Mission;
    readonly session: ExpertSession;
  }> => {
    const mission = await options.missions.get(id);
    let session = sessions.get(id);
    if (session !== undefined) return { mission, session };
    const sessionId = mission.execution?.sessionId;
    if (sessionId === undefined) throw new Error("This Mission has no prompt queue to change.");
    const rootContext = await readMissionRootContext(mission);
    const { app, runtimes: baseRuntimes } = await executionContext(mission);
    const compiled = await compileMissionExecutor(
      mission,
      withMissionRuntimeBinding(baseRuntimes, rootContext),
    );
    if ("kind" in compiled.value && compiled.value.kind === "flow") {
      throw new Error("Flow missions do not use a prompt queue.");
    }
    session = await resumeMissionSession(mission, compiled, app, sessionId);
    sessions.set(id, session);
    rememberSessionCompilation(id, await compilationIdentity(mission), compiled);
    return { mission, session };
  };

  const steerQueuedMissionMessage = async (input: {
    readonly id: string;
    readonly requestId: string;
  }): Promise<Mission> => {
    const { mission, session } = await openMissionSessionForQueueMutation(input.id);
    await session.steerQueuedPrompt(input.requestId);
    invalidateChat(input.id, missionSurfaceAudience(mission));
    return await options.missions.get(input.id);
  };

  const removeQueuedMissionMessage = async (input: {
    readonly id: string;
    readonly requestId: string;
  }): Promise<Mission> => {
    const { mission, session } = await openMissionSessionForQueueMutation(input.id);
    await session.removeQueuedPrompt(input.requestId, "Removed from queue by user.");
    invalidateChat(input.id, missionSurfaceAudience(mission));
    return await options.missions.get(input.id);
  };

  const readMissionExecutionIds = async (mission: Mission): Promise<readonly string[]> => {
    if (mission.execution?.sessionId !== undefined) {
      const session = await expertSessionStore.get(mission.execution.sessionId);
      if (session !== undefined) return session.executionIds;
    }
    const executionIds: string[] = [];
    let beforeSequence: number | undefined;
    do {
      const page = await options.missions.readTimelinePage(mission.id, {
        ...(beforeSequence === undefined ? {} : { beforeSequence }),
        limit: 100,
      });
      executionIds.push(
        ...page.turns.flatMap((turn) => (turn.executionId === undefined ? [] : [turn.executionId])),
      );
      beforeSequence = page.nextBeforeSequence;
    } while (beforeSequence !== undefined);
    return [...new Set(executionIds)].toSorted();
  };

  const getWorkSnapshot = async (id: string): Promise<MissionWorkSnapshot> => {
    const t0 = performance.now();
    const mission = await options.missions.get(id);
    const executionIds = await readMissionExecutionIds(mission);
    const records = await workHistory.listRecords({
      executionIds,
      ...(mission.execution?.sessionId === undefined
        ? {}
        : { rootSessionId: mission.execution.sessionId }),
    });
    const t1 = performance.now();
    logger.info(
      "mission.get_work_snapshot",
      `Loaded Mission work snapshot for ${id} in ${(t1 - t0).toFixed(1)}ms.`,
      {
        missionId: id,
        executionCount: executionIds.length,
        recordCount: records.length,
        elapsedMs: t1 - t0,
      },
    );
    const { avatarIds, names } = await getExecutorMetadataOrFallback(mission, "work");
    const runtimeAgentOrdinals = createRuntimeAgentOrdinals(records);
    const runtimeAgentAvatarIds = createRuntimeAgentAvatarIds(records, avatarIds.values());
    return {
      missionId: mission.id,
      revision: workRevisions.get(mission.id) ?? 0,
      records: records.map((record): MissionWorkRecord => {
        const tasks = record.tasks.map((task) => {
          const outputSummary = missionWorkOutputSummary(task.output, 1_000);
          return {
            taskId: task.taskId,
            executionId: task.executionId,
            invocationId: task.invocationId,
            runId: task.runId,
            ...(task.sequence === undefined ? {} : { sequence: task.sequence }),
            status: task.status,
            inputSummary: formatValue(task.input, 500),
            ...(outputSummary === undefined ? {} : { outputSummary }),
            ...(task.error === undefined ? {} : { error: formatValue(task.error, 10_000) }),
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          };
        });
        const latest = tasks.at(-1);
        const resolvedName =
          record.displayName ??
          (record.executorId === undefined ? undefined : names.get(record.executorId)) ??
          (record.kind === "root" ? mission.executor.name : undefined);
        const fallbackOrdinal =
          record.kind === "runtime-agent" && resolvedName === undefined
            ? runtimeAgentOrdinals.get(record.recordId)
            : undefined;
        const title =
          resolvedName ??
          (fallbackOrdinal === undefined ? undefined : `Subagent ${fallbackOrdinal}`) ??
          record.executorId ??
          record.kind;
        const avatarId =
          (record.executorId === undefined ? undefined : avatarIds.get(record.executorId)) ??
          runtimeAgentAvatarIds.get(record.recordId);
        return {
          recordId: record.recordId,
          kind: record.kind,
          sessionId: record.sessionId,
          ...(record.parentRecordId === undefined ? {} : { parentRecordId: record.parentRecordId }),
          title,
          ...(fallbackOrdinal === undefined ? {} : { fallbackOrdinal }),
          ...(record.executorId === undefined ? {} : { executorId: record.executorId }),
          ...(avatarId === undefined ? {} : { avatarId }),
          origin: record.origin,
          status: record.status,
          tasks,
          summary: latest?.outputSummary ?? latest?.inputSummary ?? title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
      }),
    };
  };

  const getWorkConversation = async (
    input: GetMissionWorkConversation,
  ): Promise<MissionWorkConversationSnapshot> => {
    const t0 = performance.now();
    const mission = await options.missions.get(input.id);
    const executionIds = await readMissionExecutionIds(mission);
    const { records, output: rawOutput } = await workHistory.readRecordsAndOutput({
      executionIds,
      ...(mission.execution?.sessionId === undefined
        ? {}
        : { rootSessionId: mission.execution.sessionId }),
      targetRecordId: input.recordId,
    });
    const t1 = performance.now();
    logger.info(
      "mission.get_work_conversation",
      `Loaded Mission work conversation for ${input.id}:${input.recordId} in ${(t1 - t0).toFixed(1)}ms.`,
      {
        missionId: input.id,
        recordId: input.recordId,
        executionCount: executionIds.length,
        outputRecordCount: rawOutput.length,
        elapsedMs: t1 - t0,
      },
    );
    const record = records.find((candidate) => candidate.recordId === input.recordId);
    if (record === undefined) throw new Error(`Mission work record not found: ${input.recordId}`);
    const taskInputEntries = workTaskInputEntries(record);
    const durableEntries = messageRecordsToChatEntries(rawOutput);
    const liveEntries = liveWorkOutputs.get(mission.id)?.get(record.recordId)?.entries ?? [];
    const liveExecutionIds = new Set(liveEntries.flatMap((entry) => entry.executionId ?? []));
    const byId = new Map<string, MissionChatEntry>();
    for (const entry of taskInputEntries) byId.set(entry.id, entry);
    for (const entry of durableEntries) {
      if (entry.executionId === undefined || !liveExecutionIds.has(entry.executionId)) {
        byId.set(entry.id, { ...entry });
      }
    }
    for (const entry of liveEntries) byId.set(entry.id, { ...entry });
    const entries = [...byId.values()].toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    const requestedEnd =
      input.beforeCursor === undefined ? entries.length : Number(input.beforeCursor);
    const end = Number.isInteger(requestedEnd)
      ? Math.max(0, Math.min(entries.length, requestedEnd))
      : entries.length;
    const start = Math.max(0, end - input.limit);
    return {
      missionId: mission.id,
      recordId: record.recordId,
      revision: workRevisions.get(mission.id) ?? 0,
      entries: entries.slice(start, end),
      ...(start === 0 ? {} : { nextBeforeCursor: String(start) }),
    };
  };

  const reconcileMissionUsage = async (mission: Mission): Promise<void> => {
    if (options.usage === undefined) return;
    const project = await options.project.openRevision(mission.project.revision);
    const names = new Map(
      project
        .listResources()
        .map((resource) => [resource.metadata.id, resource.metadata.name] as const),
    );
    names.set(mission.executor.ref, mission.executor.name);
    for (const executionId of await collectMissionExecutionIds(options.missions, mission.id)) {
      const execution = await executionStore.get(executionId);
      if (
        execution === undefined ||
        execution.createdAt < options.usage.trackingStartedAt ||
        !isFinalExecutionStatus(execution.status)
      ) {
        continue;
      }
      const invocations = await executionStore.listInvocations(executionId);
      for (const invocation of invocations) {
        if (invocation.usage === undefined) continue;
        const context = await executionStore.getContext(executionId, invocation.contextId);
        if (context === undefined) continue;
        const executorId = invocation.executorId ?? invocation.definition.id;
        options.usage.recordRecovered(
          {
            occurredAt: invocation.updatedAt,
            executionId,
            invocationId: invocation.invocationId,
            contextId: invocation.contextId,
            runtimeId: context.runtime.runtimeId,
            ...(context.modelSelection === undefined
              ? {}
              : { modelSelection: context.modelSelection }),
            executor: { id: executorId, name: names.get(executorId) ?? executorId },
            usage: invocation.usage,
          },
          {
            mission: { id: mission.id, title: mission.title },
            invocations,
            names,
          },
        );
      }
    }
  };

  const reconcileUsage = async (): Promise<void> => {
    if (options.usage === undefined) return;
    for (const summary of await options.missions.list()) {
      try {
        await reconcileMissionUsage(await options.missions.get(summary.id));
      } catch (error) {
        logger.warn(
          "mission.usage_reconciliation_skipped",
          `Usage reconciliation was skipped for Mission ${summary.id}.`,
          { missionId: summary.id, error },
        );
      }
    }
  };

  return {
    reconcileUsage,
    async invalidateEstimatedContextWindows() {
      for (const mission of await options.missions.list()) invalidateChat(mission.id, "user");
    },
    refreshMemoryContextBindings,
    async run(id) {
      const pending = pendingOperations.get(id);
      if (pending?.kind === "run") return await pending.promise;
      if (pending !== undefined) {
        throw new MissionOperationError();
      }
      const started = runMission(id);
      trackOperation(id, { kind: "run", promise: started });
      return await started;
    },
    async updateOptions(input) {
      if (pendingOperations.has(input.id)) {
        throw new MissionOperationError();
      }
      const updating = updateMissionOptions(input);
      trackOperation(input.id, { kind: "options", promise: updating });
      return await updating;
    },
    async updateContextStores(input) {
      if (pendingOperations.has(input.id)) {
        throw new MissionOperationError();
      }
      const updating = updateMissionContextStores(input);
      trackOperation(input.id, { kind: "context-stores", promise: updating });
      return await updating;
    },
    async sendMessage(input) {
      if (pendingOperations.has(input.id)) {
        throw new MissionOperationError();
      }
      const sending = sendMissionMessage(input);
      trackOperation(input.id, { kind: "message", promise: sending });
      return await sending;
    },
    async steerQueuedMessage(input) {
      if (pendingOperations.has(input.id)) throw new MissionOperationError();
      const steering = steerQueuedMissionMessage(input);
      trackOperation(input.id, { kind: "queue-steer", promise: steering });
      return await steering;
    },
    async removeQueuedMessage(input) {
      if (pendingOperations.has(input.id)) throw new MissionOperationError();
      const removing = removeQueuedMissionMessage(input);
      trackOperation(input.id, { kind: "queue-remove", promise: removing });
      return await removing;
    },
    async resumeQueue(id) {
      if (pendingOperations.has(id)) throw new MissionOperationError();
      const resuming = resumeMissionQueue(id);
      trackOperation(id, { kind: "resume", promise: resuming });
      return await resuming;
    },
    async getChat(input) {
      return await getChatSnapshot(input);
    },
    async getTerminalRuntimeFailure(id) {
      const mission = await options.missions.get(id);
      if (mission.execution === undefined) return undefined;
      const events = await readAllExecutionEvents(
        new StoredExecutionView(mission.execution.id, executionStore),
      ).catch(() => []);
      for (const item of events.toReversed()) {
        if (item.type !== "runtime.event") continue;
        const parsed = ExpertAgentStreamEventSchema.safeParse(item.data);
        if (
          !parsed.success ||
          parsed.data.type !== "run.failed" ||
          !isRootMissionRuntimeSource(parsed.data.source)
        ) {
          continue;
        }
        return {
          message: parsed.data.payload.message,
          ...(parsed.data.payload.code === undefined ? {} : { code: parsed.data.payload.code }),
          ...(parsed.data.payload.retryable === undefined
            ? {}
            : { retryable: parsed.data.payload.retryable }),
          ...(parsed.data.payload.httpStatus === undefined
            ? {}
            : { httpStatus: parsed.data.payload.httpStatus }),
          ...(parsed.data.payload.requestId === undefined
            ? {}
            : { requestId: parsed.data.payload.requestId }),
          ...(parsed.data.payload.endpoint === undefined
            ? {}
            : { endpoint: parsed.data.payload.endpoint }),
          failedAt: parsed.data.emittedAt,
        };
      }
      return undefined;
    },
    async getTerminalRuntimeOutputDiagnostic(id) {
      const mission = await options.missions.get(id);
      if (mission.execution === undefined) return undefined;
      const events = await readAllExecutionEvents(
        new StoredExecutionView(mission.execution.id, executionStore),
      ).catch(() => []);
      let completedUsage: AgentMessageUsage | undefined;
      for (const item of events.toReversed()) {
        if (item.type !== "runtime.event") continue;
        const parsed = ExpertAgentStreamEventSchema.safeParse(item.data);
        if (!parsed.success || !isRootMissionRuntimeSource(parsed.data.source)) continue;
        if (parsed.data.type === "run.completed" && completedUsage === undefined) {
          completedUsage = parsed.data.payload.usage;
          continue;
        }
        if (
          parsed.data.type !== "message.completed" ||
          parsed.data.payload.role !== "assistant" ||
          parsed.data.payload.message?.role !== "assistant"
        ) {
          continue;
        }
        const message = parsed.data.payload.message;
        return {
          finishReason: message.stopReason,
          ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
          usage: message.usage ?? completedUsage,
        };
      }
      return completedUsage === undefined ? undefined : { usage: completedUsage };
    },
    async compactContext(id) {
      const pending = pendingOperations.get(id);
      if (pending?.kind === "compact") return await pending.promise;
      if (pending !== undefined) {
        throw new MissionOperationError();
      }
      const compacting = compactMissionContext(id);
      trackOperation(id, { kind: "compact", promise: compacting });
      return await compacting;
    },
    async getRuntimeBinding(id) {
      return (await readMissionRootContext(await options.missions.get(id)))?.runtime;
    },
    subscribeChat(listener) {
      chatListeners.add(listener);
      return () => chatListeners.delete(listener);
    },
    subscribeWork(listener) {
      workListeners.add(listener);
      return () => workListeners.delete(listener);
    },
    async interrupt(id) {
      const pending = pendingOperations.get(id);
      if (pending?.kind === "interrupt") return await pending.promise;
      if (pending !== undefined) {
        throw new MissionOperationError();
      }
      const interrupting = interruptMission(id);
      trackOperation(id, { kind: "interrupt", promise: interrupting });
      return await interrupting;
    },
    async getWork(id) {
      return await getWorkSnapshot(id);
    },
    async getWorkConversation(input) {
      return await getWorkConversation(input);
    },
    async delete(id) {
      if (pendingOperations.has(id)) {
        throw new MissionOperationError();
      }
      const liveChat = liveChats.get(id);
      if (liveChat !== undefined) await liveChat.close();
      liveChats.delete(id);
      const deleting = deleteMission(id);
      trackOperation(id, { kind: "delete", promise: deleting });
      await deleting;
      chatRevisions.delete(id);
      degradedChatSync.delete(id);
      workRevisions.delete(id);
      liveWorkOutputs.delete(id);
      liveContextWindows.delete(id);
    },
    async listHumanInteractions(id) {
      return await listMissionPendingHumanInteractions(await options.missions.get(id));
    },
    async respondToHumanInteraction(input) {
      const execution = await ensureActiveExecution(input.missionId, input.interactionId);
      const request = await findHumanRequest(execution.handle, input.interactionId);
      await execution.handle.respondToHumanInteraction(
        input.interactionId,
        toExpertHumanResponse(request, input.response),
        {
          requestId: input.requestId,
        },
      );
      invalidateChat(input.missionId, execution.audience);
    },
  };

  async function listMissionPendingHumanInteractions(
    mission: Mission,
  ): Promise<MissionHumanInteraction[]> {
    const execution = active.get(mission.id);
    if (execution !== undefined) return await listPendingHumanInteractions(execution.handle);
    if (
      mission.execution === undefined ||
      !["queued", "running", "waiting"].includes(mission.execution.status)
    ) {
      return [];
    }
    return await listPendingHumanInteractions(
      new StoredExecutionView(mission.execution.id, executionStore),
    ).catch(() => []);
  }

  async function ensureActiveExecution(
    id: string,
    interactionId: string,
  ): Promise<ActiveMissionExecution> {
    const existing = active.get(id);
    if (existing !== undefined) return existing;
    const pending = pendingOperations.get(id);
    if (pending?.kind === "run") {
      await pending.promise;
    } else if (pending !== undefined) {
      throw new MissionOperationError();
    } else {
      const mission = await options.missions.get(id);
      if (
        mission.execution === undefined ||
        !["queued", "running", "waiting"].includes(mission.execution.status)
      ) {
        throw new Error("This human interaction is no longer waiting for a response.");
      }
      const restoring = runMission(id);
      trackOperation(id, { kind: "run", promise: restoring });
      await restoring;
    }
    const restored = active.get(id);
    if (restored === undefined) {
      throw new Error(
        "This human interaction could not be restored in the current Desktop process.",
      );
    }
    await waitForRestoredHumanInteraction(restored.handle, interactionId);
    return restored;
  }
}

function createRuntimeAgentOrdinals(
  records: readonly ExecutionWorkRecord[],
): ReadonlyMap<string, number> {
  const nextByParent = new Map<string, number>();
  const ordinals = new Map<string, number>();
  const ordered = [...records].toSorted((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt);
    return created === 0 ? left.recordId.localeCompare(right.recordId) : created;
  });
  for (const record of ordered) {
    if (record.kind !== "runtime-agent") continue;
    const parentKey = record.parentRecordId ?? "";
    const ordinal = (nextByParent.get(parentKey) ?? 0) + 1;
    nextByParent.set(parentKey, ordinal);
    ordinals.set(record.recordId, ordinal);
  }
  return ordinals;
}

function createRuntimeAgentAvatarIds(
  records: readonly ExecutionWorkRecord[],
  configuredAvatarIds: Iterable<string>,
): ReadonlyMap<string, string> {
  const reserved = new Set(
    [...configuredAvatarIds].map((avatarId) => resolvePragmaAvatarId("expert", avatarId)),
  );
  const available = BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS.filter((avatarId) => !reserved.has(avatarId));
  const catalog = available.length > 0 ? available : BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS;
  const runtimeRecords = records
    .filter((record) => record.kind === "runtime-agent")
    .toSorted((left, right) => {
      const created = left.createdAt.localeCompare(right.createdAt);
      return created === 0 ? left.recordId.localeCompare(right.recordId) : created;
    });
  return new Map(
    runtimeRecords.map(
      (record, index) => [record.recordId, catalog[index % catalog.length]!] as const,
    ),
  );
}

export function createDesktopAdapterHost(
  options: {
    readonly capabilityStore: CapabilityStore;
    readonly capabilityCredentials: CapabilityCredentialStore;
    readonly capabilitiesPath: string;
    readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
    readonly contextStores?: ContextStoreStore | undefined;
  },
  projectRoot: string,
): PragmaAdapterHost {
  return {
    environmentId: "desktop",
    projectRoot,
    async resolveBinding(ref): Promise<PragmaBindingRecord | undefined> {
      const capabilityRef = parseDesktopCapabilityBindingRef(ref);
      if (capabilityRef !== undefined) {
        const capabilityId = capabilityRef.id;
        const revision = capabilityRef.revision;
        const capability = await options.capabilityStore.get(capabilityId, revision);
        const toolNames =
          capability.definition.kind === "skill"
            ? []
            : capability.definition.kind === "code_service"
              ? [capability.definition.tool.name]
              : capability.definition.tools.map((tool) => tool.name);
        const contribution = await resolveExpertCapabilities({
          expert: {
            capabilities: [
              capability.definition.kind === "skill"
                ? { kind: "skill", capabilityId, revision }
                : { kind: "tools", capabilityId, revision, toolNames },
            ],
            toolApprovals: {},
          },
          store: options.capabilityStore,
          credentials: options.capabilityCredentials,
          capabilitiesPath: options.capabilitiesPath,
          ...(options.mcpToolRegistryPool === undefined
            ? {}
            : { mcpToolRegistryPool: options.mcpToolRegistryPool }),
        });
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              id: capabilityId,
              revision,
              definition: capability.definition,
              credentials: await options.capabilityCredentials.fingerprint(capabilityId),
            }),
          )
          .digest("hex");
        return { ref, revision: String(revision), fingerprint, value: { contribution } };
      }

      const contextId = parseDesktopContextBindingRef(ref);
      if (contextId !== undefined) {
        if (options.contextStores === undefined) {
          throw new Error(`Desktop context binding is unavailable: ${contextId}`);
        }
        const context = await options.contextStores.resolve(contextId);
        return {
          ref,
          revision: context.revision,
          fingerprint: context.revision,
          value: { store: context.store, storeName: context.name },
        };
      }
      return undefined;
    },
    async resolveArtifact(source) {
      throw new Error(
        source.type === "project"
          ? `Project artifact was not resolved by the interpreter: ${source.path}`
          : `Desktop has no external artifact resolver for: ${source.uri}`,
      );
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

function toRuntimeModelSelection(
  override: MissionModelOverride | undefined,
): RuntimeModelSelection | undefined {
  return override === undefined
    ? undefined
    : {
        model: { providerId: override.providerId, modelId: override.modelId },
        ...(override.thinkingLevel === undefined ? {} : { thinkingLevel: override.thinkingLevel }),
      };
}

function requireRootRuntimeId(compiled: CompiledResource<InvocableResource>): string {
  if (compiled.rootRuntimeId === undefined) {
    throw new Error("Mission executor did not resolve a root Runtime.");
  }
  return compiled.rootRuntimeId;
}

function withMissionRuntimeBinding(
  runtimes: RuntimeResolver,
  context: RuntimeContextRecord | undefined,
): RuntimeResolver {
  if (context === undefined) return runtimes;
  const binding = context.runtime;
  return {
    getDefaultRuntimeId: async () => binding.runtimeId,
    bind: async (request = {}) =>
      request.runtimeId === undefined || request.runtimeId === binding.runtimeId
        ? await runtimes.resolve({
            binding,
            ...(request.modelSelection === undefined && context.modelSelection === undefined
              ? {}
              : {
                  modelSelection: matchesBoundModel(request.modelSelection, context.modelSelection)
                    ? context.modelSelection
                    : request.modelSelection,
                }),
          })
        : await runtimes.bind(request),
    resolve: async (request) => await runtimes.resolve(request),
  };
}

function matchesBoundModel(
  requested: RuntimeModelSelection | undefined,
  bound: RuntimeModelSelection | undefined,
): boolean {
  if (requested === undefined) return bound !== undefined;
  return (
    requested.model.providerId === bound?.model.providerId &&
    requested.model.modelId === bound.model.modelId &&
    requested.thinkingLevel === bound.thinkingLevel
  );
}

function observeExecution(
  missions: MissionStore,
  missionId: string,
  execution: {
    readonly executionId: string;
    readonly result: Promise<unknown>;
    readonly getState: () => Promise<{ readonly status: string }>;
  },
  startedAt: string,
  inputMessageId: string,
  onFinished: () => void | Promise<void>,
  sessionId?: string,
  logger?: import("@pragma/core").PragmaLogger,
  onTerminal?: (() => void | Promise<void>) | undefined,
): Promise<void> {
  return (async () => {
    let status: "succeeded" | "failed" | "cancelled" = "succeeded";
    let failure: unknown;
    try {
      await execution.result;
    } catch (error) {
      const state = await execution.getState().catch(() => undefined);
      status =
        state?.status === "cancelled" || state?.status === "interrupted" ? "cancelled" : "failed";
      failure = error;
    }
    try {
      await onFinished();
    } catch (error) {
      logger?.error(
        "mission.finish_callback_failed",
        `Failed to finish Mission execution ${execution.executionId}.`,
        error,
        { missionId, executionId: execution.executionId },
      );
    }
    try {
      await onTerminal?.();
    } catch (error) {
      logger?.error(
        "mission.terminal_callback_failed",
        `Failed to compact Mission execution ${execution.executionId}.`,
        error,
        { missionId, executionId: execution.executionId },
      );
    }
    await missions.updateExecution(
      missionId,
      {
        id: execution.executionId,
        inputMessageId,
        ...(sessionId === undefined ? {} : { sessionId }),
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(status === "failed"
          ? { error: failure instanceof Error ? failure.message : String(failure) }
          : {}),
      },
      {
        executionId: execution.executionId,
        statuses: ["queued", "running", "waiting"],
      },
    );
  })();
}

function observeMissionHumanWaitingStatus(input: {
  readonly missions: MissionStore;
  readonly missionId: string;
  readonly execution: MutableExecution;
  readonly startedAt: string;
  readonly inputMessageId: string;
  readonly sessionId?: string | undefined;
  readonly logger: PragmaLogger;
}): {
  readonly onEvent: (event: ExecutionEvent) => void;
  readonly resync: () => Promise<void>;
  readonly drain: () => Promise<void>;
} {
  const pending = new Set<string>();
  let observedWaiting: boolean | undefined;
  let updates = Promise.resolve();

  const enqueueUpdate = (update: () => Promise<void>): Promise<void> => {
    const result = updates.then(update);
    // Keep the serialization queue usable after a transient failure while preserving the rejected
    // result for callers such as the event subscription retry loop.
    updates = result.catch(() => undefined);
    return result;
  };

  const persistStatus = async (): Promise<void> => {
    const waiting = pending.size > 0;
    if (waiting === observedWaiting) return;
    await input.missions.updateExecution(
      input.missionId,
      {
        id: input.execution.executionId,
        inputMessageId: input.inputMessageId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        status: waiting ? "waiting" : "running",
        startedAt: input.startedAt,
      },
      {
        executionId: input.execution.executionId,
        statuses: ["queued", "running", "waiting"],
      },
    );
    observedWaiting = waiting;
  };

  const resync = async (): Promise<void> => {
    try {
      const interactions = await listPendingHumanInteractions(input.execution);
      pending.clear();
      for (const interaction of interactions) pending.add(interaction.interactionId);
      observedWaiting = undefined;
      await persistStatus();
    } catch (error) {
      input.logger.warn(
        "mission.human_wait_status_seed_failed",
        "Mission human-input waiting status could not be initialized.",
        { error, missionId: input.missionId, executionId: input.execution.executionId },
      );
      throw error;
    }
  };
  void enqueueUpdate(resync).catch(() => undefined);

  const onEvent = (event: ExecutionEvent): void => {
    if (event.type !== "human.requested" && event.type !== "human.responded") return;
    const update = enqueueUpdate(async () => {
      const interactionId = String(
        (event.data as { readonly interactionId?: unknown }).interactionId ?? "",
      );
      if (interactionId === "") return;
      if (event.type === "human.requested") pending.add(interactionId);
      else pending.delete(interactionId);
      await persistStatus();
    });
    void update.catch((error: unknown) => {
      input.logger.warn(
        "mission.human_wait_status_update_failed",
        "Mission human-input waiting status could not be updated.",
        { error, missionId: input.missionId, executionId: input.execution.executionId },
      );
    });
  };

  return {
    onEvent,
    resync: () => enqueueUpdate(resync),
    drain: async () => await updates,
  };
}

async function persistMissionExecutionProjection(
  missions: MissionStore,
  executionStore: ReturnType<typeof createFileExecutionStore>,
  missionId: string,
  executionId: string,
): Promise<void> {
  let beforeSequence: number | undefined;
  let matched: MissionTimelineTurn | undefined;
  while (matched === undefined) {
    const page = await missions.readTimelinePage(missionId, {
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      limit: 500,
    });
    matched = page.turns.find((turn) => turn.executionId === executionId);
    if (matched !== undefined || page.nextBeforeSequence === undefined) break;
    beforeSequence = page.nextBeforeSequence;
  }
  if (matched === undefined)
    throw new Error(`Mission timeline is missing Execution ${executionId}.`);
  const history = await readMissionChatHistory([matched], executionStore, missions, missionId);
  if (history.syncIssues.length > 0) {
    throw new Error(`Execution history could not be projected: ${executionId}.`);
  }
  await missions.writeExecutionProjection(
    missionId,
    executionId,
    history.entries.filter((entry) => entry.kind !== "user"),
  );
  await executionStore.archive(executionId);
}

async function readMissionChatHistory(
  turns: readonly MissionTimelineTurn[],
  executionStore: ReturnType<typeof createFileExecutionStore>,
  missions: MissionStore,
  missionId: string,
  activeChat?: LiveMissionChat,
): Promise<{
  readonly entries: MissionChatEntry[];
  readonly syncIssues: MissionChatSyncIssue[];
}> {
  const entries: MissionChatEntry[] = [];
  const syncIssues: MissionChatSyncIssue[] = [];
  for (const turn of turns) {
    entries.push({
      id: turn.message.id,
      timelineSequence: turn.sequence,
      kind: "user",
      content: turn.message.content,
      ...(turn.message.attachments === undefined ? {} : { attachments: turn.message.attachments }),
      createdAt: turn.message.createdAt,
      ...(turn.executionId === undefined ? {} : { executionId: turn.executionId }),
    });
    if (turn.executionId === undefined) continue;

    if (turn.executionId === activeChat?.executionId) {
      try {
        entries.push(...(await activeChat.readDurableEntries(turn.sequence)));
      } catch {
        syncIssues.push(missionChatSyncIssue("history"));
      }
      continue;
    }

    const view = new StoredExecutionView(turn.executionId, executionStore);
    const state = await view.getState().catch(() => undefined);
    if (state === undefined) {
      const projection = await missions.readExecutionProjection(missionId, turn.executionId);
      if (projection !== undefined) {
        entries.push(...projection);
        continue;
      }
      syncIssues.push(missionChatSyncIssue("history"));
      entries.push({
        id: `missing:${turn.executionId}`,
        timelineSequence: turn.sequence,
        executionId: turn.executionId,
        kind: "assistant",
        content: "Execution history unavailable.",
        streaming: false,
        createdAt: turn.message.createdAt,
      });
      continue;
    }
    let histories;
    let activityEntries;
    try {
      histories = await view.getMessageHistory({ scope: { kind: "all" } });
      activityEntries = await readHistoricalRuntimeActivityEntries(
        view,
        turn.sequence,
        state.rootInvocationId,
      );
    } catch {
      const projection = await missions.readExecutionProjection(missionId, turn.executionId);
      if (projection !== undefined) {
        entries.push(...projection);
        continue;
      }
      syncIssues.push(missionChatSyncIssue("history"));
      entries.push({
        id: `missing:${turn.executionId}`,
        timelineSequence: turn.sequence,
        executionId: turn.executionId,
        kind: "assistant",
        content: "Execution history unavailable.",
        streaming: false,
        createdAt: state.updatedAt,
      });
      continue;
    }
    const richEntries = finalizeHistoricalChatEntries(
      [
        ...messageRecordsToChatEntries(
          histories
            .flatMap((history) => history.messages)
            .filter((record) => record.source?.parentSessionId === undefined),
        ).map((entry) => ({
          ...entry,
          timelineSequence: turn.sequence,
        })),
        ...activityEntries,
      ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
      isFinalExecutionStatus(state.status),
    );
    entries.push(...richEntries);
    if (
      isFinalExecutionStatus(state.status) &&
      !richEntries.some((entry) => entry.kind === "assistant")
    ) {
      entries.push({
        id: `result:${turn.executionId}`,
        timelineSequence: turn.sequence,
        executionId: turn.executionId,
        kind: "assistant",
        content: executionFallback(state.status, state.output, state.error),
        streaming: false,
        createdAt: state.updatedAt,
      });
    }
  }
  return { entries, syncIssues };
}

type MissionChatSyncIssue = NonNullable<MissionChatSnapshot["syncIssues"]>[number];

function missionChatSyncIssue(section: MissionChatSyncIssue["section"]): MissionChatSyncIssue {
  return { code: "execution_state_unavailable", section, retryable: true };
}

async function readHistoricalRuntimeActivityEntries(
  view: Pick<ExecutionView, "executionId" | "listEvents">,
  timelineSequence: number,
  rootInvocationId: string,
): Promise<MissionChatEntry[]> {
  const events: Array<{
    readonly event: ExpertAgentStreamEvent;
    readonly invocationId: string;
  }> = [];
  let after: { executionId: string; sequence: number } | undefined;
  do {
    const page = await view.listEvents({ scope: { kind: "all" }, limit: 1_000, after });
    for (const event of page.items) {
      if (event.type !== "runtime.event") continue;
      const parsed = ExpertAgentStreamEventSchema.safeParse(event.data);
      if (
        parsed.success &&
        (parsed.data.type === "agent.command" ||
          parsed.data.type.startsWith("run.") ||
          (parsed.data.type === "progress" &&
            isRuntimeContextCompactionStage(parsed.data.payload.stage)))
      ) {
        events.push({ event: parsed.data, invocationId: event.invocationId });
      }
    }
    after = page.nextCursor;
  } while (after !== undefined);
  const byId = new Map<string, MissionChatEntry>();
  for (const record of events) {
    const { event } = record;
    if (event.type === "progress") {
      if (record.invocationId !== rootInvocationId || !isRootMissionRuntimeSource(event.source)) {
        continue;
      }
      const data = readRuntimeContextCompactionProgressData(event.payload.data);
      if (data === undefined || !isRuntimeContextCompactionStage(event.payload.stage)) continue;
      const id = `context:${view.executionId}:${data.operationId}`;
      const existing = byId.get(id);
      byId.set(id, {
        id,
        timelineSequence,
        executionId: view.executionId,
        invocationId: record.invocationId,
        kind: "context_operation",
        operationId: data.operationId,
        operation: "compaction",
        trigger: data.trigger,
        runtimeId: data.runtimeId,
        status:
          event.payload.stage === RUNTIME_CONTEXT_COMPACTION_STAGES.started
            ? "running"
            : event.payload.stage === RUNTIME_CONTEXT_COMPACTION_STAGES.completed
              ? "succeeded"
              : "failed",
        ...(data.errorMessage === undefined ? {} : { error: data.errorMessage }),
        createdAt: existing?.createdAt ?? event.emittedAt,
      });
      continue;
    }
    const isCommand = event.type === "agent.command";
    if (!isCommand && event.source.parentSessionId === undefined) continue;
    const action = isCommand ? event.payload.action : "run";
    const commandId = isCommand
      ? event.payload.commandId
      : `${event.source.sessionId ?? event.runId}:${event.runId}:run`;
    const phase = isCommand
      ? event.payload.phase
      : event.type === "run.started"
        ? "started"
        : event.type === "run.completed"
          ? "completed"
          : "failed";
    byId.set(`agent:${view.executionId}:${commandId}`, {
      id: `agent:${view.executionId}:${commandId}`,
      timelineSequence,
      executionId: view.executionId,
      kind: "agent_activity",
      commandId,
      action,
      phase,
      ...(isCommand && event.payload.senderSessionId !== undefined
        ? { senderSessionId: event.payload.senderSessionId }
        : {}),
      targetSessionIds: isCommand
        ? event.payload.targetSessionIds
        : event.source.sessionId === undefined
          ? []
          : [event.source.sessionId],
      ...(event.source.displayName === undefined ? {} : { label: event.source.displayName }),
      ...(isCommand && event.payload.error !== undefined
        ? { error: truncate(event.payload.error, MISSION_CHAT_ERROR_MAX_LENGTH) }
        : event.type === "run.failed"
          ? { error: truncate(event.payload.message, MISSION_CHAT_ERROR_MAX_LENGTH) }
          : {}),
      createdAt: event.emittedAt,
    });
  }
  return [...byId.values()];
}

function executionFallback(status: string, output: unknown, error: unknown): string {
  if (status === "succeeded") {
    const content = formatValue(output, 200_000).trim();
    return content === "" ? "Execution completed without a text result." : content;
  }
  if (status === "cancelled" || status === "interrupted") return "Execution interrupted.";
  const message = readErrorMessage(error);
  return message === "" ? "Execution failed." : `Execution failed: ${message}`;
}

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message).trim();
  }
  return error === undefined ? "" : String(error).trim();
}

function finalizeHistoricalChatEntries(
  entries: readonly MissionChatEntry[],
  executionTerminal = true,
): MissionChatEntry[] {
  if (!executionTerminal) return [...entries];
  return entries.map((entry) =>
    entry.kind === "tool" && entry.status === "running"
      ? {
          ...entry,
          status: "failed",
          error: entry.error ?? "Execution ended before this tool completed.",
        }
      : entry.kind === "context_operation" && entry.status === "running"
        ? {
            ...entry,
            status: "failed",
            error: entry.error ?? "Execution ended before context compaction completed.",
          }
        : entry,
  );
}

function workTaskInputEntries(record: ExecutionWorkRecord): MissionChatEntry[] {
  return record.tasks.flatMap((task) => {
    const content = workTaskInputContent(task.input);
    if (content === "") return [];
    return [
      {
        id: `work-input:${task.taskId}`,
        executionId: task.executionId,
        invocationId: task.invocationId,
        kind: "user" as const,
        content,
        createdAt: task.createdAt,
      },
    ];
  });
}

function workTaskInputContent(input: unknown): string {
  if (typeof input === "string") return truncate(input.trim(), 200_000);
  if (
    typeof input === "object" &&
    input !== null &&
    "prompt" in input &&
    typeof input.prompt === "string"
  ) {
    return truncate(input.prompt.trim(), 200_000);
  }
  return formatValue(input, 200_000).trim();
}

function messageRecordsToChatEntries(records: readonly AgentMessageRecord[]): MissionChatEntry[] {
  const entries: MissionChatEntry[] = [];
  const messageOrdinals = new Map<string, number>();
  for (const record of [...records].sort((left, right) => left.sequence - right.sequence)) {
    const base = {
      executionId: record.executionId,
      invocationId: record.invocationId,
      ...(record.executorId === undefined ? {} : { executorId: record.executorId }),
      createdAt: new Date(record.message.timestamp).toISOString(),
    };
    if (record.message.role === "assistant") {
      record.message.content.forEach((content, index) => {
        if (content.type === "thinking" && content.thinking !== "") {
          entries.push({
            ...base,
            id: durableMessageEntryId(record, "thinking", index, messageOrdinals),
            kind: "thinking",
            content: truncate(content.thinking, 200_000),
            streaming: false,
          });
        } else if (content.type === "text" && content.text !== "") {
          entries.push({
            ...base,
            id: durableMessageEntryId(record, "assistant", index, messageOrdinals),
            kind: "assistant",
            content: truncate(content.text, 200_000),
            streaming: false,
          });
        } else if (content.type === "toolCall") {
          entries.push({
            ...base,
            id: `tool:${record.executionId}:${content.id}`,
            kind: "tool",
            toolCallId: content.id,
            toolName: content.name,
            status: "running",
            inputPreview: preview(content.arguments),
          });
        }
      });
      continue;
    }
    if (record.message.role !== "toolResult") continue;
    const message = record.message;
    const existingIndex = entries.findIndex(
      (entry) =>
        entry.kind === "tool" &&
        entry.executionId === record.executionId &&
        entry.toolCallId === message.toolCallId,
    );
    const outputPreview = preview(
      message.content
        .flatMap((content) => (content.type === "text" ? [content.text] : []))
        .join("\n"),
    );
    const tool: MissionChatEntry = {
      ...base,
      id: `tool:${record.executionId}:${message.toolCallId}`,
      kind: "tool",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      status: message.isError ? "failed" : "succeeded",
      ...(message.isError
        ? { error: outputPreview ?? "Tool failed." }
        : outputPreview === undefined
          ? {}
          : { outputPreview }),
    };
    const existing = entries[existingIndex];
    if (existingIndex === -1 || existing?.kind !== "tool") entries.push(tool);
    else entries[existingIndex] = { ...existing, ...tool };
  }
  return entries;
}

function durableMessageEntryId(
  record: AgentMessageRecord,
  kind: "assistant" | "thinking",
  contentIndex: number,
  ordinals: Map<string, number>,
): string {
  if (record.runId === undefined) {
    return `${record.executionId}:${record.invocationId}:${record.sequence}:${contentIndex}`;
  }
  return nextMessageEntryId(record.executionId, record.invocationId, record.runId, kind, ordinals);
}

function nextMessageEntryId(
  executionId: string,
  invocationId: string,
  runId: string,
  kind: "assistant" | "thinking",
  ordinals: Map<string, number>,
): string {
  const key = JSON.stringify([executionId, invocationId, runId, kind]);
  const ordinal = ordinals.get(key) ?? 0;
  ordinals.set(key, ordinal + 1);
  return `message:${executionId}:${invocationId}:${runId}:${kind}:${ordinal}`;
}

function createMissionExecutorNameResolver(
  mission: Pick<Mission, "executor">,
  names: ReadonlyMap<string, string>,
): ExecutorNameResolver {
  // A Team or Flow name identifies the invocable resource, not the concrete Expert producing an
  // entry. Their Experts must resolve through the pinned Project Revision or fall back to IDs.
  const rootExpertId =
    mission.executor.kind === "expert" && mission.executor.ref.startsWith("expert:")
      ? mission.executor.ref.slice("expert:".length)
      : undefined;
  return (executorId) =>
    names.get(executorId) ?? (executorId === rootExpertId ? mission.executor.name : undefined);
}

function createMissionExecutorAvatarIdResolver(
  avatarIds: ReadonlyMap<string, string>,
): ExecutorAvatarIdResolver {
  return (executorId) => avatarIds.get(executorId);
}

function observeMissionChat(
  execution: MutableExecution & { readonly result: Promise<unknown> },
  onOutput: (patches: readonly MissionChatPatch[]) => void,
  onInvalidate: () => void,
  onEvent: (event: ExecutionEvent) => void,
  onEventResync: () => Promise<void>,
  onSubscriptionError: (channel: "output" | "events", error: unknown) => void,
  onItem: (item: ExecutionOutputItem) => void,
  resolveExecutorName: ExecutorNameResolver,
  resolveExecutorAvatarId: ExecutorAvatarIdResolver,
): LiveMissionChat {
  const chat: LiveMissionChat = {
    executionId: execution.executionId,
    entries: [],
    messageOrdinals: new Map(),
    close: async () => undefined,
    readDurableEntries: async () => [],
  };
  let closed = false;
  let durableEntries: Promise<readonly MissionChatEntry[]> | undefined;
  chat.readDurableEntries = (timelineSequence) => {
    durableEntries ??= readDurableMissionChatEntries(execution, timelineSequence).catch((error) => {
      durableEntries = undefined;
      throw error;
    });
    return durableEntries;
  };
  let outputSubscription: Awaited<ReturnType<MutableExecution["subscribeOutput"]>> | undefined;
  let eventSubscription: Awaited<ReturnType<MutableExecution["subscribeEvents"]>> | undefined;
  const outputTask = (async () => {
    while (!closed) {
      try {
        const subscription = await execution.subscribeOutput({ scope: { kind: "all" } });
        outputSubscription = subscription;
        for await (const item of subscription) {
          if (closed) break;
          onItem(item);
          const patches = consumeLiveChatOutput(chat, item, {
            resolveExecutorName,
            resolveExecutorAvatarId,
          });
          if (patches.length > 0) onOutput(patches);
          if (isTerminalContextCompactionOutput(item)) onInvalidate();
        }
        return;
      } catch (error) {
        if (!closed) {
          onSubscriptionError("output", error);
          await missionSubscriptionRetryDelay();
        }
      } finally {
        await outputSubscription?.close();
        outputSubscription = undefined;
      }
    }
  })();
  const eventTask = (async () => {
    while (!closed) {
      try {
        const subscription = await execution.subscribeEvents({ scope: { kind: "all" } });
        eventSubscription = subscription;
        await onEventResync();
        for await (const event of subscription) {
          if (closed) break;
          onEvent(event);
          if (
            event.type === "human.requested" ||
            event.type === "human.responded" ||
            event.type.startsWith("execution.")
          ) {
            onInvalidate();
          }
        }
        return;
      } catch (error) {
        if (!closed) {
          onSubscriptionError("events", error);
          await missionSubscriptionRetryDelay();
        }
      } finally {
        await eventSubscription?.close();
        eventSubscription = undefined;
      }
    }
  })();
  chat.close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([outputSubscription?.close(), eventSubscription?.close()]);
    await Promise.allSettled([outputTask, eventTask]);
  };
  return chat;
}

async function readDurableMissionChatEntries(
  execution: ExecutionView,
  timelineSequence: number,
): Promise<readonly MissionChatEntry[]> {
  const state = await execution.getState();
  const histories = await execution.getMessageHistory({ scope: { kind: "all" } });
  const activityEntries = await readHistoricalRuntimeActivityEntries(
    execution,
    timelineSequence,
    state.rootInvocationId,
  );
  return finalizeHistoricalChatEntries(
    [
      ...messageRecordsToChatEntries(
        histories
          .flatMap((history) => history.messages)
          .filter((record) => record.source?.parentSessionId === undefined),
      ).map((entry) => ({ ...entry, timelineSequence })),
      ...activityEntries,
    ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    isFinalExecutionStatus(state.status),
  );
}

async function missionSubscriptionRetryDelay(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
}

function isVisibleTextProjectionPatch(patch: MissionChatPatch): boolean {
  if (patch.type === "entry.append") {
    return patch.field === "content" && patch.delta.length > 0;
  }
  return (
    patch.type === "entry.upsert" &&
    (patch.entry.kind === "assistant" || patch.entry.kind === "thinking") &&
    patch.entry.content.length > 0
  );
}

function logMissionPhase(
  logger: Pick<PragmaLogger, "info">,
  missionId: string,
  phase: string,
  phaseStartedAt: number,
  acceptedAt: number,
  attributes: Record<string, unknown> = {},
): void {
  logger.info("mission.prepare_phase", `Mission preparation phase completed: ${phase}`, {
    missionId,
    phase,
    durationMs: elapsedMissionMs(phaseStartedAt),
    elapsedMs: elapsedMissionMs(acceptedAt),
    ...attributes,
  });
}

function elapsedMissionMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export function isRootMissionRuntimeOutput(
  item: Pick<ExecutionOutputItem, "parentInvocationId" | "source">,
): boolean {
  return item.parentInvocationId === undefined && isRootMissionRuntimeSource(item.source);
}

function isRootMissionRuntimeSource(
  source: Pick<ExecutionOutputItem["source"], "parentSessionId">,
): boolean {
  return source.parentSessionId === undefined;
}

function isTerminalContextCompactionOutput(item: ExecutionOutputItem): boolean {
  if (item.channel !== "progress" || !isRootMissionRuntimeOutput(item)) {
    return false;
  }
  const stage = asRecord(item.value)["stage"];
  return (
    stage === RUNTIME_CONTEXT_COMPACTION_STAGES.completed ||
    stage === RUNTIME_CONTEXT_COMPACTION_STAGES.failed
  );
}

function consumeLiveChatOutput(
  chat: LiveMissionChat,
  item: ExecutionOutputItem,
  options: {
    readonly includeNestedSource?: boolean;
    readonly resolveExecutorName?: ExecutorNameResolver;
    readonly resolveExecutorAvatarId?: ExecutorAvatarIdResolver;
  } = {},
): MissionChatPatch[] {
  const executorName =
    item.executorId === undefined ? undefined : options.resolveExecutorName?.(item.executorId);
  const executorAvatarId =
    item.executorId === undefined ? undefined : options.resolveExecutorAvatarId?.(item.executorId);
  const base = {
    executionId: item.executionId,
    invocationId: item.invocationId,
    ...(item.executorId === undefined ? {} : { executorId: item.executorId }),
    ...(executorName === undefined ? {} : { executorName }),
    ...(executorAvatarId === undefined ? {} : { executorAvatarId }),
    createdAt: item.occurredAt,
  };
  if (item.channel === "agent") {
    const payload = asRecord(item.value);
    const eventType = readString(payload, "type");
    const action = eventType.startsWith("run.")
      ? "run"
      : readAgentActivityAction(readString(payload, "action"));
    if (action === undefined) return [];
    const commandId =
      readString(payload, "commandId") ||
      `${item.source.sessionId ?? item.runId}:${item.runId}:${action}`;
    const phase =
      eventType === "run.failed" || eventType === "run.cancelled"
        ? "failed"
        : eventType === "run.completed"
          ? "completed"
          : eventType === "run.started"
            ? "started"
            : readAgentActivityPhase(readString(payload, "phase"));
    if (phase === undefined) return [];
    const id = `agent:${item.executionId}:${commandId}`;
    const targets = payload["targetSessionIds"];
    const targetSessionIds = Array.isArray(targets)
      ? targets.filter((value): value is string => typeof value === "string" && value !== "")
      : item.source.sessionId === undefined
        ? []
        : [item.source.sessionId];
    const entry: MissionChatEntry = {
      ...base,
      id,
      kind: "agent_activity",
      commandId,
      action,
      phase,
      ...(readString(payload, "senderSessionId") === ""
        ? {}
        : { senderSessionId: readString(payload, "senderSessionId") }),
      targetSessionIds,
      ...(item.source.displayName === undefined ? {} : { label: item.source.displayName }),
      ...(readString(payload, "error") === ""
        ? eventType !== "run.failed"
          ? {}
          : {
              error: truncate(
                readString(payload, "message") || "Subagent failed.",
                MISSION_CHAT_ERROR_MAX_LENGTH,
              ),
            }
        : {
            error: truncate(readString(payload, "error"), MISSION_CHAT_ERROR_MAX_LENGTH),
          }),
    };
    const index = chat.entries.findIndex((candidate) => candidate.id === id);
    if (index === -1) chat.entries.push(entry);
    else chat.entries[index] = entry;
    return [{ type: "entry.upsert", entry }];
  }
  if (item.channel === "progress") {
    if (!isRootMissionRuntimeOutput(item)) return [];
    const payload = asRecord(item.value);
    const stage = payload["stage"];
    if (!isRuntimeContextCompactionStage(stage)) return [];
    const data = readRuntimeContextCompactionProgressData(payload["data"]);
    if (data === undefined) return [];
    const id = `context:${item.executionId}:${data.operationId}`;
    const existing = chat.entries.find((entry) => entry.id === id);
    const entry: MissionChatEntry = {
      ...base,
      id,
      kind: "context_operation",
      operationId: data.operationId,
      operation: "compaction",
      trigger: data.trigger,
      runtimeId: data.runtimeId,
      status:
        stage === RUNTIME_CONTEXT_COMPACTION_STAGES.started
          ? "running"
          : stage === RUNTIME_CONTEXT_COMPACTION_STAGES.completed
            ? "succeeded"
            : "failed",
      ...(data.errorMessage === undefined
        ? {}
        : { error: truncate(data.errorMessage, MISSION_CHAT_ERROR_MAX_LENGTH) }),
      createdAt: existing?.createdAt ?? item.occurredAt,
    };
    const index = chat.entries.findIndex((candidate) => candidate.id === id);
    if (index === -1) chat.entries.push(entry);
    else chat.entries[index] = entry;
    return [{ type: "entry.upsert", entry }];
  }
  if (item.source.parentSessionId !== undefined && options.includeNestedSource !== true) return [];
  if (item.channel === "thought") {
    const content = item.delta ?? formatValue(item.value, 200_000);
    if (content === "") return [];
    const current = chat.entries.at(-1);
    if (current?.kind === "thinking" && current.invocationId === item.invocationId) {
      const canAppend = current.content.length + content.length <= 200_000;
      current.content = truncate(current.content + content, 200_000);
      const patches: MissionChatPatch[] = canAppend
        ? [{ type: "entry.append", entryId: current.id, field: "content", delta: content }]
        : [{ type: "entry.upsert", entry: { ...current } }];
      if (!current.streaming) {
        current.streaming = true;
        patches.push({ type: "entry.streaming", entryId: current.id, streaming: true });
      }
      return patches;
    } else {
      const entry = {
        ...base,
        id: nextMessageEntryId(
          item.executionId,
          item.invocationId,
          item.runId,
          "thinking",
          chat.messageOrdinals,
        ),
        kind: "thinking" as const,
        content: truncate(content, 200_000),
        streaming: true,
      };
      chat.entries.push(entry);
      return [{ type: "entry.upsert", entry: { ...entry } }];
    }
  }
  if (item.channel === "message") {
    const content = item.delta ?? completedMessageText(item.value);
    const patches = markInvocationThinkingComplete(chat.entries, item.invocationId);
    const current = chat.entries.at(-1);
    if (
      item.delta !== undefined &&
      current?.kind === "assistant" &&
      current.invocationId === item.invocationId
    ) {
      const canAppend = current.content.length + content.length <= 200_000;
      current.content = truncate(current.content + content, 200_000);
      if (content !== "") {
        patches.push(
          canAppend
            ? { type: "entry.append", entryId: current.id, field: "content", delta: content }
            : { type: "entry.upsert", entry: { ...current } },
        );
      }
      if (!current.streaming) {
        current.streaming = true;
        patches.push({ type: "entry.streaming", entryId: current.id, streaming: true });
      }
    } else if (
      item.delta === undefined &&
      chat.entries.some(
        (entry) => entry.kind === "assistant" && entry.invocationId === item.invocationId,
      )
    ) {
      const last = [...chat.entries]
        .reverse()
        .find((entry) => entry.kind === "assistant" && entry.invocationId === item.invocationId);
      if (last?.kind === "assistant" && last.streaming) {
        last.streaming = false;
        patches.push({ type: "entry.streaming", entryId: last.id, streaming: false });
      }
    } else if (content !== "") {
      const entry = {
        ...base,
        id: nextMessageEntryId(
          item.executionId,
          item.invocationId,
          item.runId,
          "assistant",
          chat.messageOrdinals,
        ),
        kind: "assistant" as const,
        content: truncate(content, 200_000),
        streaming: item.delta !== undefined,
      };
      chat.entries.push(entry);
      patches.push({ type: "entry.upsert", entry: { ...entry } });
    }
    return patches;
  }
  if (item.channel === "tool") {
    const payload = asRecord(item.value);
    if (item.delta !== undefined) {
      const tool = [...chat.entries]
        .reverse()
        .find(
          (entry) =>
            entry.kind === "tool" &&
            entry.invocationId === item.invocationId &&
            entry.status === "running",
        );
      if (tool?.kind === "tool") {
        const delta = normalizeToolDelta(item.delta);
        const canAppend = (tool.outputPreview?.length ?? 0) + delta.length <= 801;
        tool.outputPreview = preview(`${tool.outputPreview ?? ""}${delta}`);
        return delta === ""
          ? []
          : canAppend
            ? [{ type: "entry.append", entryId: tool.id, field: "outputPreview", delta }]
            : [{ type: "entry.upsert", entry: { ...tool } }];
      }
      return [];
    }
    const toolCallId = readString(payload, "toolCallId") || item.sourceEventId;
    const existing = chat.entries.find(
      (entry) => entry.kind === "tool" && entry.toolCallId === toolCallId,
    );
    const toolName = readString(payload, "toolName") || "tool";
    if (existing?.kind === "tool") {
      if (payload["message"] !== undefined) {
        existing.status = "failed";
        existing.error = truncate(
          readString(payload, "message") || "Tool failed.",
          MISSION_CHAT_ERROR_MAX_LENGTH,
        );
      } else if (payload["approvalId"] !== undefined) {
        existing.status = "approval_required";
      } else if (payload["outputPreview"] !== undefined) {
        existing.status = "succeeded";
        existing.outputPreview = preview(payload["outputPreview"]);
      }
      return [{ type: "entry.upsert", entry: { ...existing } }];
    }
    const patches = markInvocationThinkingComplete(chat.entries, item.invocationId);
    const entry: MissionChatEntry = {
      ...base,
      id: `tool:${item.executionId}:${toolCallId}`,
      kind: "tool" as const,
      toolCallId,
      toolName,
      status:
        payload["message"] !== undefined
          ? "failed"
          : payload["approvalId"] !== undefined
            ? "approval_required"
            : payload["outputPreview"] !== undefined
              ? "succeeded"
              : "running",
      ...(payload["inputPreview"] === undefined
        ? {}
        : { inputPreview: preview(payload["inputPreview"]) }),
      ...(payload["outputPreview"] === undefined
        ? {}
        : { outputPreview: preview(payload["outputPreview"]) }),
      ...(payload["message"] === undefined
        ? {}
        : {
            error: truncate(
              readString(payload, "message") || "Tool failed.",
              MISSION_CHAT_ERROR_MAX_LENGTH,
            ),
          }),
    };
    chat.entries.push(entry);
    patches.push({ type: "entry.upsert", entry: { ...entry } });
    return patches;
  }
  if (item.channel === "result") {
    const content = formatValue(item.value, 200_000);
    if (
      content !== "" &&
      !chat.entries.some(
        (entry) => entry.kind === "assistant" && entry.invocationId === item.invocationId,
      )
    ) {
      const entry = {
        ...base,
        id: nextMessageEntryId(
          item.executionId,
          item.invocationId,
          item.runId,
          "assistant",
          chat.messageOrdinals,
        ),
        kind: "assistant" as const,
        content,
        streaming: false,
      };
      chat.entries.push(entry);
      return [{ type: "entry.upsert", entry: { ...entry } }];
    }
  }
  return [];
}

function readAgentActivityAction(
  value: string,
): Extract<MissionChatEntry, { kind: "agent_activity" }>["action"] | undefined {
  switch (value) {
    case "spawn":
    case "wait":
    case "list":
    case "send":
    case "resume":
    case "interrupt":
      return value;
    default:
      return undefined;
  }
}

function readAgentActivityPhase(
  value: string,
): Extract<MissionChatEntry, { kind: "agent_activity" }>["phase"] | undefined {
  switch (value) {
    case "started":
    case "completed":
    case "failed":
      return value;
    default:
      return undefined;
  }
}

async function listPendingHumanInteractions(
  execution: Pick<MutableExecution, "listEvents">,
): Promise<MissionHumanInteraction[]> {
  const events = await readAllExecutionEvents(execution);
  const responded = new Set(
    events
      .filter((event) => event.type === "human.responded")
      .map((event) => String((event.data as { interactionId?: unknown }).interactionId)),
  );
  return events.flatMap((event) => {
    if (event.type !== "human.requested") return [];
    const data = event.data as { interactionId?: unknown; request?: unknown };
    const interactionId = String(data.interactionId ?? "");
    if (interactionId === "" || responded.has(interactionId)) return [];
    const request = ExpertAgentHumanRequestSchema.safeParse(data.request);
    return request.success ? [{ interactionId, request: toDesktopHumanRequest(request.data) }] : [];
  });
}

function completedMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  const content = asRecord(value)["content"];
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      const record = asRecord(item);
      return record["type"] === "text" ? [readString(record, "text")] : [];
    })
    .join("");
}

function normalizeToolDelta(delta: string): string {
  try {
    const parsed = JSON.parse(delta) as unknown;
    const content = asRecord(parsed)["content"];
    if (!Array.isArray(content)) return formatValue(parsed, 800);
    return content.map((item) => readString(asRecord(item), "text")).join("\n");
  } catch {
    return delta;
  }
}

function markInvocationThinkingComplete(
  entries: MissionChatEntry[],
  invocationId: string,
): MissionChatPatch[] {
  const patches: MissionChatPatch[] = [];
  for (const entry of entries) {
    if (entry.kind === "thinking" && entry.invocationId === invocationId && entry.streaming) {
      entry.streaming = false;
      patches.push({ type: "entry.streaming", entryId: entry.id, streaming: false });
    }
  }
  return patches;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function preview(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const formatted = formatValue(value, 801);
  return formatted === "" ? undefined : formatted;
}

function missionWorkOutputSummary(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const output = InvocationOutputSchema.safeParse(value);
  const summary = output.success
    ? output.data.type === "inline"
      ? readableSummary(output.data.value, new Set(), 0)
      : output.data.summary.trim()
    : readableSummary(value, new Set(), 0);
  return summary === "" ? undefined : truncate(summary, maxLength);
}

function readableSummary(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > 8) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "";
    seen.add(value);
    return value
      .map((item) => readableSummary(item, seen, depth + 1))
      .filter((item) => item !== "")
      .join("\n");
  }
  if (typeof value !== "object" || value === null) return "";
  if (seen.has(value)) return "";
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of [
    "summary",
    "message",
    "text",
    "content",
    "answer",
    "result",
    "output",
    "value",
  ]) {
    const summary = readableSummary(record[key], seen, depth + 1);
    if (summary !== "") return summary;
  }
  for (const item of Object.values(record)) {
    const summary = readableSummary(item, seen, depth + 1);
    if (summary !== "") return summary;
  }
  return "";
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatValue(value: unknown, maxLength: number): string {
  let content: string;
  if (typeof value === "string") {
    content = value;
  } else if (value === undefined) {
    content = "";
  } else {
    try {
      content = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      content = String(value);
    }
  }
  return content.length <= maxLength
    ? content
    : `${content.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

async function hasPendingHumanInteraction(execution: {
  readonly listEvents: MutableExecution["listEvents"];
}): Promise<boolean> {
  const events = await readAllExecutionEvents(execution);
  const responded = new Set(
    events
      .filter((event) => event.type === "human.responded")
      .map((event) => String((event.data as { interactionId?: unknown }).interactionId)),
  );
  return events.some(
    (event) =>
      event.type === "human.requested" &&
      !responded.has(String((event.data as { interactionId?: unknown }).interactionId)),
  );
}

async function findHumanRequest(
  execution: MutableExecution,
  interactionId: string,
): Promise<ExpertAgentHumanRequest> {
  const events = await readAllExecutionEvents(execution);
  const event = events.find(
    (candidate) =>
      candidate.type === "human.requested" &&
      (candidate.data as { interactionId?: unknown }).interactionId === interactionId,
  );
  if (event === undefined) throw new Error(`Human interaction was not found: ${interactionId}`);
  return ExpertAgentHumanRequestSchema.parse((event.data as { request?: unknown }).request);
}

async function waitForRestoredHumanInteraction(
  execution: MutableExecution,
  interactionId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [state, pending] = await Promise.all([
      execution.getState().catch(() => undefined),
      listPendingHumanInteractions(execution).catch(() => []),
    ]);
    if (
      state?.status === "waiting" &&
      pending.some((interaction) => interaction.interactionId === interactionId)
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function readAllExecutionEvents(
  execution: Pick<MutableExecution, "listEvents">,
): Promise<Awaited<ReturnType<MutableExecution["listEvents"]>>["items"]> {
  const events: Array<Awaited<ReturnType<MutableExecution["listEvents"]>>["items"][number]> = [];
  let after: Awaited<ReturnType<MutableExecution["listEvents"]>>["nextCursor"] | undefined;
  do {
    const page = await execution.listEvents({
      scope: { kind: "all" },
      limit: 1_000,
      ...(after === undefined ? {} : { after }),
    });
    events.push(...page.items);
    after = page.nextCursor;
  } while (after !== undefined);
  return events;
}

export function toDesktopHumanRequest(request: ExpertAgentHumanRequest): HumanInteractionRequest {
  if (request.kind === "tool_approval") {
    return {
      kind: "approval",
      title: request.toolName,
      prompt: request.reason ?? `Approve ${request.toolName}?`,
      data: request.input,
    };
  }
  const approval = request.semantics?.kind === "approval";
  // `prompt` and `title` are legacy fields for the single-question/approval
  // surface. A multi-question request must be rendered from its indexed
  // question; copying the first item into `prompt` makes it appear below
  // every later question in the Desktop composer.
  const legacyQuestion =
    approval || request.questions.length === 1 ? request.questions[0] : undefined;
  return {
    kind: approval ? "approval" : "question",
    ...(legacyQuestion === undefined
      ? {}
      : { title: legacyQuestion.header, prompt: legacyQuestion.question }),
    questions: request.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
    ...(request.semantics === undefined ? {} : { approveOption: request.semantics.approveOption }),
  };
}

function toExpertHumanResponse(
  request: ExpertAgentHumanRequest,
  response: HumanInteractionResponse,
): ExpertAgentHumanResponse {
  if (request.kind === "tool_approval") {
    return {
      kind: "tool_approval",
      approved: response.approved ?? response.decision === "approved",
      ...(response.notes === undefined ? {} : { reason: response.notes }),
    };
  }
  const supplied =
    typeof response.answers === "object" && response.answers !== null
      ? { ...(response.answers as Record<string, unknown>) }
      : {};
  for (const question of request.questions) {
    if (supplied[question.question] !== undefined) continue;
    if (question.kind === "text" && response.notes !== undefined) {
      supplied[question.question] = response.notes;
      continue;
    }
    if (question.kind === "single_choice") {
      const approveOption = request.semantics?.approveOption;
      const selected =
        response.approved === undefined
          ? response.decision
          : response.approved
            ? approveOption
            : (response.decision ??
              question.options.find((option) => option.label !== approveOption)?.label);
      if (selected !== undefined) supplied[question.question] = selected;
    }
  }
  return {
    kind: "user_question",
    answered: true,
    answers: supplied,
    ...(response.notes === undefined || response.notes.trim() === ""
      ? {}
      : { notes: response.notes }),
  };
}

async function waitForExpertTurnSettlement(
  session: ExpertSession,
  requestId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [state, prompts] = await Promise.all([session.getState(), session.getPromptQueue()]);
    const prompt = prompts.find((candidate) => candidate.requestId === requestId);
    const settled =
      prompt !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(prompt.status) &&
      state.activeExecutionId !== prompt.executionId;
    if (settled) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
