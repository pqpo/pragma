import { randomUUID } from "node:crypto";

import { RuntimeSessionRefSchema, type AgentMessage, type AgentMessageUsage } from "@pragma/shared";

import type { Expert } from "../agent/expert-agent.ts";
import type { ExpertAgentContext, ExpertAgentStartupMessage } from "../agent/context-manager.ts";
import { createPragmaLogger, type PragmaLogger } from "../logging/logger.ts";
import { dispatchExpertAgentHook } from "../plugins/expert-agent-plugin.ts";
import type { ExpertAgentProcessEnvironmentPatch } from "../plugins/expert-agent-plugin.ts";
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
  RuntimeContextWindowUsage,
  RuntimeDriverSessionRequest,
  RuntimeOutputSchema,
  RuntimeModel,
  RuntimeModelSelection,
  RuntimeRunResult,
  RuntimeSessionInfo,
  RuntimeSessionRef,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
  RuntimeSubmitHandle,
  RuntimeSubmitRequest,
  RuntimeTaskSubmission,
} from "./runtime-adapter.ts";
import type { RuntimeStreamEvent } from "./stream-events.ts";
import { registerRuntimeSessionFactory } from "./session-factory.ts";
import type {
  ExpertAgentHumanInteractionHandler,
  ExpertToolExecutionContext,
} from "../tools/managed-tool.ts";

export interface DefineRuntimeDriverOptions {
  readonly outputRetryLimit?: number | undefined;
  readonly persistenceProvider?: RuntimeSessionPersistenceProvider | undefined;
  readonly sessionRestoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
  readonly createProcessEnvironment?: (() => NodeJS.ProcessEnv) | undefined;
}

export interface RuntimePaths {
  readonly pragma: PragmaPaths;
  readonly systemSessionDir: string;
  readonly runtimeSessionDir: (runtimeName?: string | undefined) => string;
}

export interface RuntimePrepareContext {
  readonly agent: Expert;
  readonly request: RuntimeDriverSessionRequest;
  readonly descriptor: RuntimeAdapterDescriptor;
  readonly systemSessionId: string;
  readonly owner: RuntimeDriverSessionRequest["owner"];
  readonly runContext: ExpertAgentRunContext;
  readonly requestedRuntimeSession?: RuntimeSessionRef | undefined;
  readonly workspace: string;
  readonly logger: PragmaLogger;
  readonly paths: RuntimePaths;
  readonly processEnvironment: Readonly<NodeJS.ProcessEnv>;
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
  readonly agent: Expert;
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
  readonly modelSelection?: RuntimeModelSelection | undefined;
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

export interface RuntimeCloseContext {
  readonly sessionInfo: RuntimeSessionInfo;
  readonly logger: PragmaLogger;
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
  readonly restoreSession?:
    | ((
        context: RuntimeDriverSessionContext<TPrepared>,
      ) => Promise<TNativeSession> | TNativeSession)
    | undefined;
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
  readonly readContextWindow?:
    | ((
        session: TNativeSession,
      ) => Promise<RuntimeContextWindowUsage | undefined> | RuntimeContextWindowUsage | undefined)
    | undefined;
  readonly canCompactContext?:
    | ((session: TNativeSession) => Promise<boolean> | boolean)
    | undefined;
  readonly compactContext?:
    | ((
        session: TNativeSession,
      ) => Promise<RuntimeContextWindowUsage | undefined> | RuntimeContextWindowUsage | undefined)
    | undefined;
  readonly cancelTurn?:
    | ((session: TNativeSession, context: RuntimeCancelContext) => Promise<void> | void)
    | undefined;
  readonly steerTurn?:
    | ((
        session: TNativeSession,
        request: {
          readonly requestId: string;
          readonly content: string;
          readonly targetRunId: string;
        },
      ) => Promise<void> | void)
    | undefined;
  readonly closeSession?:
    | ((session: TNativeSession, context: RuntimeCloseContext) => Promise<void> | void)
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

