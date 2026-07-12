import { randomUUID } from "node:crypto";

import { RuntimeSessionRefSchema, type AgentMessage, type AgentMessageUsage } from "@pragma/shared";

import type { ExpertAgent } from "../agent/expert-agent.ts";
import type { ExpertAgentContext, ExpertAgentStartupMessage } from "../agent/context-manager.ts";
import { createExpertAgentLogger, type ExpertAgentLogger } from "../logging/logger.ts";
import { dispatchExpertAgentHook } from "../plugins/expert-agent-plugin.ts";
import { AsyncPushQueue } from "./async-push-queue.ts";
import {
  createQueuedAgentLifecycle,
  type AgentLifecycle,
  type AgentRunExecutionContext,
} from "./agent-lifecycle.ts";
import {
  createInitialRuntimePrompt,
  createRuntimeOutputRetryPrompt,
  createRuntimeRunResult,
  normalizeOutputRetryLimit,
  parseRuntimeOutput,
  summarizeRuntimeInput,
  type RuntimeOutputParseResult,
  type RuntimeOutputParser,
} from "./output.ts";
import {
  checkpointRuntimeSession,
  createCallbackRuntimeSessionPersistenceProvider,
  createNoopRuntimeSessionPersistenceProvider,
  ensureRuntimeSessionDir,
  type RuntimeCheckpointTrigger,
  type RuntimeSessionPersistenceProvider,
  type RuntimeSessionPersistenceSpec,
  watchRuntimeSessionCheckpoint,
  type RuntimeSessionWatcher,
} from "./session-persistence.ts";
import {
  createRuntimeStreamController,
  type RuntimeEventMappingContext,
  type RuntimeEventMappingResult,
  type RuntimeStreamWriter,
} from "./stream-controller.ts";
import { mergeUsage, hasNonZeroUsage } from "./usage.ts";
import { createExpertAgentRunContext, type ExpertAgentRunContext } from "./run-context.ts";
import { PragmaPaths } from "../storage/pragma-paths.ts";
import {
  createRuntimeSessionRecord,
  restoreRuntimeSessionRecord,
  updateRuntimeSessionRecord,
  type RuntimeSessionRecord,
} from "./session-record.ts";
import type {
  RuntimeAdapter,
  RuntimeAdapterDescriptor,
  RuntimeCanUseResult,
  RuntimeDriverSessionRequest,
  RuntimeOutputSchema,
  RuntimeModel,
  RuntimeRunResult,
  RuntimeSessionInfo,
  RuntimeSessionRef,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
  RuntimeSubmitHandle,
  RuntimeSubmitRequest,
} from "./runtime-adapter.ts";
import type { RuntimeStreamEvent } from "./stream-events.ts";
import {
  registerRuntimeSessionFactory,
  type OwnedRuntimeSessionRequest,
} from "./session-factory.ts";

export interface DefineRuntimeDriverOptions {
  readonly outputRetryLimit?: number | undefined;
  readonly persistenceProvider?: RuntimeSessionPersistenceProvider | undefined;
  readonly sessionRestoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
}

export interface RuntimePaths {
  readonly pragma: PragmaPaths;
  readonly systemSessionDir: string;
  readonly runtimeSessionDir: (runtimeName?: string | undefined) => string;
}

export interface RuntimePrepareContext {
  readonly agent: ExpertAgent;
  readonly request: RuntimeDriverSessionRequest;
  readonly descriptor: RuntimeAdapterDescriptor;
  readonly systemSessionId: string;
  readonly workflowRunId: string;
  readonly taskRunId?: string | undefined;
  readonly runContext: ExpertAgentRunContext;
  readonly requestedRuntimeSession?: RuntimeSessionRef | undefined;
  readonly workspace: string;
  readonly logger: ExpertAgentLogger;
  readonly paths: RuntimePaths;
}

