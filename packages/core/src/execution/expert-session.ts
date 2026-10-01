import { randomUUID } from "node:crypto";

import type {
  AgentInstance,
  AgentMessageUsage,
  ExpertPromptAttachment,
  ExecutionCursor,
  ExecutionRecord,
  ExpertMessageHistory,
  ExpertSessionEvent,
  ExpertSessionRecord,
  ExecutionEvent,
  ExecutionEnvironmentSnapshot,
  Invocation,
  PromptMode,
  PromptRequest,
  RuntimeContextRecord,
} from "@pragma/shared";
import {
  ExpertMessageHistorySchema,
  ExpertPromptAttachmentSchema,
  InvocationOutputSchema,
} from "@pragma/shared";
import { isFinalExecutionStatus as isFinal } from "@pragma/shared";

import type { ExpertDefinition } from "../agent/expert-team.ts";
import { isExpertTeam } from "../agent/expert-team.ts";
import { fingerprintExpertExecutionDefinition } from "../agent/expert-definition-descriptor.ts";
import type { RuntimeResolver } from "../runtime-resolver.ts";
import type { PragmaLoggerProvider } from "../logging/logger.ts";
import type {
  RuntimeContextWindowUsage,
  RuntimeModelSelection,
} from "../runtime/runtime-adapter.ts";
import { openRuntimeSession } from "../runtime/session-factory.ts";
import {
  readRuntimeSessionContextWindowUsage,
  rebindRuntimeSessionExpertId,
  readRuntimeSessionRecord,
} from "../runtime/session-record.ts";
import { mergeUsages, type UsageSink } from "../runtime/usage.ts";
import { PragmaPaths } from "../storage/pragma-paths.ts";
import { isRetryableStorageContentionError } from "../storage/file-lock.ts";
import type { ExpertAgentAutomaticHumanInteractionHandler } from "../tools/managed-tool.ts";
import {
  ExecutionController,
  isHumanInteractionCheckpointError,
  listPendingHumanInteractionIds,
  persistHumanInteractionResponse,
  runExpertInvocation,
} from "./expert-runner.ts";
import { unwrapInvocationOutput } from "./context-output-service.ts";
import { createExpertPromptInput, readExpertPromptInput } from "./expert-prompt.ts";
import type {
  HostContextBindings,
  HostContextBindingsResolver,
} from "../context-system/host-context-bindings.ts";
import { RuntimeSessionPool } from "./runtime-session-pool.ts";
import { getExecutionLiveBus } from "./execution-live-bus.ts";
import {
  hasUncertainSteerDelivery,
  hasUnresolvedSteerDelivery,
  SteerDeliveryUncertainError,
  SteerNotDispatchedError,
} from "./steer-delivery-error.ts";
import {
  ExecutionFinalStatusConflictError,
  ExecutionVersionConflictError,
  type ExecutionStore,
} from "./execution-store.ts";
import {
  closeExecutionContexts,
  type ContextResolutionScopeSnapshot,
} from "./context-resolution-service.ts";
import type {
  ExpertSessionEventInput,
  ExpertSessionStore,
  ExpertSessionTransactionAction,
} from "./expert-session-store.ts";
import { createRuntimeContextRecord, mergeRuntimeContextRecord } from "./runtime-context-record.ts";
import {
  StoredExecutionView,
  type GetMessageHistoryOptions,
  type InvocationScope,
  type MutableExecution,
} from "./execution-view.ts";

export interface CreateExpertSessionOptions {
  readonly sessionId?: string | undefined;
  readonly runtime?: string | undefined;
  readonly modelSelection?: RuntimeModelSelection | undefined;
  readonly environment?: ExecutionEnvironmentSnapshot | undefined;
}

export interface ResumeExpertSessionOptions {
  readonly sessionId: string;
  readonly environment?: ExecutionEnvironmentSnapshot | undefined;
  readonly definitionMigration?:
    | {
        readonly previousExpertId: string;
        readonly previousRootExpertId?: string | undefined;
        readonly reason: string;
      }
    | undefined;
}

export interface RecoverClosedExpertSessionOptions extends ResumeExpertSessionOptions {
  readonly reason: string;
}

export class ExpertDefinitionMismatchError extends Error {
  constructor(readonly sessionId: string) {
    super(`Expert definition mismatch for Session ${sessionId}.`);
    this.name = "ExpertDefinitionMismatchError";
  }
}

export function isExpertDefinitionMismatchError(
  error: unknown,
): error is ExpertDefinitionMismatchError {
  return error instanceof ExpertDefinitionMismatchError;
}

export interface PromptOptions {
  readonly requestId?: string | undefined;
  readonly mode?: PromptMode | undefined;
  readonly modelSelection?: RuntimeModelSelection | undefined;
  readonly attachments?: readonly ExpertPromptAttachment[] | undefined;
  readonly steerFallback?: "enqueue" | undefined;
}

export interface ExpertTurn extends MutableExecution {
  readonly requestId: string;
  readonly requestedMode: PromptMode;
  readonly effectiveMode: PromptMode;
  readonly fallbackReason?: string | undefined;
  readonly result: Promise<unknown>;
  /** The Session has durably released this turn's active prompt binding. */
  readonly settled: Promise<void>;
  readonly usage: Promise<AgentMessageUsage | undefined>;
  /** Checkpoint this turn only when it is durably waiting for human input. */
  readonly checkpointWaitingHuman: () => Promise<void>;
}

export interface PromptQueueState {
  readonly state: "idle" | "running" | "paused";
  readonly pendingCount: number;
  readonly pausedAfterRequestId?: string | undefined;
}

export type QueuedPromptSteerRetainedReason =
  | "no_active_turn"
  | "target_changed"
  | "runtime_unsupported"
  | "attachments_not_supported"
  | "human_input_wait"
  | "delivery_uncertain";

export type QueuedPromptSteerAttempt =
  | { readonly outcome: "steered"; readonly turn: ExpertTurn }
  | { readonly outcome: "retained"; readonly reason: QueuedPromptSteerRetainedReason };

export class RuntimeContextCompactionNotNeededError extends Error {
  constructor() {
    super("The Runtime context does not have enough history to compact yet.");
    this.name = "RuntimeContextCompactionNotNeededError";
  }
}

export function isRuntimeContextCompactionNotNeededError(
  error: unknown,
): error is RuntimeContextCompactionNotNeededError {
  return error instanceof RuntimeContextCompactionNotNeededError;
}

export interface ExpertSession {
  readonly sessionId: string;
  readonly expert: ExpertDefinition;
  prompt(content: string, options?: PromptOptions): Promise<ExpertTurn>;
  abort(reason?: string): Promise<void>;
  /** Interrupt a persisted execution after process recovery, without requiring a live controller. */
  abortExecution(executionId: string, reason?: string): Promise<void>;
  /** Release the Session owner after a durable human-input checkpoint. */
  checkpointWaitingHuman(): Promise<void>;
  /**
   * Release transient Runtime and lease resources after a terminal turn while
   * keeping the durable ExpertSession and its RuntimeSessionRef recoverable.
   * waitForIdle seals admission while waiting for the supplied settlement and
   * automatically retries active-turn validation until pending work settles.
   */
  releaseAfterTerminal(options?: {
    readonly waitForIdle?: boolean | undefined;
    readonly settlement?: Promise<unknown> | undefined;
  }): Promise<void>;
  /**
   * Release transient Runtime and lease resources after a durable human-input
   * checkpoint. The pending interaction and its queued prompt remain
   * recoverable in the persisted ExpertSession.
   */
  releaseAfterHumanCheckpoint(): Promise<void>;
  /** Stop native work without rewriting historical Execution state. */
  freezeForDeletion(): void;
  stopForDeletion(reason?: string): Promise<void>;
  finishDeletion(): Promise<void>;
  close(reason?: string): Promise<void>;
  refreshRuntimeSessions(): Promise<void>;
  getState(): Promise<ExpertSessionRecord>;
  listTurns(): Promise<readonly ExpertTurn[]>;
  getMessageHistory(options?: GetMessageHistoryOptions): Promise<readonly ExpertMessageHistory[]>;
  listEvents(options?: ListSessionEventsOptions): Promise<SessionEventPage>;
  getUsage(): Promise<AgentMessageUsage | undefined>;
  getRootContextWindowUsage(): Promise<RuntimeContextWindowUsage | undefined>;
  canCompactRootContext(): Promise<boolean | undefined>;
  compactRootContext(): Promise<RuntimeContextWindowUsage | undefined>;
  getPromptQueue(): Promise<readonly PromptRequest[]>;
  getPromptQueueState(): Promise<PromptQueueState>;
  attemptQueuedPromptSteer(requestId: string): Promise<QueuedPromptSteerAttempt>;
  steerQueuedPrompt(requestId: string): Promise<ExpertTurn>;
  removeQueuedPrompt(requestId: string, reason?: string): Promise<void>;
  resumePromptQueue(options?: { readonly recovery?: "abandon" | undefined }): Promise<void>;
  cancelPromptQueue(reason?: string): Promise<void>;
}

export interface SessionEventCursor {
  readonly offset: number;
}

export interface ListSessionEventsOptions {
  readonly scope?: InvocationScope | undefined;
  readonly after?: SessionEventCursor | undefined;
  readonly limit?: number | undefined;
}

export interface SessionEventPage {
  readonly items: readonly (ExpertSessionEvent | ExecutionEvent)[];
  readonly nextCursor?: SessionEventCursor | undefined;
}

export interface ExpertSessionManagerDependencies {
  readonly assertExecutionOwnership?: (() => Promise<void>) | undefined;
  readonly sessions: ExpertSessionStore;
  readonly executions: ExecutionStore;
  readonly runtimes: RuntimeResolver;
  readonly loggerProvider: PragmaLoggerProvider;
  readonly usageSink?: UsageSink | undefined;
  readonly pragmaHome: string;
  readonly automaticHumanInteractionHandler?:
    ExpertAgentAutomaticHumanInteractionHandler | undefined;
  readonly hostContextBindings?: HostContextBindings | undefined;
  readonly resolveHostContextBindings?: HostContextBindingsResolver | undefined;
  readonly nestedFlowExecutor?:
    import("./expert-runner.ts").NestedFlowInvocationExecutor | undefined;
}

type SteerClaim =
  | { readonly execute: false; readonly executionId: string }
  | {
      readonly execute: true;
      readonly executionId: string;
      readonly contextId: string;
      readonly attemptId: string;
    };

interface ValidDefinitionMigration {
  readonly previousExpertId: string;
  readonly previousRootExpertId: string;
  readonly reason: string;
}

const EXPERT_SESSION_LEASE_MS = 30_000;
const EXPERT_SESSION_LEASE_RENEWAL_MS = 10_000;
const EXPERT_SESSION_LEASE_RETRY_MS = 500;
const EXPERT_SESSION_LEASE_FAILURE_DRAIN_MS = 5_000;

/** Release validation failed before teardown started; the owner must be retained. */
export class ExpertSessionReleaseBlockedError extends Error {
  constructor(
    cause: unknown,
    readonly retryable = false,
  ) {
    super(readErrorMessage(cause), { cause });
    this.name = "ExpertSessionReleaseBlockedError";
  }
}

interface QueuedSteerClaim {
  readonly requestId: string;
  readonly activeExecutionId: string;
  readonly contextId: string;
  readonly originalPrompt: PromptRequest;
  readonly attemptId: string;
}

function validateDefinitionMigration(
  record: ExpertSessionRecord,
  expert: ExpertDefinition,
  currentFingerprint: string,
  request: ResumeExpertSessionOptions,
): ValidDefinitionMigration | undefined {
  const migration = request.definitionMigration;
  if (migration === undefined) return undefined;
  if (migration.reason.trim() === "") return undefined;
  if (record.expertId !== migration.previousExpertId) return undefined;
  const rootContext = record.contexts[record.rootContextId];
  if (rootContext === undefined) return undefined;
  const rootExpert = isExpertTeam(expert) ? expert.coordinator : expert;
  const previousRootExpertId = migration.previousRootExpertId ?? migration.previousExpertId;
  if (rootContext.expert.id !== previousRootExpertId) return undefined;
  if (
    record.expertId === expert.id &&
    rootContext.expert.id === rootExpert.id &&
    record.definitionFingerprint !== currentFingerprint
  ) {
    return undefined;
  }
  return {
    previousExpertId: migration.previousExpertId,
    previousRootExpertId,
    reason: migration.reason,
  };
}

async function interruptRecoveringExecution(
  store: ExecutionStore,
  executionId: string,
): Promise<void> {
  while (true) {
    const execution = await store.get(executionId);
    if (execution === undefined || isFinal(execution.status)) return;
    const invocations = (await store.listInvocations(executionId)).filter(
      (invocation) => !isFinal(invocation.status),
    );
    const interruptedInvocationIds = new Set(
      invocations.map((invocation) => invocation.invocationId),
    );
    const agentPatches = (await store.listAgents(executionId))
      .filter(
        (agent) =>
          agent.activeInvocationId !== undefined &&
          interruptedInvocationIds.has(agent.activeInvocationId),
      )
      .map((agent) => ({
        agentId: agent.agentId,
        patch: { activeInvocationId: undefined },
      }));
    try {
      await store.commit({
        commitId: `session-recovery-interrupted:${executionId}`,
        executionId,
        expectedVersion: execution.version,
        executionPatch: { status: "interrupted" },
        invocationPatches: invocations.map((invocation) => ({
          invocationId: invocation.invocationId,
          patch: {
            status: "interrupted",
            waitReason: undefined,
            pendingExpertMessages: [],
          },
        })),
        agentPatches,
        events: invocations.flatMap((invocation) =>
          invocation.pendingExpertMessages.length === 0
            ? []
            : [
                {
                  invocationId: invocation.invocationId,
                  type: "expert.message.consumed",
                  data: {
                    messageIds: invocation.pendingExpertMessages.map(
                      (message) => message.messageId,
                    ),
                    terminalReason: "interrupted",
                  },
                },
              ],
        ),
      });
      return;
    } catch (error) {
      if (error instanceof ExecutionVersionConflictError) continue;
      if (error instanceof ExecutionFinalStatusConflictError) return;
      throw error;
    }
  }
}