  const descriptor: RuntimeAdapterDescriptor = {
    ...driver.descriptor,
    capabilities: {
      ...driver.descriptor.capabilities,
      supportsResume: true,
      supportsSteer: driver.steerTurn !== undefined,
      supportsCancel: driver.cancelTurn !== undefined,
      supportsClose: true,
      supportsContextWindowInspection: driver.readContextWindow !== undefined,
      supportsManualCompaction: driver.compactContext !== undefined,
    },
  };
  const runtime: RuntimeAdapter = {
    descriptor,
    canUse: async () => (await driver.canUse?.()) ?? { usable: true },
    ...(driver.listModels === undefined ? {} : { listModels: driver.listModels }),
  };
  registerRuntimeSessionFactory(
    runtime,
    async (request) =>
      await createManagedRuntimeSession(
        driver,
        request,
        createPersistenceProvider(),
        options.createProcessEnvironment,
      ),
  );
  return runtime;
}

async function createManagedRuntimeSession<TNativeEvent, TNativeSession, TPrepared>(
  driver: RuntimeDriver<TNativeEvent, TNativeSession, TPrepared>,
  request: RuntimeDriverSessionRequest,
  persistenceProvider: RuntimeSessionPersistenceProvider,
  createProcessEnvironment: (() => NodeJS.ProcessEnv) | undefined,
): Promise<ManagedRuntimeSession<TNativeEvent, TNativeSession, TPrepared>> {
  const executionBindings = new RuntimeExecutionBindings({
    humanInteractionHandler: request.humanInteractionHandler,
    executionContext: request.executionContext,
  });
  request = executionBindings.bindRequest(request);
  const agent = request.agent;
  const descriptor = driver.descriptor;
  const systemSessionId = request.systemSessionId ?? randomUUID();
  const runContext = createExpertAgentRunContext(request.context);
  const logger = createPragmaLogger(request.loggerProvider ?? agent.loggerProvider, {
    component: "runtime.adapter",
    scope: {
      agentId: agent.id,
      runtimeId: descriptor.id,
      systemSessionId,
    },
  });
  const sessionStartedAt = performance.now();
  logger.info("runtime.session_prepare_started", "Runtime Session preparation started", {
    restoring: request.runtimeSession !== undefined,
  });
  if (request.owner.ownerId.trim() === "") {
    throw new Error("Runtime Session ownerId must not be empty.");
  }
  if (request.runtimeSession !== undefined && request.systemSessionId === undefined) {
    throw new Error("Restoring a runtime session requires its original systemSessionId.");
  }
  const pragmaPaths = new PragmaPaths({ pragmaHome: request.pragmaHome ?? agent.pragmaHome });
  const paths = createRuntimePaths(pragmaPaths, request.owner.ownerId, systemSessionId, descriptor);
  const baseProcessEnvironment = freezeProcessEnvironment(
    createProcessEnvironment?.() ?? process.env,
  );
  let prepareContext: RuntimePrepareContext = {
    agent,
    request,
    descriptor,
    systemSessionId,
    owner: request.owner,
    runContext,
    requestedRuntimeSession: request.runtimeSession,
    workspace: agent.workspace,
    logger,
    paths,
    processEnvironment: baseProcessEnvironment,
  };
  const persistenceSpec = driver.resolvePersistence?.(prepareContext);

  let phaseStartedAt = performance.now();
  await assertRuntimeCanUse(driver, descriptor);
  logRuntimePhase(logger, "runtime.can_use", phaseStartedAt, sessionStartedAt);
  assertRequestedRuntimeSessionMatches(request.runtimeSession, descriptor);

  phaseStartedAt = performance.now();
  let sessionRecord: RuntimeSessionRecord;
  if (request.runtimeSession === undefined) {
    sessionRecord = await createRuntimeSessionRecord({
      paths: pragmaPaths,
      owner: request.owner,
      systemSessionId,
      agentId: agent.id,
      runtime: descriptor,
      workspace: agent.workspace,
    });
  } else {
    sessionRecord = await restoreRuntimeSessionRecord({
      paths: pragmaPaths,
      owner: request.owner,
      systemSessionId,
      agentId: agent.id,
      runtime: descriptor,
      runtimeSession: request.runtimeSession,
      workspace: agent.workspace,
    });
  }
  logRuntimePhase(logger, "runtime.session_record", phaseStartedAt, sessionStartedAt);

  let restoredRuntimeSessionId: string | undefined;
  let lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined> | undefined;
  let nativeSession: TNativeSession | undefined;
  let managedSession: ManagedRuntimeSession<TNativeEvent, TNativeSession, TPrepared> | undefined;

  try {
    if (persistenceSpec?.sessionDir !== undefined) {
      await ensureRuntimeSessionDir(persistenceSpec.sessionDir);
    }

    phaseStartedAt = performance.now();
    const preparation = await dispatchExpertAgentHook(agent.hooks, "beforeSessionCreate", {
      agent,
      context: runContext,
      systemSessionId,
      runtimeSession: request.runtimeSession,
      processEnvironment: baseProcessEnvironment,
      logger,
    });
    prepareContext = {
      ...prepareContext,
      processEnvironment: applyProcessEnvironmentPatch(
        baseProcessEnvironment,
        preparation?.processEnvironment,
      ),
    };
    logRuntimePhase(logger, "runtime.before_session_hook", phaseStartedAt, sessionStartedAt);

    phaseStartedAt = performance.now();
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
    logRuntimePhase(logger, "runtime.persistence_restore", phaseStartedAt, sessionStartedAt);

    phaseStartedAt = performance.now();
    const [prepared, agentContext] = await Promise.all([
      Promise.resolve(driver.prepare?.(prepareContext)).then((value) => value ?? ({} as TPrepared)),
      agent.buildContext(runContext, request.contextAssembly),
    ]);
    logRuntimePhase(logger, "runtime.prepare_and_context", phaseStartedAt, sessionStartedAt, {
      systemPromptCharacters: agentContext.systemPrompt.length,
      startupMessageCount: agentContext.startupMessages.length,
      toolCount: agent.tools?.length ?? 0,
    });
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
            driver.closeSession?.(nativeSession, {
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
            processState: "stopped",
          });
        } catch (error) {
          logger.error(
            "runtime.session_record_close_failed",
            "Failed to close Runtime session record",
            error,
            {
              ownerId: request.owner.ownerId,
              systemSessionId,
            },
          );
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
    phaseStartedAt = performance.now();
    nativeSession =
      request.runtimeSession === undefined
        ? await driver.createSession(sessionContext)
        : await (driver.restoreSession ?? driver.createSession)(sessionContext);
    logRuntimePhase(logger, "runtime.native_session_create", phaseStartedAt, sessionStartedAt);
    const snapshot = driver.readSession?.(nativeSession, { agent, runContext });
    currentRuntimeSessionId = snapshot?.runtimeSessionId ?? currentRuntimeSessionId;
    sessionRecord = await updateRuntimeSessionRecord(pragmaPaths, sessionRecord, {
      runtimeSessionRef:
        currentRuntimeSessionId === ""
          ? null
          : { type: descriptor.kind, id: currentRuntimeSessionId },
      processState: "running",
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
          processState: "running",
        });
        await checkpoint(trigger);
        await request.onSessionInfo?.(readSessionInfo());
      },
      persistContextWindowUsage: async (usage) => {
        sessionRecord = await updateRuntimeSessionRecord(pragmaPaths, sessionRecord, {
          contextWindowUsage: usage,
        });
      },
      executionBindings,
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
    await request.onSessionInfo?.(readSessionInfo());
    logger.info("runtime.session_ready", "Runtime Session preparation completed", {
      elapsedMs: elapsedRuntimeMs(sessionStartedAt),
      restored: request.runtimeSession !== undefined,
    });

    return managedSession;
  } catch (error) {
    try {
      sessionRecord = await updateRuntimeSessionRecord(pragmaPaths, sessionRecord, {
        processState: "failed",
      });
    } catch (recordError) {
      logger.error(
        "runtime.session_record_fail_failed",
        "Failed to mark Runtime session record as failed",
        recordError,
        {
          ownerId: request.owner.ownerId,
          systemSessionId,
        },
      );
    }
    logger.error("runtime.session_creation_failed", "Runtime session creation failed", error);
    if (lifecycle !== undefined) {
      await lifecycle.close().catch(() => undefined);
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

function freezeProcessEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(environment).filter((entry): entry is [string, string] => {
        return entry[1] !== undefined;
      }),
    ),
  );
}