export interface RuntimePreparedContext {
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface RuntimeDriverSessionContext<
  TPrepared = RuntimePreparedContext,
> extends RuntimePrepareContext {
  readonly agentContext: ExpertAgentContext;
  readonly lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined>;
  readonly persistence: {
    readonly spec?: RuntimeSessionPersistenceSpec | undefined;
    readonly restoredRuntimeSessionId?: string | undefined;
    readonly checkpoint: (trigger: RuntimeCheckpointTrigger) => Promise<void>;
  };
  readonly prepared: TPrepared;
  readonly sessionInfo: RuntimeSessionInfo;
}

export interface RuntimeSessionReadContext {
  readonly agent: ExpertAgent;
  readonly runContext: ExpertAgentRunContext;
}

export interface RuntimeSessionSnapshot {
  readonly runtimeSessionId?: string | undefined;
  readonly messages?: readonly AgentMessage[] | undefined;
}

export interface RuntimeTurnContext<TNativeEvent> {
  readonly runId: string;
  readonly attempt: number;
  readonly isRetry: boolean;
  readonly rawQuery: string;
  readonly prompt: string;
  readonly startupMessages: readonly ExpertAgentStartupMessage[];
  readonly modelName?: string | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly output?: RuntimeOutputSchema | undefined;
  readonly signal: AbortSignal;
  readonly source: RuntimeStreamEvent["source"];
  readonly stream: RuntimeStreamWriter<TNativeEvent>;
}

export interface RuntimeTurnResult {
  readonly outputText?: string | undefined;
  readonly usage?: AgentMessageUsage | undefined;
  readonly runtimeSessionId?: string | undefined;
}

export interface RuntimeUsageContext {
  readonly runId: string;
  readonly startedAt: Date;
  readonly outputText: string;
  readonly usage?: AgentMessageUsage | undefined;
}

export interface RuntimeCancelContext {
  readonly runId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RuntimeDestroyContext {
  readonly sessionInfo: RuntimeSessionInfo;
  readonly logger: ExpertAgentLogger;
}

export interface RuntimeDriver<TNativeEvent, TNativeSession, TPrepared = RuntimePreparedContext> {
  readonly descriptor: RuntimeAdapterDescriptor;
  readonly canUse?: (() => Promise<RuntimeCanUseResult> | RuntimeCanUseResult) | undefined;
  readonly listModels?: (() => Promise<readonly RuntimeModel[]>) | undefined;
  readonly defaultOutputParser?: RuntimeOutputParser | undefined;
  readonly outputRetryLimit?: number | undefined;
  readonly resolvePersistence?:
    | ((context: RuntimePrepareContext) => RuntimeSessionPersistenceSpec | undefined)
    | undefined;
  readonly prepare?:
    | ((context: RuntimePrepareContext) => Promise<TPrepared> | TPrepared)
    | undefined;
  readonly createSession: (
    context: RuntimeDriverSessionContext<TPrepared>,
  ) => Promise<TNativeSession> | TNativeSession;
  readonly listMessages?:
    | ((session: TNativeSession, context: RuntimeSessionReadContext) => readonly AgentMessage[])
    | undefined;
  readonly readSession?:
    | ((session: TNativeSession, context: RuntimeSessionReadContext) => RuntimeSessionSnapshot)
    | undefined;
  readonly consumeStartupMessages?:
    | ((
        session: TNativeSession,
        context: RuntimeSessionReadContext,
      ) => readonly ExpertAgentStartupMessage[])
    | undefined;
  readonly startTurn: (
    session: TNativeSession,
    turn: RuntimeTurnContext<TNativeEvent>,
  ) => Promise<RuntimeTurnResult> | RuntimeTurnResult;
  readonly mapEvent: (
    event: TNativeEvent,
    context: RuntimeEventMappingContext,
  ) => RuntimeEventMappingResult;
  readonly collectUsage?:
    | ((
        session: TNativeSession,
        context: RuntimeUsageContext,
      ) => Promise<AgentMessageUsage | undefined> | AgentMessageUsage | undefined)
    | undefined;
  readonly cancelTurn?:
    | ((session: TNativeSession, context: RuntimeCancelContext) => Promise<void> | void)
    | undefined;
  readonly destroySession?:
    | ((session: TNativeSession, context: RuntimeDestroyContext) => Promise<void> | void)
    | undefined;
}

export function defineRuntimeDriver<
  TNativeEvent,
  TNativeSession,
  TPrepared = RuntimePreparedContext,
>(
  driver: RuntimeDriver<TNativeEvent, TNativeSession, TPrepared>,
  options: DefineRuntimeDriverOptions = {},
): RuntimeAdapter {
  const createPersistenceProvider = (): RuntimeSessionPersistenceProvider =>
    options.persistenceProvider ??
    (options.sessionRestoreHandler === undefined && options.sessionSyncCallback === undefined
      ? createNoopRuntimeSessionPersistenceProvider()
      : createCallbackRuntimeSessionPersistenceProvider({
          restoreHandler: options.sessionRestoreHandler,
          syncCallback: options.sessionSyncCallback,
        }));

  const runtime: RuntimeAdapter = {
    descriptor: driver.descriptor,
    canUse: async () => (await driver.canUse?.()) ?? { usable: true },
    ...(driver.listModels === undefined ? {} : { listModels: driver.listModels }),
  };
  registerRuntimeSessionFactory(
    runtime,
    async (request) =>
      await createManagedRuntimeSession(driver, request, createPersistenceProvider()),
  );
  return runtime;
}

async function createManagedRuntimeSession<TNativeEvent, TNativeSession, TPrepared>(
  driver: RuntimeDriver<TNativeEvent, TNativeSession, TPrepared>,
  request: OwnedRuntimeSessionRequest,
  persistenceProvider: RuntimeSessionPersistenceProvider,
): Promise<ManagedRuntimeSession<TNativeEvent, TNativeSession, TPrepared>> {
  const agent = request.agent;
  const descriptor = driver.descriptor;
  const systemSessionId = request.systemSessionId ?? randomUUID();
  const runContext = createExpertAgentRunContext(request.context);
  const logger = createExpertAgentLogger(request.loggerProvider ?? agent.loggerProvider, {
    component: "runtime-adapter",
    agentId: agent.id,
    runtimeId: descriptor.id,
  });
  if (request.owner.workflowRunId.trim() === "") {
    throw new Error("Runtime session owner.workflowRunId must not be empty.");
  }
  if (request.runtimeSession !== undefined && request.systemSessionId === undefined) {
    throw new Error("Restoring a runtime session requires its original systemSessionId.");
  }
  const pragmaPaths = new PragmaPaths({ pragmaHome: request.pragmaHome ?? agent.pragmaHome });
  const paths = createRuntimePaths(
    pragmaPaths,
    request.owner.workflowRunId,
    systemSessionId,
    descriptor,
  );
  const prepareContext: RuntimePrepareContext = {
    agent,
    request,
    descriptor,
    systemSessionId,
    workflowRunId: request.owner.workflowRunId,
    ...(request.owner.taskRunId === undefined ? {} : { taskRunId: request.owner.taskRunId }),
    runContext,
    requestedRuntimeSession: request.runtimeSession,
    workspace: agent.workspace,
    logger,
    paths,
  };
  const persistenceSpec = driver.resolvePersistence?.(prepareContext);

  await assertRuntimeCanUse(driver, descriptor);
  assertRequestedRuntimeSessionMatches(request.runtimeSession, descriptor);

  let sessionRecord: RuntimeSessionRecord =
    request.runtimeSession === undefined
      ? await createRuntimeSessionRecord({
          paths: pragmaPaths,
          owner: request.owner,
          systemSessionId,
          agentId: agent.id,
          runtime: descriptor,
          workspace: agent.workspace,
        })
      : await restoreRuntimeSessionRecord({
          paths: pragmaPaths,
          owner: request.owner,
          systemSessionId,
          agentId: agent.id,
          runtime: descriptor,
          runtimeSession: request.runtimeSession,
          workspace: agent.workspace,
        });

  let restoredRuntimeSessionId: string | undefined;
  let lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined> | undefined;
  let nativeSession: TNativeSession | undefined;
  let managedSession: ManagedRuntimeSession<TNativeEvent, TNativeSession, TPrepared> | undefined;

  try {
    if (persistenceSpec?.sessionDir !== undefined) {
      await ensureRuntimeSessionDir(persistenceSpec.sessionDir);
    }

    await dispatchExpertAgentHook(agent.hooks, "beforeSessionCreate", {
      agent,
      context: runContext,
      systemSessionId,
      runtimeSession: request.runtimeSession,
      logger,
    });

    const restored = await persistenceProvider.restore({
      agentId: agent.id,
      owner: request.owner,
      runtime: descriptor,
      requestedRuntimeSession: request.runtimeSession,
      targetSessionDir: persistenceSpec?.sessionDir,
      workspace: agent.workspace,
      systemSessionId,
      context: runContext,
      metadata: persistenceSpec?.metadata,
    });
    restoredRuntimeSessionId = restored.restoredRuntimeSessionId;

    const prepared = (await driver.prepare?.(prepareContext)) ?? ({} as TPrepared);
    const agentContext = await agent.buildContext(runContext, request.contextAssembly);
    let currentRuntimeSessionId = restoredRuntimeSessionId ?? request.runtimeSession?.id ?? "";

    const readSessionInfo = (): RuntimeSessionInfo => ({
      systemSessionId,
      runtimeSession: {
        type: descriptor.kind,
        id: currentRuntimeSessionId,
      },
      agentId: agent.id,
      runtime: descriptor,
      sessionState: lifecycle?.sessionState ?? "closed",
      runState: lifecycle?.runState,
    });

    const checkpoint = async (trigger: RuntimeCheckpointTrigger): Promise<void> => {
      await checkpointRuntimeSession({
        provider: persistenceProvider,
        spec: persistenceSpec,
        trigger,
        agentId: agent.id,
        owner: request.owner,
        runtime: descriptor,
        systemSessionId,
        runtimeSessionId: currentRuntimeSessionId,
        workspace: agent.workspace,
        context: runContext,
        logger,
      });
    };

    lifecycle = createQueuedAgentLifecycle<ExpertAgentRunContext | undefined>(runContext, {
      abort: async (signal) => {
        if (nativeSession !== undefined) {
          await driver.cancelTurn?.(nativeSession, { signal });
        }
      },
      cleanup: async () => {
        const sessionInfo = readSessionInfo();
        const cleanupErrors: unknown[] = [];

        await dispatchExpertAgentHook(agent.hooks, "beforeSessionDestroy", {
          agent,
          session: sessionInfo,
          logger,
        }).catch((error: unknown) => {
          cleanupErrors.push(error);
        });
        if (nativeSession !== undefined) {
          await Promise.resolve(
            driver.destroySession?.(nativeSession, {
              sessionInfo,
              logger,
            }),
          ).catch((error: unknown) => {
            cleanupErrors.push(error);
          });
        }
        await checkpoint("session.destroyed").catch((error: unknown) => {
          cleanupErrors.push(error);
        });
        managedSession?.closeWatcher();
        const finalRuntimeSession = readSessionInfo().runtimeSession;
        try {
          sessionRecord = await updateRuntimeSessionRecord(pragmaPaths, sessionRecord, {
            runtimeSessionRef:
              finalRuntimeSession.id === "" ? sessionRecord.runtimeSessionRef : finalRuntimeSession,
            status: "closed",
          });
        } catch (error) {
          logger.error("Failed to close Runtime session record", {
            workflowRunId: request.owner.workflowRunId,
            systemSessionId,
            error,
          });
          cleanupErrors.push(error);
        }
        await dispatchExpertAgentHook(agent.hooks, "afterSessionDestroy", {
          agent,
          session: sessionInfo,
          logger,
        }).catch((error: unknown) => {
          cleanupErrors.push(error);
        });

        throwIfRuntimeCleanupFailed(cleanupErrors);
      },
    });

    const sessionContext: RuntimeDriverSessionContext<TPrepared> = {
      ...prepareContext,
      agentContext,
      lifecycle,
      persistence: {
        spec: persistenceSpec,
        restoredRuntimeSessionId,
        checkpoint,
      },
      prepared,
      sessionInfo: readSessionInfo(),
    };
    nativeSession = await driver.createSession(sessionContext);
    const snapshot = driver.readSession?.(nativeSession, { agent, runContext });
    currentRuntimeSessionId = snapshot?.runtimeSessionId ?? currentRuntimeSessionId;
    sessionRecord = await updateRuntimeSessionRecord(pragmaPaths, sessionRecord, {
      runtimeSessionRef:
        currentRuntimeSessionId === ""
          ? null
          : { type: descriptor.kind, id: currentRuntimeSessionId },
      status: "active",
    });

    managedSession = new ManagedRuntimeSession({
      agent,
      driver,
      nativeSession,
      descriptor,
      lifecycle,
      logger,
      runContext,
      systemSessionId,
      outputRetryLimit: driver.outputRetryLimit,
      defaultOutputParser: driver.defaultOutputParser,
      checkpoint,
      readSessionInfo,
      updateRuntimeSessionId: async (runtimeSessionId, trigger) => {
        if (runtimeSessionId === "" || runtimeSessionId === currentRuntimeSessionId) {
          return;
        }
        currentRuntimeSessionId = runtimeSessionId;
        sessionRecord = await updateRuntimeSessionRecord(pragmaPaths, sessionRecord, {
          runtimeSessionRef: { type: descriptor.kind, id: runtimeSessionId },
          status: "active",
        });
        await checkpoint(trigger);
      },
    });
    managedSession.setWatcher(
      persistenceSpec === undefined
        ? undefined
        : watchRuntimeSessionCheckpoint({
            spec: persistenceSpec,
            checkpoint,
            logger,
          }),
    );

    await checkpoint("session.created");
    await dispatchExpertAgentHook(agent.hooks, "afterSessionCreate", {
      agent,
      session: readSessionInfo(),
      logger,
    });

    return managedSession;
  } catch (error) {
    try {
      sessionRecord = await updateRuntimeSessionRecord(pragmaPaths, sessionRecord, {
        status: "failed",
      });
    } catch (recordError) {
      logger.error("Failed to mark Runtime session record as failed", {
        workflowRunId: request.owner.workflowRunId,
        systemSessionId,
        error: recordError,
      });
    }
    logger.error("Runtime session creation failed", { error });
    if (lifecycle !== undefined) {
      await lifecycle.abort().catch(() => undefined);
    } else {
      await dispatchExpertAgentHook(agent.hooks, "afterSessionDestroy", {
        agent,
        session: {
          systemSessionId,
          runtimeSession: {
            type: descriptor.kind,
            id: restoredRuntimeSessionId ?? request.runtimeSession?.id ?? "",
          },
          agentId: agent.id,
          runtime: descriptor,
          sessionState: "closed",
          runState: undefined,
        },
        logger,
      }).catch(() => undefined);
    }
    throw error;
  }
}

function assertRequestedRuntimeSessionMatches(
  runtimeSession: RuntimeSessionRef | undefined,
  descriptor: RuntimeAdapterDescriptor,
): void {
  if (runtimeSession === undefined || runtimeSession.type === descriptor.kind) {
    if (runtimeSession !== undefined) {
      RuntimeSessionRefSchema.parse(runtimeSession);
    }
    return;
  }

  throw new Error(
    `Runtime session type mismatch: cannot resume ${runtimeSession.type}:${runtimeSession.id} with runtime ${descriptor.kind}.`,
  );
}

async function assertRuntimeCanUse<TNativeEvent, TNativeSession, TPrepared>(
  driver: RuntimeDriver<TNativeEvent, TNativeSession, TPrepared>,
  descriptor: RuntimeAdapterDescriptor,
): Promise<void> {
  const availability = (await driver.canUse?.()) ?? { usable: true };

  if (availability.usable) {
    return;
  }

  throw new Error(createRuntimeUnavailableMessage(descriptor, availability));
}

function createRuntimeUnavailableMessage(
  descriptor: RuntimeAdapterDescriptor,
  availability: RuntimeCanUseResult,
): string {
  const reason = availability.reason?.trim();

  return reason === undefined || reason === ""
    ? `Runtime is not available: ${descriptor.displayName} (${descriptor.id}).`
    : `Runtime is not available: ${descriptor.displayName} (${descriptor.id}). ${reason}`;
}

class ManagedRuntimeSession<TNativeEvent, TNativeSession, TPrepared> {
  private watcher: RuntimeSessionWatcher | undefined;