export class ExpertSessionManager {
  private readonly active = new Map<string, ExpertSessionImpl>();

  constructor(private readonly dependencies: ExpertSessionManagerDependencies) {}

  async createSession(
    expert: ExpertDefinition,
    options: CreateExpertSessionOptions = {},
  ): Promise<ExpertSession> {
    const sessionId = options.sessionId ?? randomUUID();
    const now = new Date().toISOString();
    const rootExpert = isExpertTeam(expert) ? expert.coordinator : expert;
    const requestedModelSelection = options.modelSelection ?? rootExpert.models?.default;
    const runtime = await this.dependencies.runtimes.bind({
      runtimeId: options.runtime ?? rootExpert.defaultRuntimeId,
      modelSelection: requestedModelSelection,
    });
    const modelSelection = requestedModelSelection;
    const rootContextId = randomUUID();
    const rootContext = createRuntimeContextRecord({
      contextId: rootContextId,
      owner: { type: "expert-session", ownerId: sessionId },
      origin: { type: "expert-session", sessionId },
      expert: { id: rootExpert.id },
      runtime: runtime.binding,
      modelSelection,
      now,
    });
    await this.dependencies.sessions.create({
      schemaVersion: "pragma.expert-session/v7",
      sessionId,
      expertId: expert.id,
      definitionFingerprint: fingerprintExpertExecutionDefinition(expert),
      status: "open",
      queuedRequestIds: [],
      executionIds: [],
      rootContextId,
      contexts: { [rootContextId]: rootContext },
      createdAt: now,
      updatedAt: now,
    });
    const claimId = randomUUID();
    if (
      !(await this.dependencies.sessions.claimLease(sessionId, claimId, EXPERT_SESSION_LEASE_MS))
    ) {
      throw new Error(`ExpertSession lease could not be acquired: ${sessionId}`);
    }
    const leaseExpiresAt = Date.now() + EXPERT_SESSION_LEASE_MS;
    const session = this.createActiveSession(
      expert,
      sessionId,
      false,
      claimId,
      leaseExpiresAt,
      undefined,
      [],
      options.environment,
    );
    this.active.set(sessionId, session);
    return session;
  }

  async resumeSession(
    expert: ExpertDefinition,
    request: ResumeExpertSessionOptions,
  ): Promise<ExpertSession> {
    const existing = this.active.get(request.sessionId);
    if (existing !== undefined) {
      if (!existing.hasLeaseFailure()) return existing;
      await existing.waitForLeaseFailureCleanup();
    }
    let record = await this.dependencies.sessions.get(request.sessionId);
    if (record === undefined) throw new Error(`ExpertSession not found: ${request.sessionId}`);
    if (record.status === "closed")
      throw new Error(`ExpertSession is closed: ${request.sessionId}`);
    const currentFingerprint = fingerprintExpertExecutionDefinition(expert);
    const definitionMatches =
      record.expertId === expert.id && record.definitionFingerprint === currentFingerprint;
    const rootExpert = isExpertTeam(expert) ? expert.coordinator : expert;
    const migration = definitionMatches
      ? undefined
      : validateDefinitionMigration(record, expert, currentFingerprint, request);
    if (!definitionMatches && migration === undefined) {
      throw new ExpertDefinitionMismatchError(request.sessionId);
    }
    const claimId = randomUUID();
    if (
      !(await this.dependencies.sessions.claimLease(
        request.sessionId,
        claimId,
        EXPERT_SESSION_LEASE_MS,
      ))
    ) {
      throw new Error(`ExpertSession is active in another process: ${request.sessionId}`);
    }
    try {
      if (migration !== undefined) {
        record = await this.migrateSessionDefinition({
          sessionId: request.sessionId,
          claimId,
          expertId: expert.id,
          rootExpertId: rootExpert.id,
          definitionFingerprint: currentFingerprint,
          previousExpertId: migration.previousExpertId,
          previousRootExpertId: migration.previousRootExpertId,
          reason: migration.reason,
        });
      }
      let recoveredExecutionId: string | undefined;
      let recoveredHumanInteractionIds: readonly string[] = [];
      let recoveryCandidateId = record.activeExecutionId;
      if (recoveryCandidateId === undefined) {
        const prompts = await this.dependencies.sessions.listPrompts(request.sessionId);
        for (const prompt of prompts.toReversed()) {
          if (prompt.mode !== "enqueue" || !["queued", "running"].includes(prompt.status)) {
            continue;
          }
          const candidate = await this.dependencies.executions.get(prompt.executionId);
          if (
            candidate !== undefined &&
            !isFinal(candidate.status) &&
            (
              await listPendingHumanInteractionIds(
                this.dependencies.executions,
                candidate.executionId,
              )
            ).length > 0
          ) {
            recoveryCandidateId = candidate.executionId;
            break;
          }
        }
      }
      if (recoveryCandidateId !== undefined) {
        const execution = await this.dependencies.executions.get(recoveryCandidateId);
        const pendingHumanInteractionIds =
          execution === undefined || isFinal(execution.status)
            ? []
            : await listPendingHumanInteractionIds(
                this.dependencies.executions,
                execution.executionId,
              );
        const recoverPendingInteraction =
          execution !== undefined &&
          !isFinal(execution.status) &&
          pendingHumanInteractionIds.length > 0;
        if (recoverPendingInteraction) {
          recoveredExecutionId = execution.executionId;
          recoveredHumanInteractionIds = pendingHumanInteractionIds;
          const invocations = await this.dependencies.executions.listInvocations(
            execution.executionId,
          );
          await this.dependencies.executions.commit({
            commitId: `human-recovery-waiting:${execution.executionId}:${execution.version}`,
            executionId: execution.executionId,
            expectedVersion: execution.version,
            executionPatch: { status: "waiting" },
            invocationPatches: invocations
              .filter((invocation) => !isFinal(invocation.status))
              .map((invocation) => ({
                invocationId: invocation.invocationId,
                patch: { status: "waiting", waitReason: "human_input" },
              })),
          });
          await this.dependencies.sessions.transact(
            request.sessionId,
            ({ session, prompts }) => ({
              result: undefined,
              session: {
                ...session,
                activeExecutionId: undefined,
                queuedRequestIds: [
                  ...new Set([
                    ...session.queuedRequestIds,
                    ...prompts
                      .filter((prompt) => prompt.executionId === execution.executionId)
                      .map((prompt) => prompt.requestId),
                  ]),
                ],
                updatedAt: new Date().toISOString(),
              },
              prompts: prompts.map((prompt) =>
                prompt.executionId === execution.executionId && prompt.status === "running"
                  ? {
                      ...prompt,
                      purpose: "human_checkpoint_recovery" as const,
                      status: "queued" as const,
                      updatedAt: new Date().toISOString(),
                    }
                  : prompt,
              ),
            }),
            claimId,
          );
        } else {
          const activeExecutionId = recoveryCandidateId;
          if (execution !== undefined && !isFinal(execution.status)) {
            await interruptRecoveringExecution(this.dependencies.executions, execution.executionId);
          }
          await this.dependencies.sessions.transact(
            request.sessionId,
            ({ session, prompts }) => ({
              result: undefined,
              session: {
                ...session,
                activeExecutionId: undefined,
                lastStatus: "interrupted",
                updatedAt: new Date().toISOString(),
              },
              prompts: prompts.map((prompt) =>
                prompt.executionId === activeExecutionId && prompt.status === "running"
                  ? {
                      ...prompt,
                      status: "interrupted" as const,
                      updatedAt: new Date().toISOString(),
                    }
                  : prompt,
              ),
            }),
            claimId,
          );
        }
      }
      if (
        !(await this.dependencies.sessions.claimLease(
          request.sessionId,
          claimId,
          EXPERT_SESSION_LEASE_MS,
        ))
      ) {
        throw new Error(`ExpertSession lease was lost during recovery: ${request.sessionId}`);
      }
      const activationLeaseExpiresAt = Date.now() + EXPERT_SESSION_LEASE_MS;
      const session = this.createActiveSession(
        expert,
        request.sessionId,
        true,
        claimId,
        activationLeaseExpiresAt,
        recoveredExecutionId,
        recoveredHumanInteractionIds,
        request.environment,
      );
      await session.recoverPendingQueueSteers();
      if (session.hasLeaseFailure()) {
        await session.waitForLeaseFailureCleanup();
        throw new Error(`ExpertSession lease was lost during recovery: ${request.sessionId}`);
      }
      this.active.set(request.sessionId, session);
      return session;
    } catch (error) {
      await this.dependencies.sessions.releaseLease(request.sessionId, claimId);
      throw error;
    }
  }

  async recoverClosedSession(
    expert: ExpertDefinition,
    request: RecoverClosedExpertSessionOptions,
  ): Promise<ExpertSession> {
    const existing = this.active.get(request.sessionId);
    if (existing !== undefined) {
      if (!existing.hasLeaseFailure()) return existing;
      await existing.waitForLeaseFailureCleanup();
    }
    if (request.reason.trim() === "") {
      throw new Error("Closed ExpertSession recovery requires a reason.");
    }
    const record = await this.dependencies.sessions.get(request.sessionId);
    if (record === undefined) throw new Error(`ExpertSession not found: ${request.sessionId}`);
    if (record.status !== "closed") {
      throw new Error(`ExpertSession is not closed: ${request.sessionId}`);
    }
    const currentFingerprint = fingerprintExpertExecutionDefinition(expert);
    const definitionMatches =
      record.expertId === expert.id && record.definitionFingerprint === currentFingerprint;
    const rootExpert = isExpertTeam(expert) ? expert.coordinator : expert;
    const migration = definitionMatches
      ? undefined
      : validateDefinitionMigration(record, expert, currentFingerprint, request);
    if (!definitionMatches && migration === undefined) {
      throw new ExpertDefinitionMismatchError(request.sessionId);
    }
    const claimId = randomUUID();
    const recovered = await this.dependencies.sessions.recoverClosed({
      sessionId: request.sessionId,
      expectedUpdatedAt: record.updatedAt,
      claimId,
      leaseMs: EXPERT_SESSION_LEASE_MS,
      reason: request.reason,
    });
    if (recovered === undefined) {
      throw new Error(`ExpertSession recovery conflict: ${request.sessionId}`);
    }
    try {
      if (migration !== undefined) {
        await this.migrateSessionDefinition({
          sessionId: request.sessionId,
          claimId,
          expertId: expert.id,
          rootExpertId: rootExpert.id,
          definitionFingerprint: currentFingerprint,
          previousExpertId: migration.previousExpertId,
          previousRootExpertId: migration.previousRootExpertId,
          reason: migration.reason,
        });
      }
      if (
        !(await this.dependencies.sessions.claimLease(
          request.sessionId,
          claimId,
          EXPERT_SESSION_LEASE_MS,
        ))
      ) {
        throw new Error(`ExpertSession lease was lost during recovery: ${request.sessionId}`);
      }
      const activationLeaseExpiresAt = Date.now() + EXPERT_SESSION_LEASE_MS;
      const session = this.createActiveSession(
        expert,
        request.sessionId,
        true,
        claimId,
        activationLeaseExpiresAt,
        undefined,
        [],
        request.environment,
      );
      this.active.set(request.sessionId, session);
      return session;
    } catch (error) {
      await this.dependencies.sessions.releaseLease(request.sessionId, claimId);
      throw error;
    }
  }

  private async migrateSessionDefinition(options: {
    readonly sessionId: string;
    readonly claimId: string;
    readonly expertId: string;
    readonly rootExpertId: string;
    readonly definitionFingerprint: string;
    readonly previousExpertId: string;
    readonly previousRootExpertId: string;
    readonly reason: string;
  }): Promise<ExpertSessionRecord> {
    return await this.dependencies.sessions.transact(
      options.sessionId,
      async ({ session, prompts }) => {
        const rootContext = session.contexts[session.rootContextId];
        if (rootContext === undefined) throw new Error("ExpertSession root Context is missing.");
        if (
          session.expertId !== options.previousExpertId ||
          rootContext.expert.id !== options.previousRootExpertId
        ) {
          throw new ExpertDefinitionMismatchError(options.sessionId);
        }
        const now = new Date().toISOString();
        if (rootContext.snapshot !== undefined) {
          const paths = new PragmaPaths({ pragmaHome: this.dependencies.pragmaHome });
          await rebindRuntimeSessionExpertId({
            paths,
            ownerId: options.sessionId,
            systemSessionId: rootContext.snapshot.systemSessionId,
            fromExpertId: options.previousRootExpertId,
            toExpertId: options.rootExpertId,
          });
        }
        const migrated: ExpertSessionRecord = {
          ...session,
          expertId: options.expertId,
          definitionFingerprint: options.definitionFingerprint,
          contexts: {
            ...session.contexts,
            [session.rootContextId]: {
              ...rootContext,
              expert: { id: options.rootExpertId },
              updatedAt: now,
            },
          },
          updatedAt: now,
        };
        return {
          result: migrated,
          session: migrated,
          prompts,
        };
      },
      options.claimId,
    );
  }

  private createActiveSession(
    expert: ExpertDefinition,
    sessionId: string,
    paused: boolean,
    claimId: string,
    leaseExpiresAt: number,
    recoveredExecutionId?: string,
    recoveredHumanInteractionIds: readonly string[] = [],
    environment?: ExecutionEnvironmentSnapshot,
  ): ExpertSessionImpl {
    const session = new ExpertSessionImpl(
      expert,
      this.dependencies,
      sessionId,
      paused,
      claimId,
      leaseExpiresAt,
      recoveredExecutionId,
      recoveredHumanInteractionIds,
      environment,
      () => {
        if (this.active.get(sessionId) === session) {
          this.active.delete(sessionId);
        }
      },
    );
    return session;
  }
}