function applyProcessEnvironmentPatch(
  base: Readonly<NodeJS.ProcessEnv>,
  patch: ExpertAgentProcessEnvironmentPatch | undefined,
): Readonly<NodeJS.ProcessEnv> {
  if (patch === undefined) {
    return base;
  }
  const environment: NodeJS.ProcessEnv = { ...base };
  for (const name of patch.unset ?? []) {
    delete environment[name];
  }
  Object.assign(environment, patch.set ?? {});
  return freezeProcessEnvironment(environment);
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
  private activeRunId: string | undefined;
  private contextWindowCalibrated = false;

  constructor(
    private readonly options: {
      readonly agent: Expert;
      readonly driver: RuntimeDriver<TNativeEvent, TNativeSession, TPrepared>;
      readonly nativeSession: TNativeSession;
      readonly descriptor: RuntimeAdapterDescriptor;
      readonly lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined>;
      readonly logger: PragmaLogger;
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
      readonly persistContextWindowUsage: (
        usage: RuntimeContextWindowUsage | null,
      ) => Promise<void>;
      readonly executionBindings: RuntimeExecutionBindings;
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

  get contextWindow():
    | {
        readonly inspect: () => Promise<RuntimeContextWindowUsage | undefined>;
        readonly canCompact: () => Promise<boolean>;
        readonly compact: (() => Promise<RuntimeContextWindowUsage | undefined>) | undefined;
      }
    | undefined {
    if (this.options.driver.readContextWindow === undefined) return undefined;
    return {
      inspect: async () => {
        this.assertIdle("inspect the context window");
        return await this.refreshContextWindow(true);
      },
      canCompact: async () => {
        this.assertIdle("check whether the context window can be compacted");
        if (this.options.driver.compactContext === undefined) return false;
        return (await this.options.driver.canCompactContext?.(this.options.nativeSession)) ?? true;
      },
      compact:
        this.options.driver.compactContext === undefined
          ? undefined
          : async () => {
              this.assertIdle("compact the context window");
              const usage = await this.options.driver.compactContext!(this.options.nativeSession);
              await this.options.persistContextWindowUsage(usage ?? null);
              await this.options.checkpoint("context.compacted");
              return usage;
            },
    };
  }

  submit<TOutput = string>(
    submission: RuntimeSubmitRequest<TOutput>,
  ): RuntimeSubmitHandle<TOutput> {
    const runId = submission.runId ?? randomUUID();
    const taskSubmission = omitRuntimeSubmissionExecution(submission);
    this.options.executionBindings.bind(runId, {
      humanInteractionHandler: submission.execution.humanInteractionHandler,
      executionContext: submission.execution.context,
    });
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
    });
    let enteredLifecycle = false;
    let finalized = false;
    let settledUsage = false;
    let observedUsage: AgentMessageUsage | undefined;
    let resolveUsage!: (usage: AgentMessageUsage | undefined) => void;
    const usage = new Promise<AgentMessageUsage | undefined>((resolve) => {
      resolveUsage = resolve;
    });
    const settleUsage = (next: AgentMessageUsage | undefined): void => {
      if (settledUsage) return;
      settledUsage = true;
      resolveUsage(next);
    };
    const finalize = async (): Promise<void> => {
      if (finalized) return;
      finalized = true;
      this.options.executionBindings.deactivate(runId);
      if (this.activeRunId === runId) this.activeRunId = undefined;
      await controller.complete();
    };

    const task = this.options.lifecycle.enqueue(async ({ signal }) => {
      enteredLifecycle = true;
      this.activeRunId = runId;
      this.options.executionBindings.activate(runId);
      try {
        await dispatchExpertAgentHook(this.options.agent.hooks, "beforeTaskSubmit", {
          agent: this.options.agent,
          session: this.info(),
          runId,
          submission: taskSubmission,
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

        const runResult = await this.executeSubmission(
          runId,
          submission,
          signal,
          controller,
          (next) => {
            observedUsage = next;
          },
        );
        observedUsage = runResult.result.usage;
        settleUsage(observedUsage);
        controller.updateContextWindowUsage(await this.refreshContextWindow(false));
        controller.flushTelemetry(false);

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
          submission: taskSubmission,
          result: runResult,
          context: this.options.runContext,
          logger: this.options.logger,
        });
        await this.options.checkpoint("turn.completed");

        return runResult;
      } catch (error) {
        observedUsage ??= controller.getUsage();
        settleUsage(observedUsage);
        controller.updateContextWindowUsage(await this.refreshContextWindow(false));
        controller.flushTelemetry(false);
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
          submission: taskSubmission,
          error,
          context: this.options.runContext,
          logger: this.options.logger,
        });
        await this.options.checkpoint("turn.failed");
        throw error;
      } finally {
        settleUsage(observedUsage);
        await finalize();
      }
    });
    const result = task.result.finally(async () => {
      if (!enteredLifecycle) await finalize();
    });

    return {
      runId,
      events: queue,
      result,
      usage,
      cancel: async () => {
        cancelled = true;
        const active = this.activeRunId === runId;
        const signal = this.options.lifecycle.currentSignal;
        const cancellation = task.cancel();
        if (active) {
          await this.options.driver.cancelTurn?.(this.options.nativeSession, {
            runId,
            signal,
          });
        }
        await cancellation;
      },
    };
  }

  async steer(request: {
    readonly requestId: string;
    readonly content: string;
    readonly targetRunId: string;
  }): Promise<void> {
    if (this.options.driver.steerTurn === undefined) {
      throw new Error(`Runtime ${this.options.descriptor.id} does not support safe steer.`);
    }
    if (this.activeRunId === undefined || this.activeRunId !== request.targetRunId) {
      throw new Error(`Cannot steer inactive Runtime submission: ${request.targetRunId}`);
    }
    await this.options.driver.steerTurn(this.options.nativeSession, request);
  }

  async close(): Promise<void> {
    await this.options.lifecycle.close();
  }

  private assertIdle(operation: string): void {
    if (
      this.activeRunId !== undefined ||
      this.options.lifecycle.runState === "queued" ||
      this.options.lifecycle.runState === "running"
    ) {
      throw new Error(`Cannot ${operation} while a Runtime turn is active.`);
    }
  }

  private async refreshContextWindow(
    throwOnError: boolean,
  ): Promise<RuntimeContextWindowUsage | undefined> {
    const read = this.options.driver.readContextWindow;
    if (read === undefined) return undefined;
    try {
      const usage = await read(this.options.nativeSession);
      if (usage !== undefined) {
        if (usage.usedTokens !== null && usage.usedTokens > 0) {
          this.contextWindowCalibrated = true;
        }
        await this.options.persistContextWindowUsage(usage);
      }
      return usage;
    } catch (error) {
      if (throwOnError) throw error;
      this.options.logger.warn(
        "runtime.context_window_refresh_failed",
        "Failed to refresh Runtime context window usage.",
        { error },
      );
      return undefined;
    }
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
    observeUsage: (usage: AgentMessageUsage | undefined) => void,
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
      const attemptStartupMessages = attempt === 1 ? startupMessages : [];
      const contextWindow = await this.refreshContextWindow(false);
      controller.resetCapture();
      controller.beginUsagePreview({
        prompt,
        startupMessages: attemptStartupMessages.map((message) => message.content),
        contextBaselineCalibrated: this.contextWindowCalibrated,
        ...(usage === undefined ? {} : { accumulatedUsage: usage }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
      });
      const turnResult = await (async () => {
        const requestStartedAt = performance.now();
        this.options.logger.info(
          "runtime.model_request_dispatched",
          "Runtime adapter dispatched the native model request",
          { runId, attempt, isRetry: attempt > 1 },
        );
        try {
          const result = await this.options.driver.startTurn(this.options.nativeSession, {
            runId,
            attempt,
            isRetry: attempt > 1,
            rawQuery: submission.query,
            prompt,
            startupMessages: attemptStartupMessages,
            modelSelection: submission.modelSelection,
            output: submission.output,
            signal,
            source: controller.source,
            stream: controller.writer,
          });
          this.options.logger.info(
            "runtime.model_request_finished",
            "Runtime adapter finished the native model request",
            { runId, attempt, durationMs: elapsedRuntimeMs(requestStartedAt) },
          );
          return result;
        } catch (error) {
          usage = mergeUsage(usage, controller.getUsage());
          controller.updateUsage(usage);
          observeUsage(usage);
          throw error;
        }
      })();
      outputText = turnResult.outputText ?? controller.getOutputText();
      usage = mergeUsage(usage, mergeUsage(controller.getUsage(), turnResult.usage));
      controller.updateUsage(usage);
      observeUsage(usage);

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
    observeUsage(usage);
    controller.updateUsage(usage);

    return createRuntimeRunResult(runId, parseResult.value, usage);
  }
}

