import { trackMissionDeletionSettlement } from "./mission-deletion-settlement.ts";
import { createMissionDeletionService, type MissionDeletionService } from "@pragma/local-host";
import { fenceOwnerDeletion } from "@pragma/core";
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
  createFileExpertSessionStore,
  createPragma,
  createPragmaLogger,
  encodePragmaPathSegment,
  error,
  ExecutionController,
  ExecutionWorkHistoryReader,
  ExpertAgentHumanRequestSchema,
  ExpertSessionReleaseBlockedError,
  fingerprintExpertExecutionDefinition,
  hasUncertainSteerDelivery,
  isExpertTeam,
  isRuntimeContextCompactionNotNeededError,
  moveOwnedStorageToTrash,
  ok,
  PragmaPaths,
  readExecutionRunScope,
  ReadOnlyContextStore,
  readRuntimeSessionContextWindowUsage,
  readRuntimeSessionRecord,
  runtimeSessionDeletionSources,
  runtimeSupportsSteer,
  readRuntimeSessionsForOwners,
  withFileLock,
  StaticContextStore,
  StoredExecutionView,
  withStorageDiagnostics,
  type DurableExecutionStore,
  type ExecutionWorkRecord,
  type ExpertAgentAutomaticHumanInteractionHandler,
  type ExpertAgentContextStoreRegistrationInput,
  type ExpertAgentHumanRequest,
  type ExpertDefinition,
  type ExpertSession,
  type ExpertTurn,
  type HostContextBindingsResolver,
  type McpToolRegistryPool,
  type MutableExecution,
  type PragmaLogger,
  type RuntimeContextWindowUsage,
  type RuntimeModelSelection,
  type RuntimeResolver,
} from "@pragma/core";
import type {
  CompiledResource,
  InvocableResource,
  PragmaAdapterHost,
  PragmaInvocableResource,
  PragmaResource,
  PragmaResourceRef,
  ResolvedInvocableResource,
} from "@pragma/interpreter";
import {
  canonicalPragmaResourceRef,
  createPragmaResourceIdentityMigrationIndex,
} from "@pragma/interpreter";
import {
  createExpertSessionPromptQueueProjection,
  createLocalHostRunHandleState,
  createMissionBoard,
  createSqliteExecutionStore,
  createLocalHostMissionCommandAdmission,
  createLocalHostCoreMissionControlAdapter,
  createMissionControlApplication,
  createMissionControllerStore,
  createMissionOwnerScope,
  type MissionControlApplication,
  type MissionControlSubmitInput,
  hashCanonicalRunPayload,
  MissionExecutionOwner,
  type LocalHostRunEvent,
  type LocalHostRunHandle,
  type LocalHostRunRequest,
  type MissionOwnerScope,
  type ResolvedRunExecutor,
} from "@pragma/local-host";
import type {
  AgentMessageUsage,
  ExecutionEnvironmentSnapshot,
  ExecutionEvent,
  HumanInteractionRequest,
  RuntimeContextRecord,
} from "@pragma/shared";
import {
  BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS,
  ExpertAgentStreamEventSchema,
  isFinalExecutionStatus,
  resolvePragmaAvatarId,
  RuntimeContextWindowUsageSchema,
  type ExpertSessionEvent,
  type PromptRequest,
} from "@pragma/shared";
import { createIntegrationError } from "@pragma/shared/integration";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ContextStoreIdSchema,
  isUserFacingMissionOrigin,
  type DesktopToolPermissionMode,
  type GetMissionWorkConversation,
  MissionSchema,
  type Mission,
  type MissionChatEntry,
  type MissionChatPage,
  type MissionChatPageQuery,
  type MissionChatPatch,
  type MissionContextCompactionResult,
  type MissionContextMount,
  type MissionContextWindowSnapshot,
  type MissionContextWindowState,
  type MissionConversationState,
  type MissionHumanInteraction,
  type MissionModelOverride,
  type MissionWorkConversationSnapshot,
  type MissionWorkConversationStreamUpdate,
  type MissionWorkRecord,
  type MissionWorkSnapshot,
  type OpenMissionWorkConversationStream,
  type OpenMissionWorkConversationStreamResult,
  type UpdateMissionContextMounts,
  type UpdateMissionOptions,
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
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";
import type { DesktopUsageStore } from "../usage/usage-store.ts";
import { createDesktopAdapterHost } from "./mission-adapter-host.ts";
import { createMissionBranchContext } from "./mission-branch-context.ts";
import {
  createMissionExecutorAvatarIdResolver,
  createMissionExecutorNameResolver,
  ensureTerminalExecutionResultEntry,
  mergeMissionChatEntriesWithLive,
  messageRecordsToChatEntries,
  missionChatSyncIssue,
  readErrorMessage,
  readMissionChatHistory,
  readMissionChatHistoryPage,
  uniqueMissionChatEntries,
  workTaskInputEntries,
  type MissionChatSyncIssue,
} from "./mission-chat-history.ts";
import {
  consumeLiveChatOutput,
  isVisibleTextProjectionPatch,
  observeMissionChat,
  type LiveMissionChat,
} from "./mission-chat-live.ts";
import {
  asRecord,
  formatValue,
  isMissionTerminalExecutionStatus,
  isRootMissionRuntimeSource,
  missionWorkOutputSummary,
  readString,
  truncate,
} from "./mission-chat-projection-common.ts";
import { MissionChatService } from "./mission-chat-service.ts";
import { MissionCommandService } from "./mission-command-service.ts";
import { missionContextMountsFingerprint } from "./mission-context-mounts.ts";
import {
  hasMissionDeletionIntent,
  persistMissionDeletionIntent,
} from "./mission-deletion-intent.ts";
import { observeMissionExecution } from "./mission-execution-observer.ts";
import { createMissionOutputCoalescer } from "./mission-output-coalescer.ts";
import { observeMissionQueuedTurn } from "./mission-queued-turn-observer.ts";
import {
  readMissionConversationSnapshot,
  type MissionMessageApplicationResult,
  type MissionRunner,
  type MissionSurfaceAudience,
  type MissionWorkConversationStreamNotification,
} from "./mission-runner-contracts.ts";
import {
  createMissionResumeOptions,
  shouldCreateSuccessorExpertSession,
} from "./mission-session-upgrade.ts";
import { MissionStatusService } from "./mission-status-service.ts";
import { MissionStoreError } from "./mission-store-error.ts";
import type { MissionStore, MissionTimelineTurn } from "./mission-store.ts";
import { MissionWorkService } from "./mission-work-service.ts";

export { readMissionConversationSnapshot } from "./mission-runner-contracts.ts";
export type {
  MissionChatNotification,
  MissionCommandOutcomeNotification,
  MissionRunner,
  MissionSurfaceAudience,
  MissionWorkNotification,
} from "./mission-runner-contracts.ts";

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

interface ActiveMissionExecution {
  readonly handle: DesktopExecutionHandle;
  readonly settlement: Promise<void>;
  readonly admissionReady: Promise<void>;
  readonly terminalPublished: boolean;
  readonly audience: MissionSurfaceAudience;
  readonly live: LiveMissionChat;
  readonly releaseAfterHumanCheckpoint: () => Promise<void>;
}

type DesktopExecutionHandle = MutableExecution & {
  readonly result: Promise<unknown>;
  readonly checkpointWaitingHuman: () => Promise<void>;
};

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

interface MissionWorkConversationStreamSubscriber {
  readonly subscriptionId: string;
  readonly streamId: string;
  readonly missionId: string;
  readonly recordId: string;
  sequence: number;
  pendingUpdates:
    | Array<{
        readonly overlayRevision: number;
        readonly update: MissionWorkConversationUpdatePayload;
      }>
    | undefined;
}

type MissionWorkConversationUpdatePayload =
  | { readonly kind: "patch"; readonly patches: MissionChatPatch[] }
  | { readonly kind: "invalidate" };

interface MissionWorkConversationOverlay {
  readonly missionId: string;
  readonly recordId: string;
  readonly live: LiveMissionChat;
  revision: number;
}

interface MissionWorkConversationWatcher {
  readonly key: string;
  readonly overlay: MissionWorkConversationOverlay;
  readonly live: LiveMissionChat;
  readonly subscribers: Map<string, MissionWorkConversationStreamSubscriber>;
  close(): Promise<void>;
}

interface ExecutorMetadata {
  readonly names: ReadonlyMap<string, string>;
  readonly avatarIds: ReadonlyMap<string, string>;
}

export interface MissionExecutorPresentationMetadata {
  readonly id: string;
  readonly name: string;
  readonly avatarId?: string | undefined;
}

