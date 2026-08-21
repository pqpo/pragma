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
import type { ExpertAgentAutomaticHumanInteractionHandler } from "../tools/managed-tool.ts";
import {
  ExecutionController,
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
import type { ExecutionStore } from "./execution-store.ts";
import {
  closeExecutionContexts,
  type ContextResolutionScopeSnapshot,
} from "./context-resolution-service.ts";
import type { ExpertSessionStore } from "./expert-session-store.ts";
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
}

export interface ResumeExpertSessionOptions {
  readonly sessionId: string;
  readonly definitionMigration?:
    | {
        readonly previousExpertId: string;
        readonly previousRootExpertId?: string | undefined;
        readonly reason: string;
      }
    | undefined;
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
  readonly usage: Promise<AgentMessageUsage | undefined>;
}

export interface PromptQueueState {
  readonly state: "idle" | "running" | "paused";
  readonly pendingCount: number;
  readonly pausedAfterRequestId?: string | undefined;
}

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
  steerQueuedPrompt(requestId: string): Promise<ExpertTurn>;
  removeQueuedPrompt(requestId: string, reason?: string): Promise<void>;
  resumePromptQueue(): Promise<void>;
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
  readonly sessions: ExpertSessionStore;
  readonly executions: ExecutionStore;
  readonly runtimes: RuntimeResolver;
  readonly loggerProvider: PragmaLoggerProvider;
  readonly usageSink?: UsageSink | undefined;
  readonly pragmaHome?: string | undefined;
  readonly automaticHumanInteractionHandler?:
    ExpertAgentAutomaticHumanInteractionHandler | undefined;
  readonly hostContextBindings?: HostContextBindings | undefined;
  readonly resolveHostContextBindings?: HostContextBindingsResolver | undefined;
}

type SteerClaim =
  | { readonly execute: false; readonly executionId: string }
  | {
      readonly execute: true;
      readonly executionId: string;
      readonly contextId: string;
      readonly replacedExecutionId?: string | undefined;
    };

interface ValidDefinitionMigration {
  readonly previousExpertId: string;
  readonly previousRootExpertId: string;
  readonly reason: string;
}