function logRuntimePhase(
  logger: PragmaLogger,
  phase: string,
  phaseStartedAt: number,
  sessionStartedAt: number,
  attributes: Record<string, unknown> = {},
): void {
  logger.info("runtime.session_phase", `Runtime Session phase completed: ${phase}`, {
    phase,
    durationMs: elapsedRuntimeMs(phaseStartedAt),
    elapsedMs: elapsedRuntimeMs(sessionStartedAt),
    ...attributes,
  });
}

function elapsedRuntimeMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

interface RuntimeExecutionBinding {
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly executionContext?: ExpertToolExecutionContext | undefined;
}

function omitRuntimeSubmissionExecution<TOutput>(
  submission: RuntimeSubmitRequest<TOutput>,
): RuntimeTaskSubmission<TOutput> {
  const { execution, ...taskSubmission } = submission;
  void execution;
  return taskSubmission;
}

class RuntimeExecutionBindings {
  private readonly bindings = new Map<string, RuntimeExecutionBinding>();
  private activeRunId: string | undefined;

  constructor(private initial: RuntimeExecutionBinding | undefined) {}

  bindRequest(request: RuntimeDriverSessionRequest): RuntimeDriverSessionRequest {
    return {
      ...request,
      ...(request.humanInteractionHandler === undefined
        ? {}
        : { humanInteractionHandler: this.createHumanInteractionHandler() }),
      ...(request.executionContext === undefined
        ? {}
        : { executionContext: this.createExecutionContext() }),
    };
  }