class ExpertSessionImpl implements ExpertSession {
  private readonly ownedSessions: Pick<ExpertSessionStore, "enqueue" | "transact" | "appendEvent">;
  private controller: ExecutionController | undefined;
  private processing: Promise<void> | undefined;
  private processingGeneration = 0;
  private readonly runtimeSessions = new RuntimeSessionPool();
  private readonly queueSteersInFlight = new Set<string>();
  private readonly strictSteersInFlight = new Map<
    string,
    { readonly content: string; readonly delivery: Promise<ExpertTurn> }
  >();
  private stopPromise: Promise<void> | undefined;
  private deletionFrozen = false;
  private closePromise: Promise<void> | undefined;
  private terminalReleasePromise: Promise<void> | undefined;
  private humanCheckpointReleasePromise: Promise<void> | undefined;
  private resourcesReleasing = false;
  private terminalReleaseRequested = false;
  private readonly promptAdmissions = new Set<Promise<ExpertTurn>>();
  private readonly completions = new Map<string, Promise<ExecutionRecord>>();
  private readonly settlements = new Map<
    string,
    {
      readonly promise: Promise<void>;
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  private readonly recoveredHumanInteractionIds: readonly string[];
  private waitingForRecoveredHumanInput: boolean;
  private leaseRenewalTask: Promise<void> | undefined;
  private leaseFailureTask: Promise<void> | undefined;
  private leaseError: Error | undefined;
  private leaseExpiresAt: number;
  private leaseRenewalStopped = false;
  private readonly leaseRenewal: ReturnType<typeof setInterval>;

  constructor(
    readonly expert: ExpertDefinition,
    private readonly dependencies: ExpertSessionManagerDependencies,
    readonly sessionId: string,
    private paused: boolean,
    private readonly claimId: string,
    leaseExpiresAt: number,
    private readonly recoveredExecutionId: string | undefined,
    recoveredHumanInteractionIds: readonly string[],
    private readonly environment: ExecutionEnvironmentSnapshot | undefined,
    private readonly onClosed: () => void,
  ) {
    this.leaseExpiresAt = leaseExpiresAt;
    this.recoveredHumanInteractionIds = recoveredHumanInteractionIds;
    this.waitingForRecoveredHumanInput = recoveredHumanInteractionIds.length > 0;
    this.ownedSessions = {
      enqueue: (transaction) => this.dependencies.sessions.enqueue(transaction, this.claimId),
      transact: async <T>(sessionId: string, action: ExpertSessionTransactionAction<T>) => {
        let committed:
          { session: ExpertSessionRecord; prompts: readonly PromptRequest[] } | undefined;
        const result = await this.dependencies.sessions.transact(
          sessionId,
          async (snapshot) => {
            const next = await action(snapshot);
            committed = next;
            return next;
          },
          this.claimId,
        );
        if (committed !== undefined) this.notifySettled(committed.session, committed.prompts);
        return result;
      },
      appendEvent: (sessionId: string, event: ExpertSessionEventInput) =>
        this.dependencies.sessions.appendEvent(sessionId, event, this.claimId),
    };
    this.leaseRenewal = setInterval(() => {
      if (this.leaseRenewalTask === undefined) {
        this.leaseRenewalTask = this.renewLease().finally(() => {
          this.leaseRenewalTask = undefined;
        });
      }
    }, EXPERT_SESSION_LEASE_RENEWAL_MS);
    this.leaseRenewal.unref();
  }

  hasLeaseFailure(): boolean {
    return this.leaseError !== undefined;
  }

  async waitForLeaseFailureCleanup(): Promise<void> {
    await this.leaseFailureTask;
  }

  async prompt(content: string, options: PromptOptions = {}): Promise<ExpertTurn> {
    const admission = this.promptInternal(content, options);
    this.promptAdmissions.add(admission);
    try {
      return await admission;
    } finally {
      this.promptAdmissions.delete(admission);
    }
  }

  private async promptInternal(content: string, options: PromptOptions): Promise<ExpertTurn> {
    if (this.leaseError !== undefined) throw this.leaseError;
    if (this.resourcesReleasing || this.terminalReleaseRequested) {
      throw new Error(`ExpertSession resources are being released: ${this.sessionId}`);
    }
    if (this.closePromise !== undefined || this.stopPromise !== undefined || this.deletionFrozen) {
      throw new Error(`ExpertSession is closing or closed: ${this.sessionId}`);
    }
    if (content.trim() === "") throw new Error("Prompt content must not be empty.");
    const requestId = options.requestId ?? randomUUID();
    if (requestId.trim() === "") throw new Error("Prompt requestId must not be empty.");
    const mode = options.mode ?? "enqueue";

    if (mode === "steer") {
      if (options.steerFallback === "enqueue") {
        const previous = (await this.getPromptQueue()).find(
          (prompt) => prompt.requestId === requestId,
        );
        if (
          previous?.mode === "steer" &&
          previous.status === "failed" &&
          previous.deliveryAttempt?.state === "not_dispatched"
        ) {
          if (previous.content !== content) {
            throw new Error(`Prompt idempotency conflict: ${requestId}`);
          }
          // Resume the durable fallback after a crash without attempting native delivery again.
          return await this.fallbackToEnqueue(
            content,
            requestId,
            options,
            new Error(previous.error ?? `Steer was not dispatched: ${requestId}`),
          );
        }
      }
      if (options.modelSelection !== undefined) {
        const error = new Error(
          "A steer request cannot change the active Runtime model selection.",
        );
        if (options.steerFallback !== "enqueue") throw error;
        return await this.fallbackToEnqueue(content, requestId, options, error);
      }
      if ((options.attachments?.length ?? 0) > 0) {
        const error = new Error("A steer request cannot add prompt attachments.");
        if (options.steerFallback !== "enqueue") throw error;
        return await this.fallbackToEnqueue(content, requestId, options, error);
      }
      try {
        return await this.steer(content, requestId);
      } catch (error) {
        if (options.steerFallback !== "enqueue" || !(error instanceof SteerNotDispatchedError)) {
          throw error;
        }
        return await this.fallbackToEnqueue(content, requestId, options, error);
      }
    }

    return await this.enqueue(content, requestId, options);
  }

  private async fallbackToEnqueue(
    content: string,
    requestId: string,
    options: PromptOptions,
    error: unknown,
  ): Promise<ExpertTurn> {
    const fallbackReason = readErrorMessage(error);
    return await this.enqueue(content, requestId, options, fallbackReason);
  }

  private async enqueue(
    content: string,
    requestId: string,
    options: PromptOptions,
    fallbackReason?: string,
  ): Promise<ExpertTurn> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const session = await this.getState();
    const rootContextId = session.rootContextId;
    const modelSelection = options.modelSelection;
    const attachments = ExpertPromptAttachmentSchema.array()
      .max(20)
      .parse(options.attachments ?? []);
    const storedInput = createExpertPromptInput(content, attachments);
    const definitionKind = isExpertTeam(this.expert) ? "expert-team" : "expert";
    const execution: ExecutionRecord = {
      schemaVersion: "pragma.execution/v12",
      executionId: id,
      version: 0,
      kind: "expert-turn",
      definition: { id: this.expert.id, kind: definitionKind },
      rootInvocationId: id,
      status: "queued",
      input: storedInput,
      ...(this.environment === undefined ? {} : { environment: this.environment }),
      state: {},
      lastAppliedSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    const prompt: PromptRequest = {
      requestId,
      sessionId: this.sessionId,
      content,
      purpose: "user",
      mode: "enqueue",
      executionId: id,
      status: "queued",
      ...(modelSelection === undefined ? {} : { modelSelection }),
      createdAt: now,
      updatedAt: now,
    };
    const executionId = await this.ownedSessions.enqueue({
      execution,
      prompt,
      ...(fallbackReason === undefined
        ? {}
        : {
            events: [
              {
                eventId: `prompt-steer-fallback:${requestId}`,
                type: "prompt.steer-fallback",
                data: { requestId, reason: fallbackReason },
                occurredAt: now,
              },
            ],
          }),
      rootInvocation: {
        invocationId: id,
        rootInvocationId: id,
        definition: execution.definition,
        executorId: isExpertTeam(this.expert) ? this.expert.coordinator.id : this.expert.id,
        contextId: rootContextId,
        status: "queued",
        pendingExpertMessages: [],
        input: storedInput,
        createdAt: now,
        updatedAt: now,
      },
    });
    if ((await this.getPromptQueueState()).state !== "paused") {
      this.paused = false;
      this.startProcessing();
    }
    return this.createTurn(
      executionId,
      requestId,
      options.mode ?? "enqueue",
      "enqueue",
      fallbackReason,
    );
  }

  async abort(reason?: string): Promise<void> {
    const controller = this.controller;
    await controller?.cancel(reason);
    await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: { ...session, activeExecutionId: undefined, updatedAt: new Date().toISOString() },
      prompts: prompts.map((prompt) =>
        prompt.executionId === session.activeExecutionId && prompt.status === "running"
          ? { ...prompt, status: "cancelled" as const, updatedAt: new Date().toISOString() }
          : prompt,
      ),
    }));
    if (this.controller === controller) this.controller = undefined;
    this.processingGeneration += 1;
    this.processing = undefined;
    this.paused = false;
    this.startProcessing();
  }

  async abortExecution(executionId: string, reason?: string): Promise<void> {
    const state = await this.getState();
    if (state.activeExecutionId !== undefined && state.activeExecutionId !== executionId) {
      throw new Error(`ExpertTurn changed before interrupt: ${state.activeExecutionId}`);
    }
    if (!state.executionIds.includes(executionId)) {
      throw new Error(`ExpertTurn is not owned by this Session: ${executionId}`);
    }
    if (state.activeExecutionId === executionId && this.controller !== undefined) {
      await this.abort(reason);
      return;
    }
    await this.cancelPersistedExecution(
      executionId,
      reason ?? "Execution interrupted by the Mission controller.",
    );
    await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: {
        ...session,
        activeExecutionId:
          session.activeExecutionId === executionId ? undefined : session.activeExecutionId,
        queuedRequestIds: session.queuedRequestIds.filter(
          (requestId) =>
            prompts.find((prompt) => prompt.requestId === requestId)?.executionId !== executionId,
        ),
        lastStatus: "interrupted" as const,
        updatedAt: new Date().toISOString(),
      },
      prompts: prompts.map((prompt) =>
        prompt.executionId === executionId &&
        (prompt.status === "queued" || prompt.status === "running")
          ? { ...prompt, status: "cancelled" as const, updatedAt: new Date().toISOString() }
          : prompt,
      ),
    }));
  }

  async checkpointWaitingHuman(): Promise<void> {
    const controller = this.controller;
    if (controller === undefined) {
      throw new Error(`ExpertSession has no active human wait: ${this.sessionId}`);
    }
    const previousPaused = this.paused;
    const requestId = await this.markExecutionPromptAsHumanCheckpointRecovery(
      controller.executionId,
    );
    this.paused = true;
    try {
      await controller.checkpointWaitingHuman();
    } catch (error) {
      this.paused = previousPaused;
      await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
        result: undefined,
        session,
        prompts: prompts.map((candidate) =>
          candidate.requestId === requestId &&
          candidate.status === "running" &&
          candidate.purpose === "human_checkpoint_recovery"
            ? { ...candidate, purpose: "user" as const }
            : candidate,
        ),
      }));
      throw error;
    }
    await this.processing;
    this.stopLeaseRenewal();
    await this.dependencies.sessions.releaseLease(this.sessionId, this.claimId);
    this.controller = undefined;
    this.onClosed();
  }

  private async markExecutionPromptAsHumanCheckpointRecovery(executionId: string): Promise<string> {
    return await this.ownedSessions.transact<string>(this.sessionId, ({ session, prompts }) => {
      const prompt = prompts.find(
        (candidate) =>
          candidate.executionId === executionId &&
          candidate.mode === "enqueue" &&
          candidate.status === "running",
      );
      if (prompt === undefined) {
        throw new Error(`ExpertSession has no active human wait prompt: ${this.sessionId}`);
      }
      return {
        result: prompt.requestId,
        session,
        prompts: prompts.map((candidate) =>
          candidate.requestId === prompt.requestId
            ? { ...candidate, purpose: "human_checkpoint_recovery" as const }
            : candidate,
        ),
      };
    });
  }

  releaseAfterHumanCheckpoint(): Promise<void> {
    if (this.humanCheckpointReleasePromise === undefined) {
      this.humanCheckpointReleasePromise = this.releaseAfterHumanCheckpointInternal().catch(
        (error: unknown) => {
          if (!this.resourcesReleasing) this.humanCheckpointReleasePromise = undefined;
          throw error;
        },
      );
    }
    return this.humanCheckpointReleasePromise;
  }

  private async releaseAfterHumanCheckpointInternal(): Promise<void> {
    if (this.closePromise !== undefined || this.stopPromise !== undefined || this.deletionFrozen) {
      throw new Error(`ExpertSession is closing or closed: ${this.sessionId}`);
    }
    if (this.resourcesReleasing) throw new Error("ExpertSession resources are being released.");
    this.resourcesReleasing = true;
    try {
      await Promise.allSettled([...this.promptAdmissions]);
      if (this.controller !== undefined) {
        throw new Error(
          "Checkpoint the active human interaction before releasing the ExpertSession owner.",
        );
      }
      const state = await this.getState();
      if (state.activeExecutionId !== undefined) {
        throw new Error("Wait for the active Expert turn before releasing the human checkpoint.");
      }
    } catch (error) {
      this.resourcesReleasing = false;
      throw new ExpertSessionReleaseBlockedError(error);
    }
    const errors: unknown[] = [];
    this.stopLeaseRenewal();
    try {
      await this.runtimeSessions.clear();
    } catch (error) {
      errors.push(error);
    }
    if (this.leaseRenewalTask !== undefined) {
      try {
        await this.leaseRenewalTask;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.dependencies.sessions.releaseLease(this.sessionId, this.claimId);
    } catch (error) {
      errors.push(error);
    }
    this.onClosed();
    throwCollectedErrors(errors, "ExpertSession human checkpoint release failed.");
  }

  async refreshRuntimeSessions(): Promise<void> {
    const [state, prompts] = await Promise.all([this.getState(), this.getPromptQueue()]);
    if (
      state.activeExecutionId !== undefined ||
      prompts.some((prompt) => prompt.status === "queued" || prompt.status === "running")
    ) {
      throw new Error("Wait for the active Expert turn before changing Runtime permissions.");
    }
    await this.runtimeSessions.clear();
  }

  releaseAfterTerminal(
    options: {
      readonly waitForIdle?: boolean | undefined;
      readonly settlement?: Promise<unknown> | undefined;
    } = {},
  ): Promise<void> {
    if (options.waitForIdle) this.terminalReleaseRequested = true;
    if (this.terminalReleasePromise === undefined) {
      this.terminalReleasePromise = this.releaseTerminalWhenIdle(
        options.waitForIdle === true,
        options.settlement,
      ).catch((error: unknown) => {
        if (!this.resourcesReleasing) this.terminalReleasePromise = undefined;
        throw error;
      });
    }
    return this.terminalReleasePromise;
  }

  private async releaseTerminalWhenIdle(
    waitForIdle: boolean,
    settlement: Promise<unknown> | undefined,
  ): Promise<void> {
    // Host deadlines do not imply that cancellation or Runtime settlement ended.
    // Seal admission immediately, but preserve ownership until those tasks finish.
    if (settlement !== undefined) await Promise.allSettled([settlement]);
    while (true) {
      try {
        await this.releaseAfterTerminalInternal();
        return;
      } catch (error) {
        if (
          !waitForIdle ||
          !(error instanceof ExpertSessionReleaseBlockedError) ||
          !error.retryable
        ) {
          throw error;
        }
        // Cancellation can outlive the Host deadline. Keep admission sealed
        // and retry until the durable turn settles or lease loss is confirmed.
        await new Promise<void>((resolve) => {
          const retry = setTimeout(resolve, 500);
          retry.unref();
        });
      }
    }
  }

  private async releaseAfterTerminalInternal(): Promise<void> {
    if (this.closePromise !== undefined || this.stopPromise !== undefined || this.deletionFrozen) {
      throw new Error(`ExpertSession is closing or closed: ${this.sessionId}`);
    }
    if (this.resourcesReleasing) throw new Error("ExpertSession resources are being released.");
    this.resourcesReleasing = true;
    try {
      // Close admission before reading persisted state. A prompt already admitted
      // must finish enqueueing first, so release cannot overlook its pending turn.
      await Promise.allSettled([...this.promptAdmissions]);
      if (this.leaseError !== undefined) await this.leaseFailureTask;
      const [state, prompts] = await Promise.all([this.getState(), this.getPromptQueue()]);
      if (
        this.leaseError === undefined &&
        (state.activeExecutionId !== undefined ||
          prompts.some((prompt) => prompt.status === "queued" || prompt.status === "running"))
      ) {
        throw new ExpertSessionReleaseBlockedError(
          new Error("Wait for the active Expert turn before releasing terminal resources."),
          true,
        );
      }
    } catch (error) {
      this.resourcesReleasing = false;
      throw error instanceof ExpertSessionReleaseBlockedError
        ? error
        : new ExpertSessionReleaseBlockedError(error);
    }
    // Validation alone must not interrupt an already admitted turn. Seal its
    // execution boundary only once teardown is committed (or explicitly requested).
    this.terminalReleaseRequested = true;
    const errors: unknown[] = [];
    this.stopLeaseRenewal();
    try {
      await this.runtimeSessions.clear();
    } catch (error) {
      errors.push(error);
    }
    if (this.leaseRenewalTask !== undefined) {
      try {
        await this.leaseRenewalTask;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.dependencies.sessions.releaseLease(this.sessionId, this.claimId);
    } catch (error) {
      errors.push(error);
    }
    this.controller = undefined;
    this.onClosed();
    throwCollectedErrors(errors, "ExpertSession terminal resource release failed.");
  }

  async finishDeletion(): Promise<void> {
    await this.runtimeSessions.finishDeletion();
  }

  freezeForDeletion(): void {
    this.deletionFrozen = true;
    this.paused = true;
    this.stopLeaseRenewal();
    this.runtimeSessions.seal();
  }

  stopForDeletion(reason?: string): Promise<void> {
    this.freezeForDeletion();
    if (this.stopPromise === undefined) {
      this.processingGeneration += 1;
      this.processing = undefined;
      const controller = this.controller;
      this.stopPromise = (async () => {
        const results = await Promise.allSettled([
          controller?.cancel(reason),
          this.runtimeSessions.closeForDeletion(),
          this.leaseRenewalTask,
        ]);
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        throwCollectedErrors(errors, "ExpertSession native stop was not confirmed.");
        this.controller = undefined;
      })();
      // A rejected close is retryable; a pending close stays shared after a Host timeout.
      void this.stopPromise.catch(() => {
        this.stopPromise = undefined;
      });
    }
    return this.stopPromise;
  }

  close(reason?: string): Promise<void> {
    if (this.closePromise === undefined) {
      this.paused = true;
      this.stopLeaseRenewal();
      this.runtimeSessions.seal();
      this.closePromise = this.closeInternal(reason);
    }
    return this.closePromise;
  }

  private async closeInternal(reason?: string): Promise<void> {
    const errors: unknown[] = [];
    let stopAttempted = false;
    try {
      const pending = (await this.getPromptQueue()).filter(
        (prompt) => prompt.status === "queued" || prompt.status === "running",
      );
      await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
        result: undefined,
        session: {
          ...session,
          activeExecutionId: undefined,
          queuedRequestIds: [],
          updatedAt: new Date().toISOString(),
        },
        prompts: prompts.map((prompt) =>
          prompt.status === "queued" || prompt.status === "running"
            ? { ...prompt, status: "cancelled" as const, updatedAt: new Date().toISOString() }
            : prompt,
        ),
      }));
      stopAttempted = true;
      await this.stopForDeletion(reason);
      for (const prompt of pending) {
        await this.cancelPersistedExecution(
          prompt.executionId,
          reason ?? "Execution cancelled because the Session closed.",
        );
      }
      const session = await this.getState();
      for (const executionId of session.executionIds) {
        await closeExecutionContexts(this.dependencies.executions, executionId);
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (!stopAttempted) await this.runtimeSessions.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) {
      try {
        await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
          result: undefined,
          session: closeSessionContexts(session),
          prompts,
        }));
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.leaseRenewalTask !== undefined) {
      try {
        await this.leaseRenewalTask;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.dependencies.sessions.releaseLease(this.sessionId, this.claimId);
    } catch (error) {
      errors.push(error);
    }
    this.controller = undefined;
    this.onClosed();
    throwCollectedErrors(errors, "ExpertSession close failed.");
  }

  private async renewLease(): Promise<void> {
    if (this.closePromise !== undefined) return;
    let consecutiveFailures = 0;
    const logger = this.dependencies.loggerProvider.createLogger({
      component: "core.expert-session",
      scope: { expertSessionId: this.sessionId },
    });
    // A timer delayed by sleep or event-loop work must first check the current
    // owner under the store lock. The local timestamp cannot prove lease loss.
    while (!this.leaseRenewalStopped) {
      try {
        const renewed = await this.dependencies.sessions.claimLease(
          this.sessionId,
          this.claimId,
          EXPERT_SESSION_LEASE_MS,
        );
        if (this.leaseRenewalStopped) return;
        if (!renewed) {
          await this.failLease(new Error(`ExpertSession lease was lost: ${this.sessionId}`));
          return;
        }
        this.leaseExpiresAt = Date.now() + EXPERT_SESSION_LEASE_MS;
        return;
      } catch (error) {
        if (this.leaseRenewalStopped) return;
        if (!isRetryableStorageContentionError(error)) {
          await this.failLease(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures === 1 || consecutiveFailures % 30 === 0) {
          logger.warn(
            "expert_session.lease_renewal_delayed",
            "ExpertSession heartbeat will retry; task execution has no lease-duration limit.",
            {
              error,
              consecutiveFailures,
              leaseExpiresAt: new Date(this.leaseExpiresAt).toISOString(),
              reasonCode: "EXPERT_SESSION_LEASE_RENEWAL_DELAYED",
              retryable: true,
            },
          );
        }
        await new Promise<void>((resolve) => {
          const retry = setTimeout(resolve, EXPERT_SESSION_LEASE_RETRY_MS);
          retry.unref();
        });
      }
    }
  }

  private async failLease(error: Error): Promise<void> {
    if (this.leaseError !== undefined) {
      await this.leaseFailureTask;
      return;
    }
    this.leaseError = error;
    for (const settlement of this.settlements.values()) settlement.reject(error);
    this.dependencies.loggerProvider
      .createLogger({
        component: "core.expert-session",
        scope: { expertSessionId: this.sessionId },
      })
      .error(
        "expert_session.lease_lost",
        "ExpertSession ownership could not be retained; local execution will stop.",
        error,
        {
          reasonCode: "EXPERT_SESSION_LEASE_LOST",
          leaseExpiresAt: new Date(this.leaseExpiresAt).toISOString(),
        },
      );
    this.paused = true;
    this.stopLeaseRenewal();
    this.leaseFailureTask = this.finishLeaseLoss(error);
    await this.leaseFailureTask;
  }

  private async finishLeaseLoss(error: Error): Promise<void> {
    try {
      await this.controller?.cancel(error.message).catch(() => undefined);
      await this.waitForProcessingShutdown();
      await this.runtimeSessions.clear().catch(() => undefined);
      await this.dependencies.sessions
        .releaseLease(this.sessionId, this.claimId)
        .catch(() => undefined);
    } finally {
      this.onClosed();
    }
  }

  private async waitForProcessingShutdown(): Promise<void> {
    const processing = this.processing;
    if (processing === undefined) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        processing.catch(() => undefined),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, EXPERT_SESSION_LEASE_FAILURE_DRAIN_MS);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private stopLeaseRenewal(): void {
    this.leaseRenewalStopped = true;
    clearInterval(this.leaseRenewal);
  }

  async getState(): Promise<ExpertSessionRecord> {
    const state = await this.dependencies.sessions.get(this.sessionId);
    if (state === undefined) throw new Error(`ExpertSession not found: ${this.sessionId}`);
    return state;
  }

  async listTurns(): Promise<readonly ExpertTurn[]> {
    const [session, prompts] = await Promise.all([this.getState(), this.getPromptQueue()]);
    const requestIds = new Map(
      prompts
        .filter((prompt) => prompt.mode === "enqueue")
        .map((prompt) => [prompt.executionId, prompt.requestId]),
    );
    return session.executionIds.map((executionId) => {
      const requestId = requestIds.get(executionId);
      if (requestId === undefined) {
        throw new Error(`ExpertTurn prompt is missing: ${executionId}`);
      }
      return this.createTurn(executionId, requestId);
    });
  }

  async getMessageHistory(
    options: GetMessageHistoryOptions = {},
  ): Promise<readonly ExpertMessageHistory[]> {
    const session = await this.getState();
    const invocations = (
      await Promise.all(
        session.executionIds.map(
          async (executionId) =>
            await this.createExecutionView(executionId).getMessageHistory(options),
        ),
      )
    ).flat();
    const groups = new Map<string, typeof invocations>();
    for (const invocation of invocations) {
      const key = `${invocation.executorId ?? ""}\u0000${invocation.contextId}`;
      groups.set(key, [...(groups.get(key) ?? []), invocation]);
    }
    return [...groups.values()].map((group) =>
      ExpertMessageHistorySchema.parse({
        executorId: group[0]?.executorId,
        contextId: group[0]!.contextId,
        invocations: group,
      }),
    );
  }

  async listEvents(options: ListSessionEventsOptions = {}): Promise<SessionEventPage> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Session event limit must be an integer between 1 and 1000.");
    }
    const session = await this.getState();
    const executionEvents = (
      await Promise.all(
        session.executionIds.map(async (executionId) => {
          const view = this.createExecutionView(executionId);
          const items: ExecutionEvent[] = [];
          let after: ExecutionCursor | undefined;
          do {
            const page = await view.listEvents({ scope: options.scope, limit: 1_000, after });
            items.push(...page.items);
            after = page.nextCursor;
          } while (after !== undefined);
          return items;
        }),
      )
    ).flat();
    const events = [
      ...(await this.dependencies.sessions.listEvents(this.sessionId)),
      ...executionEvents,
    ].sort((left, right) => {
      const occurredAt = left.occurredAt.localeCompare(right.occurredAt);
      if (occurredAt !== 0) return occurredAt;
      if ("sessionId" in left.cursor && "sessionId" in right.cursor) {
        return left.cursor.sequence - right.cursor.sequence;
      }
      return left.eventId.localeCompare(right.eventId);
    });
    const offset = options.after?.offset ?? 0;
    const items = events.slice(offset, offset + limit);
    return {
      items,
      ...(offset + items.length < events.length
        ? { nextCursor: { offset: offset + items.length } }
        : {}),
    };
  }

  async getUsage(): Promise<AgentMessageUsage | undefined> {
    const session = await this.getState();
    const executions = await Promise.all(
      session.executionIds.map(
        async (executionId) => await this.dependencies.executions.get(executionId),
      ),
    );
    return mergeUsages(executions.map((execution) => execution?.usage));
  }

  async getRootContextWindowUsage(): Promise<RuntimeContextWindowUsage | undefined> {
    const context = await this.getRootContext();
    const identity = {
      contextId: context.contextId,
      expertId: context.expert.id,
      runtime: context.runtime,
    };
    const active = this.runtimeSessions.get(identity);
    if (active?.contextWindow !== undefined) {
      return await active.contextWindow.inspect();
    }
    if (context.snapshot === undefined) return undefined;
    const paths = new PragmaPaths({ pragmaHome: this.dependencies.pragmaHome });
    const record = await readRuntimeSessionRecord(
      paths,
      this.sessionId,
      context.snapshot.systemSessionId,
    );
    return readRuntimeSessionContextWindowUsage(record);
  }

  async canCompactRootContext(): Promise<boolean | undefined> {
    const context = await this.getRootContext();
    const identity = {
      contextId: context.contextId,
      expertId: context.expert.id,
      runtime: context.runtime,
    };
    const active = this.runtimeSessions.get(identity);
    return active?.contextWindow === undefined
      ? undefined
      : await active.contextWindow.canCompact();
  }

  async compactRootContext(): Promise<RuntimeContextWindowUsage | undefined> {
    if (this.leaseError !== undefined) throw this.leaseError;
    if (this.closePromise !== undefined || this.stopPromise !== undefined || this.deletionFrozen) {
      throw new Error(`ExpertSession is closing or closed: ${this.sessionId}`);
    }
    const [state, prompts] = await Promise.all([this.getState(), this.getPromptQueue()]);
    if (
      state.activeExecutionId !== undefined ||
      prompts.some((prompt) => prompt.status === "queued" || prompt.status === "running")
    ) {
      throw new Error("Wait for the active Expert turn before compacting its context.");
    }
    const context = await this.getRootContext(state);
    if (context.snapshot === undefined) {
      throw new Error("The root Runtime context has not started yet.");
    }
    const identity = {
      contextId: context.contextId,
      expertId: context.expert.id,
      runtime: context.runtime,
    };
    const active = this.runtimeSessions.get(identity);
    if (active !== undefined) {
      if (active.contextWindow?.compact === undefined) {
        throw new Error(
          `Runtime ${context.runtime.runtimeId} does not support context compaction.`,
        );
      }
      if (!(await active.contextWindow.canCompact())) {
        throw new RuntimeContextCompactionNotNeededError();
      }
      return await active.contextWindow.compact();
    }

    const resolved = await this.dependencies.runtimes.resolve({
      binding: context.runtime,
      modelSelection: context.modelSelection,
    });
    if (!resolved.adapter.descriptor.capabilities?.supportsManualCompaction) {
      throw new Error(`Runtime ${context.runtime.runtimeId} does not support context compaction.`);
    }
    const rootExpert = isExpertTeam(this.expert) ? this.expert.coordinator : this.expert;
    const opened = await openRuntimeSession(resolved.adapter, {
      agent: rootExpert,
      owner: {
        type: "expert-session",
        ownerId: this.sessionId,
        contextId: context.contextId,
      },
      pragmaHome: this.dependencies.pragmaHome,
      systemSessionId: context.snapshot.systemSessionId,
      runtimeSession: context.snapshot.runtimeSession,
      modelSelection: context.modelSelection,
      loggerProvider: this.dependencies.loggerProvider.withScope({
        expertSessionId: this.sessionId,
        contextId: context.contextId,
      }),
    });
    try {
      if (opened.contextWindow?.compact === undefined) {
        throw new Error(
          `Runtime ${context.runtime.runtimeId} does not support context compaction.`,
        );
      }
      if (!(await opened.contextWindow.canCompact())) {
        throw new RuntimeContextCompactionNotNeededError();
      }
      return await opened.contextWindow.compact();
    } finally {
      await opened.close();
    }
  }

  async getPromptQueue(): Promise<readonly PromptRequest[]> {
    return await this.dependencies.sessions.listPrompts(this.sessionId);
  }

  async getPromptQueueState(): Promise<PromptQueueState> {
    const [session, prompts, events] = await Promise.all([
      this.getState(),
      this.getPromptQueue(),
      this.dependencies.sessions.listEvents(this.sessionId),
    ]);
    const pending = prompts.filter(
      (prompt) =>
        prompt.purpose === "user" &&
        prompt.mode === "enqueue" &&
        (prompt.status === "queued" || prompt.status === "running"),
    );
    const lastControl = [...events]
      .reverse()
      .find((event) =>
        ["prompt.queue-paused", "prompt.queue-resumed", "prompt.queue-cleared"].includes(
          event.type,
        ),
      );
    const uncertain = pending.find(
      (prompt) => prompt.status === "queued" && prompt.deliveryAttempt?.state === "uncertain",
    );
    const paused =
      hasUncertainSteerDelivery(prompts) ||
      (lastControl?.type === "prompt.queue-paused" &&
        pending.some((prompt) => prompt.status === "queued"));
    const pausedRequestId =
      uncertain?.requestId ?? (lastControl?.data as { requestId?: unknown } | undefined)?.requestId;
    return {
      state: paused
        ? "paused"
        : session.activeExecutionId !== undefined || pending.length > 0
          ? "running"
          : "idle",
      pendingCount: pending.length,
      ...(paused && typeof pausedRequestId === "string"
        ? { pausedAfterRequestId: pausedRequestId }
        : {}),
    };
  }

  private queueRecoveryInFlight = false;

  async resumePromptQueue(
    options: { readonly recovery?: "abandon" | undefined } = {},
  ): Promise<void> {
    if (this.queueRecoveryInFlight)
      throw new SteerDeliveryUncertainError("Queue delivery recovery is already in progress.");
    this.queueRecoveryInFlight = true;
    try {
      await this.resumePromptQueueInternal(options);
    } finally {
      this.queueRecoveryInFlight = false;
    }
  }

  private async resumePromptQueueInternal(options: {
    readonly recovery?: "abandon" | undefined;
  }): Promise<void> {
    const recoveredAbandonment = await this.cancelAbandonedSteerExecutions(
      await this.getPromptQueue(),
    );
    if ((await this.getPromptQueueState()).state !== "paused" && !recoveredAbandonment) return;
    const uncertain = (await this.getPromptQueue()).filter(
      (prompt) => prompt.status !== "cancelled" && prompt.deliveryAttempt?.state === "uncertain",
    );
    if (uncertain.length > 0) {
      if (options.recovery === "abandon") await this.abandonQueuedSteers(uncertain);
      else await this.reconcileQueuedSteers(uncertain);
    }
    if (hasUnresolvedSteerDelivery(await this.getPromptQueue())) {
      throw new SteerDeliveryUncertainError(
        "Steer delivery is still uncertain; the queue remains paused.",
      );
    }
    await this.ownedSessions.appendEvent(this.sessionId, {
      eventId: `prompt-queue-resumed:${randomUUID()}`,
      type: "prompt.queue-resumed",
      data: {},
    });
    this.paused = false;
    this.startProcessing();
  }

  private async abandonQueuedSteers(prompts: readonly PromptRequest[]): Promise<void> {
    const state = await this.getState();
    if (state.activeExecutionId !== undefined || this.queueSteersInFlight.size > 0)
      throw new SteerDeliveryUncertainError(
        "Wait for the active execution and steer admission to settle before abandoning delivery.",
      );
    this.paused = true;
    // A successful close is required. Never unpause while a live managed native Session remains.
    await this.runtimeSessions.clear();
    const requestIds = new Set(prompts.map((prompt) => prompt.requestId));
    const updatedAt = new Date().toISOString();
    // Cancel uncertain prompts and detach the old native identity in one durable transaction.
    // A crash before this write leaves the fence intact; after it, no restart can restore
    // the old conversation or dispatch an abandoned prompt.
    await this.ownedSessions.transact(this.sessionId, ({ session, prompts: current }) => {
      if (session.activeExecutionId !== undefined || this.queueSteersInFlight.size > 0)
        throw new SteerDeliveryUncertainError(
          "Steer recovery target changed; the queue remains paused.",
        );
      const context = session.contexts[session.rootContextId];
      if (context === undefined) throw new Error("ExpertSession root Context is missing.");
      return {
        result: undefined,
        session: {
          ...session,
          queuedRequestIds: session.queuedRequestIds.filter((id) => !requestIds.has(id)),
          contexts: {
            ...session.contexts,
            [session.rootContextId]: { ...context, snapshot: undefined, updatedAt },
          },
          updatedAt,
        },
        prompts: current.map((prompt) =>
          requestIds.has(prompt.requestId) && prompt.deliveryAttempt?.state === "uncertain"
            ? {
                ...prompt,
                status: "cancelled" as const,
                error:
                  "Steer delivery abandoned without replay; prior operations may already have executed.",
                updatedAt,
              }
            : prompt,
        ),
      };
    });
    // Source Executions must remain runnable until the abandonment decision is durable.
    // Cancelled attempts are the durable cleanup intent, so a retry/restart can finish
    // cancellation if the process stops between the aggregate write and this cleanup.
    await this.cancelAbandonedSteerExecutions(await this.getPromptQueue());
    await this.ownedSessions.appendEvent(this.sessionId, {
      eventId: `prompt-steer-abandoned:${randomUUID()}`,
      type: "prompt.steer-abandoned",
      data: {
        requestIds: [...requestIds],
        runtimeSnapshot: state.contexts[state.rootContextId]?.snapshot,
      },
      occurredAt: updatedAt,
    });
  }

  private async cancelAbandonedSteerExecutions(
    prompts: readonly PromptRequest[],
  ): Promise<boolean> {
    const abandoned = prompts.filter(
      (prompt) =>
        prompt.status === "cancelled" &&
        prompt.deliveryAttempt?.kind === "queue_steer" &&
        prompt.deliveryAttempt.state === "uncertain",
    );
    for (const prompt of abandoned) {
      const sourceExecutionId = prompt.deliveryAttempt?.sourceExecutionId;
      if (sourceExecutionId === undefined) continue;
      await this.cancelPersistedExecution(
        sourceExecutionId,
        "Steer delivery abandoned without replay; prior operations may already have executed.",
      );
    }
    if (abandoned.length === 0 || hasUnresolvedSteerDelivery(prompts)) return false;
    const lastControl = [...(await this.dependencies.sessions.listEvents(this.sessionId))]
      .reverse()
      .find((event) =>
        ["prompt.queue-paused", "prompt.queue-resumed", "prompt.queue-cleared"].includes(
          event.type,
        ),
      );
    const pause = lastControl?.data as { requestId?: unknown; reason?: unknown } | undefined;
    if (
      lastControl?.type !== "prompt.queue-paused" ||
      pause?.reason !== "delivery_uncertain" ||
      !abandoned.some((prompt) => prompt.requestId === pause.requestId)
    )
      return false;
    // Replay the control-event cleanup too: an idle queue otherwise appears resumed,
    // but the stale pause would fence the next instruction after retry or restart.
    await this.ownedSessions.appendEvent(this.sessionId, {
      eventId: `prompt-queue-resumed:${randomUUID()}`,
      type: "prompt.queue-resumed",
      data: {},
    });
    return true;
  }

  private async reconcileQueuedSteers(prompts: readonly PromptRequest[]): Promise<void> {
    const state = await this.getState();
    if (state.activeExecutionId !== undefined) {
      throw new SteerDeliveryUncertainError(
        "Wait for the active execution to settle before checking steer delivery.",
      );
    }
    const context = await this.getRootContext(state);
    if (context.snapshot === undefined)
      throw new SteerDeliveryUncertainError(
        "The owned Runtime Session cannot be restored for delivery reconciliation.",
      );
    const identity = {
      contextId: context.contextId,
      expertId: context.expert.id,
      runtime: context.runtime,
    };
    // Stop any live pooled Session before restoring the same native Session.
    // The Runtime must still account for orphaned processes after a host crash.
    await this.runtimeSessions.release(identity);
    const resolved = await this.dependencies.runtimes.resolve({
      binding: context.runtime,
      modelSelection: context.modelSelection,
    });
    const native = await openRuntimeSession(resolved.adapter, {
      agent: isExpertTeam(this.expert) ? this.expert.coordinator : this.expert,
      owner: { type: "expert-session", ownerId: this.sessionId, contextId: context.contextId },
      pragmaHome: this.dependencies.pragmaHome,
      systemSessionId: context.snapshot.systemSessionId,
      runtimeSession: context.snapshot.runtimeSession,
      modelSelection: context.modelSelection,
      loggerProvider: this.dependencies.loggerProvider.withScope({
        expertSessionId: this.sessionId,
        contextId: context.contextId,
      }),
    });
    try {
      if (native.reconcileSteer === undefined)
        throw new SteerDeliveryUncertainError(
          "This Runtime cannot confirm steer delivery; the queue remains paused.",
        );
      for (const prompt of prompts) {
        const attempt = prompt.deliveryAttempt!;
        const outcome = await native.reconcileSteer({
          requestId: prompt.requestId,
          content: prompt.content,
          targetRunId: attempt.targetExecutionId,
          attemptId: attempt.attemptId,
        });
        if (outcome === "uncertain") continue;
        const confirmed = outcome === "delivered";
        await this.ownedSessions.transact(this.sessionId, ({ session, prompts: current }) => ({
          result: undefined,
          session: {
            ...session,
            queuedRequestIds: confirmed
              ? session.queuedRequestIds.filter((id) => id !== prompt.requestId)
              : session.queuedRequestIds,
            updatedAt: new Date().toISOString(),
          },
          prompts: current.map((candidate) =>
            candidate.requestId === prompt.requestId &&
            candidate.deliveryAttempt?.attemptId === attempt.attemptId &&
            candidate.deliveryAttempt.state === "uncertain"
              ? {
                  ...candidate,
                  status: confirmed
                    ? ("succeeded" as const)
                    : candidate.mode === "enqueue"
                      ? ("queued" as const)
                      : ("failed" as const),
                  error: undefined,
                  deliveryAttempt: confirmed
                    ? { ...candidate.deliveryAttempt, state: "confirmed" as const }
                    : undefined,
                  updatedAt: new Date().toISOString(),
                }
              : candidate,
          ),
        }));
        if (confirmed && attempt.sourceExecutionId !== undefined)
          await this.cancelPersistedExecution(
            attempt.sourceExecutionId,
            "Confirmed native steer delivery; the queued prompt will not be replayed.",
          );
      }
    } finally {
      await native.close();
    }
  }

  /** Recover queue-steer delivery without guessing whether Runtime observed it. */
  async recoverPendingQueueSteers(): Promise<void> {
    const allPrompts = await this.getPromptQueue();
    await this.cancelAbandonedSteerExecutions(allPrompts);
    const uncertainStrictSteers = allPrompts.filter(
      (prompt) =>
        prompt.status !== "cancelled" &&
        prompt.deliveryAttempt?.kind === "strict_steer" &&
        prompt.deliveryAttempt.state === "dispatching",
    );
    for (const prompt of uncertainStrictSteers) {
      const attempt = prompt.deliveryAttempt!;
      await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
        result: undefined,
        session: { ...session, updatedAt: new Date().toISOString() },
        prompts: prompts.map((candidate) =>
          candidate.requestId === prompt.requestId &&
          candidate.status !== "cancelled" &&
          candidate.deliveryAttempt?.attemptId === attempt.attemptId
            ? {
                ...candidate,
                status: "failed" as const,
                error: "delivery_uncertain",
                deliveryAttempt: {
                  ...attempt,
                  state: "uncertain" as const,
                },
                updatedAt: new Date().toISOString(),
              }
            : candidate,
        ),
      }));
    }
    const marked = allPrompts.filter(
      (prompt) => prompt.status !== "cancelled" && prompt.deliveryAttempt?.kind === "queue_steer",
    );
    for (const prompt of marked) {
      const replacedExecutionId = prompt.deliveryAttempt?.sourceExecutionId;
      if (replacedExecutionId === undefined) continue;
      if (prompt.status === "succeeded" || prompt.deliveryAttempt?.state === "confirmed") {
        await this.cancelPersistedExecution(
          replacedExecutionId,
          "Moved from the prompt queue to steer the active turn.",
        );
        continue;
      }
      if (prompt.status !== "queued" && prompt.status !== "running") continue;
      await this.markQueueSteerUncertain(prompt, replacedExecutionId);
    }
  }

  async attemptQueuedPromptSteer(requestId: string): Promise<QueuedPromptSteerAttempt> {
    const queue = await this.getPromptQueue();
    const prompt = queue.find((candidate) => candidate.requestId === requestId);
    if (prompt?.mode !== "enqueue" || prompt.status !== "queued") {
      throw new Error(`Queued prompt not found: ${requestId}`);
    }
    if (prompt.purpose !== "user") {
      throw new Error(`Queued prompt not found: ${requestId}`);
    }
    if (hasUncertainSteerDelivery(queue)) {
      return { outcome: "retained", reason: "delivery_uncertain" };
    }
    const invocation = await this.dependencies.executions.getInvocation(
      prompt.executionId,
      prompt.executionId,
    );
    if (readExpertPromptInput(invocation?.input).attachments.length > 0) {
      return { outcome: "retained", reason: "attachments_not_supported" };
    }
    const state = await this.getState();
    if (state.activeExecutionId === undefined) {
      return {
        outcome: "retained",
        reason:
          state.lastStatus === "waiting" ||
          this.waitingForRecoveredHumanInput ||
          this.humanCheckpointReleasePromise !== undefined
            ? "human_input_wait"
            : "no_active_turn",
      };
    }
    try {
      return { outcome: "steered", turn: await this.steerQueuedPrompt(requestId) };
    } catch (error) {
      if (error instanceof SteerNotDispatchedError) {
        return { outcome: "retained", reason: error.reason };
      }
      if (error instanceof SteerDeliveryUncertainError) {
        return { outcome: "retained", reason: "delivery_uncertain" };
      }
      throw error;
    }
  }

  async steerQueuedPrompt(requestId: string): Promise<ExpertTurn> {
    if (this.leaseError !== undefined) throw this.leaseError;
    if (this.closePromise !== undefined || this.stopPromise !== undefined || this.deletionFrozen) {
      throw new Error(`ExpertSession is closing or closed: ${this.sessionId}`);
    }
    if (this.queueSteersInFlight.has(requestId)) {
      throw new Error(`Queued prompt steer is already in progress: ${requestId}`);
    }
    this.queueSteersInFlight.add(requestId);
    let claim: QueuedSteerClaim | undefined;
    let runtimeSteerApplied = false;
    try {
      const prompt = (await this.getPromptQueue()).find(
        (candidate) => candidate.requestId === requestId,
      );
      if (prompt?.mode !== "enqueue" || prompt.status !== "queued") {
        throw new Error(`Queued prompt not found: ${requestId}`);
      }
      if (prompt.purpose !== "user") {
        throw new Error(`Queued prompt not found: ${requestId}`);
      }
      if (prompt.deliveryAttempt?.state === "uncertain") {
        throw new SteerDeliveryUncertainError(
          `Queued steer delivery outcome is uncertain: ${requestId}`,
        );
      }
      const invocation = await this.dependencies.executions.getInvocation(
        prompt.executionId,
        prompt.executionId,
      );
      if (readExpertPromptInput(invocation?.input).attachments.length > 0) {
        throw new Error("A queued prompt with attachments cannot be steered.");
      }

      const controller = await this.waitForSteerController(false);
      const now = new Date().toISOString();
      claim = await this.ownedSessions.transact<QueuedSteerClaim>(
        this.sessionId,
        ({ session, prompts }) => {
          if (hasUncertainSteerDelivery(prompts))
            throw new SteerDeliveryUncertainError(
              "Confirm the previous steer delivery before injecting another queued message.",
            );
          if (session.status === "closed") {
            throw new Error(`ExpertSession is closed: ${this.sessionId}`);
          }
          if (session.activeExecutionId === undefined) {
            throw new SteerNotDispatchedError(
              "no_active_turn",
              "Cannot steer without an active ExpertTurn.",
            );
          }
          const current = prompts.find((candidate) => candidate.requestId === requestId);
          if (current?.mode !== "enqueue" || current.status !== "queued") {
            throw new Error(`Queued prompt not found: ${requestId}`);
          }
          if (current.deliveryAttempt?.state === "uncertain") {
            throw new SteerDeliveryUncertainError(
              `Queued steer delivery outcome is uncertain: ${requestId}`,
            );
          }
          const attemptId = randomUUID();
          return {
            result: {
              requestId,
              activeExecutionId: session.activeExecutionId,
              contextId: session.rootContextId,
              originalPrompt: current,
              attemptId,
            },
            session: {
              ...session,
              queuedRequestIds: session.queuedRequestIds.filter((id) => id !== requestId),
              updatedAt: now,
            },
            prompts: prompts.map((candidate) =>
              candidate.requestId === requestId
                ? {
                    ...candidate,
                    status: "running" as const,
                    error: undefined,
                    deliveryAttempt: {
                      attemptId,
                      kind: "queue_steer" as const,
                      sourceExecutionId: current.executionId,
                      targetExecutionId: session.activeExecutionId!,
                      state: "dispatching" as const,
                    },
                    updatedAt: now,
                  }
                : candidate,
            ),
          };
        },
      );

      const current = await this.getState();
      if (this.controller !== controller || current.activeExecutionId !== claim.activeExecutionId) {
        throw new SteerNotDispatchedError(
          "target_changed",
          `ExpertTurn changed before queued steer: ${claim.activeExecutionId}`,
        );
      }
      await controller.steer(claim.contextId, {
        requestId,
        content: claim.originalPrompt.content,
        targetRunId: claim.activeExecutionId,
        attemptId: claim.attemptId,
      });
      runtimeSteerApplied = true;

      try {
        await this.markQueueSteerSucceeded(claim);
      } catch (cause) {
        await this.markQueueSteerUncertain(
          claim.originalPrompt,
          claim.originalPrompt.executionId,
          claim.attemptId,
        );
        throw new SteerDeliveryUncertainError(
          "Runtime acknowledged steer delivery, but its receipt could not be persisted.",
          { cause },
        );
      }
      await this.cancelPersistedExecution(
        claim.originalPrompt.executionId,
        "Moved from the prompt queue to steer the active turn.",
      );
      return this.createTurn(claim.activeExecutionId, requestId, "enqueue", "steer");
    } catch (error) {
      if (claim !== undefined && !runtimeSteerApplied) {
        if (error instanceof SteerNotDispatchedError) {
          let restored: boolean;
          try {
            restored = await this.restoreQueuedSteer(claim);
          } catch (restoreError) {
            await this.markQueueSteerUncertain(
              claim.originalPrompt,
              claim.originalPrompt.executionId,
              claim.attemptId,
            );
            throw new SteerDeliveryUncertainError(
              "The queue could not confirm rollback of the steer attempt.",
              { cause: restoreError },
            );
          }
          if (!restored) {
            throw new Error(`Queued prompt was cancelled before steer completed: ${requestId}`, {
              cause: error,
            });
          }
        } else {
          const retained = await this.markQueueSteerUncertain(
            claim.originalPrompt,
            claim.originalPrompt.executionId,
            claim.attemptId,
          );
          if (!retained) {
            throw new Error(`Queued prompt was cancelled before steer completed: ${requestId}`, {
              cause: error,
            });
          }
          throw new SteerDeliveryUncertainError(
            `Queued steer delivery outcome is uncertain: ${requestId}`,
            { cause: error },
          );
        }
      }
      throw error;
    } finally {
      this.queueSteersInFlight.delete(requestId);
      this.startProcessing();
    }
  }

  async removeQueuedPrompt(requestId: string, reason?: string): Promise<void> {
    const cancellationReason = reason ?? "Removed from prompt queue.";
    const now = new Date().toISOString();
    const executionId = await this.ownedSessions.transact<string>(
      this.sessionId,
      ({ session, prompts }) => {
        const prompt = prompts.find((candidate) => candidate.requestId === requestId);
        if (prompt?.purpose !== "user" || prompt.mode !== "enqueue" || prompt.status !== "queued") {
          throw new Error(`Queued prompt not found: ${requestId}`);
        }
        if (prompt.deliveryAttempt?.state === "uncertain")
          throw new SteerDeliveryUncertainError(
            "Confirm steer delivery before taking this message back for resending.",
          );
        return {
          result: prompt.executionId,
          session: {
            ...session,
            queuedRequestIds: session.queuedRequestIds.filter((id) => id !== requestId),
            updatedAt: now,
          },
          prompts: prompts.map((candidate) =>
            candidate.requestId === requestId
              ? {
                  ...candidate,
                  status: "cancelled" as const,
                  error: cancellationReason,
                  updatedAt: now,
                }
              : candidate,
          ),
        };
      },
    );
    await this.cancelPersistedExecution(executionId, cancellationReason);
  }

  async cancelPromptQueue(reason?: string): Promise<void> {
    if (hasUnresolvedSteerDelivery(await this.getPromptQueue())) {
      await this.controller?.cancel(
        reason ?? "Stopped while steer delivery requires confirmation.",
      );
      throw new SteerDeliveryUncertainError(
        "Confirm steer delivery before clearing the queue and accepting another turn.",
      );
    }
    const cancellationReason = reason ?? "Prompt queue cleared.";
    const pending = (await this.getPromptQueue()).filter(
      (prompt) => prompt.status === "queued" || prompt.status === "running",
    );
    await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => {
      if (hasUnresolvedSteerDelivery(prompts))
        throw new SteerDeliveryUncertainError(
          "Steer delivery must settle before queue cancellation.",
        );
      return {
        result: undefined,
        session: {
          ...session,
          queuedRequestIds: [],
          updatedAt: new Date().toISOString(),
        },
        prompts: prompts.map((prompt) =>
          prompt.status === "queued" || prompt.status === "running"
            ? {
                ...prompt,
                status: "cancelled" as const,
                error: cancellationReason,
                updatedAt: new Date().toISOString(),
              }
            : prompt,
        ),
      };
    });
    this.paused = true;
    await this.ownedSessions.appendEvent(this.sessionId, {
      eventId: `prompt-queue-cleared:${randomUUID()}`,
      type: "prompt.queue-cleared",
      data: {
        reason: cancellationReason,
        requestIds: pending.map((prompt) => prompt.requestId),
      },
    });
    await this.controller?.cancel(cancellationReason);
    for (const prompt of pending) {
      await this.cancelPersistedExecution(prompt.executionId, cancellationReason);
    }
    await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: {
        ...session,
        activeExecutionId: undefined,
        lastStatus: "cancelled" as const,
        updatedAt: new Date().toISOString(),
      },
      prompts,
    }));
    this.controller = undefined;
    this.processingGeneration += 1;
    this.processing = undefined;
    this.paused = false;
    this.startProcessing();
  }

  private async cancelPersistedExecution(executionId: string, reason: string): Promise<void> {
    const execution = await this.dependencies.executions.get(executionId);
    if (execution === undefined || isFinal(execution.status)) return;
    await new ExecutionController(executionId, this.dependencies.executions).cancel(reason);
  }

  private async markQueueSteerSucceeded(claim: QueuedSteerClaim): Promise<void> {
    await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: { ...session, updatedAt: new Date().toISOString() },
      prompts: prompts.map((prompt) =>
        prompt.requestId === claim.requestId &&
        prompt.mode === "enqueue" &&
        prompt.status === "running" &&
        prompt.deliveryAttempt?.attemptId === claim.attemptId
          ? {
              ...prompt,
              status: "succeeded" as const,
              deliveryAttempt: { ...prompt.deliveryAttempt, state: "confirmed" as const },
              updatedAt: new Date().toISOString(),
            }
          : prompt,
      ),
    }));
  }

  private async clearQueueSteerAttempt(
    requestId: string,
    attemptId: string | undefined,
  ): Promise<void> {
    await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: { ...session, updatedAt: new Date().toISOString() },
      prompts: prompts.map((prompt) =>
        prompt.requestId === requestId &&
        (attemptId === undefined || prompt.deliveryAttempt?.attemptId === attemptId)
          ? {
              ...prompt,
              error: undefined,
              deliveryAttempt: undefined,
              updatedAt: new Date().toISOString(),
            }
          : prompt,
      ),
    }));
  }

  private async restoreQueuedSteer(claim: QueuedSteerClaim): Promise<boolean> {
    if (this.closePromise !== undefined) return false;
    return await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => {
      const current = prompts.find((prompt) => prompt.requestId === claim.requestId);
      if (
        session.status === "closed" ||
        current === undefined ||
        current.mode !== "enqueue" ||
        current.status !== "running" ||
        current.deliveryAttempt?.attemptId !== claim.attemptId
      ) {
        return { result: false, session, prompts };
      }
      const restored = {
        ...claim.originalPrompt,
        mode: "enqueue" as const,
        executionId: claim.originalPrompt.executionId,
        status: "queued" as const,
        targetExecutionId: undefined,
        error: undefined,
        deliveryAttempt: undefined,
        updatedAt: new Date().toISOString(),
      };
      return {
        result: true,
        session: {
          ...session,
          queuedRequestIds: [...new Set([...session.queuedRequestIds, claim.requestId])],
          updatedAt: restored.updatedAt,
        },
        prompts: prompts.map((prompt) =>
          prompt.requestId === claim.requestId ? restored : prompt,
        ),
      };
    });
  }

  private async markQueueSteerUncertain(
    prompt: PromptRequest,
    sourceExecutionId: string,
    expectedAttemptId = prompt.deliveryAttempt?.attemptId,
  ): Promise<boolean> {
    if (this.closePromise !== undefined) return false;
    const updatedAt = new Date().toISOString();
    const retained = await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => {
      const current = prompts.find((candidate) => candidate.requestId === prompt.requestId);
      if (
        session.status === "closed" ||
        current?.mode !== "enqueue" ||
        (current.status !== "queued" && current.status !== "running") ||
        current.deliveryAttempt?.kind !== "queue_steer" ||
        current.deliveryAttempt.attemptId !== expectedAttemptId ||
        current.deliveryAttempt.sourceExecutionId !== sourceExecutionId
      ) {
        return { result: false, session, prompts };
      }
      const deliveryAttempt = current.deliveryAttempt;
      return {
        result: true,
        session: {
          ...session,
          queuedRequestIds: [...new Set([...session.queuedRequestIds, prompt.requestId])],
          updatedAt,
        },
        prompts: prompts.map((candidate) =>
          candidate.requestId === prompt.requestId
            ? {
                ...candidate,
                mode: "enqueue" as const,
                executionId: sourceExecutionId,
                status: "queued" as const,
                targetExecutionId: undefined,
                error: "delivery_uncertain",
                deliveryAttempt: { ...deliveryAttempt, state: "uncertain" as const },
                updatedAt,
              }
            : candidate,
        ),
      };
    });
    if (!retained) return false;
    // Delivery state is authoritative even if persisting its diagnostic event fails.
    this.paused = true;
    await this.ownedSessions.appendEvent(this.sessionId, {
      eventId: `prompt-queue-paused:delivery-uncertain:${prompt.requestId}`,
      type: "prompt.queue-paused",
      data: { requestId: prompt.requestId, reason: "delivery_uncertain" },
      occurredAt: updatedAt,
    });
    return true;
  }

  private async getRootContext(state?: ExpertSessionRecord): Promise<RuntimeContextRecord> {
    const session = state ?? (await this.getState());
    const context = session.contexts[session.rootContextId];
    if (context === undefined) throw new Error("ExpertSession root Context is missing.");
    return context;
  }

  private async steer(content: string, requestId: string): Promise<ExpertTurn> {
    const inFlight = this.strictSteersInFlight.get(requestId);
    if (inFlight !== undefined) {
      if (inFlight.content !== content) {
        throw new Error(`Prompt idempotency conflict: ${requestId}`);
      }
      return await inFlight.delivery;
    }
    const delivery = this.deliverSteer(content, requestId);
    this.strictSteersInFlight.set(requestId, { content, delivery });
    try {
      return await delivery;
    } finally {
      if (this.strictSteersInFlight.get(requestId)?.delivery === delivery) {
        this.strictSteersInFlight.delete(requestId);
      }
    }
  }

  private async deliverSteer(content: string, requestId: string): Promise<ExpertTurn> {
    const initialState = await this.getState();
    if (
      initialState.activeExecutionId === undefined &&
      (initialState.lastStatus === "waiting" ||
        this.waitingForRecoveredHumanInput ||
        this.humanCheckpointReleasePromise !== undefined)
    ) {
      throw new SteerNotDispatchedError(
        "no_active_turn",
        "Cannot steer without an active ExpertTurn.",
      );
    }
    const controller = await this.waitForSteerController();
    const now = new Date().toISOString();
    const claim = await this.ownedSessions.transact<SteerClaim>(
      this.sessionId,
      ({ session, prompts }) => {
        if (session.status === "closed") {
          throw new Error(`ExpertSession is closed: ${this.sessionId}`);
        }
        if (session.activeExecutionId === undefined) {
          throw new SteerNotDispatchedError(
            "no_active_turn",
            "Cannot steer without an active ExpertTurn.",
          );
        }
        const duplicate = prompts.find((prompt) => prompt.requestId === requestId);
        if (duplicate !== undefined) {
          if (duplicate.content !== content || duplicate.mode !== "steer") {
            throw new Error(`Prompt idempotency conflict: ${requestId}`);
          }
          if (
            duplicate.deliveryAttempt?.state === "dispatching" ||
            duplicate.deliveryAttempt?.state === "uncertain"
          ) {
            throw new Error(`Steer delivery outcome is uncertain: ${requestId}`);
          }
          if (duplicate.status === "failed") {
            throw new Error(duplicate.error ?? `Steer failed: ${requestId}`);
          }
          return {
            result: { execute: false as const, executionId: duplicate.executionId },
            session,
            prompts,
          };
        }
        if (hasUncertainSteerDelivery(prompts))
          throw new SteerDeliveryUncertainError(
            "Confirm the previous steer delivery before injecting another message.",
          );
        const contextId = session.rootContextId;
        const executionId = session.activeExecutionId;
        const attemptId = randomUUID();
        return {
          result: { execute: true as const, executionId, contextId, attemptId },
          session: { ...session, updatedAt: now },
          prompts: [
            ...prompts,
            {
              requestId,
              sessionId: this.sessionId,
              content,
              purpose: "user" as const,
              mode: "steer" as const,
              executionId,
              targetExecutionId: executionId,
              status: "running" as const,
              deliveryAttempt: {
                attemptId,
                kind: "strict_steer" as const,
                targetExecutionId: executionId,
                state: "dispatching" as const,
              },
              createdAt: now,
              updatedAt: now,
            },
          ],
        };
      },
    );
    if (!claim.execute) return this.createTurn(claim.executionId, requestId, "steer", "steer");
    try {
      const current = await this.getState();
      if (this.controller !== controller || current.activeExecutionId !== claim.executionId) {
        throw new SteerNotDispatchedError(
          "target_changed",
          `ExpertTurn changed before steer: ${claim.executionId}`,
        );
      }
      await controller.steer(claim.contextId, {
        requestId,
        content,
        targetRunId: claim.executionId,
        attemptId: claim.attemptId,
      });
      await this.completeSteer(requestId, claim.attemptId, "succeeded");
      return this.createTurn(claim.executionId, requestId, "steer", "steer");
    } catch (error) {
      await this.completeSteer(
        requestId,
        claim.attemptId,
        "failed",
        error instanceof Error ? error.message : String(error),
        error instanceof SteerNotDispatchedError ? "not_dispatched" : "uncertain",
      );
      throw error;
    }
  }

  private async completeSteer(
    requestId: string,
    attemptId: string,
    status: "succeeded" | "failed",
    error?: string,
    failureState: "not_dispatched" | "uncertain" = "uncertain",
  ): Promise<void> {
    await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: { ...session, updatedAt: new Date().toISOString() },
      prompts: prompts.map((prompt) =>
        prompt.requestId === requestId &&
        prompt.status !== "cancelled" &&
        prompt.deliveryAttempt?.attemptId === attemptId
          ? {
              ...prompt,
              status,
              ...(error === undefined ? {} : { error }),
              deliveryAttempt: {
                ...prompt.deliveryAttempt,
                state: status === "succeeded" ? ("confirmed" as const) : failureState,
              },
              updatedAt: new Date().toISOString(),
            }
          : prompt,
      ),
    }));
  }

  private async waitForSteerController(allowQueuedStartup = true): Promise<ExecutionController> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const controller = this.controller;
      if (controller !== undefined) return controller;

      const [session, prompts] = await Promise.all([this.getState(), this.getPromptQueue()]);
      const canBecomeActive =
        session.activeExecutionId !== undefined ||
        prompts.some(
          (prompt) =>
            prompt.mode === "enqueue" &&
            (prompt.status === "queued" || prompt.status === "running"),
        );
      if (!canBecomeActive || (!allowQueuedStartup && session.activeExecutionId === undefined)) {
        throw new SteerNotDispatchedError(
          "no_active_turn",
          "Cannot steer without an active ExpertTurn.",
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new SteerNotDispatchedError(
      "no_active_turn",
      "ExpertTurn did not become active before steer timed out.",
    );
  }

  private startProcessing(): void {
    if (
      this.closePromise !== undefined ||
      this.leaseError !== undefined ||
      this.paused ||
      this.processing !== undefined ||
      this.queueSteersInFlight.size > 0
    )
      return;
    const generation = ++this.processingGeneration;
    const processing = this.processQueue(generation).finally(() => {
      if (this.processingGeneration !== generation) return;
      this.processing = undefined;
      if (!this.paused) void this.restartProcessingIfQueued();
    });
    this.processing = processing;
  }

  private async restartProcessingIfQueued(): Promise<void> {
    const prompts = await this.getPromptQueue();
    if (
      !hasUnresolvedSteerDelivery(prompts) &&
      prompts.some((prompt) => prompt.status === "queued")
    ) {
      this.startProcessing();
    }
  }

  private async processQueue(generation: number): Promise<void> {
    while (true) {
      if (this.paused || this.queueSteersInFlight.size > 0) return;
      if (this.leaseError !== undefined) return;
      if (this.processingGeneration !== generation) return;
      const prompts = await this.getPromptQueue();
      if (hasUnresolvedSteerDelivery(prompts)) {
        this.paused = true;
        return;
      }
      if (this.leaseError !== undefined) return;
      if (this.processingGeneration !== generation) return;
      if (this.paused || hasUnresolvedSteerDelivery(prompts)) return;
      const next = prompts.find((prompt) => prompt.status === "queued");
      if (next === undefined) return;
      const status = await this.runPrompt(next).catch(() => "failed" as const);
      if (this.processingGeneration !== generation) return;
      if (this.leaseError !== undefined) return;
      if (status === "checkpointed") return;
      if (status === "failed") {
        const hasQueued = (await this.getPromptQueue()).some(
          (prompt) => prompt.mode === "enqueue" && prompt.status === "queued",
        );
        if (hasQueued) {
          this.paused = true;
          await this.ownedSessions.appendEvent(this.sessionId, {
            eventId: `prompt-queue-paused:${next.requestId}`,
            type: "prompt.queue-paused",
            data: { requestId: next.requestId, status },
          });
        }
        return;
      }
    }
  }

  private async runPrompt(
    prompt: PromptRequest,
  ): Promise<"succeeded" | "failed" | "cancelled" | "checkpointed"> {
    const now = new Date().toISOString();
    const claimed = await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => {
      const current = prompts.find((candidate) => candidate.requestId === prompt.requestId);
      if (hasUnresolvedSteerDelivery(prompts)) this.paused = true;
      if (
        this.paused ||
        this.queueSteersInFlight.size > 0 ||
        hasUnresolvedSteerDelivery(prompts) ||
        current?.mode !== "enqueue" ||
        current.status !== "queued"
      ) {
        return { result: false, session, prompts };
      }
      return {
        result: true,
        session: {
          ...session,
          activeExecutionId: prompt.executionId,
          queuedRequestIds: session.queuedRequestIds.filter((id) => id !== prompt.requestId),
          updatedAt: now,
        },
        prompts: prompts.map((candidate) =>
          candidate.requestId === prompt.requestId
            ? { ...candidate, status: "running" as const, updatedAt: now }
            : candidate,
        ),
      };
    });
    if (!claimed) return "cancelled";
    await this.dependencies.executions.commit({
      commitId: randomUUID(),
      executionId: prompt.executionId,
      executionPatch: { status: "running" },
      events: [
        {
          invocationId: prompt.executionId,
          type: "execution.started",
          data: {},
        },
      ],
    });
    const session = await this.getState();
    if (this.leaseError !== undefined) return "cancelled";
    const rootContextId = session.rootContextId;
    const rootContext = session.contexts[rootContextId];
    if (rootContext === undefined) throw new Error("ExpertSession root Context is missing.");
    const rootInvocation = await this.dependencies.executions.getInvocation(
      prompt.executionId,
      prompt.executionId,
    );
    const promptInput = readExpertPromptInput(rootInvocation?.input);
    const controller = new ExecutionController(
      prompt.executionId,
      this.dependencies.executions,
      this.runtimeSessions,
      {
        ...(this.recoveredExecutionId === prompt.executionId
          ? { recoverHumanInteractionIds: this.recoveredHumanInteractionIds }
          : {}),
        automaticHumanInteractionHandler: this.dependencies.automaticHumanInteractionHandler,
        assertOwnership: async () => {
          if (this.terminalReleaseRequested)
            throw new Error("ExpertSession resources are being released.");
          await this.dependencies.assertExecutionOwnership?.();
          if (this.dependencies.sessions.assertLeaseOwner !== undefined) {
            await this.dependencies.sessions.assertLeaseOwner(this.sessionId, this.claimId);
          } else {
            await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
              result: undefined,
              session,
              prompts,
            }));
          }
        },
        onHumanInteractionRequested: async () => {
          await this.markExecutionPromptAsHumanCheckpointRecovery(prompt.executionId);
        },
      },
    );
    this.controller = controller;
    let status: "succeeded" | "failed" | "cancelled" | "checkpointed" = "succeeded";
    let output: ReturnType<typeof InvocationOutputSchema.parse> | undefined;
    let error: unknown;
    try {
      output = InvocationOutputSchema.parse(
        await runExpertInvocation({
          pragmaHome: this.dependencies.pragmaHome,
          executionId: prompt.executionId,
          invocationId: prompt.executionId,
          isRecovery: this.recoveredExecutionId === prompt.executionId,
          expert: this.expert,
          prompt:
            this.recoveredExecutionId === prompt.executionId
              ? recoveryPrompt(prompt.content)
              : prompt.content,
          attachments: promptInput.attachments,
          owner: { type: "expert-session", ownerId: this.sessionId },
          context: rootContext,
          controller,
          store: this.dependencies.executions,
          runtimes: this.dependencies.runtimes,
          loggerProvider: this.dependencies.loggerProvider.withScope({
            expertSessionId: this.sessionId,
          }),
          usageSink: this.dependencies.usageSink,
          hostContextBindings: this.dependencies.hostContextBindings,
          resolveHostContextBindings: this.dependencies.resolveHostContextBindings,
          nestedFlowExecutor: this.dependencies.nestedFlowExecutor,
          ...(this.recoveredExecutionId === prompt.executionId
            ? { runtimeRunId: `${prompt.executionId}:recovery:${randomUUID()}` }
            : {}),
          ...(prompt.modelSelection === undefined ? {} : { modelSelection: prompt.modelSelection }),
          persistContext: async (context) => await this.persistRuntimeContext(context),
          readContextScope: async () => await this.readRuntimeContextScope(),
        }),
      );
    } catch (caught) {
      if (isHumanInteractionCheckpointError(caught)) {
        status = "checkpointed";
      } else {
        status = controller.isCancelled() ? "cancelled" : "failed";
        error = status === "cancelled" ? (controller.getCancellationReason() ?? caught) : caught;
      }
    }
    if (this.closePromise !== undefined || this.leaseError !== undefined) {
      if (this.controller === controller) this.controller = undefined;
      controller.finish();
      return "cancelled";
    }
    if (status === "checkpointed") {
      // The Runtime has durably checkpointed a human interaction, but the
      // prompt is still the recoverable unit of work. Persist that boundary
      // before releasing the in-memory controller so a later Mission owner
      // can discover and resume the same prompt after a process crash.
      await this.ownedSessions.transact(this.sessionId, ({ session: current, prompts }) => ({
        result: undefined,
        session: {
          ...current,
          activeExecutionId:
            current.activeExecutionId === prompt.executionId
              ? undefined
              : current.activeExecutionId,
          queuedRequestIds: [...new Set([...current.queuedRequestIds, prompt.requestId])],
          lastStatus: "waiting" as const,
          updatedAt: new Date().toISOString(),
        },
        prompts: prompts.map((candidate) =>
          candidate.requestId === prompt.requestId && candidate.status === "running"
            ? {
                ...candidate,
                purpose: "human_checkpoint_recovery" as const,
                status: "queued" as const,
                updatedAt: new Date().toISOString(),
              }
            : candidate,
        ),
      }));
      if (this.controller === controller) this.controller = undefined;
      controller.finish();
      return status;
    }
    const terminalStartedAt = performance.now();
    const phaseLogger = this.dependencies.loggerProvider.createLogger({
      component: "core.expert-session",
      scope: { expertSessionId: this.sessionId, executionId: prompt.executionId },
    });
    const usage = controller.getUsage();
    const executionPatch = {
      status,
      ...(usage === undefined ? {} : { usage }),
      ...(status === "succeeded" ? { output } : { error: serializeError(error) }),
    };
    const currentExecution = await this.dependencies.executions.get(prompt.executionId);
    if (currentExecution !== undefined && isFinal(currentExecution.status)) {
      if (usage !== undefined) {
        await this.dependencies.executions.commit({
          commitId: `expert-terminal-usage:${prompt.executionId}:${currentExecution.version}`,
          executionId: prompt.executionId,
          executionPatch: { usage },
        });
      }
      if (
        currentExecution.status === "succeeded" ||
        currentExecution.status === "failed" ||
        currentExecution.status === "cancelled"
      ) {
        status = currentExecution.status;
      }
    } else {
      await this.dependencies.executions.commit({
        commitId: `expert-turn-${status}:${prompt.executionId}`,
        executionId: prompt.executionId,
        executionPatch,
        events: [
          {
            invocationId: prompt.executionId,
            type: `execution.${status}`,
            data:
              status === "succeeded"
                ? { output, ...(usage === undefined ? {} : { usage }) }
                : { error: serializeError(error), ...(usage === undefined ? {} : { usage }) },
          },
        ],
      });
    }
    phaseLogger.info("execution.terminal_committed", "Expert turn terminal fact committed", {
      requestId: prompt.requestId,
      elapsedMs: performance.now() - terminalStartedAt,
    });
    const releaseStartedAt = performance.now();
    await this.ownedSessions.transact(this.sessionId, ({ session: current, prompts }) => ({
      result: undefined,
      session: {
        ...current,
        activeExecutionId:
          current.activeExecutionId === prompt.executionId ? undefined : current.activeExecutionId,
        lastStatus: status,
        updatedAt: new Date().toISOString(),
      },
      prompts: prompts.map((candidate) =>
        candidate.requestId === prompt.requestId
          ? { ...candidate, status, updatedAt: new Date().toISOString() }
          : candidate,
      ),
    }));
    phaseLogger.info(
      "session.active_binding_released",
      "Expert turn active binding durably released",
      { requestId: prompt.requestId, elapsedMs: performance.now() - releaseStartedAt },
    );
    if (this.controller === controller) {
      this.controller = undefined;
    }
    controller.finish();
    return status;
  }

  private async persistRuntimeContext(context: RuntimeContextRecord): Promise<void> {
    if (this.closePromise !== undefined || this.leaseError !== undefined) return;
    await this.ownedSessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: {
        ...session,
        contexts: {
          ...session.contexts,
          [context.contextId]: mergeRuntimeContextRecord(
            session.contexts[context.contextId],
            context,
          ),
        },
        updatedAt: new Date().toISOString(),
      },
      prompts,
    }));
  }

  private async readRuntimeContextScope(): Promise<ContextResolutionScopeSnapshot> {
    const session = await this.getState();
    const histories = await Promise.all(
      session.executionIds.map(async (executionId) => {
        const [invocations, agents] = await Promise.all([
          this.dependencies.executions.listInvocations(executionId),
          this.dependencies.executions.listAgents(executionId),
        ]);
        return { invocations, agents };
      }),
    );
    return {
      contexts: Object.values(session.contexts),
      invocations: histories.flatMap((history): readonly Invocation[] => history.invocations),
      agents: histories.flatMap((history): readonly AgentInstance[] => history.agents),
    };
  }

  private createTurn(
    executionId: string,
    requestId: string,
    requestedMode: PromptMode = "enqueue",
    effectiveMode: PromptMode = requestedMode,
    fallbackReason?: string,
  ): ExpertTurn {
    const view = this.createExecutionView(executionId);
    let completion = this.completions.get(executionId);
    if (completion === undefined) {
      completion = waitForTerminalExecution(this.dependencies.executions, executionId);
      this.completions.set(executionId, completion);
      const pending = completion;
      const forget = () => {
        if (this.completions.get(executionId) === pending) this.completions.delete(executionId);
      };
      // Coalesce active observers without retaining every historical output in memory.
      void pending.then(forget, forget);
    }
    const settled = this.turnSettlement(executionId);
    const result = completion.then(readExecutionResult);
    const usage = completion.then((execution) => execution.usage);
    // A turn can be used only for its event stream or metadata (for example by listTurns()).
    // Observe these derived promises eagerly so a historical failed/interrupted turn does not
    // become a process-level unhandled rejection. The original promises remain rejected for
    // callers that explicitly await them.
    void result.catch(() => undefined);
    void usage.catch(() => undefined);
    return Object.assign(view, {
      requestId,
      requestedMode,
      effectiveMode,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
      result,
      settled,
      usage,
      stopForDeletion: async (reason?: string) => await this.stopForDeletion(reason),
      cancel: async (reason?: string) => {
        const state = await this.getState();
        if (state.activeExecutionId !== executionId || this.controller === undefined) {
          throw new Error(`ExpertTurn is not active: ${executionId}`);
        }
        await this.abort(reason);
      },
      respondToHumanInteraction: async (
        interactionId: string,
        response: unknown,
        options: { readonly requestId: string },
      ) => {
        if (this.controller?.executionId === executionId) {
          await this.controller.respond(interactionId, response, options.requestId);
          this.waitingForRecoveredHumanInput =
            (await listPendingHumanInteractionIds(this.dependencies.executions, executionId))
              .length > 0;
          return;
        }
        await persistHumanInteractionResponse(
          this.dependencies.executions,
          executionId,
          interactionId,
          response,
          options.requestId,
        );
        const pendingHumanInteractionIds = await listPendingHumanInteractionIds(
          this.dependencies.executions,
          executionId,
        );
        this.waitingForRecoveredHumanInput = pendingHumanInteractionIds.length > 0;
        if (this.recoveredExecutionId === executionId && pendingHumanInteractionIds.length === 0) {
          this.paused = false;
          this.startProcessing();
        }
      },
      checkpointWaitingHuman: async () => await this.checkpointWaitingHuman(),
    });
  }

  private createExecutionView(executionId: string): StoredExecutionView {
    return new StoredExecutionView(executionId, this.dependencies.executions, this.sessionId);
  }

  private notifySettled(session: ExpertSessionRecord, prompts: readonly PromptRequest[]): void {
    for (const prompt of prompts) {
      if (session.activeExecutionId === prompt.executionId) continue;
      if (
        isFinal(prompt.status) ||
        (prompt.purpose === "human_checkpoint_recovery" && prompt.status === "queued")
      ) {
        this.settlements.get(prompt.executionId)?.resolve();
      }
    }
  }

  private turnSettlement(executionId: string): Promise<void> {
    const existing = this.settlements.get(executionId);
    if (existing !== undefined) return existing.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.settlements.set(executionId, { promise, resolve, reject });
    const forget = () => {
      if (this.settlements.get(executionId)?.promise === promise)
        this.settlements.delete(executionId);
    };
    void promise.then(forget, forget);
    void promise.catch(() => undefined);
    if (this.leaseError !== undefined) {
      reject(this.leaseError);
      return promise;
    }
    void Promise.all([this.getState(), this.getPromptQueue()]).then(
      ([session, prompts]) => this.notifySettled(session, prompts),
      reject,
    );
    return promise;
  }
}