  constructor(
    private readonly options: {
      readonly agent: ExpertAgent;
      readonly driver: RuntimeDriver<TNativeEvent, TNativeSession, TPrepared>;
      readonly nativeSession: TNativeSession;
      readonly descriptor: RuntimeAdapterDescriptor;
      readonly lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined>;
      readonly logger: ExpertAgentLogger;
      readonly runContext: ExpertAgentRunContext;
      readonly systemSessionId: string;
      readonly outputRetryLimit?: number | undefined;
      readonly defaultOutputParser?: RuntimeOutputParser | undefined;
      readonly checkpoint: (trigger: RuntimeCheckpointTrigger) => Promise<void>;
      readonly readSessionInfo: () => RuntimeSessionInfo;
      readonly updateRuntimeSessionId: (
        runtimeSessionId: string,
        trigger: RuntimeCheckpointTrigger,
      ) => Promise<void>;
    },
  ) {}

  info(): RuntimeSessionInfo {
    return this.options.readSessionInfo();
  }

  messages(): readonly AgentMessage[] {
    return (
      this.options.driver.listMessages?.(this.options.nativeSession, {
        agent: this.options.agent,
        runContext: this.options.runContext,
      }) ?? []
    );
  }

  submit<TOutput = string>(
    submission: RuntimeSubmitRequest<TOutput>,
  ): RuntimeSubmitHandle<TOutput> {
    const runId = submission.runId ?? randomUUID();
    const queue = new AsyncPushQueue<RuntimeStreamEvent>();
    let cancelled = false;
    const controller = createRuntimeStreamController<TNativeEvent>({
      agent: this.options.agent,
      queue,
      runId,
      session: () => this.info(),
      context: this.options.runContext,
      logger: this.options.logger,
      mapEvent: this.options.driver.mapEvent,
      mergeUsage,
    });

    const result = this.options.lifecycle.enqueue(async ({ signal }) => {
      try {
        await dispatchExpertAgentHook(this.options.agent.hooks, "beforeTaskSubmit", {
          agent: this.options.agent,
          session: this.info(),
          runId,
          submission,
          context: this.options.runContext,
          logger: this.options.logger,
        });

        controller.writer.write({
          runId,
          source: controller.source,
          type: "run.started",
          payload: {
            task: submission.query,
            inputSummary: summarizeRuntimeInput(submission.query),
          },
        });

        const runResult = await this.executeSubmission(runId, submission, signal, controller);

        controller.writer.write({
          runId,
          source: controller.source,
          type: "run.completed",
          payload: runResult.result.usage === undefined ? {} : { usage: runResult.result.usage },
        });
        await dispatchExpertAgentHook(this.options.agent.hooks, "afterTaskSubmit", {
          agent: this.options.agent,
          session: this.info(),
          runId,
          submission,
          result: runResult,
          context: this.options.runContext,
          logger: this.options.logger,
        });
        await this.options.checkpoint("turn.completed");

        return runResult;
      } catch (error) {
        const wasCancelled = signal.aborted || cancelled;
        const message = error instanceof Error ? error.message : "Runtime run failed.";
        const errorMetadata = readRuntimeErrorMetadata(error);

        controller.writer.write({
          runId,
          source: controller.source,
          type: wasCancelled ? "run.cancelled" : "run.failed",
          payload: wasCancelled
            ? { reason: "cancelled" }
            : {
                message,
                ...(errorMetadata.code === undefined ? {} : { code: errorMetadata.code }),
                ...(errorMetadata.retryable === undefined
                  ? {}
                  : { retryable: errorMetadata.retryable }),
              },
        });
        await dispatchExpertAgentHook(this.options.agent.hooks, "afterTaskSubmit", {
          agent: this.options.agent,
          session: this.info(),
          runId,
          submission,
          error,
          context: this.options.runContext,
          logger: this.options.logger,
        });
        await this.options.checkpoint("turn.failed");
        throw error;
      } finally {
        await controller.complete();
      }
    });

    return {
      runId,
      events: queue,
      result,
      cancel: async () => {
        cancelled = true;
        await this.options.driver.cancelTurn?.(this.options.nativeSession, {
          runId,
          signal: this.options.lifecycle.currentSignal,
        });
        await this.options.lifecycle.abort();
      },
    };
  }