  bind(runId: string, binding: RuntimeExecutionBinding): void {
    this.bindings.set(runId, binding);
  }

  activate(runId: string): void {
    this.activeRunId = runId;
    this.initial = undefined;
  }

  deactivate(runId: string): void {
    this.bindings.delete(runId);
    if (this.activeRunId === runId) this.activeRunId = undefined;
  }

  private current(): RuntimeExecutionBinding {
    return this.bindings.get(this.activeRunId ?? "") ?? this.initial ?? {};
  }

  private createHumanInteractionHandler(): ExpertAgentHumanInteractionHandler {
    return async (request) => {
      const handler = this.current().humanInteractionHandler;
      if (handler === undefined) {
        throw new Error("No human interaction handler is configured for the active Runtime run.");
      }
      return await handler(request);
    };
  }

  private createExecutionContext(): ExpertToolExecutionContext {
    const initial = this.initial!.executionContext!;
    const initialExecutionId = initial.executionId;
    const initialInvocationId = initial.invocationId;
    const initialDepth = initial.depth;
    const current = (): RuntimeExecutionBinding => this.current();
    return {
      get executionId() {
        return current().executionContext?.executionId ?? initialExecutionId;
      },
      get invocationId() {
        return current().executionContext?.invocationId ?? initialInvocationId;
      },
      get depth() {
        return current().executionContext?.depth ?? initialDepth;
      },
      get invokeResource() {
        return current().executionContext?.invokeResource;
      },
      get spawnExpert() {
        return current().executionContext?.spawnExpert;
      },
      get waitExperts() {
        return current().executionContext?.waitExperts;
      },
      get listExperts() {
        return current().executionContext?.listExperts;
      },
      get followupExpert() {
        return current().executionContext?.followupExpert;
      },
      get interruptExpert() {
        return current().executionContext?.interruptExpert;
      },
    };
  }
}

function createRuntimePaths(
  pragma: PragmaPaths,
  ownerId: string,
  systemSessionId: string,
  descriptor: RuntimeAdapterDescriptor,
): RuntimePaths {
  return {
    pragma,
    systemSessionDir: pragma.ownedSystemSessionRoot(ownerId, systemSessionId),
    runtimeSessionDir(runtimeName = descriptor.kind) {
      return pragma.ownedRuntimeRoot(ownerId, systemSessionId, runtimeName);
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
