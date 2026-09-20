import { missionContextMountsFingerprint } from "./mission-context-mounts.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  STORE_REVISION_EXPERT_REF,
  KnowledgeRevisionToolError,
  type KnowledgeRevisionSubmissionPort,
  type PragmaManagementToolPorts,
} from "@pragma/built-in-agents";
import {
  createPragma,
  AgentLifecycleQuiescenceError,
  createPragmaLogger,
  createFileExecutionStore,
  createFileExpertSessionStore,
  ExecutionController,
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
  StaticContextStore,
  error,
  ok,
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
  readExecutionRunScope,
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
import { createMissionBoard } from "@pragma/local-host";
import type {
  InvocableResource,
  CompiledResource,
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
import type {
  HumanInteractionRequest,
  HumanInteractionResponse,
  ExpertAgentStreamEvent,
  ExpertPromptAttachment,
  AgentMessageUsage,
  ExecutionEvent,
  RuntimeContextRecord,
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
  type MissionChatPage,
  type MissionContextMount,
  type MissionChatEntry,
  type MissionChatPatch,
  type MissionChatPageQuery,
  type MissionContextWindowSnapshot,
  type MissionConversationSnapshot,
  type MissionConversationState,
  type MissionContextCompactionResult,
  type MissionContextWindowState,
  type MissionHumanInteraction,
  type MissionModelOverride,
  type MissionWorkConversationSnapshot,
  type MissionWorkRecord,
  type MissionWorkSnapshot,
  type GetMissionWorkConversation,
  type DesktopToolPermissionMode,
  type UpdateMissionOptions,
  type UpdateMissionContextMounts,
} from "../../../shared/contracts/index.ts";
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";
import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import type { ContextStoreRevisionService } from "../context-stores/context-store-revision-service.ts";
import { DynamicContextStore } from "../context-stores/dynamic-context-store.ts";
import { createDesktopKnowledgeRevisionSubmissionPort } from "../context-stores/knowledge-revision-capability.ts";
import {
  createMissionResumeOptions,
  shouldCreateSuccessorExpertSession,
} from "./mission-session-upgrade.ts";
import type { MissionStore, MissionTimelineTurn } from "./mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import type { DesktopUsageStore } from "../usage/usage-store.ts";
import { createIntegrationError, type MissionCommand } from "@pragma/shared/integration";
import {
  createExpertSessionPromptQueueProjection,
  createLocalHostRunHandleState,
  dispatchMissionCommand,
  hashCanonicalRunPayload,
  type LocalHostRunEvent,
  type LocalHostRunHandle,
  type LocalHostRunRequest,
  type MissionCommandConsumer,
  type MissionControlTargetResolution,
  type MissionOwnerScope,
  type ResolvedRunExecutor,
} from "@pragma/local-host";
import { createMissionBranchContext } from "./mission-branch-context.ts";
import { observeMissionExecution } from "./mission-execution-observer.ts";
import { createDesktopAdapterHost } from "./mission-adapter-host.ts";
import { MissionChatService } from "./mission-chat-service.ts";
import { MissionWorkService } from "./mission-work-service.ts";
import { MissionLifecycleService } from "./mission-lifecycle-service.ts";
import { MissionCommandService } from "./mission-command-service.ts";
import { MissionSessionService } from "./mission-session-service.ts";
import { MissionStatusService } from "./mission-status-service.ts";
import { MISSION_EXECUTION_PROJECTION_ORDERING_VERSION } from "./mission-execution-projection.ts";
import {
  hasMissionDeletionIntent,
  persistMissionDeletionIntent,
} from "./mission-deletion-intent.ts";

export { readMissionConversationSnapshot } from "./mission-runner-contracts.ts";
export type {
  MissionChatNotification,
  MissionCommandOutcomeNotification,
  MissionRunner,
  MissionSurfaceAudience,
  MissionWorkNotification,
} from "./mission-runner-contracts.ts";
import type {
  MissionCommandOutcomeNotification,
  MissionMessageApplicationResult,
  MissionRunner,
  MissionSurfaceAudience,
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

export interface LiveMissionChat {
  readonly executionId: string;
  readonly entries: MissionChatEntry[];
  readonly messageOrdinals: Map<string, number>;
  completedAnswerRuns?: Set<string>;
  finalAnswerBoundary?: {
    readonly entryId: string;
    readonly runKey: string;
    readonly occurredAt: string;
  };
  close: () => Promise<void>;
}

type ExecutorNameResolver = (executorId: string) => string | undefined;
type ExecutorAvatarIdResolver = (executorId: string) => string | undefined;

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

const MISSION_CHAT_ERROR_MAX_LENGTH = 10_000;

export function createMissionRunner(options: {
  readonly missions: MissionStore;
  readonly missionStatus?: MissionStatusService | undefined;
  readonly project: PragmaProjectStore;
  readonly capabilityStore: CapabilityStore;
  readonly capabilityCredentials: CapabilityCredentialStore;
  readonly capabilitiesPath: string;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
  readonly pragmaHome: string;
  readonly executionStore?: FileExecutionStore | undefined;
  readonly contextStores?: ContextStoreStore | undefined;
  readonly contextStoreRevisions?: ContextStoreRevisionService | undefined;
  readonly knowledgeRevisionMountResources?: (() => readonly PragmaResource[]) | undefined;
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
  readonly assertStorageWriteAllowed?: (() => Promise<void>) | undefined;
  readonly pragmaManagementPorts?:
    (() => Omit<PragmaManagementToolPorts, "knowledgeRevisions">) | undefined;
  readonly assertExecutorReady?: ((ref: string) => void | Promise<void>) | undefined;
  readonly onStorageTrashed?: (() => void) | undefined;
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
  /** Local Host owner scope used by legacy Desktop-only persistence writes. */
  readonly ownerScope?:
    | Pick<MissionOwnerScope, "acquire" | "forceRevoke" | "runWithGuard" | "terminalDelete">
    | undefined;
}): MissionRunner {
  const logger = createPragmaLogger(options.loggerProvider, {
    component: "desktop.mission-runner",
  });
  const executionStore =
    options.executionStore ?? createFileExecutionStore({ pragmaHome: options.pragmaHome });
  const notifyExecutionLinked = async (
    mission: Mission,
    executionId: string,
    requestId: string,
  ): Promise<void> => {
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
    executions: executionStore,
    pragmaHome: options.pragmaHome,
  });
  const sessionService = new MissionSessionService<MissionExecutionContext, ExecutorMetadata>();
  const promptQueueProjection = createExpertSessionPromptQueueProjection({
    sessions: expertSessionStore,
    resolveSessionId: async (missionId) => {
      const live = sessionService.session(missionId);
      if (live !== undefined) return live.sessionId;
      const mission = await options.missions.get(missionId);
      return mission.execution?.sessionId;
    },
    supportsSteer: async (sessionId) => {
      const session = await expertSessionStore.get(sessionId);
      if (session === undefined) return false;
      const rootContext = session.contexts[session.rootContextId];
      if (rootContext === undefined) return false;
      const resolved = await options.runtimes
        .resolve({ binding: rootContext.runtime, modelSelection: rootContext.modelSelection })
        .catch(() => undefined);
      return resolved?.adapter.descriptor.capabilities?.supportsSteer === true;
    },
    resolvePromptMetadata: async (prompt) => ({
      hasAttachments: hasPromptAttachments(
        (await executionStore.getInvocation(prompt.executionId, prompt.executionId))?.input,
      ),
    }),
  });
  const workHistory = new ExecutionWorkHistoryReader(executionStore);
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
      const revisionTargetStoreIds =
        options.contextStoreRevisions === undefined
          ? []
          : ((await options.contextStores?.list()) ?? []).map((store) => store.id);
      return revisionTargetStoreIds.map((storeId) => ({
        namespace: activeMissionKnowledgeDraftNamespace(storeId),
        storeName: "Active Mission Knowledge draft",
        store: new DynamicContextStore(async (operation, runContext) => {
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
        }),
        required: false,
        mutationApproval: "none" as const,
      }));
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
        ? await options.hostContextStores()
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
  // The shared Local Host owns command idempotency and operation state. These
  // two maps only coalesce Desktop-owned projection work that is already in
  // this process; they are not a Mission-wide mutation lock.
  const lifecycleService = new MissionLifecycleService<
    Mission,
    MissionContextCompactionResult,
    ActiveMissionExecution
  >();
  const commandService = new MissionCommandService(({ error, notification }) => {
    logger.error(
      "mission.command_outcome_listener_failed",
      "A Mission command outcome listener failed.",
      error,
      { missionId: notification.missionId, requestId: notification.requestId },
    );
  });
  const chatService = new MissionChatService<LiveMissionChat>(({ error, missionId }) => {
    logger.error(
      "mission.chat_listener_failed",
      `Failed to notify Mission chat listeners for ${missionId}.`,
      error,
      { missionId },
    );
  });
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
    const existing = sessionService.executorMetadata(projectKey);
    const projectMetadata = existing ?? (await readExecutorMetadata(mission));
    if (existing === undefined) sessionService.setExecutorMetadata(projectKey, projectMetadata);
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

  const startMission = (id: string): Promise<Mission> => {
    return lifecycleService.startRun(id, (generation) =>
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
    handle: DesktopExecutionHandle,
    expectedLive: LiveMissionChat,
    audience: MissionSurfaceAudience,
    attachNextTurn = true,
    userVisibleOutput = false,
  ): Promise<void> => {
    if (lifecycleService.active(id)?.handle === handle) lifecycleService.deleteActive(id);
    clearHumanInteractionProjection(id, handle.executionId);
    await chatService.closeLiveIfCurrent(id, expectedLive);
    workService.clearLive(id);
    chatService.clearContextWindow(id);
    invalidateChat(id, audience, userVisibleOutput ? { userVisibleOutput: true } : {});
    invalidateWork(id, audience);
    if (attachNextTurn) await attachNextSessionTurn(id, audience);
  };

  const awaitTerminalLifecycleSettlement = async (mission: Mission): Promise<void> => {
    if (
      mission.execution === undefined ||
      ["queued", "running", "waiting"].includes(mission.execution.status)
    ) {
      return;
    }
    const active = lifecycleService.active(mission.id);
    if (active === undefined || active.handle.executionId !== mission.execution.id) return;
    const outcome = await settlementOutcomeWithin(active.settlement, 5_000);
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
  };

  const compileMissionExecutor = async (
    mission: Mission,
    runtimes: RuntimeResolver,
  ): Promise<CompiledResource<InvocableResource>> => {
    const knowledgeRevisions =
      options.contextStores === undefined || options.contextStoreRevisions === undefined
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
        ...(Object.keys(pragmaManagement).length === 0 ? {} : { pragmaManagement }),
      },
      mission.workspace.path,
    );
    let projectSnapshotPromise: ReturnType<typeof options.project.getRevision> | undefined;
    const getProjectSnapshot = () =>
      (projectSnapshotPromise ??= options.project.getRevision(mission.project.revision));
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
            options.adapterHostForMission?.(externalMission, desktopAdapterHost) ??
            desktopAdapterHost,
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

  const compilationIdentity = async (mission: Mission): Promise<string> =>
    createHash("sha256")
      .update(
        JSON.stringify({
          project: mission.project,
          executor: mission.executor,
          contextMounts: missionContextMountsFingerprint(mission),
          systemExecutorFingerprints: await resolveMissionSystemDependencyFingerprints({
            mission,
            project: options.project,
            getSystemExecutorFingerprint: options.getSystemExecutorFingerprint,
            getSystemExecutorResource: options.getSystemExecutorResource,
          }),
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
    if (record?.status === "closed") {
      const recovered = await app.experts.recoverClosedSession(compiled.value, {
        ...request,
        reason: `Active Desktop Mission ${mission.id} still references this closed ExpertSession.`,
      });
      logger.warn(
        "mission.closed_session_recovered",
        `Recovered closed ExpertSession ${sessionId} for active Mission ${mission.id}.`,
        { missionId: mission.id, sessionId },
      );
      return recovered;
    }
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
    let terminalInvalidationHasUserVisibleOutput = false;
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
        // The Core terminal record is already committed. Publish that canonical
        // fact even when the secondary Local Host event projection is degraded;
        // otherwise one failed projection can leave the rail visibly running.
        statusService.publish(missionId, audience, {
          id: input.handle.executionId,
          status: terminal.status,
        });
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
          if (projectionState === "current") {
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
          );
        } catch (error) {
          logger.warn(
            "mission.execution_cleanup_failed",
            "Mission execution settled, but observer cleanup needs a later retry.",
            { error, missionId, executionId: input.handle.executionId },
          );
        }
      });
    const activeExecution = {
      handle: input.handle,
      settlement,
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

  const runMission = async (id: string, runGeneration: number): Promise<Mission> => {
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
    const { app, runtimes: baseRuntimes } = await executionContext(mission);
    const runtimes = withMissionRuntimeBinding(baseRuntimes, await readMissionRootContext(mission));
    let phaseStartedAt = performance.now();
    const compiled = await compileMissionExecutor(mission, runtimes);
    const compiledIdentity = await compilationIdentity(mission);
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
        ? await createMissionExpertSession(compiled, app, { modelSelection })
        : await openMissionExpertSession({
            mission,
            compiled,
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
  }): Promise<MissionMessageApplicationResult> => {
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
    let mission = await options.missions.get(input.id);
    await awaitTerminalLifecycleSettlement(mission);
    mission = await options.missions.get(input.id);
    const contextMountsFingerprint = missionContextMountsFingerprint(mission);
    if (missionContextMountsNeedSuccessor(mission, contextMountsFingerprint)) {
      sessionService.invalidateContextBindings(mission.id);
    }
    if (sessionService.contextBindingChangeInProgress(mission.id)) {
      throw new Error("Wait for the Mission Knowledge change to finish before sending a message.");
    }
    if (sessionService.successorRequired(mission.id)) {
      if (lifecycleService.hasActive(mission.id)) {
        throw new Error(
          "Wait for the current execution to finish before sending a message with the new Mission Knowledge.",
        );
      }
      const currentSession = sessionService.session(mission.id);
      const hasQueuedPrompts = (await currentSession?.getPromptQueue())?.some(
        (prompt) => prompt.status === "queued" || prompt.status === "running",
      );
      if (hasQueuedPrompts === true) {
        throw new Error(
          "Remove or finish queued Mission messages before continuing with the new Mission Knowledge.",
        );
      }
    }
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
    let session = sessionService.session(mission.id);
    let compiled: CompiledResource<InvocableResource> | undefined;
    let phaseStartedAt = performance.now();
    const compilationCacheHit =
      session !== undefined &&
      sessionService.compilationIdentity(mission.id) === desiredCompilationIdentity;
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
    const memoryBindingsChanged = sessionService.memoryBindingsChanged(mission.id);
    const contextStoresChanged =
      sessionService.consumeSuccessorRequirement(mission.id) ||
      missionContextMountsNeedSuccessor(mission, contextMountsFingerprint) ||
      (memoryBindingsChanged && !lifecycleService.hasActive(mission.id));
    if (memoryBindingsChanged && !lifecycleService.hasActive(mission.id)) {
      sessionService.clearMemoryBindingsChanged(mission.id);
    }
    if (compiledExpert !== undefined && session !== undefined) {
      const nextDefinitionFingerprint = fingerprintExpertExecutionDefinition(compiledExpert);
      const previousDefinitionFingerprint = sessionService.definitionFingerprint(mission.id);
      if (
        previousDefinitionFingerprint !== undefined &&
        previousDefinitionFingerprint !== nextDefinitionFingerprint
      ) {
        await session.close("Mission executor definition changed.");
        sessionService.deleteSession(mission.id);
        sessionService.clearCompilation(mission.id);
        session = undefined;
        definitionChanged = true;
      }
    }
    if (contextStoresChanged && session !== undefined && !lifecycleService.hasActive(mission.id)) {
      await session.close("Mission context bindings changed.");
      sessionService.deleteSession(mission.id);
      sessionService.clearCompilation(mission.id);
      session = undefined;
    }
    const sessionCacheHit = session !== undefined;
    phaseStartedAt = performance.now();
    if (session === undefined) {
      if (compiled === undefined) {
        // A cached Session can be invalidated after the compilation cache lookup
        // (for example when Memory or Mission Knowledge bindings change). Compile
        // again before opening its successor instead of treating that valid cache
        // transition as an impossible state.
        compiled = await compileMissionExecutor(mission, runtimes);
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
    sessionService.setSession(mission.id, session);
    if (compiled !== undefined) {
      rememberSessionCompilation(mission.id, desiredCompilationIdentity, compiled);
    }
    const promptAttachments = input.attachments ?? [];
    phaseStartedAt = performance.now();
    const requestedMode = input.mode ?? "enqueue";
    const turn = await session.prompt(input.content, {
      requestId: input.requestId,
      mode: requestedMode,
      ...(promptAttachments.length === 0 ? {} : { attachments: promptAttachments }),
      ...(promptModelSelection === undefined ? {} : { modelSelection: promptModelSelection }),
    });
    logMissionPhase(logger, mission.id, "expert_session_prompt", phaseStartedAt, acceptedAt);
    // Core owns acceptance and idempotency. Project the user message only
    // after Core accepts it so a rejected strict steer cannot leave an orphan
    // in the Mission timeline. Replaying an accepted Inbox command is safe:
    // both session.prompt and appendUserMessage are keyed by requestId.
    const userMessage = await options.missions.appendUserMessage(mission.id, {
      id: input.requestId,
      content: input.content,
      ...(promptAttachments.length === 0 ? {} : { attachments: [...promptAttachments] }),
      createdAt: new Date().toISOString(),
    });
    if (userMessage.kind !== "user") {
      throw new Error("Mission user message persistence returned an invalid timeline record.");
    }
    const startedAt = new Date().toISOString();
    await options.missions.appendExecutionReference({
      missionId: mission.id,
      inputMessageId: input.requestId,
      executionId: turn.executionId,
      createdAt: startedAt,
    });
    await notifyExecutionLinked(mission, turn.executionId, input.requestId);
    if (turn.effectiveMode === "steer") {
      invalidateChat(mission.id, missionSurfaceAudience(mission));
      return {
        mission: await options.missions.get(mission.id),
        requestId: input.requestId,
        requestedMode,
        effectiveMode: "steer",
      };
    }
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
    const projectedExecutionActive =
      mission.execution !== undefined &&
      ["queued", "running", "waiting"].includes(mission.execution.status);
    const activeExecution = lifecycleService.active(mission.id);
    if (!projectedExecutionActive && activeExecution !== undefined) {
      await settlementOutcomeWithin(activeExecution.settlement, 5_000);
      lifecycleService.deleteActiveIfCurrent(mission.id, activeExecution);
    }
    if (lifecycleService.hasActive(mission.id) || projectedExecutionActive) {
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
    if (sessionService.session(mission.id) !== undefined) {
      rememberSessionCompilation(mission.id, await compilationIdentity(updated), compiled);
    }
    return updated;
  };

  const updateMissionContextMountsWithinChange = async (
    input: UpdateMissionContextMounts,
  ): Promise<Mission> => {
    let mission = await options.missions.get(input.id);
    const assertNoPendingPrompts = async (candidate: Mission): Promise<void> => {
      const sessionId =
        sessionService.session(candidate.id)?.sessionId ?? candidate.execution?.sessionId;
      if (sessionId === undefined) return;
      const pendingPrompts = (await expertSessionStore.listPrompts(sessionId)).filter(
        (prompt) =>
          prompt.mode === "enqueue" && (prompt.status === "queued" || prompt.status === "running"),
      );
      if (pendingPrompts.length > 0) {
        throw new Error(
          "Remove or finish queued Mission messages before changing Mission Knowledge Stores.",
        );
      }
    };
    if (
      mission.execution !== undefined &&
      !["queued", "running", "waiting"].includes(mission.execution.status)
    ) {
      // Inspect the durable queue before waiting for terminal observer cleanup.
      // Otherwise that cleanup may dispatch a queued turn before this mutation
      // gets a chance to reject it.
      await assertNoPendingPrompts(mission);
    }
    await awaitTerminalLifecycleSettlement(mission);
    mission = await options.missions.get(input.id);
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
    if (
      lifecycleService.hasActive(mission.id) ||
      (mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status))
    ) {
      throw new Error("Wait for the current execution before changing Mission Knowledge Stores.");
    }
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
    await assertNoPendingPrompts(mission);
    const updated = await options.missions.updateContextMounts(mission.id, input.contextMounts);
    await invalidateContextBindings(mission.id);
    return updated;
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

  const deleteMission = async (id: string): Promise<void> => {
    const mission = await options.missions.get(id);
    const active = lifecycleService.active(id);
    if (active !== undefined) {
      const cancellation = await settlementOutcomeWithin(
        active.handle.cancel("Mission deleted."),
        4_000,
      );
      if (cancellation.status !== "fulfilled") {
        logger.warn(
          "mission.delete_execution_cancel_incomplete",
          `Mission ${mission.id} Execution cancellation was not confirmed before Session shutdown.`,
          {
            missionId: mission.id,
            executionId: active.handle.executionId,
            outcome: cancellation.status,
            ...(cancellation.status === "rejected" ? { error: cancellation.error } : {}),
          },
        );
      }
    }
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
    const session = sessionService.session(id);
    if (session !== undefined) {
      const closed = await settlementOutcomeWithin(session.close("Mission deleted."), 15_000);
      if (closed.status === "timed_out") {
        logger.warn(
          "mission.delete_session_close_uncertain",
          `Mission ${mission.id} Session did not stop before forced removal continued.`,
          {
            missionId: mission.id,
            sessionId: session.sessionId,
            code: "MISSION_INTERRUPT_UNCERTAIN",
          },
        );
      }
      if (closed.status === "rejected") {
        if (containsAgentLifecycleQuiescenceError(closed.error)) {
          logger.warn(
            "mission.delete_runtime_quiescence_uncertain",
            `Mission ${mission.id} Runtime work did not quiesce before forced removal continued.`,
            {
              error: closed.error,
              missionId: mission.id,
              sessionId: session.sessionId,
              code: "MISSION_INTERRUPT_UNCERTAIN",
            },
          );
        } else
          logger.warn(
            "mission.delete_session_close_failed",
            `Mission ${mission.id} Session reported cleanup failures after stopping.`,
            { error: closed.error, missionId: mission.id, sessionId: session.sessionId },
          );
      }
      if (sessionService.deleteSessionIfCurrent(id, session)) {
        sessionService.clearCompilation(id);
      }
    }
    if (active !== undefined) {
      const settled = await settlementOutcomeWithin(active.settlement, 8_000);
      if (settled.status === "timed_out") {
        logger.warn(
          "mission.delete_execution_observer_uncertain",
          `Mission ${mission.id} execution observer did not settle before forced removal continued.`,
          {
            missionId: mission.id,
            executionId: active.handle.executionId,
            code: "MISSION_INTERRUPT_UNCERTAIN",
          },
        );
      }
      if (settled.status === "rejected") {
        logger.warn(
          "mission.delete_execution_observer_failed",
          `Mission ${mission.id} observer stopped with an error before deletion.`,
          { error: settled.error, missionId: mission.id, executionId: active.handle.executionId },
        );
      }
      await forgetActive(id, active.handle, active.live, active.audience, false);
    }
    const revisionClaims = mission.contextMounts.flatMap((mount) =>
      mount.kind === "context-store-draft" && mount.revisionJobId !== undefined
        ? [{ draftId: mount.draftId, jobId: mount.revisionJobId }]
        : [],
    );
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
      runtimeSessionOwnerIds: [...(sessionId === undefined ? [] : [sessionId]), ...executionIds],
    });
    if (options.missions.storagePath === undefined) await options.missions.remove(id);
    else options.missions.forget?.(id);
    if (options.contextStoreRevisions !== undefined) {
      for (const claim of revisionClaims) {
        await options.contextStoreRevisions.releaseMissionClaim({
          ...claim,
          missionId: mission.id,
          reason: "mission_deleted",
        });
      }
    }
    options.usage?.markSubjectDeleted("mission", id);
    sessionService.deleteExecutionContext(id);
    lifecycleService.clearControlIssue(id);
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
      const compiled = await compileMissionExecutor(mission, runtimes);
      if ("kind" in compiled.value && compiled.value.kind === "flow") {
        throw new Error("Flow missions do not expose a chat context to compact.");
      }
      session = await resumeMissionSession(mission, compiled, app, sessionId);
      rememberSessionCompilation(id, await compilationIdentity(mission), compiled);
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

  const getChatPage = async (input: MissionChatPageQuery): Promise<MissionChatPage> => {
    const startedAt = performance.now();
    const mission = await options.missions.get(input.id);
    const missionReadAt = performance.now();
    if (!isUserFacingMissionOrigin(mission.origin)) {
      throw new Error(`Mission ${mission.id} is not available on the Mission surface.`);
    }
    const executorMetadataPromise = getExecutorMetadataOrFallback(mission, "historical");
    const capturedLive = chatService.live(mission.id);
    let inheritedHistoryPromise: ReturnType<MissionStore["readBranchHistory"]> | undefined;
    const history = await readMissionChatHistoryPage({
      missionId: mission.id,
      query: input,
      executionStore,
      missions: options.missions,
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
    // Capture the revision and live entries in one synchronous turn. Keep using the live object
    // retained at the beginning of the read: settlement may already have removed it from the map,
    // but its final output still belongs in this snapshot.
    const revision = chatService.revision(mission.id);
    const revisionLiveEntries =
      input.beforeCursor === undefined
        ? (capturedLive?.entries.map((entry) => ({
            ...entry,
            ...(entry.timelineSequence === undefined && history.newestSequence !== undefined
              ? { timelineSequence: history.newestSequence }
              : {}),
          })) ?? [])
        : [];
    const resolveExecutorName = createMissionExecutorNameResolver(mission, executorMetadata.names);
    const resolveExecutorAvatarId = createMissionExecutorAvatarIdResolver(
      executorMetadata.avatarIds,
    );
    const presentedEntries = mergeMissionChatEntriesWithLive(entries, revisionLiveEntries).map(
      (entry) => {
        if (entry.executorId === undefined) return entry;
        const executorName = entry.executorName ?? resolveExecutorName(entry.executorId);
        const executorAvatarId =
          entry.executorAvatarId ?? resolveExecutorAvatarId(entry.executorId);
        if (entry.executorName !== undefined && entry.executorAvatarId !== undefined) return entry;
        return {
          ...entry,
          ...(executorName === undefined ? {} : { executorName }),
          ...(executorAvatarId === undefined ? {} : { executorAvatarId }),
        };
      },
    );
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
      logger.info("mission.chat_sync_recovered", "Mission chat state synchronization recovered.", {
        missionId: mission.id,
        executionId: mission.execution?.id,
      });
    }
    const result: MissionChatPage = {
      missionId: mission.id,
      revision,
      entries: presentedEntries,
      page: {
        ...(history.oldestSequence === undefined ? {} : { oldestSequence: history.oldestSequence }),
        ...(history.newestSequence === undefined ? {} : { newestSequence: history.newestSequence }),
        ...(history.nextBeforeCursor === undefined
          ? {}
          : { nextBeforeCursor: history.nextBeforeCursor }),
        ...(history.truncation === undefined ? {} : { truncation: history.truncation }),
      },
      ...(uniqueSyncIssues.length === 0 ? {} : { syncIssues: uniqueSyncIssues }),
    };
    logger.info("mission.chat_page_read", "Mission chat page read completed.", {
      missionId: mission.id,
      entryCount: result.entries.length,
      branchHistoryLoaded: inheritedHistoryPromise !== undefined,
      missionReadMs: Math.round((missionReadAt - startedAt) * 100) / 100,
      historyReadMs: Math.round((historyReadAt - missionReadAt) * 100) / 100,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
    return result;
  };

  const getConversationState = async (id: string): Promise<MissionConversationState> => {
    const startedAt = performance.now();
    const latestMission = await options.missions.get(id);
    if (!isUserFacingMissionOrigin(latestMission.origin)) {
      throw new Error(`Mission ${latestMission.id} is not available on the Mission surface.`);
    }
    const persistedExecution =
      latestMission.execution === undefined
        ? undefined
        : await executionStore.get(latestMission.execution.id).catch(() => undefined);
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
      if (
        cachedInteractions !== undefined &&
        cachedInteractions.executionId === latestMission.execution?.id
      ) {
        pendingInteractions = [...cachedInteractions.interactions];
      } else {
        try {
          pendingInteractions = [...(await listMissionPendingHumanInteractions(latestMission))];
          if (latestMission.execution !== undefined) {
            pendingHumanInteractionsByMission.set(id, {
              executionId: latestMission.execution.id,
              interactions: [...pendingInteractions],
            });
          }
        } catch {
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
      [sessionRecord, promptQueue, sessionEvents] = await Promise.all([
        expertSessionStore.get(sessionId),
        expertSessionStore.listPrompts(sessionId),
        expertSessionStore.listEvents(sessionId),
      ]);
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
    const queuePaused =
      lastQueueControl?.type === "prompt.queue-paused" &&
      pendingPrompts.some((prompt) => prompt.status === "queued");
    const pausedAfterRequestId =
      queuePaused &&
      typeof (lastQueueControl.data as { requestId?: unknown }).requestId === "string"
        ? ((lastQueueControl.data as { requestId: string }).requestId ?? undefined)
        : undefined;
    const rootRuntimeContext =
      sessionRecord === undefined ? undefined : sessionRecord.contexts[sessionRecord.rootContextId];
    const supportsSteer =
      rootRuntimeContext === undefined
        ? false
        : await options.runtimes
            .resolve({
              binding: rootRuntimeContext.runtime,
              modelSelection: rootRuntimeContext.modelSelection,
            })
            .then((resolved) => resolved.adapter.descriptor.capabilities?.supportsSteer === true)
            .catch(() => false);
    const queueItems = await Promise.all(
      pendingPrompts.map(async (prompt) => ({
        requestId: prompt.requestId,
        content: prompt.content,
        status: prompt.status,
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
      revision: chatService.revision(id),
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
        items: queueItems
          .filter((item) => item.status === "queued")
          .map((item) => ({
            requestId: item.requestId,
            content: item.content,
            hasAttachments: item.hasAttachments,
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
    logger.info("mission.conversation_state_read", "Mission conversation state read completed.", {
      missionId: id,
      pendingInteractionCount: result.pendingInteractions.length,
      queueItemCount: result.queue?.items.length ?? 0,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
    return result;
  };

  const getContextWindowSnapshot = async (id: string): Promise<MissionContextWindowSnapshot> => {
    const startedAt = performance.now();
    const mission = await options.missions.get(id);
    if (!isUserFacingMissionOrigin(mission.origin)) {
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
      revision: chatService.revision(id),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(unavailable ? { syncIssues: [missionChatSyncIssue("context_window")] } : {}),
    };
    logger.info("mission.context_window_read", "Mission context window read completed.", {
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

  const resumeMissionQueue = async (id: string): Promise<Mission> => {
    const mission = await options.missions.get(id);
    let session = sessionService.session(id);
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
      sessionService.setSession(id, session);
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
    let session = sessionService.session(id);
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
    sessionService.setSession(id, session);
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

  const trySteerQueuedMissionMessage = async (input: {
    readonly id: string;
    readonly requestId: string;
  }) => {
    const { mission, session } = await openMissionSessionForQueueMutation(input.id);
    const attempt = await session.attemptQueuedPromptSteer(input.requestId);
    invalidateChat(input.id, missionSurfaceAudience(mission));
    return {
      mission: await options.missions.get(input.id),
      queueSteer:
        attempt.outcome === "steered"
          ? { outcome: "steered" as const, executionId: attempt.turn.executionId }
          : attempt,
    };
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
    });
    return {
      ...localHostState.handle,
      checkpointWaitingHuman: async () => {
        await localHostState.handle.checkpointWaitingHuman?.();
        // checkpointWaitingHuman closes and releases this ExpertSession. Do
        // not let a fast response reuse the closed in-memory instance; the
        // durable recovery path must reopen it and consume the response.
        sessionService.deleteSession(input.missionId);
        const checkpointed = lifecycleService.active(input.missionId);
        if (checkpointed?.handle === current.handle) {
          await checkpointed.releaseAfterHumanCheckpoint();
        }
      },
    };
  };

  const resolveLocalHostExecutionTarget = async (input: {
    readonly missionId: string;
    readonly expectedExecutionId?: string | undefined;
  }): Promise<string | undefined> => {
    const mission = await options.missions.get(input.missionId);
    const current =
      mission.execution !== undefined &&
      ["queued", "running", "waiting"].includes(mission.execution.status)
        ? mission.execution.id
        : undefined;
    if (input.expectedExecutionId !== undefined && current !== input.expectedExecutionId) {
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "The expected execution is no longer active.",
        details: {
          reason: "execution_target_changed",
          missionId: input.missionId,
          expectedExecutionId: input.expectedExecutionId,
          ...(current === undefined ? {} : { executionId: current }),
        },
      });
    }
    return current;
  };

  const resolveLocalHostStrictTarget = async (input: {
    readonly missionId: string;
    readonly expectedExecutionId?: string | undefined;
  }): Promise<MissionControlTargetResolution | undefined> => {
    const mission = await options.missions.get(input.missionId);
    if (mission.executor.kind === "flow") {
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "Flow Missions do not support strict steer.",
        details: { missionId: input.missionId, reason: "steer_not_supported" },
      });
    }
    const current =
      mission.execution !== undefined &&
      mission.execution.status === "running" &&
      mission.execution.inputMessageId !== undefined
        ? {
            executionId: mission.execution.id,
            turnId: mission.execution.inputMessageId,
          }
        : undefined;
    if (
      current !== undefined &&
      input.expectedExecutionId !== undefined &&
      current.executionId !== input.expectedExecutionId
    ) {
      throw createIntegrationError({
        code: "STEER_TARGET_CHANGED",
        category: "conflict",
        message: "Strict Mission steer target changed before command submission.",
        details: {
          missionId: input.missionId,
          expectedExecutionId: input.expectedExecutionId,
          executionId: current.executionId,
        },
      });
    }
    return current;
  };

  const createLocalHostMissionControlAdapter = (
    adapterOptions: {
      readonly onCommandOutcome?: ((requestId: string) => void | Promise<void>) | undefined;
    } = {},
  ) => {
    const validateStrictTarget = async ({ command }: { readonly command: MissionCommand }) => {
      if (command.kind !== "steer" && command.kind !== "queue.steer") return;
      const target = command.target;
      if (target?.executionId === undefined || target.turnId === undefined) {
        throw createIntegrationError({
          code: "STEER_TARGET_NOT_ACTIVE",
          category: "conflict",
          message: "Strict Mission command requires an active execution and canonical turn.",
          details: { missionId: command.missionId },
        });
      }
      const current = await resolveLocalHostStrictTarget({ missionId: command.missionId });
      if (current === undefined) {
        throw createIntegrationError({
          code: "STEER_TARGET_CHANGED",
          category: "conflict",
          message: "Strict Mission steer target is no longer active.",
          details: { missionId: command.missionId },
        });
      }
      if (current.executionId !== target.executionId || current.turnId !== target.turnId) {
        throw createIntegrationError({
          code: "STEER_TARGET_CHANGED",
          category: "conflict",
          message: "Strict Mission steer target changed before command apply.",
          details: {
            missionId: command.missionId,
            expectedExecutionId: target.executionId,
            executionId: current.executionId,
            expectedTurnId: target.turnId,
            turnId: current.turnId,
          },
        });
      }
    };

    const apply = async (command: MissionCommand): Promise<Record<string, unknown>> =>
      await dispatchMissionCommand(command, {
        async send(command) {
          const accepted = await sendMissionMessage({
            id: command.missionId,
            content: command.payload.input.prompt,
            requestId: command.request.requestId,
            mode: "enqueue",
            ...(command.payload.input.attachments.length === 0
              ? {}
              : { attachments: command.payload.input.attachments }),
          });
          const queue = await promptQueueProjection.list(command.missionId);
          const queuedPosition = queue.items.findIndex(
            (item) => item.requestId === command.request.requestId,
          );
          return {
            missionId: command.missionId,
            ...(accepted.mission.execution === undefined
              ? {}
              : { executionId: accepted.mission.execution.id }),
            mode: accepted.effectiveMode,
            turnId: command.request.requestId,
            queueState: queue.state,
            ...(queuedPosition < 0 ? {} : { queuePosition: queuedPosition + 1 }),
          };
        },
        async steer(command) {
          const accepted = await sendMissionMessage({
            id: command.missionId,
            content: command.payload.input.prompt,
            requestId: command.request.requestId,
            mode: "steer",
            ...(command.payload.input.attachments.length === 0
              ? {}
              : { attachments: command.payload.input.attachments }),
          });
          if (accepted.effectiveMode !== "steer") {
            throw createIntegrationError({
              code: "COMMAND_REJECTED",
              category: "conflict",
              message: "Strict Mission steer could not be applied to the active turn.",
              details: { missionId: command.missionId, reason: "steer_not_supported" },
            });
          }
          return {
            missionId: command.missionId,
            ...(accepted.mission.execution === undefined
              ? {}
              : { executionId: accepted.mission.execution.id }),
            mode: "steer",
            turnId: command.request.requestId,
          };
        },
        async respond(command) {
          const interactionId = command.target?.interactionId;
          if (interactionId === undefined) {
            throw createIntegrationError({
              code: "INVALID_ARGUMENT",
              category: "usage",
              message: "Respond command requires an interaction target.",
              details: { missionId: command.missionId },
            });
          }
          const execution = await ensureActiveExecution(command.missionId, interactionId);
          const request = await findHumanRequest(execution.handle, interactionId);
          await execution.handle.respondToHumanInteraction(
            interactionId,
            toExpertHumanResponse(request, command.payload.response),
            { requestId: command.request.requestId },
          );
          acknowledgeHumanInteractionResponse(
            command.missionId,
            execution.handle.executionId,
            interactionId,
          );
          invalidateChat(command.missionId, execution.audience);
          return {
            missionId: command.missionId,
            executionId: execution.handle.executionId,
            interactionId,
          };
        },
        async interrupt(command) {
          const mission = await interruptMission(command.missionId, command.target?.executionId);
          return {
            missionId: mission.id,
            ...(mission.execution ? { executionId: mission.execution.id } : {}),
          };
        },
        async "queue.remove"(command) {
          const mission = await removeQueuedMissionMessage({
            id: command.missionId,
            requestId: command.payload.requestId,
          });
          return {
            missionId: mission.id,
            requestId: command.payload.requestId,
            changed: true,
          };
        },
        async "queue.resume"(command) {
          const before = await promptQueueProjection.list(command.missionId);
          const mission = await resumeMissionQueue(command.missionId);
          return {
            missionId: mission.id,
            changed: before.state === "paused",
            state: before.state === "paused" ? "running" : before.state,
          };
        },
        async "queue.steer"(command) {
          const mission = await steerQueuedMissionMessage({
            id: command.missionId,
            requestId: command.payload.requestId,
          });
          return {
            missionId: mission.id,
            requestId: command.payload.requestId,
            executionId: mission.execution?.id,
            turnId: command.payload.requestId,
            mode: "steer",
          };
        },
        async "queue.try-steer"(command) {
          const result = await trySteerQueuedMissionMessage({
            id: command.missionId,
            requestId: command.payload.requestId,
          });
          return {
            missionId: result.mission.id,
            requestId: command.payload.requestId,
            queueSteer: result.queueSteer,
          };
        },
      });

    const consumer: MissionCommandConsumer = {
      validateStrictTarget,
      async apply({ command, guard, signal }) {
        const execute = async () => {
          if (signal.aborted) {
            throw createIntegrationError({
              code: "COMMAND_RESULT_TIMEOUT",
              category: "conflict",
              message: "Mission command application was cancelled before dispatch.",
              details: { missionId: command.missionId, commandId: command.commandId },
            });
          }
          await validateStrictTarget({ command });
          return { result: await apply(command) };
        };
        return options.ownerScope === undefined
          ? await execute()
          : await options.ownerScope.runWithGuard(command.missionId, guard, execute);
      },
      afterOutcome: async (outcome) => {
        const notification: MissionCommandOutcomeNotification = {
          missionId: outcome.command.missionId,
          requestId: outcome.command.request.requestId,
          state: outcome.state,
          ...(outcome.result === undefined ? {} : { result: outcome.result }),
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        };
        commandService.emit(notification);
        await adapterOptions.onCommandOutcome?.(outcome.command.request.requestId);
      },
    };
    return {
      consumer,
      assertAcquisitionAllowed: async (missionId: string) => {
        const mission = await options.missions.get(missionId);
        await options.assertExecutorReady?.(mission.executor.ref);
      },
      resolveStrictTarget: resolveLocalHostStrictTarget,
      resolveExecutionTarget: resolveLocalHostExecutionTarget,
    };
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
      const { avatarIds, names } = await getExecutorMetadataOrFallback(mission, "work");
      const runtimeAgentOrdinals = createRuntimeAgentOrdinals(projection.records);
      const runtimeAgentAvatarIds = createRuntimeAgentAvatarIds(
        projection.records,
        avatarIds.values(),
      );
      const records = projection.records.map((record): MissionWorkRecord => {
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
    const { projection, cacheHit } = await loadWorkProjection(mission);
    const t1 = performance.now();
    logger.info(
      "mission.get_work_snapshot",
      `Loaded Mission work snapshot for ${id} in ${(t1 - t0).toFixed(1)}ms.`,
      {
        missionId: id,
        executionCount: projection.executionCount,
        recordCount: projection.snapshot.records.length,
        cacheHit,
        elapsedMs: t1 - t0,
      },
    );
    return projection.snapshot;
  };

  const getWorkConversation = async (
    input: GetMissionWorkConversation,
  ): Promise<MissionWorkConversationSnapshot> => {
    const t0 = performance.now();
    let mission = await options.missions.get(input.id);
    await awaitTerminalLifecycleSettlement(mission);
    mission = await options.missions.get(input.id);
    const { projection, cacheHit } = await loadWorkProjection(mission);
    const durableEntries = projection.entriesByRecordId.get(input.recordId);
    if (durableEntries === undefined) {
      throw new Error(`Mission work record not found: ${input.recordId}`);
    }
    const liveEntries = workService.live(mission.id, input.recordId)?.entries ?? [];
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
      missionId: mission.id,
      recordId: input.recordId,
      revision: workService.revision(mission.id),
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
      return await options.missions.get(id);
    },
    reconcileUsage,
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
    createLocalHostMissionControlAdapter,
    async updateOptions(input) {
      return await withMissionController(input.id, async () => await updateMissionOptions(input));
    },
    async updateContextMounts(input) {
      return await withMissionController(
        input.id,
        async () => await updateMissionContextMounts(input),
      );
    },
    async invalidateContextBindings(id) {
      await invalidateContextBindings(id);
    },
    async sendMessage(input) {
      return await withMissionController(input.id, async () => await sendMissionMessage(input));
    },
    async steerQueuedMessage(input) {
      return await withMissionController(
        input.id,
        async () => await steerQueuedMissionMessage(input),
      );
    },
    async removeQueuedMessage(input) {
      return await withMissionController(
        input.id,
        async () => await removeQueuedMissionMessage(input),
      );
    },
    async resumeQueue(id) {
      return await withMissionController(id, async () => await resumeMissionQueue(id));
    },
    async getChatPage(input) {
      return await getChatPage(input);
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
      return await lifecycleService.startCompaction(
        id,
        async () => await compactMissionContext(id),
      );
    },
    async getRuntimeBinding(id) {
      return (await readMissionRootContext(await options.missions.get(id)))?.runtime;
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
      return await withMissionController(
        id,
        async () => await interruptMission(id, expectedExecutionId),
      );
    },
    async forceInterrupt(id, expectedExecutionId) {
      return await forceInterruptMission(id, expectedExecutionId);
    },
    async stopLocalController(id) {
      lifecycleService.markLeaseLost(id);
      const current = lifecycleService.active(id);
      const session = sessionService.session(id);
      const executionContext = sessionService.executionContext(id);
      if (current !== undefined) {
        await settlementOutcomeWithin(
          current.handle.cancel("Mission controller lease was lost."),
          5_000,
        );
        await settlementOutcomeWithin(current.settlement, 30_000);
        lifecycleService.deleteActiveIfCurrent(id, current);
      }
      if (session !== undefined) {
        await settlementOutcomeWithin(
          session.cancelPromptQueue("Mission controller lease was lost."),
          5_000,
        );
        const release = await settlementOutcomeWithin(session.releaseAfterTerminal(), 10_000);
        if (release.status === "rejected") {
          logger.warn(
            "mission.controller_session_release_failed",
            `Mission ${id} could not release its ExpertSession after the controller lease was lost.`,
            { error: release.error, missionId: id, sessionId: session.sessionId },
          );
        }
        if (sessionService.deleteSessionIfCurrent(id, session)) {
          sessionService.clearCompilation(id);
        }
      }
      if (executionContext !== undefined) {
        sessionService.deleteExecutionContextIfCurrent(id, executionContext);
      }
    },
    async getCanonicalStrictTarget(id) {
      const mission = await options.missions.get(id);
      if (
        mission.executor.kind === "flow" ||
        mission.execution === undefined ||
        mission.execution.status !== "running"
      ) {
        return undefined;
      }
      if (mission.execution.inputMessageId === undefined) return undefined;
      return {
        executionId: mission.execution.id,
        turnId: mission.execution.inputMessageId,
      };
    },
    async getWork(id) {
      return await getWorkSnapshot(id);
    },
    async getWorkConversation(input) {
      return await getWorkConversation(input);
    },
    async delete(id) {
      await lifecycleService.startDeletion(id, async () => {
        lifecycleService.setControlIssue(id, {
          state: "deletion_pending",
          reasonCode: "MISSION_DELETION_PENDING",
          observedAt: new Date().toISOString(),
        });
        await persistMissionDeletionIntent(options.missions.storagePath?.(id), id);
        const inFlight = lifecycleService.run(id);
        lifecycleService.forgetRun(id);
        await options.ownerScope?.forceRevoke(id);
        if (inFlight !== undefined) await settlesWithin(inFlight, 4_000);
        const liveChat = chatService.live(id);
        if (liveChat !== undefined) await chatService.closeLiveIfCurrent(id, liveChat);
        await withMissionController(
          id,
          async () =>
            await (options.ownerScope?.terminalDelete(id, async () => await deleteMission(id)) ??
              deleteMission(id)),
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
      await withMissionController(input.missionId, async () => {
        const execution = await ensureActiveExecution(input.missionId, input.interactionId);
        const request = await findHumanRequest(execution.handle, input.interactionId);
        await execution.handle.respondToHumanInteraction(
          input.interactionId,
          toExpertHumanResponse(request, input.response),
          {
            requestId: input.requestId,
          },
        );
        acknowledgeHumanInteractionResponse(
          input.missionId,
          execution.handle.executionId,
          input.interactionId,
        );
        invalidateChat(input.missionId, execution.audience);
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

async function persistMissionExecutionProjection(
  missions: MissionStore,
  executionStore: ReturnType<typeof createFileExecutionStore>,
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
    const completeProjection =
      source === undefined
        ? [...projected.values()]
        : ensureTerminalExecutionResultEntry([...projected.values()], source);
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

type MissionChatPageCursor =
  | { readonly version: 1; readonly kind: "timeline"; readonly beforeSequence: number }
  | {
      readonly version: 1;
      readonly kind: "projection";
      readonly sequence: number;
      readonly beforeOffset: number;
    }
  | {
      readonly version: 1;
      readonly kind: "entries";
      readonly sequence: number;
      readonly beforeEntryId: string;
    }
  | {
      readonly version: 2;
      readonly kind: "entries";
      readonly sequence: number;
      readonly beforeEntryHash: string;
    }
  | { readonly version: 1; readonly kind: "turn-start"; readonly sequence: number };

async function readMissionChatHistoryPage(input: {
  readonly missionId: string;
  readonly query: MissionChatPageQuery;
  readonly executionStore: ReturnType<typeof createFileExecutionStore>;
  readonly missions: MissionStore;
  readonly activeChat?: LiveMissionChat | undefined;
  readonly loadInheritedEntries?: (() => Promise<readonly MissionChatEntry[]>) | undefined;
}): Promise<{
  readonly entries: readonly MissionChatEntry[];
  readonly syncIssues: readonly MissionChatSyncIssue[];
  readonly oldestSequence?: number | undefined;
  readonly newestSequence?: number | undefined;
  readonly nextBeforeCursor?: string | undefined;
  readonly truncation?:
    { readonly omittedEntries: number; readonly truncatedFields: number } | undefined;
}> {
  const cursor = decodeMissionChatPageCursor(input.query.beforeCursor);
  let beforeSequence = cursor?.kind === "timeline" ? cursor.beforeSequence : undefined;
  const continuationSequence =
    cursor === undefined || cursor.kind === "timeline" ? undefined : cursor.sequence;
  if (continuationSequence !== undefined) beforeSequence = continuationSequence + 1;

  let inheritedBySequence: Map<number, MissionChatEntry[]> | undefined;
  const inheritedEntriesFor = async (sequence: number): Promise<readonly MissionChatEntry[]> => {
    if (input.loadInheritedEntries === undefined) return [];
    if (inheritedBySequence === undefined) {
      inheritedBySequence = new Map();
      for (const entry of await input.loadInheritedEntries()) {
        if (entry.kind === "user" || entry.timelineSequence === undefined) continue;
        inheritedBySequence.set(entry.timelineSequence, [
          ...(inheritedBySequence.get(entry.timelineSequence) ?? []),
          entry,
        ]);
      }
    }
    return inheritedBySequence.get(sequence) ?? [];
  };

  let remaining = input.query.limit;
  let collected: MissionChatEntry[] = [];
  const syncIssues: MissionChatSyncIssue[] = [];
  let nextBeforeCursor: string | undefined;
  let omittedEntries = 0;
  let truncatedFields = 0;
  let firstTimelineRead = true;

  while (remaining > 0) {
    const timeline = await input.missions.readTimelinePage(input.missionId, {
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      limit: Math.min(100, Math.max(1, remaining)),
    });
    if (timeline.turns.length === 0) break;

    for (let index = timeline.turns.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const turn = timeline.turns[index]!;
      const turnCursor =
        firstTimelineRead && continuationSequence === turn.sequence ? cursor : undefined;
      const page = await readMissionChatTurnPage({
        missionId: input.missionId,
        turn,
        limit: remaining,
        executionStore: input.executionStore,
        missions: input.missions,
        ...(turnCursor === undefined || turnCursor.kind === "timeline"
          ? {}
          : { cursor: turnCursor }),
        ...(input.activeChat === undefined ? {} : { activeChat: input.activeChat }),
        inheritedEntries:
          turn.executionId === undefined ? await inheritedEntriesFor(turn.sequence) : [],
      });
      collected = [...page.entries, ...collected];
      syncIssues.push(...page.syncIssues);
      omittedEntries += page.truncation?.omittedEntries ?? 0;
      truncatedFields += page.truncation?.truncatedFields ?? 0;
      remaining -= page.entries.length;
      if (page.nextCursor !== undefined) {
        nextBeforeCursor = encodeMissionChatPageCursor(page.nextCursor);
        remaining = 0;
        break;
      }
      if (remaining === 0) {
        const hasEarlierTimeline = index > 0 || timeline.nextBeforeSequence !== undefined;
        if (hasEarlierTimeline) {
          nextBeforeCursor = encodeMissionChatPageCursor({
            version: 1,
            kind: "timeline",
            beforeSequence: turn.sequence,
          });
        }
        break;
      }
    }

    firstTimelineRead = false;
    if (remaining === 0 || timeline.nextBeforeSequence === undefined) break;
    beforeSequence = timeline.nextBeforeSequence;
  }

  const sequences = collected.flatMap((entry) =>
    entry.timelineSequence === undefined ? [] : [entry.timelineSequence],
  );
  return {
    entries: collected,
    syncIssues,
    ...(sequences.length === 0 ? {} : { oldestSequence: Math.min(...sequences) }),
    ...(sequences.length === 0 ? {} : { newestSequence: Math.max(...sequences) }),
    ...(nextBeforeCursor === undefined ? {} : { nextBeforeCursor }),
    ...(omittedEntries === 0 && truncatedFields === 0
      ? {}
      : { truncation: { omittedEntries, truncatedFields } }),
  };
}

async function readMissionChatTurnPage(input: {
  readonly missionId: string;
  readonly turn: MissionTimelineTurn;
  readonly limit: number;
  readonly executionStore: ReturnType<typeof createFileExecutionStore>;
  readonly missions: MissionStore;
  readonly cursor?: Exclude<MissionChatPageCursor, { readonly kind: "timeline" }> | undefined;
  readonly activeChat?: LiveMissionChat | undefined;
  readonly inheritedEntries: readonly MissionChatEntry[];
}): Promise<{
  readonly entries: readonly MissionChatEntry[];
  readonly syncIssues: readonly MissionChatSyncIssue[];
  readonly nextCursor?: MissionChatPageCursor | undefined;
  readonly truncation?:
    { readonly omittedEntries: number; readonly truncatedFields: number } | undefined;
}> {
  const userEntry: MissionChatEntry = {
    id: input.turn.message.id,
    timelineSequence: input.turn.sequence,
    kind: "user",
    content: input.turn.message.content,
    ...(input.turn.message.attachments === undefined
      ? {}
      : { attachments: input.turn.message.attachments }),
    createdAt: input.turn.message.createdAt,
    ...(input.turn.executionId === undefined ? {} : { executionId: input.turn.executionId }),
  };
  if (
    input.cursor?.kind === "turn-start" ||
    (input.turn.executionId === undefined && input.inheritedEntries.length === 0)
  ) {
    return { entries: [userEntry], syncIssues: [] };
  }

  if (
    input.turn.executionId !== undefined &&
    input.inheritedEntries.length === 0 &&
    input.turn.executionId !== input.activeChat?.executionId &&
    (input.cursor === undefined ||
      input.cursor.kind === "projection" ||
      input.cursor.kind === "entries")
  ) {
    const projectionPage = await input.missions.readExecutionProjectionPage(
      input.missionId,
      input.turn.executionId,
      { limit: 1_000 },
    );
    const projection = projectionPage?.entries;
    // Legacy and interrupted versions can have a complete Execution without a
    // terminal Mission projection. The Execution state is the authority that
    // decides whether durable history can still be reconstructed; treating a
    // missing projection as a missing Execution makes retries deterministically
    // fail even though all source records remain readable.
    const executionState = await input.executionStore
      .get(input.turn.executionId)
      .catch(() => undefined);
    // A terminal projection is immutable and already bounded for UI reads.
    // Retaining the canonical state file after archival must not force every
    // history page to inflate and decode the complete archived event stream.
    if (
      projectionPage !== undefined &&
      (executionState === undefined ||
        (isMissionTerminalExecutionStatus(executionState.status) &&
          projectionPage.orderingVersion === MISSION_EXECUTION_PROJECTION_ORDERING_VERSION &&
          projectionPage.sourceUpdatedAt !== undefined &&
          projectionPage.sourceUpdatedAt >= executionState.updatedAt))
    ) {
      const completeProjection =
        executionState === undefined
          ? projectionPage.entries
          : ensureTerminalExecutionResultEntry(projectionPage.entries, executionState);
      const projectedEntries = finalizeHistoricalChatEntries(
        orderMissionExecutionEntries(completeProjection),
        true,
        executionState?.rootInvocationId,
      ).map((entry) => ({
        ...entry,
        timelineSequence: entry.timelineSequence ?? input.turn.sequence,
      }));
      const combined = [userEntry, ...projectedEntries];
      const entryCursor = input.cursor?.kind === "entries" ? input.cursor : undefined;
      const requestedEnd =
        entryCursor === undefined
          ? combined.length
          : combined.findIndex((entry) =>
              entryCursor.version === 1
                ? entry.id === entryCursor.beforeEntryId
                : missionChatEntryHash(entry.id) === entryCursor.beforeEntryHash,
            );
      // Legacy byte cursors cannot be mapped safely after an atomic file
      // replacement. Reset them to the latest stable keyset page; entry IDs
      // keep renderer de-duplication deterministic.
      const safeEnd = input.cursor?.kind === "projection" ? combined.length : requestedEnd;
      if (safeEnd < 0) throw new Error("Mission chat page cursor is no longer available.");
      const start = Math.max(0, safeEnd - input.limit);
      return {
        entries: combined.slice(start, safeEnd),
        syncIssues: [],
        ...(projectionPage.omittedEntries === 0 && projectionPage.truncatedFields === 0
          ? {}
          : {
              truncation: {
                omittedEntries: projectionPage.omittedEntries,
                truncatedFields: projectionPage.truncatedFields,
              },
            }),
        ...(start === 0
          ? {}
          : {
              nextCursor: {
                version: 2 as const,
                kind: "entries" as const,
                sequence: input.turn.sequence,
                beforeEntryHash: missionChatEntryHash(combined[start]!.id),
              },
            }),
      };
    }
    if (projection === undefined && executionState === undefined) {
      return { entries: [userEntry], syncIssues: [missionChatSyncIssue("history")] };
    }
  }

  const history = await readMissionChatHistory(
    [input.turn],
    input.executionStore,
    input.missions,
    input.missionId,
    input.activeChat,
  );
  const activeEntries =
    input.activeChat !== undefined && input.turn.executionId === input.activeChat.executionId
      ? input.activeChat.entries
      : [];
  const combined = mergeMissionChatEntriesWithLive(
    [
      ...history.entries,
      ...input.inheritedEntries.map((entry) => ({
        ...entry,
        timelineSequence: entry.timelineSequence ?? input.turn.sequence,
      })),
    ],
    activeEntries.map((entry) => ({
      ...entry,
      timelineSequence: entry.timelineSequence ?? input.turn.sequence,
    })),
  );
  const entryCursor = input.cursor?.kind === "entries" ? input.cursor : undefined;
  const requestedEnd =
    entryCursor === undefined
      ? combined.length
      : combined.findIndex((entry) =>
          entryCursor.version === 1
            ? entry.id === entryCursor.beforeEntryId
            : missionChatEntryHash(entry.id) === entryCursor.beforeEntryHash,
        );
  if (requestedEnd < 0) throw new Error("Mission chat page cursor is no longer available.");
  const start = Math.max(0, requestedEnd - input.limit);
  return {
    entries: combined.slice(start, requestedEnd),
    syncIssues: history.syncIssues,
    ...(start === 0
      ? {}
      : {
          nextCursor: {
            version: 2 as const,
            kind: "entries" as const,
            sequence: input.turn.sequence,
            beforeEntryHash: missionChatEntryHash(combined[start]!.id),
          },
        }),
  };
}

function uniqueMissionChatEntriesById(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  const byId = new Map<string, MissionChatEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

export function mergeMissionChatEntriesWithLive(
  durable: readonly MissionChatEntry[],
  live: readonly MissionChatEntry[],
): MissionChatEntry[] {
  const durableEntries = uniqueMissionChatEntriesById(durable);
  const merged = uniqueMissionChatEntriesById(live);
  const liveIds = new Set(merged.map((entry) => entry.id));
  const firstSharedIndex = durableEntries.findIndex((entry) => liveIds.has(entry.id));
  let nextAnchor = merged.length;
  for (let index = durableEntries.length - 1; index >= 0; index -= 1) {
    const entry = durableEntries[index]!;
    if (liveIds.has(entry.id)) {
      nextAnchor = merged.findIndex((candidate) => candidate.id === entry.id);
      const current = merged[nextAnchor]!;
      merged[nextAnchor] = {
        ...current,
        ...(current.timelineSequence === undefined && entry.timelineSequence !== undefined
          ? { timelineSequence: entry.timelineSequence }
          : {}),
        ...(current.eventSequence === undefined && entry.eventSequence !== undefined
          ? { eventSequence: entry.eventSequence }
          : {}),
        ...(current.executorId === undefined && entry.executorId !== undefined
          ? { executorId: entry.executorId }
          : {}),
        ...(current.executorName === undefined && entry.executorName !== undefined
          ? { executorName: entry.executorName }
          : {}),
        ...(current.executorAvatarId === undefined && entry.executorAvatarId !== undefined
          ? { executorAvatarId: entry.executorAvatarId }
          : {}),
        ...(current.kind === "assistant" &&
        entry.kind === "assistant" &&
        current.finalAnswer === undefined &&
        entry.finalAnswer !== undefined
          ? { finalAnswer: entry.finalAnswer }
          : {}),
      } as MissionChatEntry;
    } else {
      merged.splice(firstSharedIndex < 0 || index < firstSharedIndex ? 0 : nextAnchor, 0, entry);
    }
  }
  return placeThinkingBeforeFinalAnswer(merged);
}

function placeThinkingBeforeFinalAnswer(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  const ordered = [...entries];
  for (const entry of entries) {
    if (entry.kind !== "thinking") continue;
    const runKey = missionMessageRunKey(entry.id);
    if (runKey === undefined) continue;
    const finalIndex = ordered.findIndex(
      (candidate) =>
        candidate.kind === "assistant" &&
        candidate.finalAnswer === true &&
        missionMessageRunKey(candidate.id) === runKey,
    );
    const thinkingIndex = ordered.findIndex((candidate) => candidate.id === entry.id);
    if (finalIndex < 0 || thinkingIndex < finalIndex) continue;
    ordered.splice(thinkingIndex, 1);
    ordered.splice(finalIndex, 0, entry);
  }
  return ordered;
}

function missionMessageRunKey(entryId: string): string | undefined {
  return /^(message:.+):(assistant|thinking):\d+$/.exec(entryId)?.[1];
}

function missionChatEntryHash(entryId: string): string {
  return createHash("sha256").update(entryId, "utf8").digest("hex");
}

export function encodeMissionChatPageCursor(cursor: MissionChatPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeMissionChatPageCursor(
  value: string | undefined,
): MissionChatPageCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid cursor shape");
    }
    const cursor = parsed as Record<string, unknown>;
    if (
      (cursor["version"] !== 1 && cursor["version"] !== 2) ||
      typeof cursor["kind"] !== "string"
    ) {
      throw new Error("invalid cursor version");
    }
    if (
      cursor["version"] === 1 &&
      cursor["kind"] === "timeline" &&
      Number.isInteger(cursor["beforeSequence"]) &&
      (cursor["beforeSequence"] as number) > 0
    ) {
      return {
        version: 1,
        kind: "timeline",
        beforeSequence: cursor["beforeSequence"] as number,
      };
    }
    if (
      cursor["version"] === 1 &&
      cursor["kind"] === "projection" &&
      Number.isInteger(cursor["sequence"]) &&
      (cursor["sequence"] as number) > 0 &&
      Number.isInteger(cursor["beforeOffset"]) &&
      (cursor["beforeOffset"] as number) >= 0
    ) {
      return {
        version: 1,
        kind: "projection",
        sequence: cursor["sequence"] as number,
        beforeOffset: cursor["beforeOffset"] as number,
      };
    }
    if (
      cursor["version"] === 1 &&
      cursor["kind"] === "entries" &&
      Number.isInteger(cursor["sequence"]) &&
      (cursor["sequence"] as number) > 0 &&
      typeof cursor["beforeEntryId"] === "string" &&
      cursor["beforeEntryId"] !== ""
    ) {
      return {
        version: 1,
        kind: "entries",
        sequence: cursor["sequence"] as number,
        beforeEntryId: cursor["beforeEntryId"],
      };
    }
    if (
      cursor["version"] === 2 &&
      cursor["kind"] === "entries" &&
      Number.isSafeInteger(cursor["sequence"]) &&
      (cursor["sequence"] as number) > 0 &&
      typeof cursor["beforeEntryHash"] === "string" &&
      /^[0-9a-f]{64}$/u.test(cursor["beforeEntryHash"])
    ) {
      return {
        version: 2,
        kind: "entries",
        sequence: cursor["sequence"] as number,
        beforeEntryHash: cursor["beforeEntryHash"],
      };
    }
    if (
      cursor["version"] === 1 &&
      cursor["kind"] === "turn-start" &&
      Number.isInteger(cursor["sequence"]) &&
      (cursor["sequence"] as number) > 0
    ) {
      return {
        version: 1,
        kind: "turn-start",
        sequence: cursor["sequence"] as number,
      };
    }
    throw new Error("invalid cursor fields");
  } catch {
    throw new Error("Mission chat page cursor is invalid.");
  }
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

    const activeEntries =
      turn.executionId === activeChat?.executionId ? activeChat.entries : undefined;
    // Once the live projection has visible output it is the cheapest and freshest source for an
    // active Execution. Before its replayable subscription catches up, read the durable history so
    // a cold navigation cannot briefly show only the user prompt. Completion-only and oversized
    // results have no live entry, so they still take the durable path and receive finalization.
    if (activeEntries !== undefined && activeEntries.length > 0) continue;

    const view = new StoredExecutionView(turn.executionId, executionStore);
    const state = await view.getState().catch(() => undefined);
    if (activeEntries !== undefined && state === undefined) continue;
    if (state === undefined) {
      const projection = await missions.readExecutionProjection(missionId, turn.executionId);
      if (projection !== undefined) {
        entries.push(...finalizeHistoricalChatEntries(projection, true));
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
        entries.push(...finalizeHistoricalChatEntries(projection, true, state.rootInvocationId));
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
      orderMissionExecutionEntries([
        ...messageRecordsToChatEntries(
          histories
            .flatMap((history) => history.messages)
            .filter((record) => record.source?.parentSessionId === undefined),
        ).map((entry) => ({
          ...entry,
          timelineSequence: turn.sequence,
        })),
        ...activityEntries,
      ]),
      isMissionTerminalExecutionStatus(state.status),
      state.rootInvocationId,
    );
    entries.push(...richEntries);
    if (
      isMissionTerminalExecutionStatus(state.status) &&
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

type MissionChatSyncIssue = NonNullable<MissionConversationSnapshot["syncIssues"]>[number];

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
    readonly sequence: number;
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
        events.push({
          event: parsed.data,
          invocationId: event.invocationId,
          sequence: event.cursor.sequence,
        });
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
        eventSequence: existing?.eventSequence ?? record.sequence,
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
      eventSequence:
        byId.get(`agent:${view.executionId}:${commandId}`)?.eventSequence ?? record.sequence,
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

export function orderMissionExecutionEntries(
  entries: readonly MissionChatEntry[],
): MissionChatEntry[] {
  return [...entries].toSorted((left, right) => {
    if (left.eventSequence === undefined || right.eventSequence === undefined) return 0;
    return left.eventSequence - right.eventSequence;
  });
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

function ensureTerminalExecutionResultEntry(
  entries: readonly Exclude<MissionChatEntry, { readonly kind: "user" }>[],
  execution: TerminalExecutionResultSource,
): Exclude<MissionChatEntry, { readonly kind: "user" }>[];
function ensureTerminalExecutionResultEntry(
  entries: readonly MissionChatEntry[],
  execution: TerminalExecutionResultSource,
): MissionChatEntry[];
function ensureTerminalExecutionResultEntry(
  entries: readonly MissionChatEntry[],
  execution: TerminalExecutionResultSource,
): MissionChatEntry[] {
  if (execution.status !== "succeeded") return [...entries];
  const content = missionWorkOutputSummary(execution.output, 200_000);
  if (content === undefined || content === "") return [...entries];
  const matchingIndex = entries.findLastIndex(
    (entry) =>
      entry.kind === "assistant" &&
      entry.invocationId === execution.rootInvocationId &&
      entry.content === content,
  );
  if (matchingIndex >= 0) {
    return entries.map((entry, index) =>
      index === matchingIndex && entry.kind === "assistant"
        ? { ...entry, streaming: false, finalAnswer: true }
        : entry,
    );
  }
  const presentation = entries.findLast(
    (entry) =>
      entry.invocationId === execution.rootInvocationId &&
      (entry.executorId !== undefined ||
        entry.executorName !== undefined ||
        entry.executorAvatarId !== undefined),
  );
  return [
    ...entries,
    {
      id: `result:${execution.executionId}`,
      executionId: execution.executionId,
      invocationId: execution.rootInvocationId,
      ...(presentation?.executorId === undefined ? {} : { executorId: presentation.executorId }),
      ...(presentation?.executorName === undefined
        ? {}
        : { executorName: presentation.executorName }),
      ...(presentation?.executorAvatarId === undefined
        ? {}
        : { executorAvatarId: presentation.executorAvatarId }),
      kind: "assistant",
      content,
      streaming: false,
      finalAnswer: true,
      createdAt: execution.updatedAt,
    },
  ];
}

interface TerminalExecutionResultSource {
  readonly executionId: string;
  readonly rootInvocationId: string;
  readonly status: string;
  readonly output?: unknown;
  readonly updatedAt: string;
}

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message).trim();
  }
  return error === undefined ? "" : String(error).trim();
}

export function finalizeHistoricalChatEntries(
  entries: readonly MissionChatEntry[],
  executionTerminal = true,
  rootInvocationId?: string,
): MissionChatEntry[] {
  if (!executionTerminal) return [...entries];
  const finalized = entries.map((entry): MissionChatEntry =>
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
  const finalAnswerIndex = finalized.findLastIndex(
    (entry) =>
      entry.kind === "assistant" &&
      (rootInvocationId === undefined || entry.invocationId === rootInvocationId) &&
      entry.streaming === false &&
      entry.finalAnswer === true,
  );
  if (finalAnswerIndex < 0 || finalAnswerIndex === finalized.length - 1) return finalized;
  const finalAnswer = finalized[finalAnswerIndex]!;
  return [
    ...finalized.slice(0, finalAnswerIndex),
    ...finalized.slice(finalAnswerIndex + 1),
    finalAnswer,
  ];
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

function uniqueMissionChatEntries(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  const byId = new Map<string, MissionChatEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

function messageRecordsToChatEntries(records: readonly AgentMessageRecord[]): MissionChatEntry[] {
  const entries: MissionChatEntry[] = [];
  const messageOrdinals = new Map<string, number>();
  for (const record of [...records].sort((left, right) => left.sequence - right.sequence)) {
    const base = {
      executionId: record.executionId,
      invocationId: record.invocationId,
      eventSequence: record.sequence,
      ...(record.executorId === undefined ? {} : { executorId: record.executorId }),
      createdAt: new Date(record.message.timestamp).toISOString(),
    };
    if (record.message.role === "assistant") {
      const assistantMessage = record.message;
      assistantMessage.content.forEach((content, index) => {
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
            ...(assistantMessage.stopReason === "stop" || assistantMessage.stopReason === "length"
              ? { finalAnswer: true }
              : {}),
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
    else
      entries[existingIndex] = {
        ...existing,
        ...tool,
        eventSequence: existing.eventSequence,
        createdAt: existing.createdAt,
      };
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
  // entry. Their Experts resolve through the pinned Project Revision; an unresolved identity is
  // left empty for the renderer's localized unavailable label rather than exposing its raw id.
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
  onEvent: (event: ExecutionEvent) => Promise<void>,
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
  };
  let closed = false;
  // Output subscriptions replay the in-memory history when they reconnect. Keep the
  // source event ids seen by this live projection so a replay cannot append the same
  // assistant message a second time.
  const seenOutputEventIds = new Set<string>();
  let outputSubscription: Awaited<ReturnType<MutableExecution["subscribeOutput"]>> | undefined;
  let eventSubscription: Awaited<ReturnType<MutableExecution["subscribeEvents"]>> | undefined;
  const outputTask = (async () => {
    while (!closed) {
      try {
        const subscription = await execution.subscribeOutput({ scope: { kind: "all" } });
        outputSubscription = subscription;
        for await (const item of subscription) {
          if (closed) break;
          if (seenOutputEventIds.has(item.sourceEventId)) continue;
          seenOutputEventIds.add(item.sourceEventId);
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
        if (isExecutionUnavailable(error, execution.executionId)) return;
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
        let resyncFailed = false;
        while (!closed) {
          try {
            await onEventResync();
            // A failed seed can miss an interaction event because the event bus is live-only.
            // Once its durable projection recovers, tell both the chat and rail to reload it.
            if (resyncFailed) onInvalidate();
            break;
          } catch (error) {
            if (closed) break;
            resyncFailed = true;
            onSubscriptionError("events", error);
            // Preserve the user-visible interaction update while the durable Mission projection
            // retries. The established subscription keeps subsequent live events queued.
            onInvalidate();
            await missionSubscriptionRetryDelay();
          }
        }
        if (closed) return;
        for await (const event of subscription) {
          if (closed) break;
          await onEvent(event);
          if (event.type.startsWith("human.") || event.type.startsWith("execution.")) {
            onInvalidate();
          }
        }
        return;
      } catch (error) {
        if (isExecutionUnavailable(error, execution.executionId)) return;
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

function isExecutionUnavailable(error: unknown, executionId: string): boolean {
  return error instanceof Error && error.message === `Execution not found: ${executionId}`;
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

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return await Promise.race([
    operation.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

type SettlementOutcome =
  | { readonly status: "fulfilled" }
  | { readonly status: "rejected"; readonly error: unknown }
  | { readonly status: "timed_out" };

function containsAgentLifecycleQuiescenceError(error: unknown): boolean {
  if (error instanceof AgentLifecycleQuiescenceError) return true;
  return (
    error instanceof AggregateError &&
    error.errors.some((nested) => containsAgentLifecycleQuiescenceError(nested))
  );
}

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

export function consumeLiveChatOutput(
  chat: LiveMissionChat,
  item: ExecutionOutputItem,
  options: {
    readonly includeNestedSource?: boolean;
    readonly resolveExecutorName?: ExecutorNameResolver;
    readonly resolveExecutorAvatarId?: ExecutorAvatarIdResolver;
  } = {},
): MissionChatPatch[] {
  clearSupersededFinalAnswerBoundary(chat, item);
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
    return [upsertLiveMissionChatEntry(chat, entry)];
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
    return [upsertLiveMissionChatEntry(chat, entry)];
  }
  if (item.source.parentSessionId !== undefined && options.includeNestedSource !== true) return [];
  if (item.channel === "thought") {
    if (chat.completedAnswerRuns?.has(missionAnswerRunKey(item))) return [];
    const content = item.delta ?? formatValue(item.value, 200_000);
    if (content === "") return [];
    const current = findStreamingMessageEntryForRun(chat.entries, item, "thinking");
    if (current !== undefined) {
      const canAppend = current.content.length + content.length <= 200_000;
      const nextContent = truncate(current.content + content, 200_000);
      if (nextContent === current.content) return [];
      current.content = nextContent;
      const patches: MissionChatPatch[] = canAppend
        ? [{ type: "entry.append", entryId: current.id, field: "content", delta: content }]
        : [{ type: "entry.upsert", entry: { ...current } }];
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
      return [upsertLiveMissionChatEntry(chat, entry)];
    }
  }
  if (item.channel === "message") {
    const content = item.delta ?? completedMessageText(item.value);
    const finalAnswer = item.delta === undefined && isFinalMissionAnswer(item.value);
    const patches = markRunThinkingComplete(chat.entries, item);
    if (finalAnswer) {
      (chat.completedAnswerRuns ??= new Set()).add(missionAnswerRunKey(item));
    }
    const current = findStreamingMessageEntryForRun(chat.entries, item, "assistant");
    const existingForRun = findAssistantEntryForRun(chat.entries, item);
    const startsNewSegment =
      current === undefined &&
      existingForRun !== undefined &&
      assistantMessageStartsNewSegment(chat.entries, existingForRun, item, content);
    // Codex can deliver an item/completed notification before a queued delta is
    // drained. The completed item already owns the final text; treating that late
    // delta as a new stream would create a second assistant row for the same run.
    // A Runtime run may legitimately contain several assistant messages separated
    // by tool calls, though. In that case the post-tool delta starts a new segment
    // even though an earlier assistant message for the run is already complete.
    if (
      item.delta !== undefined &&
      current === undefined &&
      hasCompletedMessageForRun(chat.entries, item) &&
      !startsNewSegment
    ) {
      return patches;
    }
    if (item.delta !== undefined && current !== undefined) {
      const canAppend = current.content.length + content.length <= 200_000;
      const nextContent = truncate(current.content + content, 200_000);
      const contentChanged = nextContent !== current.content;
      current.content = nextContent;
      if (content !== "" && contentChanged) {
        patches.push(
          canAppend
            ? { type: "entry.append", entryId: current.id, field: "content", delta: content }
            : { type: "entry.upsert", entry: { ...current } },
        );
      }
    } else if (item.delta === undefined && existingForRun !== undefined && !startsNewSegment) {
      if (current !== undefined) {
        current.streaming = false;
        if (finalAnswer) current.finalAnswer = true;
        patches.push(
          finalAnswer
            ? upsertLiveMissionChatEntry(chat, current)
            : { type: "entry.streaming", entryId: current.id, streaming: false },
        );
      } else if (finalAnswer && existingForRun.finalAnswer !== true) {
        existingForRun.finalAnswer = true;
        patches.push(upsertLiveMissionChatEntry(chat, existingForRun));
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
        ...(finalAnswer ? { finalAnswer: true } : {}),
      };
      patches.push(upsertLiveMissionChatEntry(chat, entry));
    }
    if (finalAnswer && isRootMissionRuntimeOutput(item)) {
      const finalEntry = findAssistantEntryForRun(chat.entries, item);
      if (finalEntry !== undefined) {
        chat.finalAnswerBoundary = {
          entryId: finalEntry.id,
          runKey: missionAnswerRunKey(item),
          occurredAt: item.occurredAt,
        };
      }
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
      return [upsertLiveMissionChatEntry(chat, existing)];
    }
    const patches = markRunThinkingComplete(chat.entries, item);
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
    patches.push(upsertLiveMissionChatEntry(chat, entry));
    return patches;
  }
  if (item.channel === "result") {
    (chat.completedAnswerRuns ??= new Set()).add(missionAnswerRunKey(item));
    const patches = markRunThinkingComplete(chat.entries, item);
    const content = formatValue(item.value, 200_000);
    let finalEntry = findAssistantEntryForRun(chat.entries, item);
    if (content !== "" && finalEntry === undefined) {
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
        finalAnswer: true,
      };
      const upsert = upsertLiveMissionChatEntry(chat, entry);
      patches.push(upsert);
      finalEntry = entry;
    } else if (finalEntry !== undefined && finalEntry.finalAnswer !== true) {
      finalEntry.streaming = false;
      finalEntry.finalAnswer = true;
      patches.push(upsertLiveMissionChatEntry(chat, finalEntry));
    }
    if (isRootMissionRuntimeOutput(item) && finalEntry !== undefined) {
      chat.finalAnswerBoundary = {
        entryId: finalEntry.id,
        runKey: missionAnswerRunKey(item),
        occurredAt: item.occurredAt,
      };
    }
    return patches;
  }
  return [];
}

function missionAnswerRunKey(item: Pick<ExecutionOutputItem, "invocationId" | "runId">): string {
  return JSON.stringify([item.invocationId, item.runId]);
}

function clearSupersededFinalAnswerBoundary(
  chat: LiveMissionChat,
  item: Pick<
    ExecutionOutputItem,
    "channel" | "parentInvocationId" | "runId" | "invocationId" | "occurredAt" | "source"
  >,
): void {
  const boundary = chat.finalAnswerBoundary;
  if (
    boundary !== undefined &&
    isRootMissionRuntimeOutput(item) &&
    item.channel !== "telemetry" &&
    missionAnswerRunKey(item) !== boundary.runKey &&
    item.occurredAt > boundary.occurredAt
  ) {
    delete chat.finalAnswerBoundary;
  }
}

function upsertLiveMissionChatEntry(
  chat: LiveMissionChat,
  entry: MissionChatEntry,
): Extract<MissionChatPatch, { readonly type: "entry.upsert" }> {
  const existingIndex = chat.entries.findIndex((candidate) => candidate.id === entry.id);
  const boundaryId =
    chat.finalAnswerBoundary?.entryId === entry.id ? undefined : chat.finalAnswerBoundary?.entryId;
  const boundaryIndex =
    boundaryId === undefined
      ? -1
      : chat.entries.findIndex((candidate) => candidate.id === boundaryId);

  if (existingIndex === -1) {
    if (boundaryIndex === -1) chat.entries.push(entry);
    else chat.entries.splice(boundaryIndex, 0, entry);
  } else {
    chat.entries[existingIndex] = entry;
    if (boundaryIndex >= 0 && existingIndex > boundaryIndex) {
      chat.entries.splice(existingIndex, 1);
      const nextBoundaryIndex = chat.entries.findIndex((candidate) => candidate.id === boundaryId);
      chat.entries.splice(nextBoundaryIndex, 0, entry);
    }
  }

  return {
    type: "entry.upsert",
    entry: { ...entry },
    ...(boundaryIndex === -1 ? {} : { beforeEntryId: boundaryId }),
  };
}

function isFinalMissionAnswer(value: unknown): boolean {
  const stopReason = asRecord(value)["stopReason"];
  return stopReason === "stop" || stopReason === "length";
}

function hasCompletedMessageForRun(
  entries: readonly MissionChatEntry[],
  item: Pick<ExecutionOutputItem, "executionId" | "invocationId" | "runId">,
): boolean {
  const prefix = `message:${item.executionId}:${item.invocationId}:${item.runId}:assistant:`;
  return entries.some(
    (entry) =>
      entry.kind === "assistant" &&
      entry.executionId === item.executionId &&
      entry.invocationId === item.invocationId &&
      entry.streaming === false &&
      entry.content.length > 0 &&
      entry.id.startsWith(prefix),
  );
}

function assistantMessageStartsNewSegment(
  entries: readonly MissionChatEntry[],
  previous: Extract<MissionChatEntry, { readonly kind: "assistant" }>,
  item: Pick<ExecutionOutputItem, "executionId" | "invocationId" | "runId" | "occurredAt">,
  content: string,
): boolean {
  if (content !== "" && content !== previous.content) return true;
  const previousIndex = entries.findIndex((entry) => entry.id === previous.id);
  if (previousIndex < 0) return false;
  return entries
    .slice(previousIndex + 1)
    .some(
      (entry) =>
        entry.kind === "tool" &&
        entry.executionId === item.executionId &&
        entry.invocationId === item.invocationId &&
        entry.createdAt <= item.occurredAt,
    );
}

function findAssistantEntryForRun(
  entries: readonly MissionChatEntry[],
  item: Pick<ExecutionOutputItem, "executionId" | "invocationId" | "runId">,
): Extract<MissionChatEntry, { readonly kind: "assistant" }> | undefined {
  const prefix = `message:${item.executionId}:${item.invocationId}:${item.runId}:assistant:`;
  return entries.findLast(
    (entry): entry is Extract<MissionChatEntry, { readonly kind: "assistant" }> =>
      entry.kind === "assistant" && entry.id.startsWith(prefix),
  );
}

function findStreamingMessageEntryForRun<K extends "assistant" | "thinking">(
  entries: readonly MissionChatEntry[],
  item: Pick<ExecutionOutputItem, "executionId" | "invocationId" | "runId">,
  kind: K,
): Extract<MissionChatEntry, { kind: K }> | undefined {
  const prefix = `message:${item.executionId}:${item.invocationId}:${item.runId}:${kind}:`;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.kind === kind &&
      entry.invocationId === item.invocationId &&
      entry.streaming &&
      entry.id.startsWith(prefix)
    ) {
      return entry as Extract<MissionChatEntry, { kind: K }>;
    }
  }
  return undefined;
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

function isMissionTerminalExecutionStatus(
  status: Parameters<typeof isFinalExecutionStatus>[0],
): boolean {
  return status === "interrupted" || isFinalExecutionStatus(status);
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

function markRunThinkingComplete(
  entries: MissionChatEntry[],
  item: Pick<ExecutionOutputItem, "executionId" | "invocationId" | "runId">,
): MissionChatPatch[] {
  const patches: MissionChatPatch[] = [];
  const prefix = `message:${item.executionId}:${item.invocationId}:${item.runId}:thinking:`;
  for (const entry of entries) {
    if (
      entry.kind === "thinking" &&
      entry.invocationId === item.invocationId &&
      entry.streaming &&
      entry.id.startsWith(prefix)
    ) {
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

function hasPromptAttachments(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attachments = (value as { readonly attachments?: unknown }).attachments;
  return Array.isArray(attachments) && attachments.length > 0;
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