interface MissionExecutionContext {
  readonly app: ReturnType<typeof createPragma>;
  readonly runtimes: RuntimeResolver;
  readonly setToolPermissionMode: (mode: DesktopToolPermissionMode) => void;
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

export async function resolveMissionSystemDependencyFingerprints(input: {
  readonly mission: Mission;
  readonly project: Pick<PragmaProjectStore, "getRevision">;
  readonly getSystemExecutorFingerprint?:
    ((ref: string) => string | undefined | Promise<string | undefined>) | undefined;
  readonly getSystemExecutorResource?:
    ((ref: string) => PragmaInvocableResource | undefined) | undefined;
}): Promise<readonly (readonly [string, string])[]> {
  const fingerprints = new Map<string, string>();
  const visited = new Set<string>();
  let projectSnapshotPromise: ReturnType<typeof input.project.getRevision> | undefined;
  const getProjectSnapshot = () =>
    (projectSnapshotPromise ??= input.project.getRevision(input.mission.project.revision));

  const visit = async (ref: string): Promise<void> => {
    if (visited.has(ref)) return;
    visited.add(ref);
    const fingerprint = await input.getSystemExecutorFingerprint?.(ref);
    if (fingerprint !== undefined) fingerprints.set(ref, fingerprint);
    const systemResource = input.getSystemExecutorResource?.(ref);
    if (systemResource === undefined && fingerprint !== undefined) return;
    const resource =
      systemResource ??
      (await getProjectSnapshot()).resources.find(
        (candidate) => canonicalPragmaResourceRef(candidate) === ref,
      );
    if (resource === undefined) return;
    await Promise.all(
      [...referencedPragmaResourceRefs([resource])].map(async (dependencyRef) => {
        await visit(dependencyRef);
      }),
    );
  };

  await visit(input.mission.executor.ref);
  return [...fingerprints.entries()].toSorted(([left], [right]) => left.localeCompare(right));
}

export function createMissionRunner(options: {
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
    | ((mission: Mission) => Promise<readonly ExpertAgentContextStoreRegistrationInput[]>)
    | undefined;
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
        readonly knowledgeRevisions?: KnowledgeRevisionSubmissionPort | undefined;
        readonly resolveExternalInvocable: (
          ref: PragmaResourceRef,
        ) => Promise<ResolvedInvocableResource | undefined>;
      }) => Promise<CompiledResource<InvocableResource> | undefined>)
    | undefined;
  readonly getSystemExecutorFingerprint?:
    ((ref: string) => string | undefined | Promise<string | undefined>) | undefined;
  readonly getSystemExecutorMetadata?:
    (() => readonly MissionExecutorPresentationMetadata[]) | undefined;
  readonly getSystemExecutorResource?:
    ((ref: string) => PragmaInvocableResource | undefined) | undefined;
  readonly pragmaManagementPorts?:
    (() => Omit<PragmaManagementToolPorts, "knowledgeRevisions">) | undefined;
  readonly registerExecutionDelivery?:
    | ((mission: Mission, executionId: string, requestId: string) => void | Promise<void>)
    | undefined;
  readonly deferTerminalProjection?: boolean | undefined;
  readonly wakeExecutionDelivery?: (() => void) | undefined;
  readonly assertExecutorReady?: ((ref: string) => void | Promise<void>) | undefined;
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
  readonly onMissionActivity?:
    ((input: { readonly mission: Mission }) => Promise<void>) | undefined;
  readonly invalidateRuntimeReadiness?: (() => void) | undefined;
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
}): MissionRunner {
  const logger = createPragmaLogger(options.loggerProvider, {
    component: "desktop.mission-runner",
  });
  const executionStore =
    options.executionStore ??
    createSqliteExecutionStore({ pragmaHome: options.pragmaHome, logger });
  const notifyExecutionLinked = async (
    mission: Mission,
    executionId: string,
    requestId: string,
  ): Promise<void> => {
    await options.registerExecutionDelivery?.(mission, executionId, requestId);
    try {
      await retryMissionEventProjection(async () =>
        options.onExecutionLinked?.({ mission, executionId, requestId }),
      );
    } catch (error) {
      logger.warn(
        "mission.execution_link_projection_degraded",
        "The Core execution started, but its Mission event anchor needs recovery.",
        {
          error,
          missionId: mission.id,
          executionId,
          errorCode: "MISSION_EXECUTION_LINK_PROJECTION_DEGRADED",
          retryable: true,
        },
      );
    }
    try {
      await options.onExecutionContextLinked?.({ mission, executionId, requestId });
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
    logger,
    executions: executionStore,
    pragmaHome: options.pragmaHome,
  });
  const executionOwner = new MissionExecutionOwner<
    MissionExecutionContext,
    Mission,
    MissionContextCompactionResult,
    ActiveMissionExecution
  >();
  const sessionService = executionOwner;
  const executorMetadataCache = new Map<string, ExecutorMetadata>();
  const promptQueueProjection = createExpertSessionPromptQueueProjection({
    sessions: expertSessionStore,
    resolveSessionId: async (missionId) => {
      const live = sessionService.session(missionId);
      if (live !== undefined) return live.sessionId;
      const mission = await options.missions.get(missionId);
      return mission.execution?.sessionId;
    },
    steeringFeatures: async (_sessionId, session) => {
      const rootContext = session.contexts[session.rootContextId];
      const resolved =
        rootContext === undefined
          ? undefined
          : await options.runtimes
              .resolve({ binding: rootContext.runtime, modelSelection: rootContext.modelSelection })
              .catch(() => undefined);
      return {
        supportsSteer:
          resolved === undefined ? false : await runtimeSupportsSteer(resolved.adapter),
        steeringRecovery: resolved?.adapter.features.steering.steeringRecovery,
      };
    },
    resolvePromptMetadata: async (prompt) => ({
      hasAttachments: hasPromptAttachments(
        (await executionStore.getInvocation(prompt.executionId, prompt.executionId))?.input,
      ),
    }),
  });
  const workHistory = new ExecutionWorkHistoryReader(executionStore);
  const publishPromptQueue = async (mission: Mission): Promise<void> => {
    try {
      const queue = await promptQueueProjection.list(mission.id);
      chatService.emitPatches(mission.id, missionSurfaceAudience(mission), [
        {
          type: "queue.update",
          queue: {
            state: queue.state,
            pendingCount: queue.pendingCount,
            supportsSteer: queue.supportsSteer,
            deliveryUncertain: queue.deliveryUncertain,
            steeringRecovery: queue.steeringRecovery,
            pausedAfterRequestId: queue.pausedAfterRequestId,
            items: queue.items
              .filter((item) => item.status === "queued")
              .map((item) => ({
                requestId: item.requestId,
                content: item.content,
                hasAttachments: item.hasAttachments,
              })),
          },
        },
      ]);
    } catch (error) {
      // The prompt mutation has already committed. Projection failure must not
      // turn a successful admission/steer into a failed Inbox operation.
      logger.warn("mission.queue_projection_degraded", "Queue control projection needs a refresh", {
        missionId: mission.id,
        error,
        retryable: true,
      });
      chatService.invalidate(mission.id, missionSurfaceAudience(mission));
    }
  };
  const runtimeResolverForToolPermissionMode = (mode: DesktopToolPermissionMode) =>
    options.runtimesForToolPermissionMode?.(mode) ?? options.runtimes;
  const automaticHumanInteractionHandlerForToolPermissionMode = (mode: DesktopToolPermissionMode) =>
    options.automaticHumanInteractionHandlerForToolPermissionMode?.(mode) ??
    options.automaticHumanInteractionHandler;
  const invalidateContextBindings = async (id: string): Promise<void> => {
    sessionService.invalidateContextBindings(id);
    const session = sessionService.session(id);
    if (session === undefined || lifecycleService.hasActive(id)) return;
    const hasQueuedPrompts = (await session.getPromptQueue()).some(
      (prompt) => prompt.status === "queued" || prompt.status === "running",
    );
    if (hasQueuedPrompts) return;
    await session.close("Mission context bindings changed.");
    sessionService.deleteSession(id);
  };
  const executionContext = async (mission: Mission): Promise<MissionExecutionContext> => {
    const existing = sessionService.executionContext(mission.id);
    if (existing !== undefined) return await existing;
    const creating = createExecutionContext(mission);
    sessionService.setExecutionContext(mission.id, creating);
    try {
      return await creating;
    } catch (error) {
      sessionService.deleteExecutionContextIfCurrent(mission.id, creating);
      throw error;
    }
  };
  const createExecutionContext = async (mission: Mission): Promise<MissionExecutionContext> => {
    let executionGuard: Awaited<ReturnType<MissionOwnerScope["acquire"]>> | undefined;
    const assertExecutionOwnership =
      options.ownerScope === undefined
        ? undefined
        : async () => {
            executionGuard ??= await options.ownerScope!.acquire(mission.id);
            await options.ownerScope!.assertOwnership(mission.id, executionGuard);
          };
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
              : await executionStore.getInvocation(provenance.executionId, provenance.invocationId);
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
            async (mount) => (await options.contextStoreRevisions!.getDraft(mount.draftId)).storeId,
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
    const resolveConfiguredHostContextBindings = async (): Promise<
      readonly ExpertAgentContextStoreRegistrationInput[]
    > => {
      if (systemMission || options.hostContextStores === undefined) return [];
      return typeof options.hostContextStores === "function"
        ? await options.hostContextStores(mission)
        : options.hostContextStores;
    };
    const resolveHostContextBindings: HostContextBindingsResolver = async () => [
      ...(await resolveConfiguredHostContextBindings()),
      ...legacyExecutionOutputBindings,
      ...branchHistoryBindings,
      ...board.bindings,
      ...(await resolveMissionKnowledgeBindings()),
      ...(await resolveActiveKnowledgeRevisionBindings()),
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
        assertExecutionOwnership,
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
          return await automaticHumanInteractionHandlerForToolPermissionMode(toolPermissionMode)?.(
            request,
          );
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
                            (resource) => [resource.metadata.id, resource.metadata.name] as const,
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
      }),
      setToolPermissionMode: (mode: DesktopToolPermissionMode) => {
        toolPermissionMode = mode;
      },
    };
    return context;
  };
  const lifecycleService = executionOwner;
  const commandService = new MissionCommandService(({ error, notification }) => {
    logger.error(
      "mission.command_outcome_listener_failed",
      "A Mission command outcome listener failed.",
      error,
      { missionId: notification.missionId, requestId: notification.requestId },
    );
  });
  const chatService = new MissionChatService<LiveMissionChat>(
    ({ error, missionId }) => {
      logger.error(
        "mission.chat_listener_failed",
        `Failed to notify Mission chat listeners for ${missionId}.`,
        error,
        { missionId },
      );
    },
    (metrics) => {
      if (process.env["PRAGMA_STORAGE_DIAGNOSTICS"] === "1")
        logger.info("mission.read_completed", "Mission display read completed", metrics);
    },
  );
  const pendingHumanInteractionsByMission = new Map<
    string,
    {
      readonly executionId: string;
      readonly interactions: readonly MissionHumanInteraction[];
    }
  >();
  const respondedHumanInteractionsByMission = new Map<
    string,
    {
      readonly executionId: string;
      readonly interactionIds: ReadonlySet<string>;
    }
  >();
  const excludeRespondedHumanInteractions = (
    missionId: string,
    executionId: string | undefined,
    interactions: readonly MissionHumanInteraction[],
  ): MissionHumanInteraction[] => {
    const responded = respondedHumanInteractionsByMission.get(missionId);
    if (executionId === undefined || responded?.executionId !== executionId) {
      return [...interactions];
    }
    return interactions.filter(
      (interaction) => !responded.interactionIds.has(interaction.interactionId),
    );
  };
  const acknowledgeHumanInteractionResponse = (
    missionId: string,
    executionId: string,
    interactionId: string,
  ): void => {
    const current = respondedHumanInteractionsByMission.get(missionId);
    const interactionIds =
      current?.executionId === executionId ? new Set(current.interactionIds) : new Set<string>();
    interactionIds.add(interactionId);
    respondedHumanInteractionsByMission.set(missionId, { executionId, interactionIds });
    const cached = pendingHumanInteractionsByMission.get(missionId);
    if (cached?.executionId === executionId) {
      pendingHumanInteractionsByMission.set(missionId, {
        executionId,
        interactions: cached.interactions.filter(
          (interaction) => interaction.interactionId !== interactionId,
        ),
      });
    }
  };
  const clearHumanInteractionProjection = (
    missionId: string,
    executionId?: string | undefined,
  ): void => {
    const pending = pendingHumanInteractionsByMission.get(missionId);
    if (executionId === undefined || pending?.executionId === executionId) {
      pendingHumanInteractionsByMission.delete(missionId);
    }
    const responded = respondedHumanInteractionsByMission.get(missionId);
    if (executionId === undefined || responded?.executionId === executionId) {
      respondedHumanInteractionsByMission.delete(missionId);
    }
  };
  const workService = new MissionWorkService<LiveMissionChat>(({ error, missionId }) => {
    logger.error(
      "mission.work_listener_failed",
      `Failed to notify Mission work listeners for ${missionId}.`,
      error,
      { missionId },
    );
  });
  const workConversationStreamListeners = new Set<
    (notification: MissionWorkConversationStreamNotification) => void
  >();
  const workConversationStreams = new Map<
    string,
    {
      readonly missionId: string;
      readonly streamId: string;
      readonly watcher?: MissionWorkConversationWatcher | undefined;
    }
  >();
  const workConversationWatchers = new Map<string, MissionWorkConversationWatcher>();
  const workConversationWatcherPromises = new Map<
    string,
    Promise<MissionWorkConversationWatcher>
  >();
  // The reader, initial stream snapshot, refresh, and Load Earlier all resolve this same active
  // overlay so one cursor never crosses two different entry sets.
  const workConversationOverlays = new Map<string, MissionWorkConversationOverlay>();
  const workConversationOverlayKey = (missionId: string, recordId: string): string =>
    JSON.stringify([missionId, recordId]);
  const emitWorkConversationStreamUpdate = (update: MissionWorkConversationStreamUpdate): void => {
    for (const listener of workConversationStreamListeners) {
      try {
        listener({ update });
      } catch (error) {
        logger.error(
          "mission.work_conversation_listener_failed",
          `Failed to notify Mission work conversation listeners for ${update.missionId}.`,
          error,
          { missionId: update.missionId, recordId: update.recordId },
        );
      }
    }
  };
  const emitWorkConversationSubscriberUpdate = (
    subscriber: MissionWorkConversationStreamSubscriber,
    update: MissionWorkConversationUpdatePayload,
  ): void => {
    emitWorkConversationStreamUpdate({
      subscriptionId: subscriber.subscriptionId,
      streamId: subscriber.streamId,
      sequence: ++subscriber.sequence,
      missionId: subscriber.missionId,
      recordId: subscriber.recordId,
      ...update,
    });
  };
  const statusService =
    options.missionStatus ??
    new MissionStatusService(({ error, missionId }) => {
      logger.error(
        "mission.status_listener_failed",
        `Failed to notify Mission status listeners for ${missionId}.`,
        error,
        { missionId },
      );
    });

  const refreshMemoryContextBindings = async (): Promise<void> => {
    for (const [missionId, session] of sessionService.sessionEntries()) {
      sessionService.markMemoryBindingsChanged(missionId);
      if (lifecycleService.hasActive(missionId)) continue;
      try {
        await session.close("Memory policy changed.");
      } catch (error) {
        logger.warn(
          "mission.memory_context_refresh_failed",
          `Mission ${missionId} could not close its previous Expert Session after the Memory policy changed.`,
          { error, missionId },
        );
      } finally {
        sessionService.deleteSession(missionId);
        sessionService.clearCompilation(missionId);
      }
    }
  };

  const readExecutorMetadata = async (
    mission: Pick<Mission, "project">,
  ): Promise<ExecutorMetadata> => {
    const resources = await withOpenPragmaProjectRevision(
      options.project,
      mission.project.revision,
      async (project) => project.listResources(),
    );
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

  const readSystemExecutorMetadata = (): readonly MissionExecutorPresentationMetadata[] => {
    try {
      return options.getSystemExecutorMetadata?.() ?? [];
    } catch (error) {
      logger.warn(
        "mission.system_executor_names_unavailable",
        "System Expert presentation metadata could not be read.",
        { error },
      );
      return [];
    }
  };

  const getExecutorMetadata = async (
    mission: Pick<Mission, "project">,
  ): Promise<ExecutorMetadata> => {
    const projectKey = `${mission.project.id}:${mission.project.revision}`;
    const existing = executorMetadataCache.get(projectKey);
    const projectMetadata = existing ?? (await readExecutorMetadata(mission));
    if (existing === undefined) executorMetadataCache.set(projectKey, projectMetadata);
    return mergeMissionExecutorMetadata(projectMetadata, readSystemExecutorMetadata());
  };

  const getExecutorMetadataOrFallback = async (
    mission: Mission,
    surface: "live" | "historical" | "work",
  ): Promise<ExecutorMetadata> =>
    await getExecutorMetadata(mission).catch((error: unknown) => {
      logger.warn(
        "mission.executor_names_unavailable",
        `Mission ${mission.id} could not read Project Expert names for ${surface} output labels.`,
        { error, missionId: mission.id },
      );
      // Keep built-in/system identities available even when the pinned Project Revision cannot be
      // opened. The root Expert can still resolve from the immutable Mission executor snapshot;
      // any remaining identity stays unresolved so the renderer can use a localized unavailable
      // label instead of exposing an opaque resource id.
      return mergeMissionExecutorMetadata(
        { names: new Map<string, string>(), avatarIds: new Map<string, string>() },
        readSystemExecutorMetadata(),
      );
    });

  // A controller lease fences other processes; it does not serialize callers
  // inside this Host. Reserve admission before any async startup work so Inbox
  // sends cannot open a competing Session while the initial run is preparing.
  const withMissionPromptAdmission = async <T>(
    missionId: string,
    operation: () => Promise<T>,
    requestId?: string,
  ): Promise<T> => {
    const queuedAt = performance.now();
    return await executionOwner.admit(missionId, () => {
      logMissionPhase(
        logger,
        missionId,
        "prompt_admission_wait",
        queuedAt,
        queuedAt,
        requestId === undefined ? {} : { requestId },
      );
      return withStorageDiagnostics(
        {
          family: "mission-admission",
          ownerId: missionId,
          operation: "prepare",
          ...(requestId === undefined ? {} : { requestId }),
        },
        operation,
        logger,
      );
    });
  };

  const startMission = (id: string): Promise<Mission> => {
    return lifecycleService.startRun(id, (generation) =>
      withMissionPromptAdmission(id, () =>
        withMissionController(id, async () => {
          if (!lifecycleService.isRunGenerationCurrent(id, generation)) {
            throw createIntegrationError({
              code: "MISSION_FENCING_REJECTED",
              category: "conflict",
              message: "This Mission run was superseded before it acquired its controller lease.",
              details: { missionId: id, runGeneration: generation },
            });
          }
          return await runMission(id, generation);
        }),
      ),
    );
  };

  const assertRunGenerationCurrent = (
    missionId: string,
    runGeneration: number,
    phase: string,
  ): void => {
    if (lifecycleService.isRunGenerationCurrent(missionId, runGeneration)) return;
    throw createIntegrationError({
      code: "MISSION_FENCING_REJECTED",
      category: "conflict",
      message: `Mission recovery was superseded ${phase}.`,
      details: { missionId, runGeneration, phase },
    });
  };

  const emitChatPatches = (
    id: string,
    audience: MissionSurfaceAudience,
    patches: readonly MissionChatPatch[],
  ): void => chatService.emitPatches(id, audience, patches);

  const invalidateChat = (
    id: string,
    audience: MissionSurfaceAudience,
    options: { readonly userVisibleOutput?: true | undefined } = {},
  ): void => chatService.invalidate(id, audience, options);

  const invalidateWork = (id: string, audience: MissionSurfaceAudience): void =>
    workService.invalidate(id, audience);

  async function attachNextSessionTurn(
    id: string,
    audience: MissionSurfaceAudience,
  ): Promise<void> {
    const session = sessionService.session(id);
    if (session === undefined || lifecycleService.hasActive(id)) return;
    if (sessionService.contextBindingChangeInProgress(id)) {
      invalidateChat(id, audience);
      return;
    }
    if (sessionService.successorRequired(id)) {
      invalidateChat(id, audience);
      return;
    }
    while (true) {
      if (
        sessionService.contextBindingChangeInProgress(id) ||
        sessionService.successorRequired(id)
      ) {
        invalidateChat(id, audience);
        break;
      }
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
        if (
          lifecycleService.hasActive(id) ||
          sessionService.contextBindingChangeInProgress(id) ||
          sessionService.successorRequired(id)
        ) {
          break;
        }
        const turn = (await session.listTurns()).find(
          (candidate) => candidate.executionId === nextPrompt.executionId,
        );
        if (turn !== undefined) {
          const startedAt =
            nextPrompt.status === "running" ? nextPrompt.updatedAt : nextPrompt.createdAt;
          const linked = await options.missions.updateExecution(
            id,
            {
              id: turn.executionId,
              inputMessageId: nextPrompt.requestId,
              sessionId: session.sessionId,
              status: "running",
              startedAt,
            },
            { executionId: mission.execution?.id },
          );
          if (linked.execution?.id !== turn.executionId || lifecycleService.hasActive(id)) break;
          trackExecution({
            mission,
            handle: turn,
            executorMetadata: await getExecutorMetadataOrFallback(mission, "live"),
            startedAt,
            inputMessageId: nextPrompt.requestId,
            sessionId: session.sessionId,
            onFinished: async () => await turn.settled,
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
    handle: DesktopExecutionHandle,
    expectedLive: LiveMissionChat,
    audience: MissionSurfaceAudience,
    attachNextTurn = true,
    userVisibleOutput = false,
    onDetached?: () => void,
  ): Promise<void> => {
    clearHumanInteractionProjection(id, handle.executionId);
    if (lifecycleService.active(id)?.handle !== handle) {
      await expectedLive.close();
      onDetached?.();
      return;
    }
    forgetFlowControlOwner(id, handle);
    lifecycleService.deleteActive(id);
    await chatService.closeLiveIfCurrent(id, expectedLive);
    // A queued turn can install its projection while the old subscriptions close.
    if (lifecycleService.hasActive(id) || chatService.live(id) !== undefined) {
      onDetached?.();
      return;
    }
    workService.clearLive(id);
    chatService.clearContextWindow(id);
    invalidateChat(id, audience, userVisibleOutput ? { userVisibleOutput: true } : {});
    invalidateWork(id, audience);
    onDetached?.();
    if (attachNextTurn) await attachNextSessionTurn(id, audience);
  };

  const forgetFlowControlOwner = (id: string, handle: DesktopExecutionHandle): void => {
    const owner = executionOwner.controlOwner(id);
    if (owner?.kind === "flow" && owner.execution === handle)
      executionOwner.deleteControlOwnerIfCurrent(id, owner);
  };

  const awaitTerminalLifecycleSettlement = async (
    mission: Mission,
    admissionOnly = false,
  ): Promise<boolean> => {
    const active = lifecycleService.active(mission.id);
    if (
      mission.execution === undefined ||
      active === undefined ||
      active.handle.executionId !== mission.execution.id
    )
      return false;
    if (
      ["queued", "running", "waiting"].includes(mission.execution.status) &&
      !(admissionOnly && active.terminalPublished)
    )
      return false;
    const startedAt = performance.now();
    const outcome = await settlementOutcomeWithin(
      admissionOnly ? active.admissionReady : active.settlement,
      5_000,
    );
    logMissionPhase(logger, mission.id, "terminal_lifecycle_settlement", startedAt, startedAt, {
      outcome: outcome.status,
    });
    if (outcome.status === "timed_out") {
      logger.warn(
        "mission.terminal_cleanup_pending",
        "Mission terminal state is visible while its bounded observer cleanup remains pending.",
        { missionId: mission.id, executionId: mission.execution.id, retryable: true },
      );
    }
    if (outcome.status === "rejected") {
      logger.warn(
        "mission.terminal_cleanup_failed",
        "Mission terminal state is visible while its observer cleanup reported a failure.",
        { error: outcome.error, missionId: mission.id, executionId: mission.execution.id },
      );
    }
    return true;
  };

  const compileMissionExecutor = async (
    mission: Mission,
    runtimes: RuntimeResolver,
    revisionReader: Pick<PragmaProjectStore, "getRevision"> = options.project,
    purpose: "execute" | "stop" = "execute",
  ): Promise<CompiledResource<InvocableResource>> => {
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
                    : executionStore.getInvocation(provenance.executionId, provenance.invocationId),
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
                    ).some((prompt) => prompt.status === "queued" || prompt.status === "running");
                    if (
                      lifecycleService.hasActive(previousMissionId) ||
                      previousHasQueuedPrompts ||
                      (previousMission.execution !== undefined &&
                        ["queued", "running", "waiting"].includes(previousMission.execution.status))
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
                    await options.contextStoreRevisions!.attachMission(revisionJobId, mission.id);
                  } else {
                    await options.contextStoreRevisions!.attachMission(revisionJobId, mission.id);
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
                      await options.contextStoreRevisions!.detachMission(revisionJobId, mission.id);
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
        pragmaManagementScope: { missionId: mission.id, workspacePath: mission.workspace.path },
        ...(Object.keys(pragmaManagement).length === 0 ? {} : { pragmaManagement }),
      },
      mission.workspace.path,
    );
    let projectSnapshotPromise: ReturnType<typeof options.project.getRevision> | undefined;
    const getProjectSnapshot = () =>
      (projectSnapshotPromise ??= revisionReader.getRevision(mission.project.revision));
    const completed = new Map<
      string,
      {
        readonly resource?: PragmaInvocableResource | undefined;
        readonly compiled: CompiledResource<InvocableResource>;
      }
    >();
    const compileRef = async (
      ref: PragmaResourceRef,
      ancestors: ReadonlySet<string> = new Set(),
    ): Promise<{
      readonly resource?: PragmaInvocableResource | undefined;
      readonly compiled: CompiledResource<InvocableResource>;
    }> => {
      const cached = completed.get(ref);
      if (cached !== undefined) return cached;
      if (ancestors.has(ref)) {
        throw new Error(`Cyclic external resource dependency: ${ref}`);
      }
      const nextAncestors = new Set(ancestors).add(ref);
      return await (async () => {
        const resolveExternalInvocable = async (
          targetRef: PragmaResourceRef,
        ): Promise<ResolvedInvocableResource | undefined> => {
          const target = await compileRef(targetRef, nextAncestors);
          if (target.resource === undefined) {
            throw new Error(`System resource descriptor not found: ${targetRef}`);
          }
          return { resource: target.resource, value: target.compiled.value };
        };
        const externalMission = {
          ...mission,
          executor:
            ref === mission.executor.ref
              ? mission.executor
              : {
                  kind: ref.startsWith("team:")
                    ? ("team" as const)
                    : ref.startsWith("flow:")
                      ? ("flow" as const)
                      : ("expert" as const),
                  ref,
                  name: ref,
                },
        };
        const system = await options.compileSystemExecutor?.({
          mission: externalMission,
          runtimes,
          knowledgeRevisions,
          resolveExternalInvocable,
        });
        const systemResource = options.getSystemExecutorResource?.(ref);
        if (
          system !== undefined &&
          (systemResource !== undefined || ref === mission.executor.ref)
        ) {
          const resolved = { resource: systemResource, compiled: system };
          completed.set(ref, resolved);
          return resolved;
        }
        const projectSnapshot = await getProjectSnapshot();
        const projectResource = projectSnapshot.resources.find(
          (candidate): candidate is PragmaInvocableResource =>
            (candidate.kind === "Expert" ||
              candidate.kind === "ExpertTeam" ||
              candidate.kind === "Flow") &&
            canonicalPragmaResourceRef(candidate) === ref,
        );
        if (system !== undefined && projectResource !== undefined) {
          const resolved = { resource: projectResource, compiled: system };
          completed.set(ref, resolved);
          return resolved;
        }
        const resource = projectResource;
        if (resource === undefined) throw new Error(`Pragma resource not found: ${ref}`);
        const compiled = await options.project.compile<InvocableResource>({
          projectId: mission.project.id,
          revision: mission.project.revision,
          ref,
          workspace: mission.workspace.path,
          pragmaHome: options.pragmaHome,
          environmentId: "desktop",
          adapterHost:
            purpose === "stop"
              ? desktopAdapterHost
              : (options.adapterHostForMission?.(externalMission, desktopAdapterHost) ??
                desktopAdapterHost),
          runtimes,
          resolveExternalInvocable,
          ...(mission.modelOverride === undefined || ref !== mission.executor.ref
            ? {}
            : { rootModelSelectionOverride: toRuntimeModelSelection(mission.modelOverride) }),
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
        const resolved = { resource, compiled };
        completed.set(ref, resolved);
        return resolved;
      })();
    };

    return (await compileRef(mission.executor.ref as PragmaResourceRef)).compiled;
  };

  type ResolvedCapabilityEnvironment = {
    readonly capabilityId: string;
    readonly resolvedRevision: number;
    readonly fingerprint: string;
  };

  const createIdentityReadScope = (mission: Mission, diagnosticLogger = logger) => {
    let revision: ReturnType<PragmaProjectStore["getRevision"]> | undefined;
    const project: Pick<PragmaProjectStore, "getRevision"> = {
      getRevision: (revisionNumber) => {
        if (revisionNumber !== mission.project.revision)
          return options.project.getRevision(revisionNumber);
        return (revision ??= (async () => {
          const startedAt = performance.now();
          try {
            return await options.project.getRevision(revisionNumber);
          } finally {
            logMissionPhase(
              diagnosticLogger,
              mission.id,
              "identity_revision_read",
              startedAt,
              startedAt,
            );
          }
        })());
      },
    };
    return { project, logger: diagnosticLogger };
  };

  const compilationIdentity = async (
    mission: Mission,
    capabilities: readonly ResolvedCapabilityEnvironment[],
    scope = createIdentityReadScope(mission),
  ): Promise<string> => {
    const startedAt = performance.now();
    const systemExecutorFingerprints = await resolveMissionSystemDependencyFingerprints({
      mission,
      project: scope.project,
      getSystemExecutorFingerprint: options.getSystemExecutorFingerprint,
      getSystemExecutorResource: options.getSystemExecutorResource,
    });
    logMissionPhase(
      scope.logger,
      mission.id,
      "system_dependency_fingerprints",
      startedAt,
      startedAt,
    );
    return createHash("sha256")
      .update(
        JSON.stringify({
          project: mission.project,
          executor: mission.executor,
          contextMounts: missionContextMountsFingerprint(mission),
          systemExecutorFingerprints,
          toolPermissionMode: mission.toolPermissionMode,
          modelOverride: mission.modelOverride ?? null,
          capabilities,
        }),
      )
      .digest("hex");
  };

  const missionCapabilityIds = async (
    mission: Mission,
    scope = createIdentityReadScope(mission),
  ): Promise<readonly string[]> => {
    let resourcesPromise: Promise<ReadonlyMap<string, PragmaResource>> | undefined;
    const projectResources = async (): Promise<ReadonlyMap<string, PragmaResource>> =>
      await (resourcesPromise ??= scope.project
        .getRevision(mission.project.revision)
        .then(
          (snapshot) =>
            new Map(
              snapshot.resources.map((resource) => [
                canonicalPragmaResourceRef(resource),
                resource,
              ]),
            ),
        ));
    const visited = new Set<string>();
    const capabilityIds = new Set<string>();
    const visit = async (ref: string): Promise<void> => {
      if (visited.has(ref)) return;
      visited.add(ref);
      const systemResource = options.getSystemExecutorResource?.(ref);
      if (
        systemResource === undefined &&
        (await options.getSystemExecutorFingerprint?.(ref)) !== undefined
      ) {
        return;
      }
      const resource = systemResource ?? (await projectResources()).get(ref);
      if (resource === undefined) return;
      if (resource.kind === "Capability") {
        const binding = resource.spec.binding;
        const capabilityId =
          binding === undefined
            ? undefined
            : (parseDesktopCapabilityBindingRef(binding) ??
              parseLegacyDesktopCapabilityBindingRef(binding)?.id);
        if (capabilityId !== undefined) capabilityIds.add(capabilityId);
      }
      await Promise.all(
        [...referencedPragmaResourceRefs([resource])].map(async (dependencyRef) => {
          await visit(dependencyRef);
        }),
      );
    };
    await visit(mission.executor.ref);
    return [...capabilityIds].toSorted();
  };

  const capabilityEnvironmentIdentity = async (
    mission: Mission,
    scope = createIdentityReadScope(mission),
  ): Promise<ResolvedCapabilityEnvironment[]> => {
    const active = await Promise.all(
      (await missionCapabilityIds(mission, scope)).map(async (capabilityId) => {
        const activeStartedAt = performance.now();
        const capability = await options.capabilityStore.resolveActive(capabilityId);
        logMissionPhase(
          scope.logger,
          mission.id,
          "capability_active_read",
          activeStartedAt,
          activeStartedAt,
        );
        const credentialsStartedAt = performance.now();
        const credentials = await options.capabilityCredentials.fingerprint(capability.manifest.id);
        logMissionPhase(
          scope.logger,
          mission.id,
          "capability_credentials_fingerprint",
          credentialsStartedAt,
          credentialsStartedAt,
        );
        return {
          capabilityId: capability.manifest.id,
          resolvedRevision: capability.manifest.latestRevision,
          fingerprint: createHash("sha256")
            .update(JSON.stringify({ definition: capability.definition, credentials }))
            .digest("hex"),
        };
      }),
    );
    return active.toSorted((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  };

  const executionEnvironmentSnapshot = async (
    compiled: CompiledResource<InvocableResource>,
    capabilities: readonly ResolvedCapabilityEnvironment[],
  ): Promise<ExecutionEnvironmentSnapshot> => {
    return {
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            compiledEnvironment: compiled.environmentFingerprint.value,
            capabilities,
          }),
        )
        .digest("hex"),
      resources: capabilities.map((capability) => ({
        kind: "capability",
        id: capability.capabilityId,
        revision: capability.resolvedRevision,
        fingerprint: capability.fingerprint,
      })),
    };
  };

  const compileMissionExecutorWithStableCapabilities = async (
    mission: Mission,
    runtimes: RuntimeResolver,
    scope = createIdentityReadScope(mission),
  ): Promise<{
    readonly compiled: CompiledResource<InvocableResource>;
    readonly capabilities: ResolvedCapabilityEnvironment[];
    readonly identity: string;
  }> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await capabilityEnvironmentIdentity(mission, scope);
      const compiled = await compileMissionExecutor(mission, runtimes, scope.project);
      const after = await capabilityEnvironmentIdentity(mission, scope);
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return {
          compiled,
          capabilities: after,
          identity: await compilationIdentity(mission, after, scope),
        };
      }
    }
    throw new Error(
      `Mission Capability environment changed repeatedly while compiling: ${mission.id}`,
    );
  };

  const rememberSessionCompilation = (
    missionId: string,
    identity: string,
    compiled: CompiledResource<InvocableResource>,
  ): void => {
    if ("kind" in compiled.value && compiled.value.kind === "flow") return;
    sessionService.setCompilationIdentity(missionId, identity);
    sessionService.setDefinitionFingerprint(
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
    mission: Mission,
    compiled: CompiledResource<InvocableResource>,
    capabilities: readonly ResolvedCapabilityEnvironment[],
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
      environment: await executionEnvironmentSnapshot(compiled, capabilities),
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
    });
  };

  const resumeMissionSession = async (
    mission: Mission,
    compiled: CompiledResource<InvocableResource>,
    capabilities: readonly ResolvedCapabilityEnvironment[],
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
    const requestWithEnvironment = {
      ...request,
      environment: await executionEnvironmentSnapshot(compiled, capabilities),
    };
    if (record?.status === "closed") {
      const recovered = await app.experts.recoverClosedSession(compiled.value, {
        ...requestWithEnvironment,
        reason: `Active Desktop Mission ${mission.id} still references this closed ExpertSession.`,
      });
      logger.warn(
        "mission.closed_session_recovered",
        `Recovered closed ExpertSession ${sessionId} for active Mission ${mission.id}.`,
        { missionId: mission.id, sessionId },
      );
      return recovered;
    }
    return await app.experts.resumeSession(compiled.value, requestWithEnvironment);
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
    readonly capabilities: readonly ResolvedCapabilityEnvironment[];
    readonly app: ReturnType<typeof createPragma>;
    readonly sessionId?: string | undefined;
    readonly modelSelection?: RuntimeModelSelection | undefined;
    readonly createSuccessorOnMismatch: boolean;
  }): Promise<ExpertSession> => {
    if (input.sessionId === undefined) {
      return await createMissionExpertSession(
        input.mission,
        input.compiled,
        input.capabilities,
        input.app,
        { modelSelection: input.modelSelection },
      );
    }
    try {
      return await resumeMissionSession(
        input.mission,
        input.compiled,
        input.capabilities,
        input.app,
        input.sessionId,
      );
    } catch (error) {
      if (!input.createSuccessorOnMismatch || !shouldCreateSuccessorExpertSession(error)) {
        throw error;
      }
      const successor = await createMissionExpertSession(
        input.mission,
        input.compiled,
        input.capabilities,
        input.app,
        { modelSelection: input.modelSelection },
      );
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
    readonly handle: DesktopExecutionHandle;
    readonly runGeneration?: number | undefined;
    readonly startedAt: string;
    readonly inputMessageId: string;
    readonly sessionId?: string | undefined;
    readonly executorMetadata: ExecutorMetadata;
    readonly acceptedAt?: number | undefined;
    readonly onFinished?: (() => void | Promise<void>) | undefined;
  }): void => {
    const missionId = input.mission.id;
    if (lifecycleService.active(missionId)?.handle.executionId === input.handle.executionId) return;
    if (
      input.runGeneration !== undefined &&
      !lifecycleService.isRunGenerationCurrent(missionId, input.runGeneration)
    ) {
      void input.handle.cancel("Superseded Mission recovery generation.").catch(() => undefined);
      return;
    }
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
      onInteractionsChanged: (interactions) => {
        if (lifecycleService.active(missionId)?.handle.executionId !== input.handle.executionId)
          return;
        pendingHumanInteractionsByMission.set(missionId, {
          executionId: input.handle.executionId,
          interactions: excludeRespondedHumanInteractions(
            missionId,
            input.handle.executionId,
            interactions,
          ),
        });
      },
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
      () => invalidateWork(missionId, audience),
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
              chatService.setContextWindow(missionId, usage.data);
              emitChatPatches(missionId, audience, [
                { type: "context-window.update", usage: usage.data },
              ]);
            }
          }
        }
        const sessionId = item.source.sessionId;
        if (item.source.parentSessionId !== undefined && sessionId !== undefined) {
          const recordId = `runtime-agent:${sessionId}`;
          const { value: output, created: isNewRecord } = workService.getOrCreateLive(
            missionId,
            recordId,
            () => ({
              executionId: item.executionId,
              entries: [],
              messageOrdinals: new Map(),
              close: async () => undefined,
            }),
          );
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
      {
        outputSubscription:
          input.mission.executor.kind === "team"
            ? { scope: { kind: "root" }, sourceScope: { kind: "root" } }
            : { scope: { kind: "all" } },
        onOutputStats: (stats) => {
          logger.info("mission.output_coalescing", "Mission live output coalescing completed.", {
            missionId,
            executionId: input.handle.executionId,
            ...stats,
          });
        },
      },
    );
    const replacedLive = chatService.setLive(missionId, live);
    if (replacedLive !== undefined && replacedLive !== live) {
      // A Mission owns one live projection. Close a stale observer immediately when a
      // recovery/retry installs a replacement, otherwise both observers publish patches.
      void replacedLive.close().catch((error: unknown) => {
        logger.warn(
          "mission.chat_observer_replaced_close_failed",
          "Failed to close the replaced Mission chat observer.",
          { error, missionId, executionId: input.handle.executionId },
        );
      });
    }
    let releaseCheckpoint = (): void => undefined;
    const checkpoint = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    let settlementKind: "terminal" | "checkpointed" = "terminal";
    let terminalPublishedAt: number | undefined;
    let terminalInvalidationHasUserVisibleOutput = false;
    let resolveAdmission = (): void => undefined;
    let rejectAdmission: (error: unknown) => void = () => undefined;
    const admissionReady = new Promise<void>((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    void admissionReady.catch(() => undefined);
    const settlement = observeMissionExecution(
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
      async (terminal) => {
        const mission = input.mission;
        if (terminal.status === "failed") options.invalidateRuntimeReadiness?.();
        // Core already committed the terminal fact. A rebuildable Mission
        // projection must not hold the UI's status notification hostage.
        if (lifecycleService.active(missionId)?.handle === input.handle) {
          terminalPublishedAt = performance.now();
          statusService.publish(missionId, audience, {
            id: input.handle.executionId,
            status: terminal.status,
          });
          logger.info(
            "mission.terminal_status_published",
            "Core terminal status published to Desktop",
            {
              missionId,
              executionId: input.handle.executionId,
              requestId: input.inputMessageId,
              status: terminal.status,
            },
          );
        }
        if (options.deferTerminalProjection) {
          options.wakeExecutionDelivery?.();
          return;
        }
        let canonicalProjectionFailure: unknown;
        try {
          await retryMissionEventProjection(async () =>
            options.onExecutionTerminal?.({
              mission,
              executionId: input.handle.executionId,
              status: terminal.status,
              ...(terminal.result === undefined ? {} : { result: terminal.result }),
              ...(terminal.error === undefined ? {} : { error: terminal.error }),
            }),
          );
        } catch (error) {
          canonicalProjectionFailure = error;
          logger.error(
            "mission.terminal_projection_degraded",
            "The Core terminal state committed, but the Mission event projection needs recovery.",
            error,
            { missionId, executionId: input.handle.executionId, retryable: true },
          );
        }
        if (canonicalProjectionFailure !== undefined) throw canonicalProjectionFailure;
      },
      checkpoint,
      async (terminal) => {
        try {
          const projectionResult = await persistMissionExecutionProjection(
            options.missions,
            executionStore,
            missionId,
            input.handle.executionId,
            terminal.status === "cancelled",
            live.entries,
          );
          const projectionState = projectionResult.status;
          terminalInvalidationHasUserVisibleOutput ||= projectionResult.userVisibleOutput;
          if (projectionState === "current" && !options.deferTerminalProjection) {
            try {
              await executionStore.archive(input.handle.executionId);
            } catch (error) {
              logger.warn(
                "mission.execution_archive_degraded",
                "Mission chat projection committed, but Execution archival needs a retry.",
                {
                  error,
                  missionId,
                  executionId: input.handle.executionId,
                  errorCode: "MISSION_EXECUTION_ARCHIVE_DEGRADED",
                  retryable: true,
                },
              );
            }
          }
          if (projectionState === "current" && chatService.markSyncRecovered(missionId)) {
            logger.info(
              "mission.projection_rebuilt",
              "Mission chat projection is current after terminal materialization.",
              { missionId, executionId: input.handle.executionId },
            );
          }
          if (projectionState === "partial") {
            chatService.markSyncDegraded(missionId);
            logger.warn(
              "mission.projection_degraded",
              "Mission cancellation snapshot committed, but canonical chat enrichment needs a retry.",
              {
                missionId,
                executionId: input.handle.executionId,
                errorCode: "MISSION_CHAT_PROJECTION_PARTIAL",
                retryable: true,
              },
            );
            invalidateChat(missionId, audience);
          }
        } catch (error) {
          chatService.markSyncDegraded(missionId);
          logger.warn(
            "mission.projection_degraded",
            "Mission reached a terminal state while its rebuildable chat projection remained unavailable.",
            {
              error,
              missionId,
              executionId: input.handle.executionId,
              errorCode: "MISSION_CHAT_PROJECTION_DEGRADED",
              retryable: true,
            },
          );
          invalidateChat(missionId, audience);
        }
      },
      (error) => {
        logger.warn(
          "mission.terminal_side_effect_failed",
          "Mission terminal status committed while a terminal side effect failed.",
          { error, missionId, executionId: input.handle.executionId, retryable: true },
        );
      },
      options.deferTerminalProjection,
    )
      .then((kind) => {
        settlementKind = kind;
        if (kind === "terminal" && input.acceptedAt !== undefined) {
          logger.info("mission.final_result", "Mission execution reached a final result", {
            missionId,
            executionId: input.handle.executionId,
            elapsedMs: elapsedMissionMs(input.acceptedAt),
          });
        }
      })
      .finally(async () => {
        try {
          await forgetActive(
            missionId,
            input.handle,
            live,
            audience,
            settlementKind !== "checkpointed",
            terminalInvalidationHasUserVisibleOutput,
            () => resolveAdmission(),
          );
        } catch (error) {
          rejectAdmission(error);
          logger.warn(
            "mission.execution_cleanup_failed",
            "Mission execution settled, but observer cleanup needs a later retry.",
            { error, missionId, executionId: input.handle.executionId },
          );
        }
        if (terminalPublishedAt !== undefined)
          logger.info("mission.observer_settled", "Mission observer cleanup completed", {
            missionId,
            executionId: input.handle.executionId,
            requestId: input.inputMessageId,
            elapsedMs: performance.now() - terminalPublishedAt,
          });
      });
    const activeExecution = {
      handle: input.handle,
      settlement,
      admissionReady,
      get terminalPublished() {
        return terminalPublishedAt !== undefined;
      },
      audience,
      live,
      releaseAfterHumanCheckpoint: async () => {
        releaseCheckpoint();
        await settlement;
      },
    };
    const installed =
      input.runGeneration === undefined
        ? (lifecycleService.setActive(missionId, activeExecution), true)
        : lifecycleService.setActiveForRun(missionId, input.runGeneration, activeExecution);
    if (!installed) {
      void input.handle.cancel("Superseded Mission recovery generation.").catch(() => undefined);
      void live.close().catch(() => undefined);
      return;
    }
    if (input.mission.executor.kind === "flow")
      executionOwner.setControlOwner(missionId, { kind: "flow", execution: input.handle }, "live");
    const session = sessionService.session(missionId);
    if (session !== undefined && session.sessionId === input.sessionId) {
      void watchPendingSessionTurns(input.mission, session, input.executorMetadata).catch(
        (error: unknown) => {
          if (sessionService.session(missionId) === session)
            reportQueuedTurnObserverFailure(missionId, audience, error);
        },
      );
    }
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

  const queuedTurnObservers = new Map<
    string,
    { readonly session: ExpertSession; readonly controller: AbortController }
  >();
  const reportQueuedTurnObserverFailure = (
    missionId: string,
    audience: MissionSurfaceAudience,
    error: unknown,
  ): void => {
    chatService.markSyncDegraded(missionId);
    logger.warn(
      "mission.queued_turn_observer_failed",
      "Queued Mission execution needs projection recovery.",
      {
        error,
        missionId,
        errorCode: "MISSION_QUEUED_TURN_OBSERVER_FAILED",
        retryable: true,
      },
    );
    invalidateChat(missionId, audience);
  };

  const watchQueuedSessionTurn = (
    mission: Mission,
    session: ExpertSession,
    turn: ExpertTurn,
    executorMetadata: ExecutorMetadata,
  ): void => {
    if (
      queuedTurnObservers.get(turn.executionId)?.session === session ||
      lifecycleService.active(mission.id)?.handle.executionId === turn.executionId
    )
      return;
    queuedTurnObservers.get(turn.executionId)?.controller.abort();
    const observer = { session, controller: new AbortController() };
    queuedTurnObservers.set(turn.executionId, observer);
    const observing = observeMissionQueuedTurn(
      turn,
      async () => {
        await withMissionPromptAdmission(mission.id, async () => {
          if (sessionService.session(mission.id) !== session) return;
          const current = await options.missions.get(mission.id);
          if (current.lifecycleStatus !== "active") return;
          const queue = await session.getPromptQueue();
          const promptIndex = queue.findIndex((prompt) => prompt.executionId === turn.executionId);
          const prompt = queue[promptIndex];
          const currentIndex = queue.findIndex(
            (candidate) => candidate.executionId === current.execution?.id,
          );
          if (
            prompt === undefined ||
            prompt.status === "cancelled" ||
            prompt.deliveryAttempt?.kind === "queue_steer" ||
            promptIndex < currentIndex
          )
            return;
          if (lifecycleService.active(mission.id)?.handle.executionId === turn.executionId) return;
          const startedAt = prompt.updatedAt;
          const linked = await options.missions.updateExecution(
            mission.id,
            {
              id: turn.executionId,
              inputMessageId: prompt.requestId,
              sessionId: session.sessionId,
              status: "running",
              startedAt,
            },
            { executionId: current.execution?.id },
          );
          if (linked.execution?.id !== turn.executionId) return;
          trackExecution({
            mission: current,
            handle: turn,
            executorMetadata,
            startedAt,
            inputMessageId: prompt.requestId,
            sessionId: session.sessionId,
            onFinished: async () => await turn.settled,
          });
          statusService.publish(mission.id, missionSurfaceAudience(current), {
            id: turn.executionId,
            status: "running",
          });
        });
      },
      observer.controller.signal,
    );
    void observing
      .catch((error: unknown) => {
        if (sessionService.session(mission.id) === session) {
          reportQueuedTurnObserverFailure(mission.id, missionSurfaceAudience(mission), error);
        }
      })
      .finally(() => {
        if (queuedTurnObservers.get(turn.executionId) === observer)
          queuedTurnObservers.delete(turn.executionId);
      });
  };

  const watchPendingSessionTurns = async (
    mission: Mission,
    session: ExpertSession,
    executorMetadata: ExecutorMetadata,
  ): Promise<void> => {
    const pending = (await session.getPromptQueue()).filter(
      (prompt) =>
        prompt.mode === "enqueue" &&
        ["queued", "running"].includes(prompt.status) &&
        queuedTurnObservers.get(prompt.executionId)?.session !== session &&
        lifecycleService.active(mission.id)?.handle.executionId !== prompt.executionId,
    );
    if (pending.length === 0) return;
    const turns = await session.listTurns();
    if (sessionService.session(mission.id) !== session) return;
    for (const prompt of pending) {
      const turn = turns.find((candidate) => candidate.executionId === prompt.executionId);
      if (turn !== undefined) watchQueuedSessionTurn(mission, session, turn, executorMetadata);
    }
  };

  const runMission = async (id: string, runGeneration: number): Promise<Mission> => {
    const acceptedAt = performance.now();
    logger.info("mission.message_accepted", "Mission request accepted", {
      missionId: id,
      kind: "initial",
    });
    const missionLoadStartedAt = performance.now();
    const mission = await options.missions.get(id);
    assertRunGenerationCurrent(mission.id, runGeneration, "before loading its execution context");
    await options.assertExecutorReady?.(mission.executor.ref);
    if (mission.branch !== undefined && mission.execution === undefined) {
      throw new Error("Continue a branched Mission by sending a new message.");
    }
    if (lifecycleService.hasActive(mission.id)) return mission;
    if (mission.lifecycleStatus === "active") await notifyMissionActivity(mission);
    const contextMountsFingerprint = missionContextMountsFingerprint(mission);
    const recoverableMissionExecution =
      mission.execution !== undefined &&
      ["queued", "running", "waiting"].includes(mission.execution.status);
    if (
      missionContextMountsNeedSuccessor(mission, contextMountsFingerprint) &&
      !recoverableMissionExecution
    ) {
      await invalidateContextBindings(mission.id);
    }
    logMissionPhase(
      logger,
      id,
      "mission_load_and_executor_ready",
      missionLoadStartedAt,
      acceptedAt,
    );
    const executionContextStartedAt = performance.now();
    const { app, runtimes: baseRuntimes } = await executionContext(mission);
    const runtimes = withMissionRuntimeBinding(baseRuntimes, await readMissionRootContext(mission));
    logMissionPhase(logger, id, "execution_context", executionContextStartedAt, acceptedAt);
    let phaseStartedAt = performance.now();
    const stableCompilation = await compileMissionExecutorWithStableCapabilities(mission, runtimes);
    const {
      compiled,
      capabilities: resolvedCapabilities,
      identity: compiledIdentity,
    } = stableCompilation;
    assertRunGenerationCurrent(mission.id, runGeneration, "while compiling its executor");
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
        if (
          mission.execution!.resolvedCapabilities === undefined ||
          JSON.stringify(mission.execution!.resolvedCapabilities) !==
            JSON.stringify(resolvedCapabilities)
        ) {
          throw new Error(
            `Mission ${mission.id} cannot recover its Flow because its persisted Capability environment is missing or no longer active. Start a successor Mission instead.`,
          );
        }
        // Verify the durable Mission link before recover() starts the Flow again. Recovery keeps the
        // same Execution id, so the original timestamp makes this append idempotent.
        await options.missions.appendExecutionReference({
          missionId: mission.id,
          inputMessageId,
          executionId: mission.execution!.id,
          createdAt: executionStartedAt,
        });
        await notifyExecutionLinked(mission, mission.execution!.id, inputMessageId);
      }
      const handle = recoverable
        ? await app.flows.recover(compiled.value, {
            executionId: mission.execution!.id,
            runtime,
          })
        : await app.flows.start(compiled.value, {
            input: mission.flowInput!,
            runtime,
            environment: await executionEnvironmentSnapshot(compiled, resolvedCapabilities),
          });
      if (!lifecycleService.isRunGenerationCurrent(mission.id, runGeneration)) {
        await settlementOutcomeWithin(
          handle.cancel("Superseded Mission recovery generation."),
          5_000,
        );
        throw createIntegrationError({
          code: "MISSION_FENCING_REJECTED",
          category: "conflict",
          message: "Mission recovery was superseded while opening its Flow execution.",
          details: { missionId: mission.id, executionId: handle.executionId, runGeneration },
        });
      }
      if (!recoverable) {
        await options.missions.appendExecutionReference({
          missionId: mission.id,
          inputMessageId,
          executionId: handle.executionId,
          createdAt: executionStartedAt,
        });
        await notifyExecutionLinked(mission, handle.executionId, inputMessageId);
      }
      const recoveredWaiting = recoverable && (await hasPendingHumanInteraction(handle));
      const running = await options.missions.updateExecution(mission.id, {
        id: handle.executionId,
        inputMessageId,
        status: recoveredWaiting ? "waiting" : "running",
        contextMountsFingerprint,
        environmentFingerprint: recoverable
          ? mission.execution!.environmentFingerprint
          : compiled.environmentFingerprint.value,
        resolvedCapabilities: recoverable
          ? mission.execution!.resolvedCapabilities
          : resolvedCapabilities,
        startedAt: executionStartedAt,
      });
      trackExecution({
        mission,
        handle,
        runGeneration,
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
    if (
      recoverable &&
      (mission.execution!.resolvedCapabilities === undefined ||
        JSON.stringify(mission.execution!.resolvedCapabilities) !==
          JSON.stringify(resolvedCapabilities))
    ) {
      throw new Error(
        `Mission ${mission.id} cannot recover its Expert execution because its persisted Capability environment is missing or no longer active. Interrupt it and start a successor execution instead.`,
      );
    }
    phaseStartedAt = performance.now();
    const memoryBindingsChanged = sessionService.consumeMemoryBindingsChanged(mission.id);
    let session = sessionService.session(mission.id);
    let openedSessionForRun = false;
    if (memoryBindingsChanged && session !== undefined) {
      await session.close("Memory policy changed.");
      sessionService.deleteSession(mission.id);
      sessionService.clearCompilation(mission.id);
      session = undefined;
    }
    if (session === undefined) {
      session = memoryBindingsChanged
        ? await createMissionExpertSession(mission, compiled, resolvedCapabilities, app, {
            modelSelection,
          })
        : await openMissionExpertSession({
            mission,
            compiled,
            capabilities: resolvedCapabilities,
            app,
            sessionId: recoverable ? mission.execution!.sessionId : undefined,
            modelSelection,
            createSuccessorOnMismatch: true,
          });
      openedSessionForRun = true;
    }
    const assertOpenedSessionCurrent = async (phase: string): Promise<void> => {
      if (lifecycleService.isRunGenerationCurrent(mission.id, runGeneration)) return;
      if (memoryBindingsChanged) sessionService.markMemoryBindingsChanged(mission.id);
      if (openedSessionForRun) {
        const closing = session.close("Superseded Mission recovery generation.");
        const closeOutcome = await settlementOutcomeWithin(closing, 5_000);
        if (session.sessionId !== mission.execution?.sessionId) {
          const removeUnlinkedSession = async (): Promise<void> => {
            await expertSessionStore.delete(session.sessionId);
          };
          if (closeOutcome.status === "fulfilled") {
            await removeUnlinkedSession();
          } else {
            void closing
              .then(removeUnlinkedSession)
              .catch((error: unknown) =>
                logger.warn(
                  "mission.superseded_session_cleanup_failed",
                  `Superseded unlinked ExpertSession ${session.sessionId} could not be removed.`,
                  { error, missionId: mission.id, sessionId: session.sessionId },
                ),
              );
          }
        }
      }
      assertRunGenerationCurrent(mission.id, runGeneration, phase);
    };
    await assertOpenedSessionCurrent("while opening its ExpertSession");
    if (memoryBindingsChanged) {
      await interruptSupersededMissionSession(mission);
    }
    await assertOpenedSessionCurrent("before installing its ExpertSession");
    logMissionPhase(logger, mission.id, "expert_session_open", phaseStartedAt, acceptedAt, {
      cacheHit: sessionService.session(mission.id) !== undefined,
    });
    sessionService.setSession(mission.id, session);
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
    if (!lifecycleService.isRunGenerationCurrent(mission.id, runGeneration)) {
      throw createIntegrationError({
        code: "MISSION_FENCING_REJECTED",
        category: "conflict",
        message: "Mission recovery was superseded before its Expert turn started.",
        details: { missionId: mission.id, runGeneration },
      });
    }
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
    if (!lifecycleService.isRunGenerationCurrent(mission.id, runGeneration)) {
      await settlementOutcomeWithin(turn.cancel("Superseded Mission recovery generation."), 5_000);
      throw createIntegrationError({
        code: "MISSION_FENCING_REJECTED",
        category: "conflict",
        message: "Mission recovery was superseded while opening its Expert turn.",
        details: { missionId: mission.id, executionId: turn.executionId, runGeneration },
      });
    }
    logMissionPhase(logger, mission.id, "expert_session_prompt", phaseStartedAt, acceptedAt);
    await publishPromptQueue(mission);
    const executionStartedAt =
      recoveredTurn === undefined ? startedAt : mission.execution!.startedAt;
    await options.missions.appendExecutionReference({
      missionId: mission.id,
      inputMessageId,
      executionId: turn.executionId,
      createdAt: executionStartedAt,
    });
    await notifyExecutionLinked(mission, turn.executionId, inputMessageId);
    const running = await options.missions.updateExecution(mission.id, {
      id: turn.executionId,
      inputMessageId,
      sessionId: session.sessionId,
      status: recoveredTurn === undefined ? "running" : "waiting",
      ...(recoverable ? {} : { contextMountsFingerprint }),
      environmentFingerprint: compiledIdentity,
      resolvedCapabilities,
      startedAt: executionStartedAt,
    });
    trackExecution({
      mission,
      handle: turn,
      runGeneration,
      executorMetadata,
      startedAt: executionStartedAt,
      inputMessageId,
      sessionId: session.sessionId,
      acceptedAt,
      onFinished: async () => await turn.settled,
    });
    return running;
  };

  const prepareMissionMessage = async (
    mission: Mission,
    input: import("@pragma/local-host").MissionMessageAdmissionInput,
    acceptedAt: number,
  ) => {
    const requestLogger = logger.child({
      scope: { missionId: input.id, requestId: input.requestId },
    });
    const contextMountsFingerprint = missionContextMountsFingerprint(mission);
    const missionLoadStartedAt = acceptedAt;
    const activityStartedAt = performance.now();
    await notifyMissionActivity(mission);
    logMissionPhase(
      requestLogger,
      mission.id,
      "activity_notification",
      activityStartedAt,
      acceptedAt,
    );
    logMissionPhase(
      requestLogger,
      mission.id,
      "mission_load_and_executor_ready",
      missionLoadStartedAt,
      acceptedAt,
    );
    const executionContextStartedAt = performance.now();
    const { app, runtimes: baseRuntimes } = await executionContext(mission);
    const rootContextStartedAt = performance.now();
    const rootContext = await readMissionRootContext(mission);
    logMissionPhase(
      requestLogger,
      mission.id,
      "root_context_read",
      rootContextStartedAt,
      acceptedAt,
    );
    const bindingStartedAt = performance.now();
    const runtimes = withMissionRuntimeBinding(baseRuntimes, rootContext);
    logMissionPhase(requestLogger, mission.id, "runtime_binding", bindingStartedAt, acceptedAt);
    logMissionPhase(
      requestLogger,
      mission.id,
      "execution_context",
      executionContextStartedAt,
      acceptedAt,
    );
    const compilationIdentityStartedAt = performance.now();
    const identityScope = createIdentityReadScope(mission, requestLogger);
    let desiredCapabilities = await capabilityEnvironmentIdentity(mission, identityScope);
    let desiredCompilationIdentity = await compilationIdentity(
      mission,
      desiredCapabilities,
      identityScope,
    );
    logMissionPhase(
      requestLogger,
      mission.id,
      "compilation_identity",
      compilationIdentityStartedAt,
      acceptedAt,
    );
    let session = sessionService.session(mission.id);
    let compiled: CompiledResource<InvocableResource> | undefined;
    let phaseStartedAt = performance.now();
    const compilationCacheHit =
      session !== undefined &&
      sessionService.compilationIdentity(mission.id) === desiredCompilationIdentity;
    if (!compilationCacheHit) {
      const stableCompilation = await compileMissionExecutorWithStableCapabilities(
        mission,
        runtimes,
        identityScope,
      );
      compiled = stableCompilation.compiled;
      desiredCapabilities = stableCompilation.capabilities;
      desiredCompilationIdentity = stableCompilation.identity;
    }
    const executionEnvironmentChanged =
      session !== undefined &&
      (mission.execution?.resolvedCapabilities === undefined ||
        JSON.stringify(mission.execution.resolvedCapabilities) !==
          JSON.stringify(desiredCapabilities));
    logMissionPhase(
      requestLogger,
      mission.id,
      "default_agent_compile",
      phaseStartedAt,
      acceptedAt,
      {
        cacheHit: compilationCacheHit,
      },
    );
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
    // Capture the model on acceptance, even when it equals the current Context.
    // Queued prompts must not inherit a model selected by a later prompt.
    const promptModelSelection =
      input.mode === "steer"
        ? undefined
        : (modelSelection ?? rootExpert?.models?.default ?? rootContext?.modelSelection);
    let definitionChanged = false;
    const memoryBindingsChanged = sessionService.memoryBindingsChanged(mission.id);
    const contextStoresChanged =
      sessionService.consumeSuccessorRequirement(mission.id) ||
      missionContextMountsNeedSuccessor(mission, contextMountsFingerprint) ||
      (memoryBindingsChanged && !lifecycleService.hasActive(mission.id));
    if (memoryBindingsChanged && !lifecycleService.hasActive(mission.id)) {
      sessionService.clearMemoryBindingsChanged(mission.id);
    }
    if (compiledExpert !== undefined && session !== undefined) {
      const fingerprint = fingerprintExpertExecutionDefinition(compiledExpert);
      const previous = sessionService.definitionFingerprint(mission.id);
      definitionChanged =
        executionEnvironmentChanged || (previous !== undefined && previous !== fingerprint);
    }
    return {
      session,
      definitionChanged,
      contextStoresChanged,
      promptModelSelection,
      desiredCompilationIdentity,
      desiredCapabilities,
      executorMetadata,
      contextMountsFingerprint,
      createSession: async (successor: boolean) => {
        session = undefined;
        phaseStartedAt = performance.now();
        if (session === undefined) {
          if (compiled === undefined) {
            // A cached Session can be invalidated after the compilation cache lookup
            // (for example when Memory or Mission Knowledge bindings change). Compile
            // again before opening its successor instead of treating that valid cache
            // transition as an impossible state.
            const stableCompilation = await compileMissionExecutorWithStableCapabilities(
              mission,
              runtimes,
            );
            compiled = stableCompilation.compiled;
            desiredCapabilities = stableCompilation.capabilities;
            desiredCompilationIdentity = stableCompilation.identity;
          }
          if (successor) {
            session = await createMissionExpertSession(
              mission,
              compiled,
              desiredCapabilities,
              app,
              {
                modelSelection,
              },
            );
            await interruptSupersededMissionSession(mission);
            logger.warn(
              "mission.session_successor_created",
              `Created a successor ExpertSession for Mission ${mission.id} after its execution context changed.`,
              {
                reason: definitionChanged
                  ? "executor_definition_changed"
                  : "context_stores_changed",
                sessionId: session.sessionId,
              },
            );
          } else {
            session = await openMissionExpertSession({
              mission,
              compiled,
              capabilities: desiredCapabilities,
              app,
              sessionId: mission.execution?.sessionId,
              modelSelection,
              createSuccessorOnMismatch: true,
            });
          }
        }
        return session;
      },
      rememberSession: (currentSession: ExpertSession) => {
        sessionService.setSession(mission.id, currentSession);
        if (compiled !== undefined)
          rememberSessionCompilation(mission.id, desiredCompilationIdentity, compiled);
      },
    };
  };
  const sendMissionMessage = createLocalHostMissionCommandAdmission({
    onAccepted: (input) =>
      logger.info("mission.message_accepted", "Mission request accepted", {
        missionId: input.id,
        requestId: input.requestId,
        kind: "followup",
      }),
    onPhase: (input) =>
      logMissionPhase(
        logger.child({ scope: { missionId: input.missionId, requestId: input.requestId } }),
        input.missionId,
        input.phase,
        input.startedAt,
        input.acceptedAt,
        input.cacheHit === undefined ? {} : { cacheHit: input.cacheHit },
      ),
    getMission: (id) => options.missions.get(id),
    admit: withMissionPromptAdmission,
    withController: (id, operation) => withMissionController(id, operation),
    settleTerminal: (mission: Mission) => awaitTerminalLifecycleSettlement(mission, true),
    contextBindingsChanging: (id) => sessionService.contextBindingChangeInProgress(id),
    successorRequired: (mission: Mission) => {
      if (missionContextMountsNeedSuccessor(mission, missionContextMountsFingerprint(mission)))
        sessionService.invalidateContextBindings(mission.id);
      return sessionService.successorRequired(mission.id);
    },
    hasActive: (id) => lifecycleService.hasActive(id),
    session: (id) => sessionService.session(id),
    assertReady: async (mission) => {
      await options.assertExecutorReady?.(mission.executor.ref);
    },
    startInitialRun: (mission) =>
      runMission(mission.id, lifecycleService.runGeneration(mission.id)),
    prepare: prepareMissionMessage,
    forgetSession: (id) => {
      sessionService.deleteSession(id);
      sessionService.clearCompilation(id);
    },
    projectAccepted: async ({
      mission,
      input,
      turn,
      requestedMode,
      prepared,
      acceptedAt,
    }): Promise<MissionMessageApplicationResult> => {
      const {
        desiredCompilationIdentity,
        desiredCapabilities,
        executorMetadata,
        contextMountsFingerprint,
      } = prepared;
      const session = sessionService.session(mission.id)!;
      const promptAttachments = input.attachments ?? [];
      await publishPromptQueue(mission);
      // Core owns acceptance and idempotency. Project the user message only
      // after Core accepts it so a rejected strict steer cannot leave an orphan
      // in the Mission timeline. Replaying an accepted Inbox command is safe:
      // both session.prompt and appendUserMessage are keyed by requestId.
      const userMessage = await options.missions.appendUserMessage(mission.id, {
        id: input.requestId,
        content: input.content,
        ...(promptAttachments.length === 0 ? {} : { attachments: [...promptAttachments] }),
        createdAt: input.requestedAt,
      });
      if (userMessage.kind !== "user") {
        throw new Error("Mission user message persistence returned an invalid timeline record.");
      }
      if (turn.effectiveMode === "steer") {
        // A steer belongs to the already-linked active Execution; attaching it
        // again under another input message conflicts with its timeline identity.
        invalidateChat(mission.id, missionSurfaceAudience(mission));
        return {
          mission: await options.missions.get(mission.id),
          requestId: input.requestId,
          requestedMode,
          effectiveMode: "steer",
        };
      }
      const startedAt = new Date().toISOString();
      await options.missions.appendExecutionReference({
        missionId: mission.id,
        inputMessageId: input.requestId,
        executionId: turn.executionId,
        createdAt: startedAt,
      });
      await notifyExecutionLinked(mission, turn.executionId, input.requestId);
      const hasCurrent = lifecycleService.hasActive(mission.id);
      const queuePaused = (await session.getPromptQueueState()).state === "paused";
      const running =
        hasCurrent || queuePaused
          ? await options.missions.get(mission.id)
          : await options.missions.updateExecution(mission.id, {
              id: turn.executionId,
              inputMessageId: input.requestId,
              sessionId: session.sessionId,
              status: "running",
              contextMountsFingerprint,
              environmentFingerprint: desiredCompilationIdentity,
              resolvedCapabilities: desiredCapabilities,
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
          onFinished: async () => await turn.settled,
        });
      } else {
        watchQueuedSessionTurn(mission, session, turn, executorMetadata);
      }
      invalidateChat(mission.id, missionSurfaceAudience(mission));
      return {
        mission: running,
        requestId: input.requestId,
        requestedMode,
        effectiveMode: turn.effectiveMode,
        ...(turn.fallbackReason === undefined ? {} : { fallbackReason: turn.fallbackReason }),
      };
    },
  });

  const updateMissionOptions = async (input: UpdateMissionOptions): Promise<Mission> => {
    let mission = await options.missions.get(input.id);
    let projectedExecutionActive = activeMissionExecution(mission);
    // The Core Execution record is authoritative. If its terminal projection
    // was interrupted, the Mission can still look active even though the UI
    // already observes the completed Execution from Core.
    if (projectedExecutionActive && mission.execution !== undefined) {
      const persisted = await executionStore.get(mission.execution.id);
      if (persisted !== undefined && isFinalExecutionStatus(persisted.status)) {
        mission = await options.missions.updateExecution(
          mission.id,
          {
            ...mission.execution,
            status:
              persisted.status === "succeeded"
                ? "succeeded"
                : persisted.status === "failed"
                  ? "failed"
                  : "cancelled",
            finishedAt: persisted.updatedAt,
          },
          {
            executionId: mission.execution.id,
            statuses: ["queued", "running", "waiting"],
          },
        );
        invalidateChat(mission.id, missionSurfaceAudience(mission));
        projectedExecutionActive = activeMissionExecution(mission);
      }
    }
    const activeExecution = lifecycleService.active(mission.id);
    if (!projectedExecutionActive && activeExecution !== undefined) {
      await settlementOutcomeWithin(activeExecution.settlement, 5_000);
      lifecycleService.deleteActiveIfCurrent(mission.id, activeExecution);
    }
    if (
      (lifecycleService.hasActive(mission.id) || projectedExecutionActive) &&
      input.toolPermissionMode !== mission.toolPermissionMode
    ) {
      throw new Error("Wait for the current execution before changing mission permissions.");
    }
    if (mission.executor.kind === "flow" && input.modelOverride !== null) {
      throw new Error("Flow missions do not support a model override.");
    }
    const prospective = { ...mission, toolPermissionMode: input.toolPermissionMode };
    if (input.modelOverride === null) delete prospective.modelOverride;
    else prospective.modelOverride = input.modelOverride;
    const baseRuntimes = runtimeResolverForToolPermissionMode(input.toolPermissionMode);
    const runtimes = withMissionRuntimeBinding(baseRuntimes, await readMissionRootContext(mission));
    const stableCompilation = await compileMissionExecutorWithStableCapabilities(
      prospective,
      runtimes,
    );
    const { compiled } = stableCompilation;
    if (prospective.modelOverride !== undefined) {
      await runtimes.bind({
        runtimeId: requireRootRuntimeId(compiled),
        modelSelection: toRuntimeModelSelection(prospective.modelOverride),
      });
    }
    if (input.toolPermissionMode !== mission.toolPermissionMode) {
      await sessionService.session(mission.id)?.refreshRuntimeSessions();
    }
    const updated = await options.missions.updateOptions(mission.id, {
      toolPermissionMode: input.toolPermissionMode,
      ...(prospective.modelOverride === undefined
        ? {}
        : { modelOverride: prospective.modelOverride }),
    });
    (await sessionService.executionContext(mission.id))?.setToolPermissionMode(
      input.toolPermissionMode,
    );
    // Validation must not mark the live Session as compiled with its next model.
    // Recompile on the next accepted prompt, retaining the current definition fingerprint.
    sessionService.setCompilationIdentity(mission.id, "");
    return updated;
  };

  const activeMissionExecution = (candidate: Mission): boolean =>
    candidate.execution !== undefined &&
    ["queued", "running", "waiting"].includes(candidate.execution.status);

  const assertNoPendingMissionPrompts = async (candidate: Mission): Promise<void> => {
    const sessionId =
      sessionService.session(candidate.id)?.sessionId ?? candidate.execution?.sessionId;
    if (sessionId === undefined) return;
    const pendingPrompts = (await expertSessionStore.listPrompts(sessionId)).filter(
      (prompt) =>
        prompt.mode === "enqueue" && (prompt.status === "queued" || prompt.status === "running"),
    );
    if (pendingPrompts.length > 0) {
      throw new MissionStoreError(
        "message_conflict",
        "Remove or finish queued Mission messages before changing Mission Knowledge Stores.",
      );
    }
  };

  const assertContextMountChangeAllowedWithinController = async (
    missionId: string,
  ): Promise<Mission> => {
    let candidate = await options.missions.get(missionId);
    if (activeMissionExecution(candidate)) {
      throw new MissionStoreError(
        "mission_active",
        "Wait for the current execution before changing Mission Knowledge Stores.",
      );
    }
    await assertNoPendingMissionPrompts(candidate);
    await awaitTerminalLifecycleSettlement(candidate);
    candidate = await options.missions.get(missionId);
    if (lifecycleService.hasActive(candidate.id) || activeMissionExecution(candidate)) {
      throw new MissionStoreError(
        "mission_active",
        "Wait for the current execution before changing Mission Knowledge Stores.",
      );
    }
    await assertNoPendingMissionPrompts(candidate);
    return candidate;
  };

  const revalidateContextMountChangeWithinController = async (
    missionId: string,
  ): Promise<Mission> => {
    const candidate = await options.missions.get(missionId);
    if (lifecycleService.hasActive(candidate.id) || activeMissionExecution(candidate)) {
      throw new MissionStoreError(
        "mission_active",
        "Wait for the current execution before changing Mission Knowledge Stores.",
      );
    }
    await assertNoPendingMissionPrompts(candidate);
    return candidate;
  };

  const updateMissionContextMountsWithinChange = async (
    input: UpdateMissionContextMounts,
  ): Promise<Mission> => {
    let mission = await assertContextMountChangeAllowedWithinController(input.id);
    const existingDraftMounts = mission.contextMounts.filter(
      (mount): mount is Extract<MissionContextMount, { kind: "context-store-draft" }> =>
        mount.kind === "context-store-draft",
    );
    const requestedDraftMounts = input.contextMounts.filter(
      (mount): mount is Extract<MissionContextMount, { kind: "context-store-draft" }> =>
        mount.kind === "context-store-draft",
    );
    if (
      requestedDraftMounts.length !== existingDraftMounts.length ||
      requestedDraftMounts.some(
        (requested) =>
          !existingDraftMounts.some(
            (existing) =>
              existing.draftId === requested.draftId &&
              existing.revisionJobId === requested.revisionJobId,
          ),
      )
    ) {
      throw new Error("Mission Knowledge Drafts can only be changed by revision tools.");
    }
    const contextStoreIds = input.contextMounts.flatMap((mount) =>
      mount.kind === "context-store" ? [mount.storeId] : [],
    );
    return await withContextStoreRevisionLocks(options.contextStores, contextStoreIds, async () => {
      await Promise.all(
        input.contextMounts.map(async (mount) => {
          if (mount.kind === "context-store-draft" && mount.revisionJobId !== undefined) {
            const existing = mission.contextMounts.find(
              (candidate) =>
                candidate.kind === "context-store-draft" &&
                candidate.draftId === mount.draftId &&
                candidate.revisionJobId === mount.revisionJobId,
            );
            if (existing === undefined) {
              throw new Error("Managed Mission Knowledge Drafts cannot be changed manually.");
            }
          }
          if (mount.kind === "context-store") {
            if (options.contextStores === undefined) {
              throw new Error("Mission Knowledge Stores are unavailable.");
            }
            await options.contextStores.resolve(mount.storeId);
            return;
          }
          if (options.contextStoreRevisions === undefined) {
            throw new Error("Mission Knowledge Drafts are unavailable.");
          }
          await options.contextStoreRevisions.resolveDraft(mount.draftId);
        }),
      );
      // The settlement wait has already run before Store locks are acquired.
      // Recheck state without waiting while holding those locks.
      mission = await revalidateContextMountChangeWithinController(input.id);
      const updated = await options.missions.updateContextMounts(mission.id, input.contextMounts);
      await invalidateContextBindings(mission.id);
      return updated;
    });
  };

  const updateMissionContextMounts = async (
    input: UpdateMissionContextMounts,
  ): Promise<Mission> => {
    // Prevent terminal cleanup from dispatching the next queued turn while the
    // mutation is waiting for that cleanup. The mutation must first inspect the
    // stable queue and either reject without side effects or install new mounts.
    sessionService.beginContextBindingChange(input.id);
    try {
      return await updateMissionContextMountsWithinChange(input);
    } finally {
      sessionService.finishContextBindingChange(input.id);
    }
  };

  const pendingDeletionSettlements = new Map<string, Promise<void>>();
  const deletionService =
    options.deletionService ??
    createMissionDeletionService({
      paths: new PragmaPaths({ pragmaHome: options.pragmaHome }),
      logger,
      ports: {
        usage: async (record) => {
          await options.usage?.markSubjectDeleted("mission", record.missionId);
        },
        memory: async (record) => {
          await options.onOwnerDeleting?.({
            mission: MissionSchema.parse(record.payload.mission),
            executionIds: record.executionIds,
          });
        },
        drafts: async (record) => {
          // Standalone callers have no Desktop DSL drafts; record the completed host step.
          logger.debug(
            "mission.deletion_drafts_completed",
            "Mission has no host DSL draft service.",
            { missionId: record.missionId },
          );
        },
        claims: async (record) => {
          const mission = MissionSchema.parse(record.payload.mission);
          for (const mount of mission.contextMounts) {
            if (mount.kind === "context-store-draft" && mount.revisionJobId !== undefined) {
              await options.contextStoreRevisions?.releaseMissionClaim({
                draftId: mount.draftId,
                jobId: mount.revisionJobId,
                missionId: mission.id,
                reason: "mission_deleted",
              });
            }
          }
        },
        settlement: async (record) => {
          await pendingDeletionSettlements.get(record.missionId);
        },
      },
    });

  const deleteMission = async (id: string): Promise<void> => {
    const deletionStartedAt = performance.now();
    const measureDeletionPhase = async <T>(phase: string, action: () => Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      let succeeded = false;
      try {
        const result = await action();
        succeeded = true;
        return result;
      } finally {
        logger.info("mission.delete_phase", "Mission deletion phase completed.", {
          missionId: id,
          phase,
          succeeded,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          elapsedMs: Math.round((performance.now() - deletionStartedAt) * 100) / 100,
        });
      }
    };
    const mission = await options.missions.get(id);
    const active = lifecycleService.active(id);
    const session = sessionService.session(id);
    session?.freezeForDeletion();
    const executionIds = new Set(
      await measureDeletionPhase("execution_inventory", () =>
        collectMissionExecutionIds(options.missions, id),
      ),
    );
    if (mission.execution !== undefined) executionIds.add(mission.execution.id);
    if (session !== undefined)
      for (const executionId of (await session.getState()).executionIds)
        executionIds.add(executionId);
    const sessionId = mission.execution?.sessionId ?? session?.sessionId;
    const sessionIds = new Set(sessionId === undefined ? [] : [sessionId]);
    await measureDeletionPhase("session_inventory", async () => {
      const contexts = await Promise.all(
        [...executionIds].map(
          async (executionId) => await executionStore.listContexts(executionId),
        ),
      );
      for (const context of contexts.flat()) {
        if (context.owner.type === "expert-session") sessionIds.add(context.owner.ownerId);
      }
    });
    const prepared = await deletionService.prepare({
      missionId: id,
      executionIds: [...executionIds],
      payload: { mission, sessionIds: [...sessionIds] },
      ...(options.missions.storagePath === undefined
        ? {}
        : { missionPath: options.missions.storagePath(id) }),
    });
    await options.prepareOwnerDeletion?.({ mission, executionIds: [...executionIds] });
    const stop =
      session === undefined
        ? (active?.handle.stopForDeletion("Mission deleted.") ?? Promise.resolve())
        : session.stopForDeletion("Mission deleted.");
    const stopped = await measureDeletionPhase("runtime_stop", () =>
      settlementOutcomeWithin(stop, 15_000),
    );
    const unconfirmedOwners =
      stopped.status === "fulfilled"
        ? (
            await readRuntimeSessionsForOwners(
              new PragmaPaths({ pragmaHome: options.pragmaHome }),
              [...sessionIds, ...executionIds],
            )
          ).filter((record) => record.processState !== "stopped")
        : [];
    if (stopped.status !== "fulfilled" || unconfirmedOwners.length > 0) {
      const error = Object.assign(new Error("MISSION_DELETE_RUNTIME_STOP_UNCONFIRMED"), {
        code: "MISSION_DELETE_RUNTIME_STOP_UNCONFIRMED",
      });
      logger.warn(
        "mission.delete_runtime_stop_unconfirmed",
        "Mission retained because Runtime stop was not confirmed.",
        {
          missionId: id,
          errorCode: error.message,
          outcome: stopped.status,
          unconfirmedSystemSessionIds: unconfirmedOwners.map((record) => record.systemSessionId),
        },
      );
      throw error;
    }
    // Only an admitted run can add owners during inventory. Existing Execution
    // contexts retain the same owner; inspect just newly allocated Executions.
    if (session !== undefined || active !== undefined) {
      const lateIds = new Set(await collectMissionExecutionIds(options.missions, id));
      if (session !== undefined)
        for (const executionId of (await session.getState()).executionIds) lateIds.add(executionId);
      const added = [...lateIds].filter((executionId) => !executionIds.has(executionId));
      for (const executionId of added) executionIds.add(executionId);
      for (const context of (
        await Promise.all(
          added.map(async (executionId) => await executionStore.listContexts(executionId)),
        )
      ).flat())
        if (context.owner.type === "expert-session") sessionIds.add(context.owner.ownerId);
      if (added.length > 0) {
        await deletionService.updateOwners(id, [...executionIds], {
          mission,
          sessionIds: [...sessionIds],
        });
        const outstanding = (
          await readRuntimeSessionsForOwners(new PragmaPaths({ pragmaHome: options.pragmaHome }), [
            ...sessionIds,
            ...executionIds,
          ])
        ).filter((record) => record.processState !== "stopped");
        if (outstanding.length > 0)
          throw Object.assign(new Error("MISSION_DELETE_RUNTIME_STOP_UNCONFIRMED"), {
            code: "MISSION_DELETE_RUNTIME_STOP_UNCONFIRMED",
          });
      }
    }
    if (session !== undefined && sessionService.deleteSessionIfCurrent(id, session))
      sessionService.clearCompilation(id);
    if (active !== undefined) {
      forgetFlowControlOwner(id, active.handle);
      lifecycleService.deleteActive(id);
      const settlement = active.settlement.then(
        () => undefined,
        () => undefined,
      );
      const priorSettlement = pendingDeletionSettlements.get(id);
      const combined = Promise.all([priorSettlement, settlement]).then(() => undefined);
      trackMissionDeletionSettlement(pendingDeletionSettlements, id, combined);
    }
    const observers = pendingDeletionSettlements.get(id);
    deletionService.trackSettlement(id, async () => {
      await Promise.all([
        observers,
        session?.finishDeletion() ?? active?.handle.finishDeletion?.() ?? Promise.resolve(),
      ]);
    });
    const lockStartedAt = performance.now();
    const deleteOwnedStorage = async (canonicalHandoffFiles: readonly string[]): Promise<void> => {
      logger.info("mission.delete_phase", "Mission deletion locks acquired.", {
        missionId: id,
        phase: "lock_wait",
        durationMs: performance.now() - lockStartedAt,
      });
      const paths = new PragmaPaths({ pragmaHome: options.pragmaHome });
      const sources = [
        { label: "memory-attention", path: paths.memoryAttentionRoot(mission.id) },
        ...[...executionIds].map((executionId) => ({
          label: `executions/${encodePragmaPathSegment(executionId)}`,
          path: paths.executionRoot(executionId),
        })),
        ...[...executionIds].map((executionId) => ({
          label: `execution-archives/${encodePragmaPathSegment(executionId)}.jsonl.gz`,
          path: paths.executionArchive(executionId),
        })),
        ...[...executionIds].map((executionId) => ({
          label: `memory-execution-activity/${encodePragmaPathSegment(executionId)}`,
          path: paths.memoryExecutionActivityRoot(executionId),
        })),
        ...canonicalHandoffFiles.map((path) => ({
          label: `canonical-event-handoffs/${basename(path)}`,
          path,
        })),
        ...[...sessionIds].map((ownedSessionId) => ({
          label: `expert-sessions/${encodePragmaPathSegment(ownedSessionId)}`,
          path: paths.expertSessionRoot(ownedSessionId),
        })),
        ...(
          await Promise.all(
            [...sessionIds].map(
              async (ownedSessionId) => await runtimeSessionDeletionSources(paths, ownedSessionId),
            ),
          )
        ).flat(),
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
      await fenceOwnerDeletion(paths, [id, ...executionIds, ...sessionIds]);
      try {
        await moveOwnedStorageToTrash({
          paths,
          onCommitted: async () => await deletionService.commit(id),
          onPhase: (phase, durationMs) =>
            logger.info("mission.delete_phase", "Mission storage deletion phase completed.", {
              missionId: id,
              phase,
              durationMs,
            }),
          deletionId: prepared.deletionId,
          owner: { type: "mission", id },
          sources: uniqueSources,
          runtimeSessionOwnerIds: [...sessionIds, ...executionIds],
        });
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "STORAGE_DELETION_COMMITTED_FINALIZATION_PENDING"
          ) &&
          (await deletionService.read(id))?.phase !== "committed"
        )
          throw error;
        logger.warn(
          "mission.deletion_finalization_degraded",
          "Mission deletion committed; transaction finalization will recover.",
          {
            missionId: id,
            moduleId: "pragma.mission-deletion",
            errorCode: "MISSION_DELETE_FINALIZATION_RETRY_PENDING",
            error,
          },
        );
      }
      if (options.missions.storagePath === undefined) await options.missions.remove(id);
      else options.missions.forget?.(id);
      sessionService.deleteExecutionContext(id);
      lifecycleService.clearControlIssue(id);
      deletionService.wake();
      if (options.deletionService === undefined) {
        void deletionService
          .runOnce()
          .catch((error: unknown) =>
            logger.warn(
              "mission.deletion_cleanup_failed",
              "Deletion committed; cleanup will resume from its record.",
              { error, missionId: id },
            ),
          );
      }
      options.onStorageTrashed?.();
    };
    await measureDeletionPhase("owned_storage_transaction", async () => {
      const action = async () =>
        await withFileLock(
          new PragmaPaths({ pragmaHome: options.pragmaHome }).executionLock(id),
          async () =>
            await executionStore.withCanonicalEventDeletion([...executionIds], deleteOwnedStorage, [
              ...sessionIds,
            ]),
          { operation: "mission.attention-deletion-barrier" },
        );
      if (options.missions.withDeletionBarrier === undefined) await action();
      else await options.missions.withDeletionBarrier(id, action);
    });
  };

  const getContextWindowState = async (
    mission: Mission,
    usageOverride?: RuntimeContextWindowUsage | undefined,
  ): Promise<MissionContextWindowState | undefined> => {
    if (mission.executor.kind === "flow") return undefined;
    const rootContext = await readMissionRootContext(mission);
    if (rootContext === undefined) return undefined;
    // Display inspection needs routing, not a new execution app or host mounts.
    // In particular, a read racing owner release must not recreate that cache.
    const runtimes = runtimeResolverForToolPermissionMode(mission.toolPermissionMode);
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
      lifecycleService.hasActive(mission.id) ||
      (mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status));
    let usage = usageOverride ?? chatService.contextWindow(mission.id);
    if (usage === undefined && rootContext.snapshot !== undefined) {
      if (!executionBusy) {
        usage = await sessionService
          .session(mission.id)
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
        ? await sessionService
            .session(mission.id)
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
    const mission = await options.missions.get(id);
    if (mission.executor.kind === "flow") {
      throw new Error("Flow missions do not expose a chat context to compact.");
    }
    if (mission.lifecycleStatus !== "active") {
      throw new Error("Reopen this mission before compacting its context.");
    }
    if (
      lifecycleService.hasActive(id) ||
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
    let session = sessionService.session(id);
    if (session === undefined) {
      const stableCompilation = await compileMissionExecutorWithStableCapabilities(
        mission,
        runtimes,
      );
      const { compiled } = stableCompilation;
      if ("kind" in compiled.value && compiled.value.kind === "flow") {
        throw new Error("Flow missions do not expose a chat context to compact.");
      }
      session = await resumeMissionSession(
        mission,
        compiled,
        stableCompilation.capabilities,
        app,
        sessionId,
      );
      rememberSessionCompilation(id, stableCompilation.identity, compiled);
    }
    sessionService.setSession(id, session);
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

  const getChatPage = (
    input: MissionChatPageQuery,
    audience: MissionSurfaceAudience = "user",
  ): Promise<MissionChatPage> =>
    chatService.read(
      input.id,
      audience,
      "getChatPage",
      [input.beforeCursor ?? null, input.limit],
      (assertCurrent) =>
        withStorageDiagnostics(
          { family: "mission-display", ownerId: input.id, operation: "history" },
          () => getChatPageUnmerged(input, audience, assertCurrent),
          logger,
        ),
    );

  const historyPreparations = new Map<string, MissionTimelineTurn>();
  const historyPreparationFailures = new Map<string, { code: string; retryAt: number }>();
  let preparingHistory = false;
  const prepareHistory = () => {
    if (preparingHistory) return;
    preparingHistory = true;
    void (async () => {
      while (historyPreparations.size > 0) {
        const [key, turn] = historyPreparations.entries().next().value!;
        const missionId = key.slice(0, key.indexOf("/"));
        try {
          const state = await executionStore.get(turn.executionId!);
          if (state === undefined)
            throw Object.assign(new Error("Execution history source is missing"), {
              code: "execution_history_source_missing",
            });
          const rebuilt = await readMissionChatHistory(
            [turn],
            executionStore,
            options.missions,
            missionId,
            undefined,
            false,
          );
          if (rebuilt.syncIssues.length > 0)
            throw Object.assign(new Error("Execution history rebuild failed"), {
              code: "execution_history_rebuild_failed",
            });
          await withMissionController(missionId, async () => {
            const prior = await options.missions.readExecutionProjection(
              missionId,
              turn.executionId!,
            );
            const entries = rebuilt.entries.filter((entry) => entry.kind !== "user");
            if (!isDeepStrictEqual(prior, entries))
              await options.missions.writeExecutionProjection(
                missionId,
                turn.executionId!,
                entries,
                state.updatedAt,
              );
          });
          historyPreparationFailures.delete(key);
        } catch (error) {
          const code = String(
            (error as { code?: unknown }).code ?? "execution_history_preparation_failed",
          );
          historyPreparationFailures.set(key, { code, retryAt: Date.now() + 30_000 });
          if (historyPreparationFailures.size > 128)
            historyPreparationFailures.delete(historyPreparationFailures.keys().next().value!);
          logger.warn("mission.history_preparation_failed", "History source verification failed", {
            missionId,
            executionId: turn.executionId,
            errorCode: code,
            error,
          });
        } finally {
          historyPreparations.delete(key);
          invalidateChat(missionId, "user");
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })()
      .finally(() => {
        preparingHistory = false;
      })
      .catch((error) =>
        logger.warn("mission.history_preparation_failed", "History preparation stopped", {
          error,
          errorCode: "execution_history_preparation_failed",
        }),
      );
  };
  const getChatPageUnmerged = async (
    input: MissionChatPageQuery,
    audience: MissionSurfaceAudience = "user",
    assertReadCurrent: () => void = () => undefined,
  ): Promise<MissionChatPage> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = performance.now();
      const mission = await options.missions.get(input.id);
      const missionReadAt = performance.now();
      if (audience === "user" && !isUserFacingMissionOrigin(mission.origin)) {
        throw new Error(`Mission ${mission.id} is not available on the Mission surface.`);
      }
      const executorMetadataPromise = getExecutorMetadataOrFallback(mission, "historical");
      const capturedLive = chatService.live(mission.id);
      const capturedRevision = chatService.revision(mission.id);
      const capturedLiveEntries = capturedLive?.entries.map((entry) => ({ ...entry })) ?? [];
      const capturedInvalidationRevision = chatService.invalidationRevision(mission.id);
      let inheritedHistoryPromise: ReturnType<MissionStore["readBranchHistory"]> | undefined;
      const history = await readMissionChatHistoryPage({
        missionId: mission.id,
        query: input,
        executionStore,
        missions: options.missions,
        rootOnly: mission.executor.kind === "team",
        onPreparationRequired: (turn) => {
          const key = `${mission.id}/${turn.executionId}`;
          if (
            (historyPreparationFailures.get(key)?.retryAt ?? 0) > Date.now() ||
            historyPreparations.has(key)
          )
            return;
          if (historyPreparations.size < 64) {
            historyPreparations.set(key, turn);
            prepareHistory();
          }
        },
        ...(capturedLive === undefined ? {} : { activeChat: capturedLive }),
        ...(mission.branch === undefined
          ? {}
          : {
              loadInheritedEntries: async () => {
                inheritedHistoryPromise ??= options.missions.readBranchHistory(mission.id);
                return (await inheritedHistoryPromise)?.entries ?? [];
              },
            }),
      });
      const entries = [...history.entries];
      const historyReadAt = performance.now();
      const syncIssues = [...history.syncIssues];
      const executorMetadata = await executorMetadataPromise;
      // An entire queued execution can start and finish while history is read, leaving
      // both live pointers undefined. Invalidation revisions also capture that lifecycle
      // and timeline changes; text-only patches are covered by the live entries below.
      const changedDuringRead =
        input.beforeCursor === undefined &&
        (chatService.live(mission.id) !== capturedLive ||
          chatService.invalidationRevision(mission.id) !== capturedInvalidationRevision);
      if (changedDuringRead && attempt < 2) continue;
      // Capture the revision and live entries in one synchronous turn so every live
      // delta covered by the watermark is also represented in the returned page.
      // At the retry limit, retain the read-start watermark and live snapshot.
      // Updates emitted during the read remain pending, including the invalidation
      // that asks the renderer for another refresh. Historical pages never acknowledge
      // new live updates either and do not retry when the current turn changes.
      const revision =
        changedDuringRead || input.beforeCursor !== undefined
          ? capturedRevision
          : chatService.revision(mission.id);
      const revisionLiveEntries =
        input.beforeCursor === undefined
          ? ((changedDuringRead ? capturedLiveEntries : capturedLive?.entries)?.map((entry) => ({
              ...entry,
              ...(entry.timelineSequence === undefined && history.newestSequence !== undefined
                ? { timelineSequence: history.newestSequence }
                : {}),
            })) ?? [])
          : [];
      const resolveExecutorName = createMissionExecutorNameResolver(
        mission,
        executorMetadata.names,
      );
      const resolveExecutorAvatarId = createMissionExecutorAvatarIdResolver(
        executorMetadata.avatarIds,
      );
      const presentedEntries = mergeMissionChatEntriesWithLive(entries, revisionLiveEntries).map(
        (entry) => {
          if (entry.executorId === undefined) return entry;
          const executorName = entry.executorName ?? resolveExecutorName(entry.executorId);
          const executorAvatarId =
            entry.executorAvatarId ?? resolveExecutorAvatarId(entry.executorId);
          if (entry.executorName !== undefined && entry.executorAvatarId !== undefined)
            return entry;
          return {
            ...entry,
            ...(executorName === undefined ? {} : { executorName }),
            ...(executorAvatarId === undefined ? {} : { executorAvatarId }),
          };
        },
      );
      assertReadCurrent();
      const uniqueSyncIssues = [
        ...new Map(syncIssues.map((issue) => [issue.section, issue])).values(),
      ];
      if (uniqueSyncIssues.length > 0) {
        if (chatService.markSyncDegraded(mission.id)) {
          logger.warn(
            "mission.chat_sync_degraded",
            "Mission chat is using partial state while Execution data is unavailable.",
            {
              missionId: mission.id,
              executionId: mission.execution?.id,
              code: "execution_state_unavailable",
              retryable: true,
              sections: uniqueSyncIssues.map((issue) => issue.section),
            },
          );
        }
      } else if (chatService.markSyncRecovered(mission.id)) {
        logger.info(
          "mission.chat_sync_recovered",
          "Mission chat state synchronization recovered.",
          {
            missionId: mission.id,
            executionId: mission.execution?.id,
          },
        );
      }
      const result: MissionChatPage = {
        missionId: mission.id,
        revision,
        entries: presentedEntries,
        sourceVerification: [...historyPreparationFailures.keys()].some((key) =>
          key.startsWith(`${mission.id}/`),
        )
          ? "unavailable"
          : history.sourceVerification,
        page: {
          ...(history.oldestSequence === undefined
            ? {}
            : { oldestSequence: history.oldestSequence }),
          ...(history.newestSequence === undefined
            ? {}
            : { newestSequence: history.newestSequence }),
          ...(history.nextBeforeCursor === undefined
            ? {}
            : { nextBeforeCursor: history.nextBeforeCursor }),
          ...(history.truncation === undefined ? {} : { truncation: history.truncation }),
        },
        ...(uniqueSyncIssues.length === 0 ? {} : { syncIssues: uniqueSyncIssues }),
      };
      logger.debug("mission.chat_page_read", "Mission chat page read completed.", {
        missionId: mission.id,
        entryCount: result.entries.length,
        branchHistoryLoaded: inheritedHistoryPromise !== undefined,
        missionReadMs: Math.round((missionReadAt - startedAt) * 100) / 100,
        historyReadMs: Math.round((historyReadAt - missionReadAt) * 100) / 100,
        elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
      return result;
    }
    throw new Error("Mission chat page read exhausted its attempts.");
  };

  const getConversationState = (
    id: string,
    audience: MissionSurfaceAudience = "user",
  ): Promise<MissionConversationState> =>
    chatService.read(id, audience, "getConversationState", null, (assertCurrent) =>
      withStorageDiagnostics(
        { family: "mission-display", ownerId: id, operation: "control" },
        () => getConversationStateUnmerged(id, audience, assertCurrent),
        logger,
      ),
    );

  const getConversationStateUnmerged = async (
    id: string,
    audience: MissionSurfaceAudience = "user",
    assertReadCurrent: () => void = () => undefined,
  ): Promise<MissionConversationState> => {
    const startedAt = performance.now();
    // A read must not borrow a patch revision emitted after it began.
    const stateRevision = chatService.revision(id);
    const latestMission = await options.missions.get(id);
    assertReadCurrent();
    if (audience === "user" && !isUserFacingMissionOrigin(latestMission.origin)) {
      throw new Error(`Mission ${latestMission.id} is not available on the Mission surface.`);
    }
    const persistedExecution =
      latestMission.execution === undefined
        ? undefined
        : await executionStore.get(latestMission.execution.id).catch(() => undefined);
    assertReadCurrent();
    const persistedTerminalStatus =
      persistedExecution !== undefined &&
      isMissionTerminalExecutionStatus(persistedExecution.status)
        ? persistedExecution.status === "interrupted"
          ? ("cancelled" as const)
          : persistedExecution.status
        : undefined;
    let effectiveExecutionStatus = persistedTerminalStatus ?? latestMission.execution?.status;
    let projectedExecutionActive =
      effectiveExecutionStatus !== undefined &&
      ["queued", "running", "waiting"].includes(effectiveExecutionStatus);
    const syncIssues: MissionChatSyncIssue[] = [];
    let pendingInteractions: MissionHumanInteraction[] = [];
    if (projectedExecutionActive && effectiveExecutionStatus === "waiting") {
      const cachedInteractions = pendingHumanInteractionsByMission.get(id);
      try {
        // Execution events are authoritative. The observer cache can briefly contain the empty
        // seed snapshot after another path has already projected the Mission as waiting.
        pendingInteractions = [...(await listMissionPendingHumanInteractions(latestMission))];
        assertReadCurrent();
        if (latestMission.execution !== undefined) {
          pendingHumanInteractionsByMission.set(id, {
            executionId: latestMission.execution.id,
            interactions: [...pendingInteractions],
          });
        }
      } catch {
        if (
          cachedInteractions !== undefined &&
          cachedInteractions.executionId === latestMission.execution?.id
        ) {
          pendingInteractions = [...cachedInteractions.interactions];
        } else {
          syncIssues.push(missionChatSyncIssue("pending_interactions"));
        }
      }
    } else {
      // Pending human input belongs to one active Execution. A terminal or
      // non-waiting state closes it and stale snapshots cannot resurrect it.
      const cachedInteractions = pendingHumanInteractionsByMission.get(id);
      if (
        latestMission.execution === undefined ||
        cachedInteractions?.executionId === latestMission.execution.id
      ) {
        pendingHumanInteractionsByMission.delete(id);
      }
    }
    const current = lifecycleService.active(id);
    const session = sessionService.session(id);
    let promptQueue: readonly PromptRequest[] = [];
    let sessionEvents: readonly ExpertSessionEvent[] = [];
    const sessionId = session?.sessionId ?? latestMission.execution?.sessionId;
    let sessionRecord: Awaited<ReturnType<typeof expertSessionStore.get>>;
    if (sessionId !== undefined) {
      const snapshot = await expertSessionStore.readSnapshot(sessionId);
      sessionRecord = snapshot?.session;
      promptQueue = snapshot?.prompts ?? [];
      sessionEvents = snapshot?.events ?? [];
    }
    const pendingPrompts = promptQueue.filter(
      (prompt) =>
        prompt.purpose === "user" &&
        prompt.mode === "enqueue" &&
        (prompt.status === "queued" || prompt.status === "running"),
    );
    const lastQueueControl = [...sessionEvents]
      .toReversed()
      .find((event) =>
        ["prompt.queue-paused", "prompt.queue-resumed", "prompt.queue-cleared"].includes(
          event.type,
        ),
      );
    const deliveryUncertain = hasUncertainSteerDelivery(promptQueue);
    const uncertainQueuedPrompt = pendingPrompts.find(
      (prompt) => prompt.status === "queued" && prompt.deliveryAttempt?.state === "uncertain",
    );
    const queuePaused =
      deliveryUncertain ||
      (lastQueueControl?.type === "prompt.queue-paused" &&
        pendingPrompts.some((prompt) => prompt.status === "queued"));
    const lastPausedRequestId = (lastQueueControl?.data as { requestId?: unknown } | undefined)
      ?.requestId;
    const pausedAfterRequestId =
      uncertainQueuedPrompt?.requestId ??
      (queuePaused && typeof lastPausedRequestId === "string" ? lastPausedRequestId : undefined);
    const rootRuntimeContext =
      sessionRecord === undefined ? undefined : sessionRecord.contexts[sessionRecord.rootContextId];
    const resolvedRootRuntime =
      rootRuntimeContext === undefined
        ? undefined
        : await options.runtimes
            .resolve({
              binding: rootRuntimeContext.runtime,
              modelSelection: rootRuntimeContext.modelSelection,
            })
            .catch(() => undefined);
    const supportsSteer =
      resolvedRootRuntime === undefined
        ? false
        : await runtimeSupportsSteer(resolvedRootRuntime.adapter).catch(() => false);
    const steeringRecovery = resolvedRootRuntime?.adapter.features.steering.steeringRecovery;
    const queueItems = await Promise.all(
      pendingPrompts.map(async (prompt) => ({
        requestId: prompt.requestId,
        content: prompt.content,
        status: prompt.status,
        deliveryUncertain: prompt.deliveryAttempt?.state === "uncertain",
        hasAttachments: hasPromptAttachments(
          (await executionStore.getInvocation(prompt.executionId, prompt.executionId))?.input,
        ),
      })),
    );
    const removedPromptIds = new Set(
      sessionEvents.flatMap((event) => {
        if (event.type !== "prompt.removed") return [];
        const requestId = (event.data as { requestId?: unknown }).requestId;
        return typeof requestId === "string" ? [requestId] : [];
      }),
    );
    const steerFallbackByRequestId = new Map<string, string>();
    for (const event of sessionEvents) {
      if (event.type !== "prompt.steer-fallback") continue;
      const data = event.data as { requestId?: unknown; reason?: unknown };
      if (typeof data.requestId === "string" && typeof data.reason === "string") {
        steerFallbackByRequestId.set(data.requestId, data.reason);
      }
    }
    const executionActivatedAt = new Map<string, string>();
    for (const event of sessionEvents) {
      if (event.type !== "execution.attached") continue;
      const executionId = (event.data as { executionId?: unknown }).executionId;
      if (typeof executionId === "string") executionActivatedAt.set(executionId, event.occurredAt);
    }
    const deliveries = promptQueue.flatMap((prompt) => {
      const fallbackReason = steerFallbackByRequestId.get(prompt.requestId);
      const queueSteered =
        prompt.deliveryAttempt?.kind === "queue_steer" &&
        prompt.deliveryAttempt.state === "confirmed";
      const activatedAt = queueSteered
        ? prompt.updatedAt
        : prompt.mode === "enqueue" && prompt.status !== "queued"
          ? executionActivatedAt.get(prompt.executionId)
          : undefined;
      return [
        {
          entryId: prompt.requestId,
          delivery: {
            requestedMode: queueSteered || fallbackReason !== undefined ? "steer" : prompt.mode,
            effectiveMode: queueSteered ? "steer" : prompt.mode,
            status: prompt.status,
            ...(activatedAt === undefined ? {} : { activatedAt }),
            ...(removedPromptIds.has(prompt.requestId) ? { removed: true } : {}),
            ...(fallbackReason === undefined ? {} : { fallbackReason }),
          },
        },
      ];
    });
    const hiddenEntryIds = promptQueue.flatMap((prompt) =>
      prompt.deliveryAttempt?.kind === "queue_steer" &&
      prompt.deliveryAttempt.state === "confirmed" &&
      prompt.deliveryAttempt.sourceExecutionId !== undefined
        ? [`result:${prompt.deliveryAttempt.sourceExecutionId}`]
        : [],
    );
    // Pending interactions and session queues are independent reads. They can
    // cross an interrupt, so validate the canonical aggregate again before
    // publishing the composite state. This prevents an old askUser snapshot
    // from being returned with a newer chat revision.
    if (latestMission.execution !== undefined) {
      const finalExecutionState = await executionStore
        .get(latestMission.execution.id)
        .catch(() => undefined);
      if (
        finalExecutionState !== undefined &&
        isMissionTerminalExecutionStatus(finalExecutionState.status)
      ) {
        assertReadCurrent();
        effectiveExecutionStatus =
          finalExecutionState.status === "interrupted" ? "cancelled" : finalExecutionState.status;
        projectedExecutionActive = false;
        pendingInteractions = [];
        clearHumanInteractionProjection(id, latestMission.execution.id);
      }
    }
    // Re-apply acknowledgements after all asynchronous reads. A response may have completed while
    // this composite state was being assembled, in which case its earlier pending snapshot must
    // not be published to the renderer.
    pendingInteractions = excludeRespondedHumanInteractions(
      id,
      latestMission.execution?.id,
      pendingInteractions,
    );
    const healthCurrent = lifecycleService.active(id);
    const activeHandleMatches =
      projectedExecutionActive && healthCurrent?.handle.executionId === latestMission.execution?.id;
    const controlIssue = lifecycleService.controlIssue(id);
    const deletionPending =
      controlIssue?.state === "deletion_pending" ||
      (await hasMissionDeletionIntent(options.missions.storagePath?.(id), id));
    const controlHealth: MissionConversationState["controlHealth"] = deletionPending
      ? {
          state: "deletion_pending",
          reasonCode: "MISSION_DELETION_PENDING",
          ...(latestMission.execution === undefined
            ? {}
            : { executionId: latestMission.execution.id }),
          observedAt: controlIssue?.observedAt ?? new Date().toISOString(),
          availableActions: ["force_remove"],
        }
      : !projectedExecutionActive
        ? {
            state: "idle",
            observedAt: new Date().toISOString(),
            availableActions: [],
          }
        : controlIssue !== undefined
          ? {
              state: controlIssue.state,
              reasonCode: controlIssue.reasonCode,
              executionId: latestMission.execution!.id,
              observedAt: controlIssue.observedAt,
              staleSince: latestMission.execution!.startedAt,
              availableActions: ["recover", "force_interrupt", "force_remove"],
            }
          : activeHandleMatches
            ? {
                state: "healthy_active",
                executionId: latestMission.execution!.id,
                observedAt: new Date().toISOString(),
                availableActions: [],
              }
            : lifecycleService.run(id) !== undefined
              ? {
                  state: "reconciling",
                  reasonCode: "MISSION_RECOVERY_IN_PROGRESS",
                  executionId: latestMission.execution!.id,
                  observedAt: new Date().toISOString(),
                  staleSince: latestMission.execution!.startedAt,
                  availableActions: ["force_interrupt", "force_remove"],
                }
              : {
                  state: "orphaned",
                  reasonCode: "MISSION_EXECUTION_ORPHANED",
                  executionId: latestMission.execution!.id,
                  observedAt: new Date().toISOString(),
                  staleSince: latestMission.execution!.startedAt,
                  availableActions: ["recover", "force_interrupt", "force_remove"],
                };
    const result: MissionConversationState = {
      missionId: id,
      revision: stateRevision,
      pendingInteractions,
      controlHealth,
      queue: {
        state: queuePaused
          ? "paused"
          : pendingPrompts.length > 0 ||
              (projectedExecutionActive && sessionRecord?.activeExecutionId !== undefined)
            ? "running"
            : "idle",
        pendingCount: pendingPrompts.length,
        supportsSteer,
        deliveryUncertain,
        steeringRecovery,
        items: queueItems
          .filter((item) => item.status === "queued")
          .map((item) => ({
            requestId: item.requestId,
            content: item.content,
            hasAttachments: item.hasAttachments,
            ...(item.deliveryUncertain ? { deliveryUncertain: true } : {}),
          })),
        ...(pausedAfterRequestId === undefined ? {} : { pausedAfterRequestId }),
      },
      deliveries,
      hiddenEntryIds,
      ...(syncIssues.length === 0 ? {} : { syncIssues }),
      ...(latestMission.execution === undefined
        ? {}
        : {
            execution: {
              id: latestMission.execution.id,
              status: effectiveExecutionStatus!,
              interruptible:
                current?.handle.executionId === latestMission.execution.id &&
                ["queued", "running", "waiting"].includes(effectiveExecutionStatus!),
              ...(persistedTerminalStatus === "failed" && persistedExecution?.error !== undefined
                ? { error: readErrorMessage(persistedExecution.error) }
                : latestMission.execution.error === undefined
                  ? {}
                  : { error: latestMission.execution.error }),
            },
          }),
    };
    logger.debug("mission.conversation_state_read", "Mission conversation state read completed.", {
      missionId: id,
      pendingInteractionCount: result.pendingInteractions.length,
      queueItemCount: result.queue?.items.length ?? 0,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
    return result;
  };

  const getContextWindowSnapshot = (
    id: string,
    audience: MissionSurfaceAudience = "user",
  ): Promise<MissionContextWindowSnapshot> =>
    chatService.read(id, audience, "getContextWindowSnapshot", null, () =>
      withStorageDiagnostics(
        { family: "mission-display", ownerId: id, operation: "context" },
        () => getContextWindowSnapshotUnmerged(id, audience),
        logger,
      ),
    );

  const getContextWindowSnapshotUnmerged = async (
    id: string,
    audience: MissionSurfaceAudience = "user",
  ): Promise<MissionContextWindowSnapshot> => {
    const startedAt = performance.now();
    const revision = chatService.revision(id);
    const mission = await options.missions.get(id);
    if (audience === "user" && !isUserFacingMissionOrigin(mission.origin)) {
      throw new Error(`Mission ${mission.id} is not available on the Mission surface.`);
    }
    let contextWindow: MissionContextWindowState | undefined;
    let unavailable = false;
    try {
      contextWindow = await getContextWindowState(mission);
    } catch {
      unavailable = true;
    }
    const result: MissionContextWindowSnapshot = {
      missionId: id,
      revision,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(unavailable ? { syncIssues: [missionChatSyncIssue("context_window")] } : {}),
    };
    logger.debug("mission.context_window_read", "Mission context window read completed.", {
      missionId: id,
      available: result.contextWindow !== undefined,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
    return result;
  };

  const interruptMission = async (id: string, expectedExecutionId?: string): Promise<Mission> => {
    const mission = await options.missions.get(id);
    if (expectedExecutionId !== undefined && mission.execution?.id !== expectedExecutionId) {
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "The expected execution is no longer active.",
        details: {
          reason: "execution_target_changed",
          missionId: id,
          expectedExecutionId,
          ...(mission.execution?.id === undefined ? {} : { executionId: mission.execution.id }),
        },
      });
    }
    if (mission.execution?.status === "cancelled") {
      return mission;
    }
    if (
      mission.execution === undefined ||
      !["queued", "running", "waiting"].includes(mission.execution.status)
    ) {
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "Mission has no active execution.",
        details: {
          reason: "no_active_execution",
          missionId: id,
          ...(mission.execution?.id === undefined ? {} : { executionId: mission.execution.id }),
        },
      });
    }
    const persistForcedInterrupt = async (reason: string): Promise<Mission> => {
      const executionId = mission.execution!.id;
      const persisted = await executionStore.get(executionId);
      if (persisted !== undefined && !isFinalExecutionStatus(persisted.status)) {
        await new ExecutionController(executionId, executionStore).cancel(reason);
      }
      const updated = await options.missions.updateExecution(
        id,
        {
          ...mission.execution!,
          status: "cancelled",
          finishedAt: new Date().toISOString(),
        },
        { executionId, statuses: ["queued", "running", "waiting"] },
      );
      lifecycleService.clearControlIssue(id);
      invalidateChat(id, missionSurfaceAudience(mission));
      return updated;
    };
    const session = sessionService.session(id);
    if (session !== undefined) {
      const cancellation = await settlementOutcomeWithin(
        session.cancelPromptQueue("Stopped and cleared by user."),
        5_000,
      );
      const active = lifecycleService.active(id);
      const settlement =
        active === undefined
          ? ({ status: "fulfilled" } as const)
          : await settlementOutcomeWithin(active.settlement, 30_000);
      if (cancellation.status !== "fulfilled" || settlement.status !== "fulfilled") {
        lifecycleService.setControlIssue(id, {
          state: "interrupt_uncertain",
          reasonCode: "MISSION_INTERRUPT_UNCERTAIN",
          observedAt: new Date().toISOString(),
        });
        logger.warn(
          "mission.interrupt_settlement_uncertain",
          `Mission ${id} did not settle cooperatively and will be force-interrupted.`,
          {
            missionId: id,
            executionId: mission.execution.id,
            cancellation: cancellation.status,
            settlement: settlement.status,
            code: "MISSION_INTERRUPT_UNCERTAIN",
          },
        );
        if (active !== undefined) {
          await settlementOutcomeWithin(
            active.handle.cancel("Forced Mission interruption."),
            5_000,
          );
          lifecycleService.deleteActiveIfCurrent(id, active);
        }
        if (sessionService.deleteSessionIfCurrent(id, session)) {
          sessionService.clearCompilation(id);
        }
        return await persistForcedInterrupt(
          "Forced Mission interruption after settlement timeout.",
        );
      }
      invalidateChat(id, missionSurfaceAudience(mission));
      return await options.missions.get(id);
    }
    const current = lifecycleService.active(id);
    if (current === undefined || current.handle.executionId !== mission.execution?.id) {
      return await persistForcedInterrupt("Interrupted by user.");
    }
    const cancellation = await settlementOutcomeWithin(
      current.handle.cancel("Interrupted by user."),
      5_000,
    );
    const settlement = await settlementOutcomeWithin(current.settlement, 30_000);
    if (cancellation.status !== "fulfilled" || settlement.status !== "fulfilled") {
      lifecycleService.setControlIssue(id, {
        state: "interrupt_uncertain",
        reasonCode: "MISSION_INTERRUPT_UNCERTAIN",
        observedAt: new Date().toISOString(),
      });
      lifecycleService.deleteActiveIfCurrent(id, current);
      forgetFlowControlOwner(id, current.handle);
      return await persistForcedInterrupt("Forced Mission interruption after settlement timeout.");
    }
    return await options.missions.get(id);
  };

  const recoverMission = async (id: string, expectedExecutionId?: string): Promise<Mission> => {
    const mission = await options.missions.get(id);
    if (expectedExecutionId !== undefined && mission.execution?.id !== expectedExecutionId) {
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "The expected execution is no longer active.",
        details: {
          reason: "execution_target_changed",
          missionId: id,
          expectedExecutionId,
          ...(mission.execution?.id === undefined ? {} : { executionId: mission.execution.id }),
        },
      });
    }
    if (
      mission.execution === undefined ||
      !["queued", "running", "waiting"].includes(mission.execution.status)
    ) {
      return mission;
    }
    if (lifecycleService.active(id)?.handle.executionId === mission.execution.id) return mission;
    lifecycleService.clearControlIssue(id);

    const persisted = await executionStore.get(mission.execution.id);
    if (persisted !== undefined && isFinalExecutionStatus(persisted.status)) {
      const repaired = await options.missions.updateExecution(
        id,
        {
          ...mission.execution,
          status:
            persisted.status === "succeeded"
              ? "succeeded"
              : persisted.status === "failed"
                ? "failed"
                : "cancelled",
          finishedAt: persisted.updatedAt,
        },
        { executionId: mission.execution.id, statuses: ["queued", "running", "waiting"] },
      );
      invalidateChat(id, missionSurfaceAudience(mission));
      logger.info(
        "mission.execution_projection_repaired",
        `Repaired stale Mission execution projection ${mission.execution.id}.`,
        {
          missionId: id,
          executionId: mission.execution.id,
          code: "MISSION_EXECUTION_PROJECTION_STALE",
        },
      );
      return repaired;
    }

    const inFlight = lifecycleService.run(id);
    if (inFlight !== undefined) {
      const settled = await settlementOutcomeWithin(inFlight, 45_000);
      if (settled.status === "fulfilled") return await options.missions.get(id);
      lifecycleService.setControlIssue(id, {
        state: "recovery_failed",
        reasonCode: "MISSION_RECOVERY_FAILED",
        observedAt: new Date().toISOString(),
      });
      throw createIntegrationError({
        code: "EXECUTION_FAILED",
        category: "execution",
        retryable: true,
        message: "Mission recovery did not settle; force interruption is available.",
        details: {
          reason: "MISSION_RECOVERY_FAILED",
          missionId: id,
          executionId: mission.execution.id,
        },
      });
    }
    try {
      const recovered = await startMission(id);
      lifecycleService.clearControlIssue(id);
      return recovered;
    } catch (error) {
      lifecycleService.setControlIssue(id, {
        state: "recovery_failed",
        reasonCode: "MISSION_RECOVERY_FAILED",
        observedAt: new Date().toISOString(),
      });
      throw error;
    }
  };

  const forceInterruptMission = async (
    id: string,
    expectedExecutionId?: string,
  ): Promise<Mission> => {
    const beforeFence = await options.missions.get(id);
    if (expectedExecutionId !== undefined && beforeFence.execution?.id !== expectedExecutionId) {
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "The expected execution is no longer active.",
        details: {
          reason: "execution_target_changed",
          missionId: id,
          expectedExecutionId,
          ...(beforeFence.execution?.id === undefined
            ? {}
            : { executionId: beforeFence.execution.id }),
        },
      });
    }
    lifecycleService.forgetRun(id);
    await options.ownerScope?.forceRevoke(id);
    return await withMissionController(
      id,
      async () => await interruptMission(id, expectedExecutionId),
      true,
    );
  };

  const openMissionSessionForQueueMutation = async (
    id: string,
    generation: number,
  ): Promise<{
    readonly mission: Mission;
    readonly session: ExpertSession;
  }> => {
    const mission = await options.missions.get(id);
    assertRunGenerationCurrent(id, generation, "while reading its prompt queue owner");
    let session = sessionService.session(id);
    if (session !== undefined) return { mission, session };
    const sessionId = mission.execution?.sessionId;
    if (sessionId === undefined) throw new Error("This Mission has no prompt queue to change.");
    const rootContext = await readMissionRootContext(mission);
    assertRunGenerationCurrent(id, generation, "before creating its prompt queue context");
    const { app, runtimes: baseRuntimes } = await executionContext(mission);
    const stableCompilation = await compileMissionExecutorWithStableCapabilities(
      mission,
      withMissionRuntimeBinding(baseRuntimes, rootContext),
    );
    const { compiled } = stableCompilation;
    assertRunGenerationCurrent(id, generation, "while compiling its prompt queue owner");
    if ("kind" in compiled.value && compiled.value.kind === "flow") {
      throw new Error("Flow missions do not use a prompt queue.");
    }
    session = await resumeMissionSession(
      mission,
      compiled,
      stableCompilation.capabilities,
      app,
      sessionId,
    );
    sessionService.setSession(id, session);
    rememberSessionCompilation(id, stableCompilation.identity, compiled);
    return { mission, session };
  };

  /**
   * Local Host owns reservation, fencing and durable run events.  This
   * adapter deliberately starts only the Desktop Core projection and returns
   * its lower-level handle to Local Host; it never reserves a Mission or
   * appends a Local Host event itself.
   */
  const assertLocalHostRunAllowed = async (input: {
    readonly request: LocalHostRunRequest;
    readonly executor: ResolvedRunExecutor;
    readonly missionId: string;
    readonly payloadHash?: string | undefined;
  }): Promise<void> => {
    const mission = await options.missions.get(input.missionId);
    const expectedCommand = `${mission.executor.kind}.run` as LocalHostRunRequest["command"];
    const conflict = (message: string, details: Record<string, unknown> = {}): never => {
      throw createIntegrationError({
        code: "IDEMPOTENCY_CONFLICT",
        category: "conflict",
        message,
        details: { missionId: input.missionId, ...details },
      });
    };

    if (mission.branch !== undefined && mission.execution === undefined) {
      throw new Error("Continue a branched Mission by sending a new message.");
    }
    if (
      mission.executor.kind !== input.request.executor.kind ||
      mission.executor.ref !== `${input.request.executor.kind}:${input.request.executor.id}` ||
      input.request.command !== expectedCommand
    ) {
      conflict("The attached Mission executor does not match the run request.", {
        executor: input.request.executor,
      });
    }
    if (
      input.executor.descriptor.ref.kind !== input.request.executor.kind ||
      input.executor.descriptor.ref.id !== input.request.executor.id
    ) {
      conflict("The resolved executor does not match the attached Mission.", {
        executor: input.request.executor,
      });
    }
    if (
      input.request.workspace.canonicalPath !== mission.workspace.path ||
      input.request.requestId !== mission.initialMessageId
    ) {
      conflict("The attached Mission workspace or initial request identity changed.", {
        requestId: input.request.requestId,
      });
    }

    const project = input.executor.descriptor.project;
    if (project !== undefined) {
      if (
        project.projectId !== mission.project.id ||
        project.revision !== mission.project.revision ||
        input.request.project?.projectId !== mission.project.id ||
        input.request.project?.revision !== mission.project.revision
      ) {
        conflict("The attached Mission project revision does not match the run request.");
      }
    } else if (input.request.project !== undefined) {
      conflict("The built-in executor cannot carry a project binding.");
    }

    if (input.payloadHash !== undefined) {
      const expectedPayloadHash = hashCanonicalRunPayload({
        command: expectedCommand,
        executor: input.executor.descriptor.ref,
        workspace: input.request.workspace,
        ...(project === undefined ? {} : { project }),
        ...(mission.executor.kind === "flow"
          ? { input: mission.flowInput }
          : { prompt: mission.goal }),
      });
      if (expectedPayloadHash !== input.payloadHash) {
        conflict("The attached Mission semantic run payload changed.", {
          requestId: input.request.requestId,
        });
      }
    }
  };

  const startLocalHostRun = async (input: {
    readonly request: LocalHostRunRequest;
    readonly executor: ResolvedRunExecutor;
    readonly missionId: string;
    readonly onEvent?: ((event: LocalHostRunEvent) => void) | undefined;
  }): Promise<LocalHostRunHandle> => {
    await assertLocalHostRunAllowed(input);
    await startMission(input.missionId);
    const current = lifecycleService.active(input.missionId);
    if (current === undefined) {
      throw createIntegrationError({
        code: "EXECUTION_FAILED",
        category: "execution",
        retryable: false,
        message: "Desktop did not retain the started Mission execution handle.",
        details: { missionId: input.missionId },
      });
    }
    const localHostState = createLocalHostRunHandleState({
      coreHandle: current.handle,
      executions: executionStore,
      missionId: input.missionId,
      release: async () => undefined,
      onEvent: input.onEvent,
      onCheckpointed: async () => {
        // The checkpoint must be fully detached from the old in-memory
        // ExpertSession before input_required is exposed. Otherwise a fast
        // response can be routed to the old handle after its controller and
        // lease have already been released, leaving the response persisted
        // but never resumed.
        sessionService.deleteSession(input.missionId);
        const checkpointed = lifecycleService.active(input.missionId);
        if (checkpointed?.handle === current.handle) {
          // Remove the old handle synchronously. `releaseAfterHumanCheckpoint`
          // resolves the checkpoint gate before awaiting observer settlement;
          // keeping it in the lifecycle map during that await lets a fast
          // response reuse the detached handle.
          lifecycleService.deleteActiveIfCurrent(input.missionId, checkpointed);
          forgetFlowControlOwner(input.missionId, checkpointed.handle);
          void checkpointed.releaseAfterHumanCheckpoint().catch((error: unknown) => {
            logger.warn(
              "mission.human_checkpoint_release_failed",
              "Mission human checkpoint was exposed, but old observer cleanup failed.",
              { error, missionId: input.missionId, executionId: current.handle.executionId },
            );
          });
        }
      },
    });
    return { ...localHostState.handle, missionOwnerLifetime: "host" };
  };

  let missionCommands: MissionControlApplication | undefined;
  let standaloneOwnerScope: MissionOwnerScope | undefined;
  const submitMissionCommand = async (input: MissionControlSubmitInput) => {
    // Standalone Host composition uses the same durable application. Desktop's
    // Node composition binds its existing controller/owner before product use.
    if (missionCommands === undefined) {
      const controller = createMissionControllerStore({
        missionsPath: new PragmaPaths({ pragmaHome: options.pragmaHome }).missionsRoot(),
        ...(options.missions.storagePath === undefined
          ? {}
          : { missionPath: options.missions.storagePath }),
      });
      const ownerScope = options.ownerScope ?? createMissionOwnerScope({ controller });
      if (options.ownerScope === undefined) standaloneOwnerScope = ownerScope;
      missionCommands = createMissionControlApplication({
        controller,
        ownerScope,
        consumer: coreControl.consumer,
        assertMission: async (id) => {
          await options.missions.get(id);
        },
        resolveStrictTarget: coreControl.resolveStrictTarget,
        resolveExecutionTarget: coreControl.resolveExecutionTarget,
      });
    }
    try {
      const submitted = await missionCommands.submit(input);
      const operation = await missionCommands.waitForTerminal({
        missionId: input.missionId,
        requestId: input.requestId,
      });
      if (operation.state === "rejected")
        throw operation.error ?? new Error("Mission command was rejected.");
      return { submitted, operation };
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string" &&
        !(error instanceof Error)
      ) {
        throw Object.assign(new Error(error.message), error);
      }
      throw error;
    }
  };

  const coreControl = createLocalHostCoreMissionControlAdapter({
    pragmaHome: options.pragmaHome,
    runtimes: options.runtimes,
    executions: executionStore,
    sessions: expertSessionStore,
    loggerProvider: options.loggerProvider,
    executionSettlement: (id) => lifecycleService.active(id)?.settlement,
    resolveInteractionHandle: async (id, executionId) => {
      // A checkpoint keeps the durable Session but detaches its Desktop
      // observer. Restore that projection before Core consumes the response,
      // using the same Session that the shared owner registry recovered.
      const active = lifecycleService.active(id) ?? (await ensureActiveExecution(id, ""));
      return active.handle.executionId === executionId ? active.handle : undefined;
    },
    ownerAccess: executionOwner,
    onApplicationBound: (application) => {
      missionCommands = application;
    },
    assertMissionReady: async (id) => {
      await options.assertExecutorReady?.((await options.missions.get(id)).executor.ref);
    },
    executors: [],
    resolveMissionBinding: async () => undefined,
    resolveExecutionId: async (id) => (await options.missions.get(id)).execution?.id,
    resolveSessionId: async (id) => (await options.missions.get(id)).execution?.sessionId,
    resolveActiveOwner: async (id) => {
      const session = sessionService.session(id);
      if (session !== undefined) return { kind: "session", session };
      const active = lifecycleService.active(id);
      if (active !== undefined && (await options.missions.get(id)).executor.kind === "flow")
        return { kind: "flow", execution: active.handle };
      return undefined;
    },
    recoverActiveOwner: async (id) => {
      const generation = lifecycleService.runGeneration(id);
      const mission = await options.missions.get(id);
      assertRunGenerationCurrent(id, generation, "while reading its control owner");
      if (mission.executor.kind === "flow") {
        const active = await ensureActiveExecution(id, "");
        return { kind: "flow", execution: active.handle };
      }
      return await withMissionPromptAdmission(id, async () => {
        const { session } = await openMissionSessionForQueueMutation(id, generation);
        return { kind: "session" as const, session };
      });
    },
    stopFlow: async (id, executionId, reason, signal) => {
      const mission = await options.missions.get(id);
      if (mission.executor.kind !== "flow" || mission.execution?.id !== executionId)
        throw createIntegrationError({
          code: "COMMAND_REJECTED",
          category: "conflict",
          message: "The expected Flow execution is no longer active.",
          details: { missionId: id, reason: "execution_target_changed" },
        });
      const { app, runtimes: baseRuntimes } = await executionContext(mission);
      const runtimes = withMissionRuntimeBinding(
        baseRuntimes,
        await readMissionRootContext(mission),
      );
      // Stop uses the original Context snapshots; preparing current tools,
      // credentials or mounts would make interruption depend on their health.
      const compiled = await compileMissionExecutor(mission, runtimes, options.project, "stop");
      if (!("kind" in compiled.value) || compiled.value.kind !== "flow")
        throw new Error(`Mission ${id} does not resolve to a Flow.`);
      await app.flows.stop(compiled.value, { executionId, reason, signal });
    },
    ...(options.ownerScope === undefined
      ? {}
      : {
          runWithGuard: <T>(
            id: string,
            guard: import("@pragma/local-host").MissionControllerGuard,
            operation: () => Promise<T>,
          ) => options.ownerScope!.runWithGuard(id, guard, operation),
        }),
    admission: sendMissionMessage.mapResult(async (accepted) => {
      const input = { id: accepted.mission.id, requestId: accepted.requestId };
      const queue = await promptQueueProjection.list(input.id);
      const queuedPosition = queue.items.findIndex((item) => item.requestId === input.requestId);
      return {
        missionId: input.id,
        ...(accepted.mission.execution === undefined
          ? {}
          : { executionId: accepted.mission.execution.id }),
        mode: accepted.effectiveMode,
        turnId: input.requestId,
        queueState: queue.state,
        ...(queuedPosition < 0 ? {} : { queuePosition: queuedPosition + 1 }),
      };
    }),
    onCommandApplied: async (command, result) => {
      if (command.kind === "send" || command.kind === "steer") return;
      const mission = await options.missions.get(command.missionId);
      if (
        command.kind === "respond" &&
        command.target?.interactionId !== undefined &&
        typeof result["executionId"] === "string"
      ) {
        acknowledgeHumanInteractionResponse(
          command.missionId,
          result["executionId"],
          command.target.interactionId,
        );
      }
      if (command.kind === "interrupt" && mission.execution !== undefined) {
        const persisted = await executionStore.get(mission.execution.id);
        if (persisted !== undefined && isFinalExecutionStatus(persisted.status)) {
          await options.missions.updateExecution(
            mission.id,
            {
              ...mission.execution,
              status:
                persisted.status === "succeeded"
                  ? "succeeded"
                  : persisted.status === "failed"
                    ? "failed"
                    : "cancelled",
              finishedAt: persisted.updatedAt,
            },
            { executionId: mission.execution.id, statuses: ["queued", "running", "waiting"] },
          );
        }
      }
      if (command.kind.startsWith("queue.")) {
        await publishPromptQueue(mission);
        if (command.kind === "queue.resume")
          await attachNextSessionTurn(command.missionId, missionSurfaceAudience(mission));
      }
      invalidateChat(command.missionId, missionSurfaceAudience(mission));
    },
    onCommandOutcome: async (outcome) => {
      commandService.emit({
        missionId: outcome.command.missionId,
        requestId: outcome.command.request.requestId,
        state: outcome.state,
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      });
    },
  });

  options.ownerScope?.bindConsumer(coreControl.consumer);

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

  const projectMissionWorkRecords = async (
    mission: Mission,
    historyRecords: readonly ExecutionWorkRecord[],
  ): Promise<MissionWorkRecord[]> => {
    const { avatarIds, names } = await getExecutorMetadataOrFallback(mission, "work");
    const runtimeAgentOrdinals = createRuntimeAgentOrdinals(historyRecords);
    const runtimeAgentAvatarIds = createRuntimeAgentAvatarIds(historyRecords, avatarIds.values());
    return historyRecords.map((record): MissionWorkRecord => {
      const tasks = record.tasks.map((task) => {
        const outputSummary = missionWorkOutputSummary(task.output, 1_000);
        return {
          taskId: task.taskId,
          executionId: task.executionId,
          invocationId: task.invocationId,
          runId: task.runId,
          ...(task.sequence === undefined ? {} : { sequence: task.sequence }),
          status: task.status,
          ...(task.waitReason === undefined ? {} : { waitReason: task.waitReason }),
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
        ...(record.waitReason === undefined ? {} : { waitReason: record.waitReason }),
        tasks,
        summary: latest?.outputSummary ?? latest?.inputSummary ?? title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    });
  };

  const loadWorkSnapshot = async (mission: Mission) => {
    const revision = workService.revision(mission.id);
    const executionIds = await readMissionExecutionIds(mission);
    const historyRecords = await workHistory.listRecords({
      executionIds,
      ...(mission.execution?.sessionId === undefined
        ? {}
        : { rootSessionId: mission.execution.sessionId }),
    });
    const records = await projectMissionWorkRecords(mission, historyRecords);
    return {
      executionCount: executionIds.length,
      snapshot: { missionId: mission.id, revision, records },
    };
  };

  const loadWorkProjection = async (mission: Mission) => {
    const revision = workService.revision(mission.id);
    const executionIds = await readMissionExecutionIds(mission);
    const executionSignature = (
      await Promise.all(
        executionIds.map(async (executionId) => {
          const execution = await executionStore.get(executionId);
          return `${executionId}:${execution?.version ?? "missing"}:${execution?.lastAppliedSequence ?? "missing"}`;
        }),
      )
    ).join("|");
    const cached = workService.cached(mission.id, revision, executionSignature);
    if (cached !== undefined) {
      return { projection: cached, cacheHit: true } as const;
    }
    const activeLoad = workService.loading(mission.id, revision, executionSignature);
    if (activeLoad !== undefined) {
      return { projection: await activeLoad, cacheHit: true } as const;
    }

    const promise = (async () => {
      const projection = await workHistory.readProjection({
        executionIds,
        ...(mission.execution?.sessionId === undefined
          ? {}
          : { rootSessionId: mission.execution.sessionId }),
      });
      const records = await projectMissionWorkRecords(mission, projection.records);
      const entriesByRecordId = new Map<string, readonly MissionChatEntry[]>();
      for (const record of projection.records) {
        const supersededTaskIds =
          projection.conversations.supersededTaskIds.get(record.recordId) ?? new Set<string>();
        const taskInputEntries = workTaskInputEntries({
          ...record,
          tasks: record.tasks.filter((task) => !supersededTaskIds.has(task.taskId)),
        });
        const messageInputEntries = (
          projection.conversations.messageInputs.get(record.recordId) ?? []
        ).map((entry): MissionChatEntry => ({
          id: entry.id,
          executionId: entry.executionId,
          invocationId: entry.invocationId,
          kind: "user",
          content: truncate(entry.content, 200_000),
          createdAt: entry.createdAt,
        }));
        const durableEntries = messageRecordsToChatEntries(
          projection.conversations.output.get(record.recordId) ?? [],
        );
        entriesByRecordId.set(
          record.recordId,
          uniqueMissionChatEntries([
            ...taskInputEntries,
            ...messageInputEntries,
            ...durableEntries,
          ]).toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
        );
      }
      return {
        revision,
        executionSignature,
        executionCount: executionIds.length,
        snapshot: { missionId: mission.id, revision, records },
        entriesByRecordId,
      };
    })();
    workService.beginLoad(mission.id, revision, executionSignature, promise);
    try {
      const projection = await promise;
      if (
        workService.revision(mission.id) === revision &&
        projection.executionSignature === executionSignature
      ) {
        workService.cache(mission.id, projection);
      }
      return { projection, cacheHit: false } as const;
    } finally {
      workService.finishLoad(mission.id, promise);
    }
  };

  const getWorkSnapshot = async (id: string): Promise<MissionWorkSnapshot> => {
    const t0 = performance.now();
    let mission = await options.missions.get(id);
    await awaitTerminalLifecycleSettlement(mission);
    mission = await options.missions.get(id);
    const projection = await loadWorkSnapshot(mission);
    const t1 = performance.now();
    logger.info(
      "mission.get_work_snapshot",
      `Loaded Mission work snapshot for ${id} in ${(t1 - t0).toFixed(1)}ms.`,
      {
        missionId: id,
        executionCount: projection.executionCount,
        recordCount: projection.snapshot.records.length,
        projection: "records",
        elapsedMs: t1 - t0,
      },
    );
    return projection.snapshot;
  };

  const readWorkConversation = async (
    input: GetMissionWorkConversation,
  ): Promise<{
    readonly snapshot: MissionWorkConversationSnapshot;
    readonly overlay?: MissionWorkConversationOverlay | undefined;
    readonly overlayRevision: number;
  }> => {
    const t0 = performance.now();
    let phaseReadStartedAt = performance.now();
    let mission = await options.missions.get(input.id);
    logMissionPhase(logger, input.id, "mission_read_initial", phaseReadStartedAt, t0);
    if (await awaitTerminalLifecycleSettlement(mission)) {
      phaseReadStartedAt = performance.now();
      mission = await options.missions.get(input.id);
      logMissionPhase(logger, input.id, "mission_read_after_settlement", phaseReadStartedAt, t0);
    }
    const { projection, cacheHit } = await loadWorkProjection(mission);
    const durableEntries = projection.entriesByRecordId.get(input.recordId);
    if (durableEntries === undefined) {
      throw new Error(`Mission work record not found: ${input.recordId}`);
    }
    const overlay = workConversationOverlays.get(
      workConversationOverlayKey(mission.id, input.recordId),
    );
    const overlayRevision = overlay?.revision ?? 0;
    const liveEntries = uniqueMissionChatEntries([
      ...(workService.live(mission.id, input.recordId)?.entries ?? []),
      ...(overlay?.live.entries ?? []),
    ]);
    const liveExecutionIds = new Set(liveEntries.flatMap((entry) => entry.executionId ?? []));
    const byId = new Map<string, MissionChatEntry>();
    for (const entry of durableEntries) {
      if (
        entry.kind === "user" ||
        entry.executionId === undefined ||
        !liveExecutionIds.has(entry.executionId)
      ) {
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
    const t1 = performance.now();
    logger.info(
      "mission.get_work_conversation",
      `Loaded Mission work conversation for ${input.id}:${input.recordId} in ${(t1 - t0).toFixed(1)}ms.`,
      {
        missionId: input.id,
        recordId: input.recordId,
        executionCount: projection.executionCount,
        outputRecordCount: entries.length,
        cacheHit,
        elapsedMs: t1 - t0,
      },
    );
    return {
      snapshot: {
        missionId: mission.id,
        recordId: input.recordId,
        revision: workService.revision(mission.id),
        entries: entries.slice(start, end),
        ...(start === 0 ? {} : { nextBeforeCursor: String(start) }),
      },
      ...(overlay === undefined ? {} : { overlay }),
      overlayRevision,
    };
  };

  const getWorkConversation = async (
    input: GetMissionWorkConversation,
  ): Promise<MissionWorkConversationSnapshot> => (await readWorkConversation(input)).snapshot;

  const closeWorkConversationStream = async (subscriptionId: string): Promise<void> => {
    const stream = workConversationStreams.get(subscriptionId);
    if (stream === undefined) return;
    workConversationStreams.delete(subscriptionId);
    const watcher = stream.watcher;
    if (watcher === undefined) return;
    watcher.subscribers.delete(subscriptionId);
    if (watcher.subscribers.size > 0) return;
    workConversationWatchers.delete(watcher.key);
    workConversationWatcherPromises.delete(watcher.key);
    await watcher.close();
  };

  const createWorkConversationWatcher = async (input: {
    readonly key: string;
    readonly mission: Mission;
    readonly record: MissionWorkRecord;
    readonly task: MissionWorkRecord["tasks"][number];
  }): Promise<MissionWorkConversationWatcher> => {
    const metadata = await getExecutorMetadataOrFallback(input.mission, "work");
    const subscription = await new StoredExecutionView(
      input.task.executionId,
      executionStore,
    ).subscribeOutput({
      scope: { kind: "invocation", invocationId: input.task.invocationId },
      sourceScope:
        input.record.kind === "runtime-agent"
          ? { kind: "session", sessionId: input.record.sessionId }
          : { kind: "root" },
      // The latest durable message is written only when a Runtime message completes. Replaying
      // the bounded in-memory output history is therefore required when the drawer opens after a
      // thought, tool call, or message has already started. The watcher projection uses the same
      // stable entry ids as the durable projection, so the opening snapshot can de-duplicate both.
      replay: "history",
    });
    const live: LiveMissionChat = {
      executionId: input.task.executionId,
      entries: [],
      messageOrdinals: new Map(),
      close: async () => undefined,
    };
    const overlay: MissionWorkConversationOverlay = {
      missionId: input.mission.id,
      recordId: input.record.recordId,
      live,
      revision: 0,
    };
    const subscribers = new Map<string, MissionWorkConversationStreamSubscriber>();
    let closed = false;
    const emitToSubscribers = (update: MissionWorkConversationUpdatePayload): void => {
      const overlayRevision = ++overlay.revision;
      for (const subscriber of subscribers.values()) {
        if (subscriber.pendingUpdates !== undefined) {
          subscriber.pendingUpdates.push({ overlayRevision, update });
        } else {
          emitWorkConversationSubscriberUpdate(subscriber, update);
        }
      }
    };
    const coalescer = createMissionOutputCoalescer({
      emit: (item) => {
        const patches = consumeLiveChatOutput(live, item, {
          includeNestedSource: input.record.kind === "runtime-agent",
          resolveExecutorName: createMissionExecutorNameResolver(input.mission, metadata.names),
          resolveExecutorAvatarId: createMissionExecutorAvatarIdResolver(metadata.avatarIds),
        });
        if (!closed && patches.length > 0) emitToSubscribers({ kind: "patch", patches });
      },
    });
    const watcher: MissionWorkConversationWatcher = {
      key: input.key,
      overlay,
      live,
      subscribers,
      close: async () => {
        if (closed) return;
        closed = true;
        coalescer.close();
        await subscription.close();
        await outputTask;
      },
    };
    workConversationWatchers.set(input.key, watcher);
    workConversationOverlays.set(
      workConversationOverlayKey(input.mission.id, input.record.recordId),
      overlay,
    );
    const outputTask = (async () => {
      try {
        for await (const item of subscription) {
          if (closed) break;
          coalescer.push(item);
        }
        coalescer.flush();
        if (!closed) emitToSubscribers({ kind: "invalidate" });
      } catch (error) {
        if (!closed) {
          logger.warn(
            "mission.work_conversation_subscription_failed",
            `Mission work conversation watcher failed for ${input.mission.id}:${input.record.recordId}.`,
            { error, missionId: input.mission.id, recordId: input.record.recordId },
          );
          emitToSubscribers({ kind: "invalidate" });
        }
      } finally {
        if (workConversationWatchers.get(input.key) === watcher) {
          workConversationWatchers.delete(input.key);
          workConversationWatcherPromises.delete(input.key);
        }
        const overlayKey = workConversationOverlayKey(input.mission.id, input.record.recordId);
        if (workConversationOverlays.get(overlayKey) === overlay) {
          workConversationOverlays.delete(overlayKey);
        }
        for (const subscriber of subscribers.values()) {
          if (workConversationStreams.get(subscriber.subscriptionId)?.watcher === watcher) {
            workConversationStreams.delete(subscriber.subscriptionId);
          }
        }
        subscribers.clear();
      }
    })();
    return watcher;
  };

  const getOrCreateWorkConversationWatcher = async (input: {
    readonly key: string;
    readonly mission: Mission;
    readonly record: MissionWorkRecord;
    readonly task: MissionWorkRecord["tasks"][number];
  }): Promise<MissionWorkConversationWatcher> => {
    const existing = workConversationWatchers.get(input.key);
    if (existing !== undefined) return existing;
    const pending = workConversationWatcherPromises.get(input.key);
    if (pending !== undefined) return await pending;
    const created = createWorkConversationWatcher(input).catch((error: unknown) => {
      workConversationWatcherPromises.delete(input.key);
      throw error;
    });
    workConversationWatcherPromises.set(input.key, created);
    return await created;
  };

  const openWorkConversationStream = async (
    input: OpenMissionWorkConversationStream,
  ): Promise<OpenMissionWorkConversationStreamResult> => {
    await closeWorkConversationStream(input.subscriptionId);
    let mission = await options.missions.get(input.missionId);
    await awaitTerminalLifecycleSettlement(mission);
    mission = await options.missions.get(input.missionId);
    const work = await loadWorkSnapshot(mission);
    const record = work.snapshot.records.find((candidate) => candidate.recordId === input.recordId);
    if (record === undefined) throw new Error(`Mission work record not found: ${input.recordId}`);
    const activeTask = record.tasks
      .toReversed()
      .find(
        (task) =>
          task.executionId === mission.execution?.id &&
          (task.status === "queued" || task.status === "running" || task.status === "waiting"),
      );
    const streamId = randomUUID();
    let watcher: MissionWorkConversationWatcher | undefined;
    if (mission.executor.kind === "team" && activeTask !== undefined) {
      const key = JSON.stringify([
        input.missionId,
        input.recordId,
        activeTask.executionId,
        activeTask.invocationId,
      ]);
      watcher = await getOrCreateWorkConversationWatcher({
        key,
        mission,
        record,
        task: activeTask,
      });
    }
    let subscriber: MissionWorkConversationStreamSubscriber | undefined;
    if (watcher !== undefined && workConversationWatchers.get(watcher.key) === watcher) {
      // Buffer before the asynchronous durable read. The overlay watermark below discards
      // updates already represented by the opening snapshot and forwards only the later tail.
      subscriber = {
        subscriptionId: input.subscriptionId,
        streamId,
        missionId: input.missionId,
        recordId: input.recordId,
        sequence: 0,
        pendingUpdates: [],
      };
      watcher.subscribers.set(input.subscriptionId, subscriber);
    } else {
      watcher = undefined;
    }
    workConversationStreams.set(input.subscriptionId, {
      missionId: input.missionId,
      streamId,
      watcher,
    });
    try {
      const opened = await readWorkConversation({
        id: input.missionId,
        recordId: input.recordId,
        limit: input.limit,
      });
      if (
        watcher !== undefined &&
        subscriber !== undefined &&
        watcher.subscribers.get(input.subscriptionId) === subscriber
      ) {
        const capturedOverlayRevision =
          opened.overlay === watcher.overlay ? opened.overlayRevision : -1;
        const pendingUpdates = subscriber.pendingUpdates ?? [];
        subscriber.pendingUpdates = undefined;
        for (const pending of pendingUpdates) {
          if (pending.overlayRevision > capturedOverlayRevision) {
            emitWorkConversationSubscriberUpdate(subscriber, pending.update);
          }
        }
      }
      return { subscriptionId: input.subscriptionId, streamId, snapshot: opened.snapshot };
    } catch (error) {
      await closeWorkConversationStream(input.subscriptionId);
      throw error;
    }
  };

  const reconcileMissionUsage = async (mission: Mission): Promise<void> => {
    if (options.usage === undefined) return;
    // Deferred Host initialization must load the durable tracking cutoff before
    // deciding whether historical executions belong to this accounting ledger.
    await options.usage.assertAvailable();
    const names = await withOpenPragmaProjectRevision(
      options.project,
      mission.project.revision,
      async (project) =>
        new Map(
          project
            .listResources()
            .map((resource) => [resource.metadata.id, resource.metadata.name] as const),
        ),
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
        await options.usage.recordRecovered(
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
  const withMissionController = async <T>(
    missionId: string,
    operation: () => Promise<T>,
    allowDeletionPending = false,
  ): Promise<T> => {
    if (
      !allowDeletionPending &&
      (lifecycleService.controlIssue(missionId)?.state === "deletion_pending" ||
        (await hasMissionDeletionIntent(options.missions.storagePath?.(missionId), missionId)))
    ) {
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "Mission deletion is pending; only the explicit removal retry is available.",
        details: { missionId, reason: "MISSION_DELETION_PENDING" },
      });
    }
    if (options.ownerScope === undefined) {
      return await operation();
    }
    const guard = await options.ownerScope.acquire(missionId);
    return await options.ownerScope.runWithGuard(missionId, guard, operation);
  };

  return {
    async get(id) {
      const mission = await options.missions.get(id);
      if (mission.execution !== undefined)
        await options.registerExecutionDelivery?.(
          mission,
          mission.execution.id,
          mission.execution.inputMessageId,
        );
      return mission;
    },
    reconcileUsage,
    coordinateMemoryTerminal: withMissionPromptAdmission,
    markDeliveryDegraded(id) {
      chatService.markSyncDegraded(id);
      invalidateChat(id, "user");
    },
    markDeliveryRecovered(id) {
      if (chatService.markSyncRecovered(id)) invalidateChat(id, "user");
    },
    notifyProjectionChanged(id) {
      invalidateChat(id, "user");
      invalidateWork(id, "user");
    },
    async invalidateEstimatedContextWindows() {
      for (const mission of await options.missions.list()) invalidateChat(mission.id, "user");
    },
    refreshMemoryContextBindings,
    async run(id) {
      return await startMission(id);
    },
    async recover(id, expectedExecutionId) {
      return await recoverMission(id, expectedExecutionId);
    },
    startLocalHostRun,
    assertLocalHostRunAllowed,
    missionControl: coreControl,
    async updateOptions(input) {
      return await withMissionPromptAdmission(input.id, () =>
        withMissionController(input.id, async () => await updateMissionOptions(input)),
      );
    },
    async updateContextMounts(input) {
      return await withMissionPromptAdmission(input.id, () =>
        withMissionController(input.id, async () => await updateMissionContextMounts(input)),
      );
    },
    async assertContextMountChangeAllowed(id) {
      await withMissionController(id, async () => {
        await assertContextMountChangeAllowedWithinController(id);
      });
    },
    async removeContextStoreMount(input) {
      return await withMissionController(input.id, async () => {
        const mission = await options.missions.get(input.id);
        if (!isUserFacingMissionOrigin(mission.origin)) return mission;
        const contextMounts = mission.contextMounts.filter(
          (mount) => mount.kind !== "context-store" || mount.storeId !== input.storeId,
        );
        if (contextMounts.length === mission.contextMounts.length) return mission;
        return await updateMissionContextMounts({ id: input.id, contextMounts });
      });
    },
    async invalidateContextBindings(id) {
      await invalidateContextBindings(id);
    },
    async sendMessage(input) {
      const mode = input.mode ?? "enqueue";
      const { operation } = await submitMissionCommand({
        missionId: input.id,
        requestId: input.requestId,
        kind: mode === "steer" ? "steer" : "send",
        createdAt: new Date().toISOString(),
        payload: {
          kind: mode === "steer" ? "steer" : "send",
          input: { prompt: input.content, attachments: [...(input.attachments ?? [])] },
        },
      });
      return {
        mission: await options.missions.get(input.id),
        requestId: input.requestId,
        requestedMode: mode,
        effectiveMode: operation.result?.["mode"] === "steer" ? "steer" : "enqueue",
      };
    },
    async steerQueuedMessage(input) {
      await submitMissionCommand({
        missionId: input.id,
        requestId: randomUUID(),
        kind: "queue.steer",
        payload: { kind: "queue.steer", requestId: input.requestId },
      });
      return await options.missions.get(input.id);
    },
    async removeQueuedMessage(input) {
      await submitMissionCommand({
        missionId: input.id,
        requestId: randomUUID(),
        kind: "queue.remove",
        payload: { kind: "queue.remove", requestId: input.requestId },
      });
      return await options.missions.get(input.id);
    },
    async resumeQueue(id) {
      await submitMissionCommand({
        missionId: id,
        requestId: randomUUID(),
        kind: "queue.resume",
        payload: { kind: "queue.resume" },
      });
      return await options.missions.get(id);
    },
    async getChatPage(input) {
      return await getChatPage(input);
    },
    async getInternalConversationSnapshot(id) {
      const mission = await options.missions.get(id);
      if (mission.origin.type !== "system-memory") {
        throw new Error("Internal Memory transcript access requires a system-memory Mission.");
      }
      return await readMissionConversationSnapshot(
        {
          getChatPage: (input) => getChatPage(input, "internal"),
          getConversationState: (missionId) => getConversationState(missionId, "internal"),
          getContextWindow: (missionId) => getContextWindowSnapshot(missionId, "internal"),
        },
        id,
      );
    },
    async getConversationState(id) {
      return await getConversationState(id);
    },
    async getContextWindow(id) {
      return await getContextWindowSnapshot(id);
    },
    async listPromptQueue(id) {
      return await promptQueueProjection.list(id);
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
      return await lifecycleService.startCompaction(id, () =>
        withMissionPromptAdmission(id, async () => await compactMissionContext(id)),
      );
    },
    async getRuntimeBinding(id, missionSnapshot) {
      const mission = missionSnapshot ?? (await options.missions.get(id));
      return (await readMissionRootContext(mission))?.runtime;
    },
    subscribeChat(listener) {
      return chatService.subscribe(listener);
    },
    subscribeWork(listener) {
      return workService.subscribe(listener);
    },
    subscribeStatus(listener) {
      return statusService.subscribe(listener);
    },
    subscribeCommandOutcomes(listener) {
      return commandService.subscribe(listener);
    },
    async interrupt(id, expectedExecutionId) {
      await submitMissionCommand({
        missionId: id,
        requestId: randomUUID(),
        kind: "interrupt",
        payload: { kind: "interrupt" },
        ...(expectedExecutionId === undefined ? {} : { expectedExecutionId }),
      });
      return await options.missions.get(id);
    },
    async forceInterrupt(id, expectedExecutionId) {
      return await forceInterruptMission(id, expectedExecutionId);
    },
    async stopLocalController(id) {
      const standaloneScope = standaloneOwnerScope;
      const standaloneGuard = standaloneScope?.currentGuard(id);
      const releaseStandaloneOwner = async (): Promise<void> => {
        const currentGuard = standaloneScope?.currentGuard(id);
        if (
          standaloneScope !== undefined &&
          standaloneGuard !== undefined &&
          currentGuard?.claimId === standaloneGuard.claimId &&
          currentGuard.fencingToken === standaloneGuard.fencingToken &&
          sessionService.session(id) === undefined &&
          !lifecycleService.hasActive(id)
        ) {
          await standaloneScope.release(id);
        }
      };
      chatService.clearReads(id);
      lifecycleService.markLeaseLost(id);
      const current = lifecycleService.active(id);
      const session = sessionService.session(id);
      const executionContext = sessionService.executionContext(id);
      const pendingSettlement: Promise<unknown>[] = [];
      if (current !== undefined) {
        const cancelling = current.handle.cancel("Mission controller lease was lost.");
        pendingSettlement.push(cancelling, current.settlement);
        await settlementOutcomeWithin(cancelling, 5_000);
        await settlementOutcomeWithin(current.settlement, 30_000);
        lifecycleService.deleteActiveIfCurrent(id, current);
        forgetFlowControlOwner(id, current.handle);
      }
      if (session !== undefined) {
        const cancellingQueue = session.cancelPromptQueue("Mission controller lease was lost.");
        pendingSettlement.push(cancellingQueue);
        await settlementOutcomeWithin(cancellingQueue, 5_000);
        // Keep the owner and its PragmaApp until release settles. A timeout is
        // not a released lease: opening a new app here would compete with this
        // process's own ExpertSession and strand subsequent messages.
        const forgetReleasedOwner = (): boolean => {
          if (!sessionService.deleteSessionIfCurrent(id, session)) return false;
          sessionService.clearCompilation(id);
          if (executionContext !== undefined) {
            sessionService.deleteExecutionContextIfCurrent(id, executionContext);
          }
          return true;
        };
        const releasing = session
          .releaseAfterTerminal({
            waitForIdle: true,
            settlement: Promise.allSettled(pendingSettlement),
          })
          .then(
            async () => {
              const releasedCurrentOwner = forgetReleasedOwner();
              // The standalone controller remains live while Core teardown is
              // pending, so concurrent sends receive the sealed Session error.
              // Its Mission lease can be released after that exact owner ends.
              if (releasedCurrentOwner) await releaseStandaloneOwner();
            },
            async (error: unknown) => {
              // Validation can reject while a turn is still settling. Teardown
              // has not started in that case, so this Session still owns its lease.
              if (!(error instanceof ExpertSessionReleaseBlockedError)) {
                if (forgetReleasedOwner()) await releaseStandaloneOwner();
              }
              throw error;
            },
          );
        const release = await settlementOutcomeWithin(releasing, 10_000);
        if (release.status === "rejected") {
          logger.warn(
            "mission.controller_session_release_failed",
            `Mission ${id} could not release its ExpertSession after the controller lease was lost.`,
            { error: release.error, missionId: id, sessionId: session.sessionId },
          );
        }
        return;
      }
      if (executionContext !== undefined) {
        sessionService.deleteExecutionContextIfCurrent(id, executionContext);
      }
      await releaseStandaloneOwner();
    },
    getResourceDiagnostics() {
      return {
        warmSessionCount: [...sessionService.sessionEntries()].length,
        busyMissionCount: lifecycleService.busyMissionCount(),
      };
    },
    async releaseIdleSession(id, idleTimeoutMs, releaseOwner) {
      return await withMissionPromptAdmission(id, async () => {
        if (lifecycleService.isBusy(id) || sessionService.contextBindingChangeInProgress(id))
          return false;
        const session = sessionService.session(id);
        const executionContext = sessionService.executionContext(id);
        if (session !== undefined) {
          const [state, prompts] = await Promise.all([
            session.getState(),
            session.getPromptQueue(),
          ]);
          if (
            state.activeExecutionId !== undefined ||
            prompts.some((prompt) => prompt.status === "queued" || prompt.status === "running") ||
            Date.now() - Date.parse(state.updatedAt) < idleTimeoutMs
          )
            return false;
          // Release transient resources, preserving the durable Session and
          // RuntimeSessionRef for the next prompt. Never close/cancel an idle
          // Session as though the user had ended the conversation.
          await session.releaseAfterTerminal();
          if (!sessionService.deleteSessionIfCurrent(id, session)) return false;
          sessionService.clearCompilation(id);
        } else {
          const mission = await options.missions.get(id);
          const execution =
            mission.execution === undefined
              ? undefined
              : await executionStore.get(mission.execution.id);
          if (execution !== undefined && !isMissionTerminalExecutionStatus(execution.status))
            return false;
        }
        if (executionContext !== undefined)
          sessionService.deleteExecutionContextIfCurrent(id, executionContext);
        // Keep admission reserved until both lower-level resources and the
        // Mission fence are released. A racing send then reacquires a fresh
        // guard and resumes the same durable Session.
        await releaseOwner();
        // Durable display reads remain valid when only transient resources are released.
        logger.info(
          "mission.idle_resources_released",
          "Idle Mission transient resources released",
          {
            missionId: id,
            idleTimeoutMs,
            warmSessionCount: [...sessionService.sessionEntries()].length,
          },
        );
        return true;
      });
    },
    async getCanonicalStrictTarget(id) {
      return await coreControl.resolveStrictTarget({ missionId: id });
    },
    async getWork(id) {
      return await getWorkSnapshot(id);
    },
    async getWorkConversation(input) {
      return await getWorkConversation(input);
    },
    async openWorkConversationStream(input) {
      return await openWorkConversationStream(input);
    },
    async closeWorkConversationStream(subscriptionId) {
      await closeWorkConversationStream(subscriptionId);
    },
    subscribeWorkConversationStreams(listener) {
      workConversationStreamListeners.add(listener);
      return () => workConversationStreamListeners.delete(listener);
    },
    async delete(id) {
      await lifecycleService.startDeletion(id, async () => {
        const prior = await deletionService.read(id);
        if (prior?.phase === "committed" || prior?.phase === "completed") return;
        lifecycleService.setControlIssue(id, {
          state: "deletion_pending",
          reasonCode: "MISSION_DELETION_PENDING",
          observedAt: new Date().toISOString(),
        });
        const freezeStarted = performance.now();
        await persistMissionDeletionIntent(options.missions.storagePath?.(id), id);
        const inFlight = lifecycleService.run(id);
        lifecycleService.forgetRun(id);
        await (options.ownerScope ?? standaloneOwnerScope)?.forceRevoke(id);
        logger.info("mission.delete_phase", "Mission admission frozen.", {
          missionId: id,
          phase: "freeze",
          durationMs: performance.now() - freezeStarted,
        });
        if (inFlight !== undefined) void inFlight.catch(() => undefined);
        const liveChat = chatService.live(id);
        const detached =
          liveChat === undefined ? undefined : chatService.detachLiveIfCurrent(id, liveChat);
        const closingObservers = Promise.all([
          detached?.close(),
          ...[...workConversationStreams.entries()]
            .filter(([, stream]) => stream.missionId === id)
            .map(async ([subscriptionId]) => await closeWorkConversationStream(subscriptionId)),
        ]).then(() => undefined);
        trackMissionDeletionSettlement(pendingDeletionSettlements, id, closingObservers);
        await withMissionController(
          id,
          async () =>
            await ((options.ownerScope ?? standaloneOwnerScope)?.terminalDelete(
              id,
              async () => await deleteMission(id),
            ) ?? deleteMission(id)),
          true,
        );
        await chatService.clear(id);
        workService.clear(id);
      });
    },
    async listHumanInteractions(id) {
      const mission = await options.missions.get(id);
      return excludeRespondedHumanInteractions(
        id,
        mission.execution?.id,
        await listMissionPendingHumanInteractions(mission),
      );
    },
    async respondToHumanInteraction(input) {
      await submitMissionCommand({
        missionId: input.missionId,
        requestId: input.requestId,
        kind: "respond",
        target: { interactionId: input.interactionId },
        payload: { kind: "respond", response: input.response },
      });
    },
  };

  async function listMissionPendingHumanInteractions(
    mission: Mission,
  ): Promise<MissionHumanInteraction[]> {
    const execution = lifecycleService.active(mission.id);
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
    const existing = lifecycleService.active(id);
    if (existing !== undefined) return existing;
    const inFlight = lifecycleService.run(id);
    if (inFlight !== undefined) {
      await inFlight;
    } else {
      const mission = await options.missions.get(id);
      if (
        mission.execution === undefined ||
        !["queued", "running", "waiting"].includes(mission.execution.status)
      ) {
        throw new Error("This human interaction is no longer waiting for a response.");
      }
      await startMission(id);
    }
    const restored = lifecycleService.active(id);
    if (restored === undefined) {
      throw new Error(
        "This human interaction could not be restored in the current Desktop process.",
      );
    }
    if (interactionId !== "") await waitForRestoredHumanInteraction(restored.handle, interactionId);
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

function missionContextMountsNeedSuccessor(mission: Mission, fingerprint: string): boolean {
  if (mission.execution?.sessionId === undefined) return false;
  if (mission.execution.contextMountsFingerprint === undefined) return false;
  return mission.execution.contextMountsFingerprint !== fingerprint;
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

function observeMissionHumanWaitingStatus(input: {
  readonly missions: MissionStore;
  readonly missionId: string;
  readonly execution: MutableExecution;
  readonly startedAt: string;
  readonly inputMessageId: string;
  readonly sessionId?: string | undefined;
  readonly logger: PragmaLogger;
  readonly onInteractionsChanged?:
    ((interactions: readonly MissionHumanInteraction[]) => void) | undefined;
}): {
  readonly onEvent: (event: ExecutionEvent) => Promise<void>;
  readonly resync: () => Promise<void>;
  readonly drain: () => Promise<void>;
} {
  const pending = new Set<string>();
  let observedWaiting: boolean | undefined;
  let observedWaitReason: "experts" | "human_input" | undefined;
  let updates = Promise.resolve();

  const enqueueUpdate = (update: () => Promise<void>): Promise<void> => {
    const result = updates.then(update);
    // Keep the serialization queue usable after a transient failure while preserving the rejected
    // result for callers such as the event subscription retry loop.
    updates = result.catch(() => undefined);
    return result;
  };

  const persistStatus = async (
    invocationWaitReason?: "experts" | "human_input" | undefined,
  ): Promise<void> => {
    const waitReason = pending.size > 0 ? "human_input" : invocationWaitReason;
    const waiting = waitReason !== undefined;
    if (waiting === observedWaiting && waitReason === observedWaitReason) return;
    await input.missions.updateExecution(
      input.missionId,
      {
        id: input.execution.executionId,
        inputMessageId: input.inputMessageId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        status: waiting ? "waiting" : "running",
        ...(waitReason === undefined ? {} : { waitReason }),
        startedAt: input.startedAt,
      },
      {
        executionId: input.execution.executionId,
        statuses: ["queued", "running", "waiting"],
      },
    );
    observedWaiting = waiting;
    observedWaitReason = waitReason;
  };

  const resync = async (): Promise<void> => {
    try {
      const interactions = await listPendingHumanInteractions(input.execution);
      input.onInteractionsChanged?.(interactions);
      pending.clear();
      for (const interaction of interactions) pending.add(interaction.interactionId);
      const tree = await input.execution.getTree();
      observedWaiting = undefined;
      observedWaitReason = undefined;
      await persistStatus(tree.invocation.waitReason);
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

  const onEvent = async (event: ExecutionEvent): Promise<void> => {
    if (
      event.type !== "human.requested" &&
      event.type !== "human.responded" &&
      event.type !== "human.waiting" &&
      event.type !== "human.resumed" &&
      !event.type.startsWith("expert.children.")
    ) {
      return;
    }
    try {
      await enqueueUpdate(resync);
    } catch (error) {
      input.logger.warn(
        "mission.human_wait_status_update_failed",
        "Mission human-input waiting status could not be updated.",
        { error, missionId: input.missionId, executionId: input.execution.executionId },
      );
    }
  };

  return {
    onEvent,
    resync: () => enqueueUpdate(resync),
    drain: async () => await updates,
  };
}

export async function persistMissionExecutionProjection(
  missions: MissionStore,
  executionStore: DurableExecutionStore,
  missionId: string,
  executionId: string,
  cancelled: boolean,
  liveEntries: readonly MissionChatEntry[] = [],
): Promise<{
  readonly status: "current" | "partial";
  readonly userVisibleOutput: boolean;
}> {
  const interruptedProjection = liveEntries
    .filter(
      (entry): entry is Exclude<MissionChatEntry, { readonly kind: "user" }> =>
        entry.kind !== "user" && entry.executionId === executionId,
    )
    .map(finalizeInterruptedMissionEntry);
  // Cancellation can make the Core event stream incomplete. Persist the live
  // renderer projection first so a later history-read or archive failure cannot
  // make already-visible output disappear.
  if (cancelled) {
    await retryMissionProjectionWrite(missions, missionId, executionId, interruptedProjection);
  }
  try {
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
    if (matched === undefined) {
      throw new Error(`Mission timeline is missing Execution ${executionId}.`);
    }
    const history = await readMissionChatHistory([matched], executionStore, missions, missionId);
    if (history.syncIssues.length > 0) {
      throw new Error(`Execution history could not be projected: ${executionId}.`);
    }
    const projected = new Map(
      history.entries
        .filter((entry) => entry.kind !== "user")
        .map((entry) => [entry.id, entry] as const),
    );
    for (const entry of interruptedProjection) projected.set(entry.id, entry);
    const source = await executionStore.get(executionId);
    const canonicalAnswer = history.entries.findLast(
      (entry) =>
        entry.kind === "assistant" &&
        entry.invocationId === source?.rootInvocationId &&
        entry.finalAnswer === true,
    );
    const completeProjection =
      source === undefined
        ? [...projected.values()]
        : ensureTerminalExecutionResultEntry(
            [...projected.values()],
            source,
            canonicalAnswer?.kind === "assistant" ? canonicalAnswer.content : undefined,
          );
    await retryMissionProjectionWrite(
      missions,
      missionId,
      executionId,
      completeProjection,
      source?.updatedAt,
    );
    return {
      status: "current",
      userVisibleOutput: missionProjectionAddsUserVisibleOutput(liveEntries, completeProjection),
    };
  } catch (error) {
    // The cancellation snapshot above is already durable and sufficient for
    // chat recovery. Canonical history enrichment is best-effort after that
    // commit because an interrupted Runtime may never finish its event stream.
    if (cancelled) return { status: "partial", userVisibleOutput: false };
    throw error;
  }
}

export function missionProjectionAddsUserVisibleOutput(
  previous: readonly MissionChatEntry[],
  next: readonly MissionChatEntry[],
): boolean {
  const previousById = new Map(previous.map((entry) => [entry.id, entry] as const));
  return next.some((entry) => {
    const fingerprint = missionChatEntryUnreadFingerprint(entry);
    if (fingerprint === undefined) return false;
    const previousEntry = previousById.get(entry.id);
    return (
      previousEntry === undefined ||
      missionChatEntryUnreadFingerprint(previousEntry) !== fingerprint
    );
  });
}

function missionChatEntryUnreadFingerprint(entry: MissionChatEntry): string | undefined {
  switch (entry.kind) {
    case "assistant":
    case "thinking":
      return `${entry.kind}:${entry.content}`;
    case "tool":
      return `${entry.kind}:${entry.status}:${entry.outputPreview ?? ""}:${entry.error ?? ""}`;
    case "agent_activity":
      return `${entry.kind}:${entry.action}:${entry.phase}:${entry.error ?? ""}`;
    case "user":
    case "context_operation":
      return undefined;
  }
}

async function retryMissionProjectionWrite(
  missions: MissionStore,
  missionId: string,
  executionId: string,
  entries: readonly Exclude<MissionChatEntry, { readonly kind: "user" }>[],
  sourceUpdatedAt?: string,
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await missions.writeExecutionProjection(missionId, executionId, entries, sourceUpdatedAt);
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(`Mission execution projection could not be persisted: ${executionId}.`, {
    cause: failure,
  });
}

async function retryMissionEventProjection(operation: () => void | Promise<void>): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw new Error("Mission execution event projection could not be committed.", { cause: failure });
}

function finalizeInterruptedMissionEntry(
  entry: Exclude<MissionChatEntry, { readonly kind: "user" }>,
): Exclude<MissionChatEntry, { readonly kind: "user" }> {
  if (entry.kind === "assistant" || entry.kind === "thinking") {
    return { ...entry, streaming: false };
  }
  if (
    entry.kind === "tool" &&
    (entry.status === "running" || entry.status === "approval_required")
  ) {
    return { ...entry, status: "failed", error: entry.error ?? "Execution interrupted." };
  }
  if (entry.kind === "agent_activity" && entry.phase === "started") {
    return { ...entry, phase: "failed", error: entry.error ?? "Execution interrupted." };
  }
  if (entry.kind === "context_operation" && entry.status === "running") {
    return { ...entry, status: "failed", error: entry.error ?? "Execution interrupted." };
  }
  return entry;
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

type SettlementOutcome =
  | { readonly status: "fulfilled" }
  | { readonly status: "rejected"; readonly error: unknown }
  | { readonly status: "timed_out" };

async function settlementOutcomeWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<SettlementOutcome> {
  let timer: NodeJS.Timeout | undefined;
  return await Promise.race([
    operation.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    new Promise<{ readonly status: "timed_out" }>((resolve) => {
      timer = setTimeout(() => resolve({ status: "timed_out" }), timeoutMs);
      timer.unref();
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function listPendingHumanInteractions(
  execution: Pick<MutableExecution, "getState" | "listEvents">,
): Promise<MissionHumanInteraction[]> {
  const stateBeforeRead = await execution.getState();
  if (isMissionTerminalExecutionStatus(stateBeforeRead.status)) return [];
  const events = await readAllExecutionEvents(execution);
  const stateAfterRead = await execution.getState();
  if (isMissionTerminalExecutionStatus(stateAfterRead.status)) return [];
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

function hasPromptAttachments(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attachments = (value as { readonly attachments?: unknown }).attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}