const EXPERT_SESSION_LEASE_MS = 30_000;
const EXPERT_SESSION_LEASE_RENEWAL_MS = 10_000;

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
      schemaVersion: "pragma.expert-session/v5",
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
    const session = this.createActiveSession(expert, sessionId, false, claimId);
    this.active.set(sessionId, session);
    return session;
  }

  async resumeSession(
    expert: ExpertDefinition,
    request: ResumeExpertSessionOptions,
  ): Promise<ExpertSession> {
    const existing = this.active.get(request.sessionId);
    if (existing !== undefined) return existing;
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
      if (record.activeExecutionId !== undefined) {
        const execution = await this.dependencies.executions.get(record.activeExecutionId);
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
          await this.dependencies.executions.update(execution.executionId, {
            status: "waiting",
          });
          for (const invocation of await this.dependencies.executions.listInvocations(
            execution.executionId,
          )) {
            if (!isFinal(invocation.status)) {
              await this.dependencies.executions.putInvocation(execution.executionId, {
                ...invocation,
                status: "waiting",
                updatedAt: new Date().toISOString(),
              });
            }
          }
          await this.dependencies.sessions.transact(request.sessionId, ({ session, prompts }) => ({
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
                ? { ...prompt, status: "queued" as const, updatedAt: new Date().toISOString() }
                : prompt,
            ),
          }));
        } else {
          const activeExecutionId = record.activeExecutionId;
          if (execution !== undefined && !isFinal(execution.status)) {
            await this.dependencies.executions.update(execution.executionId, {
              status: "interrupted",
            });
            for (const invocation of await this.dependencies.executions.listInvocations(
              execution.executionId,
            )) {
              if (!isFinal(invocation.status)) {
                await this.dependencies.executions.putInvocation(execution.executionId, {
                  ...invocation,
                  status: "interrupted",
                  updatedAt: new Date().toISOString(),
                });
              }
            }
          }
          await this.dependencies.sessions.transact(request.sessionId, ({ session, prompts }) => ({
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
          }));
        }
      }
      const session = this.createActiveSession(
        expert,
        request.sessionId,
        true,
        claimId,
        recoveredExecutionId,
        recoveredHumanInteractionIds,
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
          const paths = new PragmaPaths(
            this.dependencies.pragmaHome === undefined
              ? {}
              : { pragmaHome: this.dependencies.pragmaHome },
          );
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
    );
  }

  private createActiveSession(
    expert: ExpertDefinition,
    sessionId: string,
    paused: boolean,
    claimId: string,
    recoveredExecutionId?: string,
    recoveredHumanInteractionIds: readonly string[] = [],
  ): ExpertSessionImpl {
    const session = new ExpertSessionImpl(
      expert,
      this.dependencies,
      sessionId,
      paused,
      claimId,
      recoveredExecutionId,
      recoveredHumanInteractionIds,
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
  private controller: ExecutionController | undefined;
  private processing: Promise<void> | undefined;
  private readonly runtimeSessions = new RuntimeSessionPool();
  private closePromise: Promise<void> | undefined;
  private leaseRenewalTask: Promise<void> | undefined;
  private leaseError: Error | undefined;
  private readonly leaseRenewal: ReturnType<typeof setInterval>;

  constructor(
    readonly expert: ExpertDefinition,
    private readonly dependencies: ExpertSessionManagerDependencies,
    readonly sessionId: string,
    private paused: boolean,
    private readonly claimId: string,
    private readonly recoveredExecutionId: string | undefined,
    private readonly recoveredHumanInteractionIds: readonly string[],
    private readonly onClosed: () => void,
  ) {
    this.leaseRenewal = setInterval(() => {
      if (this.leaseRenewalTask === undefined) {
        this.leaseRenewalTask = this.renewLease().finally(() => {
          this.leaseRenewalTask = undefined;
        });
      }
    }, EXPERT_SESSION_LEASE_RENEWAL_MS);
    this.leaseRenewal.unref();
  }

  async prompt(content: string, options: PromptOptions = {}): Promise<ExpertTurn> {
    if (this.leaseError !== undefined) throw this.leaseError;
    if (this.closePromise !== undefined) {
      throw new Error(`ExpertSession is closing or closed: ${this.sessionId}`);
    }
    if (content.trim() === "") throw new Error("Prompt content must not be empty.");
    const requestId = options.requestId ?? randomUUID();
    if (requestId.trim() === "") throw new Error("Prompt requestId must not be empty.");
    const mode = options.mode ?? "enqueue";

    if (mode === "steer") {
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
        if (options.steerFallback !== "enqueue") throw error;
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
    const storedInput =
      attachments.length === 0 ? content : createExpertPromptInput(content, attachments);
    const definitionKind = isExpertTeam(this.expert) ? "expert-team" : "expert";
    const execution: ExecutionRecord = {
      schemaVersion: "pragma.execution/v9",
      executionId: id,
      version: 0,
      kind: "expert-turn",
      definition: { id: this.expert.id, kind: definitionKind },
      rootInvocationId: id,
      status: "queued",
      input: storedInput,
      state: {},
      lastAppliedSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    const prompt: PromptRequest = {
      requestId,
      sessionId: this.sessionId,
      content,
      mode: "enqueue",
      executionId: id,
      status: "queued",
      ...(modelSelection === undefined ? {} : { modelSelection }),
      createdAt: now,
      updatedAt: now,
    };
    const executionId = await this.dependencies.sessions.enqueue({
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
    await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: { ...session, activeExecutionId: undefined, updatedAt: new Date().toISOString() },
      prompts: prompts.map((prompt) =>
        prompt.executionId === session.activeExecutionId && prompt.status === "running"
          ? { ...prompt, status: "cancelled" as const, updatedAt: new Date().toISOString() }
          : prompt,
      ),
    }));
    this.startProcessing();
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

  close(reason?: string): Promise<void> {
    if (this.closePromise === undefined) {
      this.paused = true;
      clearInterval(this.leaseRenewal);
      this.runtimeSessions.seal();
      this.closePromise = this.closeInternal(reason);
    }
    return this.closePromise;
  }

  private async closeInternal(reason?: string): Promise<void> {
    const errors: unknown[] = [];
    try {
      const pending = (await this.getPromptQueue()).filter(
        (prompt) => prompt.status === "queued" || prompt.status === "running",
      );
      await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
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
      await this.controller?.cancel(reason);
      for (const prompt of pending) {
        const execution = await this.dependencies.executions.get(prompt.executionId);
        if (execution !== undefined && !isFinal(execution.status)) {
          await this.dependencies.executions.update(prompt.executionId, {
            status: "cancelled",
            error: reason,
          });
          for (const invocation of await this.dependencies.executions.listInvocations(
            prompt.executionId,
          )) {
            if (!isFinal(invocation.status)) {
              await this.dependencies.executions.putInvocation(prompt.executionId, {
                ...invocation,
                status: "cancelled",
                error: reason,
                updatedAt: new Date().toISOString(),
              });
            }
          }
        }
      }
      await this.processing;
      const session = await this.getState();
      for (const executionId of session.executionIds) {
        await closeExecutionContexts(this.dependencies.executions, executionId);
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.runtimeSessions.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) {
      try {
        await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
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
    try {
      const renewed = await this.dependencies.sessions.claimLease(
        this.sessionId,
        this.claimId,
        EXPERT_SESSION_LEASE_MS,
      );
      if (!renewed) throw new Error(`ExpertSession lease was lost: ${this.sessionId}`);
    } catch (error) {
      this.leaseError = error instanceof Error ? error : new Error(String(error));
      this.paused = true;
      await this.controller?.cancel(this.leaseError.message).catch(() => undefined);
    }
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
    const paths = new PragmaPaths(
      this.dependencies.pragmaHome === undefined
        ? {}
        : { pragmaHome: this.dependencies.pragmaHome },
    );
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
    if (this.closePromise !== undefined) {
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
        prompt.mode === "enqueue" && (prompt.status === "queued" || prompt.status === "running"),
    );
    const lastControl = [...events]
      .reverse()
      .find((event) =>
        ["prompt.queue-paused", "prompt.queue-resumed", "prompt.queue-cleared"].includes(
          event.type,
        ),
      );
    const paused =
      lastControl?.type === "prompt.queue-paused" &&
      pending.some((prompt) => prompt.status === "queued");
    const pausedRequestId = (lastControl?.data as { requestId?: unknown } | undefined)?.requestId;
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

  async resumePromptQueue(): Promise<void> {
    if ((await this.getPromptQueueState()).state !== "paused") return;
    await this.dependencies.sessions.appendEvent(this.sessionId, {
      eventId: `prompt-queue-resumed:${randomUUID()}`,
      type: "prompt.queue-resumed",
      data: {},
    });
    this.paused = false;
    this.startProcessing();
  }

  async steerQueuedPrompt(requestId: string): Promise<ExpertTurn> {
    const prompt = (await this.getPromptQueue()).find(
      (candidate) => candidate.requestId === requestId,
    );
    if (prompt?.mode !== "enqueue" || prompt.status !== "queued") {
      throw new Error(`Queued prompt not found: ${requestId}`);
    }
    const invocation = await this.dependencies.executions.getInvocation(
      prompt.executionId,
      prompt.executionId,
    );
    if (readExpertPromptInput(invocation?.input, prompt.content).attachments.length > 0) {
      throw new Error("A queued prompt with attachments cannot be steered.");
    }
    return await this.steer(prompt.content, requestId);
  }

  async removeQueuedPrompt(requestId: string, reason?: string): Promise<void> {
    const cancellationReason = reason ?? "Removed from prompt queue.";
    const now = new Date().toISOString();
    const executionId = await this.dependencies.sessions.transact<string>(
      this.sessionId,
      ({ session, prompts }) => {
        const prompt = prompts.find((candidate) => candidate.requestId === requestId);
        if (prompt?.mode !== "enqueue" || prompt.status !== "queued") {
          throw new Error(`Queued prompt not found: ${requestId}`);
        }
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
    this.paused = true;
    const cancellationReason = reason ?? "Prompt queue cleared.";
    const pending = (await this.getPromptQueue()).filter(
      (prompt) => prompt.status === "queued" || prompt.status === "running",
    );
    await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
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
    }));
    await this.dependencies.sessions.appendEvent(this.sessionId, {
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
    this.paused = false;
  }

  private async cancelPersistedExecution(executionId: string, reason: string): Promise<void> {
    const execution = await this.dependencies.executions.get(executionId);
    if (execution === undefined || isFinal(execution.status)) return;
    await this.dependencies.executions.update(executionId, {
      status: "cancelled",
      error: reason,
    });
    for (const invocation of await this.dependencies.executions.listInvocations(executionId)) {
      if (!isFinal(invocation.status)) {
        await this.dependencies.executions.putInvocation(executionId, {
          ...invocation,
          status: "cancelled",
          error: reason,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  private async getRootContext(state?: ExpertSessionRecord): Promise<RuntimeContextRecord> {
    const session = state ?? (await this.getState());
    const context = session.contexts[session.rootContextId];
    if (context === undefined) throw new Error("ExpertSession root Context is missing.");
    return context;
  }

  private async steer(content: string, requestId: string): Promise<ExpertTurn> {
    const controller = await this.waitForSteerController();
    const now = new Date().toISOString();
    const claim = await this.dependencies.sessions.transact<SteerClaim>(
      this.sessionId,
      ({ session, prompts }) => {
        if (session.status === "closed") {
          throw new Error(`ExpertSession is closed: ${this.sessionId}`);
        }
        if (session.activeExecutionId === undefined) {
          throw new Error("Cannot steer without an active ExpertTurn.");
        }
        const duplicate = prompts.find((prompt) => prompt.requestId === requestId);
        if (duplicate !== undefined) {
          if (
            duplicate.content === content &&
            duplicate.mode === "enqueue" &&
            duplicate.status === "queued"
          ) {
            const contextId = session.rootContextId;
            const executionId = session.activeExecutionId;
            return {
              result: {
                execute: true as const,
                executionId,
                contextId,
                replacedExecutionId: duplicate.executionId,
              },
              session: {
                ...session,
                queuedRequestIds: session.queuedRequestIds.filter((id) => id !== requestId),
                updatedAt: now,
              },
              prompts: prompts.map((prompt) =>
                prompt.requestId === requestId
                  ? {
                      ...prompt,
                      mode: "steer" as const,
                      executionId,
                      targetExecutionId: executionId,
                      status: "running" as const,
                      error: undefined,
                      updatedAt: now,
                    }
                  : prompt,
              ),
            };
          }
          if (duplicate.content !== content || duplicate.mode !== "steer") {
            throw new Error(`Prompt idempotency conflict: ${requestId}`);
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
        const contextId = session.rootContextId;
        const executionId = session.activeExecutionId;
        return {
          result: { execute: true as const, executionId, contextId },
          session: { ...session, updatedAt: now },
          prompts: [
            ...prompts,
            {
              requestId,
              sessionId: this.sessionId,
              content,
              mode: "steer" as const,
              executionId,
              targetExecutionId: executionId,
              status: "running" as const,
              createdAt: now,
              updatedAt: now,
            },
          ],
        };
      },
    );
    if (!claim.execute) return this.createTurn(claim.executionId, requestId, "steer", "steer");
    try {
      if (claim.replacedExecutionId !== undefined) {
        await this.cancelPersistedExecution(
          claim.replacedExecutionId,
          "Moved from the prompt queue to steer the active turn.",
        );
      }
      const current = await this.getState();
      if (this.controller !== controller || current.activeExecutionId !== claim.executionId) {
        throw new Error(`ExpertTurn changed before steer: ${claim.executionId}`);
      }
      await controller.steer(claim.contextId, {
        requestId,
        content,
        targetRunId: claim.executionId,
      });
      await this.completeSteer(requestId, "succeeded");
      return this.createTurn(claim.executionId, requestId, "steer", "steer");
    } catch (error) {
      await this.completeSteer(
        requestId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async completeSteer(
    requestId: string,
    status: "succeeded" | "failed",
    error?: string,
  ): Promise<void> {
    await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
      result: undefined,
      session: { ...session, updatedAt: new Date().toISOString() },
      prompts: prompts.map((prompt) =>
        prompt.requestId === requestId
          ? {
              ...prompt,
              status,
              ...(error === undefined ? {} : { error }),
              updatedAt: new Date().toISOString(),
            }
          : prompt,
      ),
    }));
  }

  private async waitForSteerController(): Promise<ExecutionController> {
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
      if (!canBecomeActive) {
        throw new Error("Cannot steer without an active ExpertTurn.");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("ExpertTurn did not become active before steer timed out.");
  }

  private startProcessing(): void {
    if (this.paused || this.processing !== undefined) return;
    this.processing = this.processQueue().finally(() => {
      this.processing = undefined;
      if (!this.paused) void this.restartProcessingIfQueued();
    });
  }

  private async restartProcessingIfQueued(): Promise<void> {
    if ((await this.getPromptQueue()).some((prompt) => prompt.status === "queued")) {
      this.startProcessing();
    }
  }

  private async processQueue(): Promise<void> {
    while (true) {
      const prompts = await this.getPromptQueue();
      const next = prompts.find((prompt) => prompt.status === "queued");
      if (next === undefined) return;
      const status = await this.runPrompt(next).catch(() => "failed" as const);
      if (status === "failed") {
        const hasQueued = (await this.getPromptQueue()).some(
          (prompt) => prompt.mode === "enqueue" && prompt.status === "queued",
        );
        if (hasQueued) {
          this.paused = true;
          await this.dependencies.sessions.appendEvent(this.sessionId, {
            eventId: `prompt-queue-paused:${next.requestId}`,
            type: "prompt.queue-paused",
            data: { requestId: next.requestId, status },
          });
        }
        return;
      }
    }
  }

  private async runPrompt(prompt: PromptRequest): Promise<"succeeded" | "failed" | "cancelled"> {
    const now = new Date().toISOString();
    const claimed = await this.dependencies.sessions.transact(
      this.sessionId,
      ({ session, prompts }) => {
        const current = prompts.find((candidate) => candidate.requestId === prompt.requestId);
        if (current?.mode !== "enqueue" || current.status !== "queued") {
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
      },
    );
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
    const rootContextId = session.rootContextId;
    const rootContext = session.contexts[rootContextId];
    if (rootContext === undefined) throw new Error("ExpertSession root Context is missing.");
    const rootInvocation = await this.dependencies.executions.getInvocation(
      prompt.executionId,
      prompt.executionId,
    );
    const promptInput = readExpertPromptInput(rootInvocation?.input, prompt.content);
    const controller = new ExecutionController(
      prompt.executionId,
      this.dependencies.executions,
      this.runtimeSessions,
      {
        ...(this.recoveredExecutionId === prompt.executionId
          ? { recoverHumanInteractionIds: this.recoveredHumanInteractionIds }
          : {}),
        automaticHumanInteractionHandler: this.dependencies.automaticHumanInteractionHandler,
      },
    );
    this.controller = controller;
    let status: "succeeded" | "failed" | "cancelled" = "succeeded";
    let output: ReturnType<typeof InvocationOutputSchema.parse> | undefined;
    let error: unknown;
    try {
      output = InvocationOutputSchema.parse(
        await runExpertInvocation({
          executionId: prompt.executionId,
          invocationId: prompt.executionId,
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
          ...(this.recoveredExecutionId === prompt.executionId
            ? { runtimeRunId: `${prompt.executionId}:recovery:${randomUUID()}` }
            : {}),
          ...(prompt.modelSelection === undefined ? {} : { modelSelection: prompt.modelSelection }),
          persistContext: async (context) => await this.persistRuntimeContext(context),
          readContextScope: async () => await this.readRuntimeContextScope(),
        }),
      );
    } catch (caught) {
      status = controller.isCancelled() ? "cancelled" : "failed";
      error = status === "cancelled" ? (controller.getCancellationReason() ?? caught) : caught;
    }
    const usage = controller.getUsage();
    const executionPatch = {
      status,
      ...(usage === undefined ? {} : { usage }),
      ...(status === "succeeded" ? { output } : { error: serializeError(error) }),
    };
    const currentExecution = await this.dependencies.executions.get(prompt.executionId);
    if (currentExecution !== undefined && isFinal(currentExecution.status)) {
      if (usage !== undefined) {
        await this.dependencies.executions.update(prompt.executionId, { usage });
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
    await this.dependencies.sessions.transact(this.sessionId, ({ session: current, prompts }) => ({
      result: undefined,
      session: {
        ...current,
        activeExecutionId: undefined,
        lastStatus: status,
        updatedAt: new Date().toISOString(),
      },
      prompts: prompts.map((candidate) =>
        candidate.requestId === prompt.requestId
          ? { ...candidate, status, updatedAt: new Date().toISOString() }
          : candidate,
      ),
    }));
    if (this.controller === controller) {
      this.controller = undefined;
    }
    controller.finish();
    return status;
  }

  private async persistRuntimeContext(context: RuntimeContextRecord): Promise<void> {
    await this.dependencies.sessions.transact(this.sessionId, ({ session, prompts }) => ({
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
    const completion = waitForTerminalExecution(this.dependencies.executions, executionId);
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
      usage,
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
          return;
        }
        await persistHumanInteractionResponse(
          this.dependencies.executions,
          executionId,
          interactionId,
          response,
          options.requestId,
        );
        if (
          this.recoveredExecutionId === executionId &&
          (await listPendingHumanInteractionIds(this.dependencies.executions, executionId))
            .length === 0
        ) {
          this.paused = false;
          this.startProcessing();
        }
      },
    });
  }

  private createExecutionView(executionId: string): StoredExecutionView {
    return new StoredExecutionView(executionId, this.dependencies.executions, this.sessionId);
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
  while (true) {
    const record = await store.get(executionId);
    if (record === undefined) throw new Error(`Execution not found: ${executionId}`);
    if (
      record.status === "succeeded" ||
      record.status === "failed" ||
      record.status === "cancelled" ||
      record.status === "interrupted"
    )
      return record;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
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