  async abort(): Promise<void> {
    await this.options.driver.cancelTurn?.(this.options.nativeSession, {
      signal: this.options.lifecycle.currentSignal,
    });
    await this.options.lifecycle.abort();
  }

  setWatcher(watcher: RuntimeSessionWatcher | undefined): void {
    this.watcher = watcher;
  }

  closeWatcher(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private async executeSubmission<TOutput>(
    runId: string,
    submission: RuntimeSubmitRequest<TOutput>,
    signal: AgentRunExecutionContext["signal"],
    controller: ReturnType<typeof createRuntimeStreamController<TNativeEvent>>,
  ): Promise<RuntimeRunResult<TOutput>> {
    const startupMessages =
      this.options.driver.consumeStartupMessages?.(this.options.nativeSession, {
        agent: this.options.agent,
        runContext: this.options.runContext,
      }) ?? [];
    const maxAttempts =
      submission.output === undefined
        ? 1
        : normalizeOutputRetryLimit(submission.outputRetryLimit ?? this.options.outputRetryLimit) +
          1;
    let parseResult: RuntimeOutputParseResult<TOutput> | undefined;
    let outputText = "";
    let usage: AgentMessageUsage | undefined;
    const startedAt = new Date();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt =
        attempt === 1
          ? createInitialRuntimePrompt(submission.query, submission.output)
          : createRuntimeOutputRetryPrompt(parseResult);
      controller.resetCapture();
      const turnResult = await this.options.driver.startTurn(this.options.nativeSession, {
        runId,
        attempt,
        isRetry: attempt > 1,
        rawQuery: submission.query,
        prompt,
        startupMessages: attempt === 1 ? startupMessages : [],
        modelName: submission.modelName,
        thinkingLevel: submission.thinkingLevel,
        output: submission.output,
        signal,
        source: controller.source,
        stream: controller.writer,
      });
      outputText = turnResult.outputText ?? controller.getOutputText();
      usage = mergeUsage(controller.getUsage(), turnResult.usage);

      const runtimeSessionId = turnResult.runtimeSessionId ?? controller.getRuntimeSessionId();
      if (runtimeSessionId !== undefined) {
        await this.options.updateRuntimeSessionId(runtimeSessionId, "runtimeSessionId.changed");
      }

      parseResult = parseRuntimeOutput(
        outputText,
        submission.output,
        this.options.defaultOutputParser,
      );

      if (parseResult.ok) {
        break;
      }

      if (attempt === maxAttempts) {
        throw parseResult.error;
      }
    }

    if (parseResult === undefined || !parseResult.ok) {
      throw new Error("Runtime output parsing did not complete.");
    }

    if (!hasNonZeroUsage(usage)) {
      usage =
        (await this.options.driver.collectUsage?.(this.options.nativeSession, {
          runId,
          startedAt,
          outputText,
          usage,
        })) ?? usage;
    }

    return createRuntimeRunResult(runId, parseResult.value, usage);
  }
}

function createRuntimePaths(
  pragma: PragmaPaths,
  workflowRunId: string,
  systemSessionId: string,
  descriptor: RuntimeAdapterDescriptor,
): RuntimePaths {
  return {
    pragma,
    systemSessionDir: pragma.systemSessionRoot(workflowRunId, systemSessionId),
    runtimeSessionDir(runtimeName = descriptor.kind) {
      return pragma.runtimeRoot(workflowRunId, systemSessionId, runtimeName);
    },
  };
}

function throwIfRuntimeCleanupFailed(errors: readonly unknown[]): void {
  if (errors.length === 0) {
    return;
  }

  if (errors.length === 1) {
    throw errors[0];
  }

  throw new AggregateError(errors, "Runtime session cleanup failed.");
}

function readRuntimeErrorMetadata(error: unknown): {
  readonly code?: string | undefined;
  readonly retryable?: boolean | undefined;
} {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const record = error as { readonly code?: unknown; readonly retryable?: unknown };
  return {
    ...(typeof record.code === "string" && record.code.trim() !== "" ? { code: record.code } : {}),
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
  };
}