function recoveryPrompt(originalPrompt: string): string {
  return [
    "[Pragma interrupted-turn recovery]",
    "The previous Runtime process stopped while waiting for a human interaction.",
    "Resume the interrupted work from the restored Runtime session.",
    "Recreate only the pending human-gated operation so Pragma can supply the durable response.",
    "Do not repeat work that the restored session already completed.",
    "Original user request:",
    originalPrompt,
    "[/Pragma interrupted-turn recovery]",
  ].join("\n");
}

function closeSessionContexts(session: ExpertSessionRecord): ExpertSessionRecord {
  const now = new Date().toISOString();
  return {
    ...session,
    status: "closed",
    contexts: Object.fromEntries(
      Object.entries(session.contexts).map(([contextId, context]) => [
        contextId,
        context.lifecycle === "closed"
          ? context
          : { ...context, lifecycle: "closed" as const, closedAt: now, updatedAt: now },
      ]),
    ),
    updatedAt: now,
  };
}

async function waitForTerminalExecution(
  store: ExecutionStore,
  executionId: string,
): Promise<ExecutionRecord> {
  let subscription = getExecutionLiveBus(store).subscribeEvents(executionId);
  let iterator = subscription[Symbol.asyncIterator]();
  let next = iterator.next();
  try {
    let checkState = true;
    let nextCheckAt = Date.now();
    for (;;) {
      if (checkState || Date.now() >= nextCheckAt) {
        const record = await store.get(executionId);
        if (record === undefined) throw new Error(`Execution not found: ${executionId}`);
        if (isFinal(record.status)) return record;
        checkState = false;
        nextCheckAt = Date.now() + 500;
      }
      // Subscribe before reading to avoid losing a terminal commit. Intermediate
      // metadata does not need another aggregate read; cross-process fallback
      // has a fixed deadline so a busy local stream cannot starve it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const event = await Promise.race([
        next,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), Math.max(1, nextCheckAt - Date.now()));
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (event === undefined) continue;
      if (event.done) {
        // A human checkpoint closes the in-memory stream while the durable
        // Execution stays waiting. Re-arm before reading so recovery may reuse
        // the same Execution without being mistaken for a terminal failure.
        await subscription.close();
        subscription = getExecutionLiveBus(store).subscribeEvents(executionId);
        iterator = subscription[Symbol.asyncIterator]();
        next = iterator.next();
        const record = await store.get(executionId);
        if (record === undefined) throw new Error(`Execution not found: ${executionId}`);
        if (isFinal(record.status)) return record;
        nextCheckAt = Date.now() + 500;
        checkState = false;
        continue;
      }
      checkState = /\.(succeeded|failed|cancelled|interrupted)$/.test(event.value.type);
      next = iterator.next();
    }
  } finally {
    await subscription.close();
  }
}

function readExecutionResult(record: ExecutionRecord): unknown {
  if (record.status === "succeeded") {
    return record.output === undefined ? undefined : unwrapInvocationOutput(record.output);
  }
  throw new Error(
    record.error === undefined
      ? `Execution ${record.status}: ${record.executionId}`
      : readErrorMessage(record.error),
  );
}

function serializeError(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error;
}

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}
