import { randomUUID } from "node:crypto";

import {
  RuntimeSessionRefSchema,
  type AgentMessage,
  type AgentMessageUsage,
  type ExpertPromptAttachment,
} from "@pragma/shared";

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
import {
  RUNTIME_CONTEXT_COMPACTION_STAGES,
  RUNTIME_STARTUP_MESSAGE_STAGES,
  readRuntimeContextCompactionProgressData,
} from "./context-compaction.ts";
import { defaultRuntimeTokenCounter } from "./token-counter.ts";
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
  RuntimeDriverDescriptor,
} from "./runtime-adapter.ts";
import type { RuntimeStreamEvent } from "./stream-events.ts";
import { registerRuntimeSessionFactory } from "./session-factory.ts";
import {
  RUNTIME_FEATURE_CATALOG,
  deriveRuntimeAdapterCapabilities,
  isRuntimeFeatureEnabled,
  snapshotRuntimeFeatures,
  validateRuntimeFeatures,
  type RuntimeFeatureName,
  type RuntimePreparationPhase,
  type RuntimePreparationNode,
  type RuntimePreparationOutput,
  type RuntimePreparedFeatureSet,
  type RuntimeFeatureSet,
} from "./features.ts";
import { RuntimeResourceScope, type RuntimeResourceRegistrar } from "./resource-scope.ts";
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

export interface RuntimeFeatureSessionPrepareContext extends RuntimePrepareContext {
  readonly agentContext: ExpertAgentContext;
  readonly lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined>;
  readonly persistence: {
    readonly spec?: RuntimeSessionPersistenceSpec | undefined;
    readonly restoredRuntimeSessionId?: string | undefined;
    readonly checkpoint: (trigger: RuntimeCheckpointTrigger) => Promise<void>;
  };
  readonly resources: RuntimeResourceRegistrar;
  readonly sessionInfo: RuntimeSessionInfo;
}

export interface RuntimePreparedSteps<TPhase extends RuntimePreparationPhase> {
  readonly get: <TNode extends RuntimePreparationNode<TPhase, unknown>>(
    node: TNode,
  ) => RuntimePreparationOutput<TNode>;
}

/**
 * The sealed context exposed to provider-native Session creation. It deliberately
 * omits the resource registrar: lifecycle resources may only be acquired by
 * explicit Runtime Features or private preparation Steps.
 */
export interface RuntimeNativeSessionContext<
  TFeatures extends RuntimeFeatureSet = RuntimeFeatureSet,
> extends RuntimePrepareContext {
  readonly agentContext: ExpertAgentContext;
  readonly lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined>;
  readonly persistence: {
    readonly spec?: RuntimeSessionPersistenceSpec | undefined;
    readonly restoredRuntimeSessionId?: string | undefined;
    readonly checkpoint: (trigger: RuntimeCheckpointTrigger) => Promise<void>;
  };
  readonly sessionInfo: RuntimeSessionInfo;
  readonly features: RuntimePreparedFeatureSet<TFeatures>;
  readonly steps: RuntimePreparedSteps<"session">;
}

/** @deprecated Use RuntimeNativeSessionContext. */
export type RuntimeDriverSessionContext<TFeatures extends RuntimeFeatureSet = RuntimeFeatureSet> =
  RuntimeNativeSessionContext<TFeatures>;

export interface RuntimeSessionReadContext {
  readonly agent: Expert;
  readonly runContext: ExpertAgentRunContext;
}

export interface RuntimeSessionSnapshot {
  readonly runtimeSessionId?: string | undefined;
  readonly messages?: readonly AgentMessage[] | undefined;
}

export interface RuntimeTurnContext<
  TNativeEvent,
  TFeatures extends RuntimeFeatureSet = RuntimeFeatureSet,
> {
  readonly runId: string;
  readonly attempt: number;
  readonly isRetry: boolean;
  readonly rawQuery: string;
  readonly prompt: string;
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly startupMessages: readonly ExpertAgentStartupMessage[];
  readonly modelSelection?: RuntimeModelSelection | undefined;
  readonly output?: RuntimeOutputSchema | undefined;
  readonly signal: AbortSignal;
  readonly source: RuntimeStreamEvent["source"];
  readonly stream: RuntimeStreamWriter<TNativeEvent>;
  readonly features: RuntimePreparedFeatureSet<TFeatures>;
  readonly steps: RuntimePreparedSteps<"turn">;
}

export interface RuntimeFeatureTurnPrepareContext {
  readonly feature?: RuntimeFeatureName | undefined;
  readonly agent: Expert;
  readonly runContext: ExpertAgentRunContext;
  readonly sessionInfo: RuntimeSessionInfo;
  readonly runId: string;
  readonly query: string;
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly modelSelection?: RuntimeModelSelection | undefined;
  readonly output?: RuntimeOutputSchema | undefined;
  readonly signal: AbortSignal;
  readonly logger: PragmaLogger;
  readonly resources: RuntimeResourceRegistrar;
  readonly sessionFeatures: Readonly<Partial<Record<RuntimeFeatureName, unknown>>>;
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

export interface RuntimeDriver<
  TNativeEvent,
  TNativeSession,
  TFeatures extends RuntimeFeatureSet = RuntimeFeatureSet,
> {
  readonly descriptor: RuntimeDriverDescriptor;
  readonly features: TFeatures;
  readonly sessionSteps?: readonly RuntimePreparationNode<"session", unknown>[] | undefined;
  readonly turnSteps?: readonly RuntimePreparationNode<"turn", unknown>[] | undefined;
  readonly canUse?:
    | ((options?: Record<string, unknown>) => Promise<RuntimeCanUseResult> | RuntimeCanUseResult)
    | undefined;
  readonly listModels?: (() => Promise<readonly RuntimeModel[]>) | undefined;
  readonly defaultOutputParser?: RuntimeOutputParser | undefined;
  readonly outputRetryLimit?: number | undefined;
  readonly resolvePersistence?:
    ((context: RuntimePrepareContext) => RuntimeSessionPersistenceSpec | undefined) | undefined;
  readonly createSession: (
    context: RuntimeNativeSessionContext<TFeatures>,
  ) => Promise<TNativeSession> | TNativeSession;
  readonly restoreSession?:
    | ((
        context: RuntimeNativeSessionContext<TFeatures>,
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
    turn: RuntimeTurnContext<TNativeEvent, TFeatures>,
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
    ((session: TNativeSession) => Promise<boolean> | boolean) | undefined;
  readonly compactContext?:
    | ((
        session: TNativeSession,
      ) => Promise<RuntimeContextWindowUsage | undefined> | RuntimeContextWindowUsage | undefined)
    | undefined;
  readonly cancelTurn?:
    ((session: TNativeSession, context: RuntimeCancelContext) => Promise<void> | void) | undefined;
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
    ((session: TNativeSession, context: RuntimeCloseContext) => Promise<void> | void) | undefined;
}

type RuntimeDriverFeatureMethodContract<
  TNativeEvent,
  TNativeSession,
  TFeatures extends RuntimeFeatureSet,
> = RuntimeFeatureSet extends TFeatures
  ? object
  : RequireRuntimeFeatureMethod<TNativeEvent, TNativeSession, TFeatures, "availability", "canUse"> &
      RequireRuntimeFeatureMethod<
        TNativeEvent,
        TNativeSession,
        TFeatures,
        "modelDiscovery",
        "listModels"
      > &
      RequireRuntimeFeatureMethod<
        TNativeEvent,
        TNativeSession,
        TFeatures,
        "contextWindow",
        "readContextWindow"
      > &
      RequireRuntimeManualCompactionMethod<TNativeEvent, TNativeSession, TFeatures> &
      RequireRuntimeFeatureMethod<
        TNativeEvent,
        TNativeSession,
        TFeatures,
        "cancellation",
        "cancelTurn"
      > &
      RequireRuntimeFeatureMethod<
        TNativeEvent,
        TNativeSession,
        TFeatures,
        "steering",
        "steerTurn"
      > &
      RequireRuntimeFeatureMethod<TNativeEvent, TNativeSession, TFeatures, "close", "closeSession">;

type RequireRuntimeFeatureMethod<
  TNativeEvent,
  TNativeSession,
  TFeatures extends RuntimeFeatureSet,
  TFeature extends RuntimeFeatureName,
  TMethod extends keyof RuntimeDriver<TNativeEvent, TNativeSession>,
> = TFeatures[TFeature]["readiness"]["status"] extends "supported" | "degraded"
  ? Required<Pick<RuntimeDriver<TNativeEvent, TNativeSession>, TMethod>>
  : object;

type RequireRuntimeManualCompactionMethod<
  TNativeEvent,
  TNativeSession,
  TFeatures extends RuntimeFeatureSet,
> = TFeatures["compaction"]["readiness"]["status"] extends "supported" | "degraded"
  ? TFeatures["compaction"] extends {
      readonly readiness: { readonly compactionModes?: infer TModes };
    }
    ? "manual" extends ArrayElement<TModes>
      ? Required<Pick<RuntimeDriver<TNativeEvent, TNativeSession>, "compactContext">>
      : object
    : object
  : object;

type ArrayElement<TValue> = TValue extends readonly (infer TElement)[] ? TElement : never;

export function defineRuntimeDriver<
  TNativeEvent,
  TNativeSession,
  const TFeatures extends RuntimeFeatureSet = RuntimeFeatureSet,
>(
  driver: RuntimeDriver<TNativeEvent, TNativeSession, TFeatures> & {
    readonly features: TFeatures;
  } & RuntimeDriverFeatureMethodContract<TNativeEvent, TNativeSession, TFeatures>,
  options: DefineRuntimeDriverOptions = {},
): RuntimeAdapter {
  validateRuntimeFeatures(driver.features);
  const createPersistenceProvider = (): RuntimeSessionPersistenceProvider =>
    options.persistenceProvider ??
    (options.sessionRestoreHandler === undefined && options.sessionSyncCallback === undefined
      ? createNoopRuntimeSessionPersistenceProvider()
      : createCallbackRuntimeSessionPersistenceProvider({
          restoreHandler: options.sessionRestoreHandler,
          syncCallback: options.sessionSyncCallback,
        }));

  const descriptor: RuntimeAdapterDescriptor = Object.freeze({
    ...driver.descriptor,
    capabilities: deriveRuntimeAdapterCapabilities(driver.features, driver.descriptor.capabilities),
  });
  assertRuntimeFeatureMethodContracts(driver, descriptor);
  const runtime: RuntimeAdapter = {
    descriptor,
    features: snapshotRuntimeFeatures(driver.features),
    canUse: async (options?: Record<string, unknown>) =>
      (await (
        driver.canUse as
          | ((opts?: Record<string, unknown>) => Promise<RuntimeCanUseResult> | RuntimeCanUseResult)
          | undefined
      )?.(options)) ?? { usable: true },
    ...(driver.listModels === undefined ? {} : { listModels: driver.listModels }),
  };
  registerRuntimeSessionFactory(
    runtime,
    async (request) =>
      await createManagedRuntimeSession(
        driver,
        descriptor,
        request,
        createPersistenceProvider(),
        options.createProcessEnvironment,
      ),
  );
  return runtime;
}

async function createManagedRuntimeSession<
  TNativeEvent,
  TNativeSession,
  TFeatures extends RuntimeFeatureSet,
>(
  driver: RuntimeDriver<TNativeEvent, TNativeSession, TFeatures>,
  descriptor: RuntimeAdapterDescriptor,
  request: RuntimeDriverSessionRequest,
  persistenceProvider: RuntimeSessionPersistenceProvider,
  createProcessEnvironment: (() => NodeJS.ProcessEnv) | undefined,
): Promise<ManagedRuntimeSession<TNativeEvent, TNativeSession>> {
  const executionBindings = new RuntimeExecutionBindings({
    humanInteractionHandler: request.humanInteractionHandler,
    executionContext: request.executionContext,
  });
  request = executionBindings.bindRequest(request);
  const agent = request.agent;
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
  const resources = new RuntimeResourceScope(`runtime-session:${systemSessionId}`);
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
  await assertRuntimeCanUse(driver as RuntimeDriver<TNativeEvent, TNativeSession>, descriptor);
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
  let managedSession: ManagedRuntimeSession<TNativeEvent, TNativeSession> | undefined;

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
    const agentContext = await agent.buildContext(runContext, request.contextAssembly);
    logRuntimePhase(logger, "runtime.context_prepared", phaseStartedAt, sessionStartedAt, {
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
        await resources.dispose().catch((error: unknown) => {
          cleanupErrors.push(error);
        });
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

    const featureContext: RuntimeFeatureSessionPrepareContext & {
      readonly resources: RuntimeResourceScope;
    } = {
      ...prepareContext,
      agentContext,
      lifecycle,
      persistence: {
        spec: persistenceSpec,
        restoredRuntimeSessionId,
        checkpoint,
      },
      resources,
      sessionInfo: readSessionInfo(),
    };
    const prepared = await prepareRuntimeSessionFeatures(driver, featureContext);
    resources.seal();
    const { resources: _resources, ...nativeSessionBaseContext } = featureContext;
    void _resources;
    const sessionContext: RuntimeNativeSessionContext<TFeatures> = {
      ...nativeSessionBaseContext,
      features: prepared.features,
      steps: prepared.steps,
    };
    phaseStartedAt = performance.now();
    nativeSession =
      request.runtimeSession === undefined
        ? await driver.createSession(sessionContext)
        : await (driver.restoreSession ?? driver.createSession)(sessionContext);
    resources.transfer();
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
      driver: driver as RuntimeDriver<TNativeEvent, TNativeSession>,
      nativeSession,
      descriptor,
      lifecycle,
      logger,
      runContext,
      sessionFeatureOutputs: prepared.features,
      startupMessages: agentContext.startupMessages,
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
      await resources.dispose().catch(() => undefined);
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

async function prepareRuntimeSessionFeatures<
  TNativeEvent,
  TNativeSession,
  TFeatures extends RuntimeFeatureSet,
>(
  driver: RuntimeDriver<TNativeEvent, TNativeSession, TFeatures>,
  context: RuntimeFeatureSessionPrepareContext & { readonly resources: RuntimeResourceScope },
): Promise<{
  readonly features: RuntimePreparedFeatureSet<TFeatures>;
  readonly steps: RuntimePreparedSteps<"session">;
}> {
  const featureByNode = new Map<object, RuntimeFeatureName>();
  const roots: RuntimePreparationNode<"session", unknown>[] = [...(driver.sessionSteps ?? [])];

  for (const { name, lifecycle } of RUNTIME_FEATURE_CATALOG) {
    const feature = driver.features[name];
    if (lifecycle !== "session" || feature.kind !== "feature") continue;
    if (!isRuntimeFeatureEnabled(feature)) continue;
    roots.push(feature as unknown as RuntimePreparationNode<"session", unknown>);
    featureByNode.set(feature, name);
  }
  const execution = await executeRuntimePreparationGraph({
    phase: "session",
    roots,
    featureByNode,
    resources: context.resources,
    execute: async (node, resources, dependencies) => {
      const featureName = featureByNode.get(node);
      const startedAt = performance.now();
      const value = await node.prepare({ ...context, resources }, dependencies);
      context.logger.debug(
        "runtime.feature_session_phase",
        `Runtime Session preparation completed: ${featureName ?? node.id ?? "internal step"}`,
        {
          ...(featureName === undefined ? {} : { feature: featureName }),
          durationMs: elapsedRuntimeMs(startedAt),
        },
      );
      return value;
    },
  });
  return {
    features: readRuntimePreparedFeatures(execution.results, featureByNode),
    steps: createRuntimePreparedSteps("session", execution.results),
  };
}

async function prepareRuntimeTurnFeatures<
  TNativeEvent,
  TNativeSession,
  TFeatures extends RuntimeFeatureSet,
>(
  context: Omit<RuntimeFeatureTurnPrepareContext, "feature"> & {
    readonly driver: RuntimeDriver<TNativeEvent, TNativeSession, TFeatures>;
    readonly resources: RuntimeResourceScope;
  },
): Promise<{
  readonly features: RuntimePreparedFeatureSet<TFeatures>;
  readonly steps: RuntimePreparedSteps<"turn">;
}> {
  const featureByNode = new Map<object, RuntimeFeatureName>();
  const { driver, ...baseContext } = context;
  const roots: RuntimePreparationNode<"turn", unknown>[] = [...(driver.turnSteps ?? [])];

  for (const { name, lifecycle } of RUNTIME_FEATURE_CATALOG) {
    const feature = driver.features[name];
    if (lifecycle !== "turn" || feature.kind !== "feature") continue;
    if (!isRuntimeFeatureEnabled(feature)) continue;
    roots.push(feature as unknown as RuntimePreparationNode<"turn", unknown>);
    featureByNode.set(feature, name);
  }
  const execution = await executeRuntimePreparationGraph({
    phase: "turn",
    roots,
    featureByNode,
    resources: baseContext.resources,
    execute: async (node, resources, dependencies) => {
      const featureName = featureByNode.get(node);
      const startedAt = performance.now();
      const value = await node.prepare(
        {
          ...baseContext,
          resources,
          ...(featureName === undefined ? {} : { feature: featureName }),
        },
        dependencies,
      );
      baseContext.logger.debug(
        "runtime.feature_turn_phase",
        `Runtime turn preparation completed: ${featureName ?? node.id ?? "internal step"}`,
        {
          ...(featureName === undefined ? {} : { feature: featureName }),
          durationMs: elapsedRuntimeMs(startedAt),
        },
      );
      return value;
    },
  });
  return {
    features: readRuntimePreparedFeatures(execution.results, featureByNode),
    steps: createRuntimePreparedSteps("turn", execution.results),
  };
}

async function executeRuntimePreparationGraph<TPhase extends RuntimePreparationPhase>(options: {
  readonly phase: TPhase;
  readonly roots: readonly RuntimePreparationNode<TPhase, unknown>[];
  readonly featureByNode: ReadonlyMap<object, RuntimeFeatureName>;
  readonly resources: RuntimeResourceScope;
  readonly execute: (
    node: RuntimePreparationNode<TPhase, unknown>,
    resources: RuntimeResourceScope,
    dependencies: Readonly<Record<string, unknown>>,
  ) => Promise<unknown> | unknown;
}): Promise<{ readonly results: ReadonlyMap<object, unknown> }> {
  const graph = validateRuntimePreparationGraph(options.phase, options.roots);
  const results = new Map<object, unknown>();
  const executions = new Map<object, Promise<unknown>>();
  const scopes = new Map<object, RuntimeResourceScope>();
  const labels = new Map(
    graph.nodes.map((node, index) => [
      node,
      node.id ?? options.featureByNode.get(node) ?? `node-${index + 1}`,
    ]),
  );

  const run = (node: RuntimePreparationNode<TPhase, unknown>): Promise<unknown> => {
    const existing = executions.get(node);
    if (existing !== undefined) return existing;
    const scope = new RuntimeResourceScope(`${options.resources.label}:${labels.get(node)!}`);
    scopes.set(node, scope);
    const execution = (async () => {
      const entries = await Promise.all(
        Object.entries(node.needs ?? {}).map(
          async ([name, dependency]) =>
            [name, await run(dependency as RuntimePreparationNode<TPhase, unknown>)] as const,
        ),
      );
      const value = await options.execute(node, scope, Object.freeze(Object.fromEntries(entries)));
      scope.seal();
      results.set(node, value);
      return value;
    })();
    executions.set(node, execution);
    return execution;
  };

  const settled = await Promise.allSettled(options.roots.map(run));
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    const cleanup = await Promise.allSettled([...scopes.values()].map((scope) => scope.dispose()));
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [...failures, ...cleanupFailures],
        `Runtime ${options.phase} preparation and resource cleanup failed.`,
      );
    }
    throw failures[0];
  }

  for (const node of graph.nodes) {
    options.resources.attach(scopes.get(node)!);
  }
  return { results };
}

function validateRuntimePreparationGraph<TPhase extends RuntimePreparationPhase>(
  phase: TPhase,
  roots: readonly RuntimePreparationNode<TPhase, unknown>[],
): { readonly nodes: readonly RuntimePreparationNode<TPhase, unknown>[] } {
  const states = new Map<object, "visiting" | "complete">();
  const ids = new Map<string, object>();
  const nodes: RuntimePreparationNode<TPhase, unknown>[] = [];
  const phaseName = phase === "session" ? "Session" : "turn";

  const visit = (candidate: unknown): void => {
    if (!isRuntimePreparationNode(candidate)) {
      throw new Error(`Runtime ${phaseName} preparation graph contains an invalid node.`);
    }
    const node = candidate as RuntimePreparationNode<TPhase, unknown>;
    if (node.phase !== phase) {
      throw new Error(
        `Runtime ${phaseName} preparation node ${node.id ?? "unnamed node"} depends on a ${node.phase} node.`,
      );
    }
    const state = states.get(node);
    if (state === "visiting") {
      throw new Error(
        `Runtime ${phaseName} preparation dependency cycle at ${node.id ?? "unnamed node"}.`,
      );
    }
    if (state === "complete") return;
    if (node.id !== undefined) {
      if (node.id.trim() === "") {
        throw new Error(`Runtime ${phaseName} preparation node id must not be empty.`);
      }
      const existing = ids.get(node.id);
      if (existing !== undefined && existing !== node) {
        throw new Error(
          `Runtime ${phaseName} preparation graph has duplicate node id: ${node.id}.`,
        );
      }
      ids.set(node.id, node);
    }
    if (node.needs !== undefined && (node.needs === null || Array.isArray(node.needs))) {
      throw new Error(
        `Runtime ${phaseName} preparation node ${node.id ?? "unnamed node"} has invalid needs.`,
      );
    }
    states.set(node, "visiting");
    for (const dependency of Object.values(node.needs ?? {})) visit(dependency);
    states.set(node, "complete");
    nodes.push(node);
  };

  for (const root of roots) visit(root);
  return { nodes };
}

function isRuntimePreparationNode(
  candidate: unknown,
): candidate is RuntimePreparationNode<RuntimePreparationPhase, unknown> {
  if (candidate === null || typeof candidate !== "object") return false;
  const node = candidate as Partial<RuntimePreparationNode<RuntimePreparationPhase, unknown>>;
  return (
    (node.kind === "feature" || node.kind === "preparation") &&
    (node.phase === "session" || node.phase === "turn") &&
    typeof node.prepare === "function"
  );
}

function readRuntimePreparedFeatures<TFeatures extends RuntimeFeatureSet>(
  results: ReadonlyMap<object, unknown>,
  featureByNode: ReadonlyMap<object, RuntimeFeatureName>,
): RuntimePreparedFeatureSet<TFeatures> {
  const featureResults: Partial<Record<RuntimeFeatureName, unknown>> = {};
  for (const [node, name] of featureByNode) featureResults[name] = results.get(node);
  return Object.freeze(featureResults) as RuntimePreparedFeatureSet<TFeatures>;
}

function createRuntimePreparedSteps<TPhase extends RuntimePreparationPhase>(
  phase: TPhase,
  results: ReadonlyMap<object, unknown>,
): RuntimePreparedSteps<TPhase> {
  return Object.freeze({
    get: <TNode extends RuntimePreparationNode<TPhase, unknown>>(node: TNode) => {
      if (!results.has(node)) {
        throw new Error(
          `Runtime ${phase} preparation step ${node.id ?? "unnamed node"} was not run.`,
        );
      }
      return results.get(node) as RuntimePreparationOutput<TNode>;
    },
  });
}

function assertRuntimeFeatureMethodContracts<
  TNativeEvent,
  TNativeSession,
  TFeatures extends RuntimeFeatureSet,
>(
  driver: RuntimeDriver<TNativeEvent, TNativeSession, TFeatures>,
  descriptor: RuntimeAdapterDescriptor,
): void {
  for (const { name, enforcement } of RUNTIME_FEATURE_CATALOG) {
    if (enforcement.kind !== "driver-method") continue;
    const feature = driver.features[name];
    const enabled =
      isRuntimeFeatureEnabled(feature) &&
      (("when" in enforcement ? enforcement.when : undefined) !== "manual-compaction" ||
        feature.readiness.compactionModes?.includes("manual") === true);
    const method = driver[enforcement.method];
    if (enabled && method === undefined) {
      throw new Error(
        `Runtime ${descriptor.id} declares ${name} as ${feature.readiness.status} but does not implement ${enforcement.method}().`,
      );
    }
    if (!enabled && method !== undefined) {
      throw new Error(
        `Runtime ${descriptor.id} implements ${enforcement.method}() while feature ${name} is not enabled.`,
      );
    }
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

async function assertRuntimeCanUse<TNativeEvent, TNativeSession>(
  driver: RuntimeDriver<TNativeEvent, TNativeSession>,
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

class ManagedRuntimeSession<TNativeEvent, TNativeSession> {
  private watcher: RuntimeSessionWatcher | undefined;
  private activeRunId: string | undefined;
  private contextWindowCalibrated = false;
  private initialStartupMessagesConsumed = false;
  private startupMessagesReinjectionPending = false;
  private startupMessagesRetryPending: readonly ExpertAgentStartupMessage[] | undefined;

  constructor(
    private readonly options: {
      readonly agent: Expert;
      readonly driver: RuntimeDriver<TNativeEvent, TNativeSession>;
      readonly nativeSession: TNativeSession;
      readonly descriptor: RuntimeAdapterDescriptor;
      readonly lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined>;
      readonly logger: PragmaLogger;
      readonly runContext: ExpertAgentRunContext;
      readonly sessionFeatureOutputs: Readonly<Partial<Record<RuntimeFeatureName, unknown>>>;
      readonly startupMessages: readonly ExpertAgentStartupMessage[];
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
              this.rearmStartupMessages();
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
      onEvent: (event) => this.observeRuntimeEvent(event),
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
                ...(errorMetadata.httpStatus === undefined
                  ? {}
                  : { httpStatus: errorMetadata.httpStatus }),
                ...(errorMetadata.requestId === undefined
                  ? {}
                  : { requestId: errorMetadata.requestId }),
                ...(errorMetadata.endpoint === undefined
                  ? {}
                  : { endpoint: errorMetadata.endpoint }),
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
    const resources = new RuntimeResourceScope(`runtime-turn:${runId}`);
    const outcome = await this.executeSubmissionInScope(
      runId,
      submission,
      signal,
      controller,
      observeUsage,
      resources,
    ).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const cleanupError = await resources.dispose().then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!outcome.ok) {
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [outcome.error, cleanupError],
          `Runtime turn ${runId} and resource cleanup failed.`,
        );
      }
      throw outcome.error;
    }
    if (cleanupError !== undefined) throw cleanupError;
    return outcome.result;
  }

  private async executeSubmissionInScope<TOutput>(
    runId: string,
    submission: RuntimeSubmitRequest<TOutput>,
    signal: AgentRunExecutionContext["signal"],
    controller: ReturnType<typeof createRuntimeStreamController<TNativeEvent>>,
    observeUsage: (usage: AgentMessageUsage | undefined) => void,
    resources: RuntimeResourceScope,
  ): Promise<RuntimeRunResult<TOutput>> {
    const startupMessages = this.takeStartupMessages();
    const attachmentPlan = await resolveRuntimeAttachmentPlan({
      attachments: submission.attachments ?? [],
      listModels: this.options.driver.listModels,
      logger: this.options.logger,
      modelSelection: submission.modelSelection,
      query: submission.query,
      runtimeId: this.options.descriptor.id,
    });
    const preparedTurn = await prepareRuntimeTurnFeatures({
      driver: this.options.driver,
      agent: this.options.agent,
      runContext: this.options.runContext,
      sessionInfo: this.info(),
      runId,
      query: attachmentPlan.query,
      attachments: attachmentPlan.nativeAttachments,
      modelSelection: submission.modelSelection,
      output: submission.output,
      signal,
      logger: this.options.logger,
      resources,
      sessionFeatures: this.options.sessionFeatureOutputs,
    });
    const featureOutputs = Object.freeze({
      ...this.options.sessionFeatureOutputs,
      ...preparedTurn.features,
    }) as RuntimePreparedFeatureSet<RuntimeFeatureSet>;
    resources.seal();
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
          ? createInitialRuntimePrompt(attachmentPlan.query, submission.output)
          : createRuntimeOutputRetryPrompt(parseResult);
      const contextWindow = await this.refreshContextWindow(false);
      const attemptStartupMessages =
        attempt === 1
          ? this.applyStartupMessageBudget(startupMessages, contextWindow, submission, controller)
          : [];
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
            rawQuery: attachmentPlan.query,
            prompt,
            attachments: attempt === 1 ? attachmentPlan.nativeAttachments : [],
            startupMessages: attemptStartupMessages,
            modelSelection: submission.modelSelection,
            output: submission.output,
            signal,
            source: controller.source,
            stream: controller.writer,
            features: featureOutputs,
            steps: preparedTurn.steps,
          });
          this.options.logger.info(
            "runtime.model_request_finished",
            "Runtime adapter finished the native model request",
            { runId, attempt, durationMs: elapsedRuntimeMs(requestStartedAt) },
          );
          return result;
        } catch (error) {
          // Native runtimes may discover their resumable session identity before
          // reporting a terminal failure. Persist that observation before this
          // turn rejects, otherwise the next process cannot resume the native
          // conversation that actually received the startup message and prompt.
          const observedRuntimeSessionId = controller.getRuntimeSessionId();
          if (observedRuntimeSessionId !== undefined) {
            await this.options.updateRuntimeSessionId(
              observedRuntimeSessionId,
              "runtimeSessionId.changed",
            );
          } else if (this.info().runtimeSession.id === "" && attemptStartupMessages.length > 0) {
            // A fresh native process that failed before allocating a resumable
            // identity did not establish a durable recipient for startup context.
            // Preserve the exact consumed messages for the next submission.
            this.startupMessagesRetryPending = attemptStartupMessages;
          }
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

  private takeStartupMessages(): {
    readonly kind: "initial" | "reinjection";
    readonly messages: readonly ExpertAgentStartupMessage[];
  } {
    if (this.startupMessagesRetryPending !== undefined) {
      const messages = this.startupMessagesRetryPending;
      this.startupMessagesRetryPending = undefined;
      this.startupMessagesReinjectionPending = false;
      return { kind: "initial", messages };
    }
    if (!this.initialStartupMessagesConsumed) {
      this.initialStartupMessagesConsumed = true;
      const messages =
        this.options.driver.consumeStartupMessages?.(this.options.nativeSession, {
          agent: this.options.agent,
          runContext: this.options.runContext,
        }) ?? [];
      if (messages.length > 0) {
        this.startupMessagesReinjectionPending = false;
        return { kind: "initial", messages };
      }
    }

    if (this.startupMessagesReinjectionPending) {
      this.startupMessagesReinjectionPending = false;
      return { kind: "reinjection", messages: this.options.startupMessages };
    }

    return { kind: "initial", messages: [] };
  }

  private applyStartupMessageBudget<TOutput>(
    candidate: {
      readonly kind: "initial" | "reinjection";
      readonly messages: readonly ExpertAgentStartupMessage[];
    },
    contextWindow: RuntimeContextWindowUsage | undefined,
    submission: RuntimeSubmitRequest<TOutput>,
    controller: ReturnType<typeof createRuntimeStreamController<TNativeEvent>>,
  ): readonly ExpertAgentStartupMessage[] {
    if (
      candidate.kind !== "reinjection" ||
      candidate.messages.length === 0 ||
      contextWindow?.usedTokens === null ||
      contextWindow?.usedTokens === undefined
    ) {
      return candidate.messages;
    }

    const remainingTokens = Math.max(
      0,
      contextWindow.contextWindowTokens - contextWindow.usedTokens,
    );
    const thresholdTokens = Math.floor(remainingTokens * 0.5);
    const count = defaultRuntimeTokenCounter.countText(
      candidate.messages.map((message) => message.content).join("\n\n"),
      {
        runtimeKind: this.options.descriptor.kind,
        providerId: submission.modelSelection?.model.providerId,
        modelId: submission.modelSelection?.model.modelId,
      },
    );
    if (count.tokens <= thresholdTokens) {
      return candidate.messages;
    }

    const data = {
      reason: "insufficient_remaining_context",
      startupMessageTokens: count.tokens,
      tokenCountSource: count.source,
      remainingTokens,
      thresholdTokens,
      thresholdRatio: 0.5,
      contextWindow,
    };
    this.options.logger.warn(
      "runtime.startup_messages_reinjection_skipped",
      "Always-on context reinjection was skipped because it exceeded the remaining context budget.",
      data,
    );
    controller.writer.write({
      runId: controller.source.runId,
      source: controller.source,
      type: "progress",
      payload: {
        stage: RUNTIME_STARTUP_MESSAGE_STAGES.reinjectionSkipped,
        message:
          "Always-on context reinjection was skipped; use read_expert_context when the full context is needed.",
        data,
      },
    });
    return [];
  }

  private observeRuntimeEvent(event: RuntimeStreamEvent): void {
    if (
      event.type !== "progress" ||
      event.payload.stage !== RUNTIME_CONTEXT_COMPACTION_STAGES.completed ||
      readRuntimeContextCompactionProgressData(event.payload.data) === undefined
    ) {
      return;
    }
    this.rearmStartupMessages();
  }

  private rearmStartupMessages(): void {
    if (this.options.startupMessages.length > 0) {
      this.startupMessagesReinjectionPending = true;
    }
  }
}

interface RuntimeAttachmentPlan {
  readonly query: string;
  readonly nativeAttachments: readonly ExpertPromptAttachment[];
}

async function resolveRuntimeAttachmentPlan(options: {
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly listModels: RuntimeDriver<unknown, unknown>["listModels"];
  readonly logger: PragmaLogger;
  readonly modelSelection?: RuntimeModelSelection | undefined;
  readonly query: string;
  readonly runtimeId: string;
}): Promise<RuntimeAttachmentPlan> {
  const images = options.attachments.filter((attachment) => attachment.kind === "image");
  if (images.length === 0) {
    return { query: options.query, nativeAttachments: options.attachments };
  }
  const queryWithOriginalPaths = ensureImagePathContext(options.query, images);

  let selectedModel: RuntimeModel | undefined;
  let reason = "model-capability-unavailable";
  if (options.listModels !== undefined) {
    try {
      const models = await options.listModels();
      selectedModel = resolveSelectedRuntimeModel(models, options.modelSelection);
      reason =
        selectedModel === undefined ? "selected-model-unavailable" : "selected-model-is-text-only";
    } catch {
      reason = "model-catalog-unavailable";
    }
  }

  if (selectedModel?.inputModalities?.includes("image") === true) {
    return {
      query: queryWithOriginalPaths,
      nativeAttachments: options.attachments.map((attachment) => {
        if (attachment.kind !== "image" || attachment.optimized === undefined) return attachment;
        return {
          id: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          path: attachment.optimized.path,
          mimeType: attachment.optimized.mimeType,
          size: attachment.optimized.size,
        };
      }),
    };
  }

  options.logger.warn(
    "runtime.image_input_degraded",
    "Native image input was unavailable; the Runtime will continue with local image paths in text context.",
    {
      runtimeId: options.runtimeId,
      providerId: options.modelSelection?.model.providerId ?? selectedModel?.provider.id,
      modelId: options.modelSelection?.model.modelId ?? selectedModel?.id,
      imageCount: images.length,
      reason,
    },
  );
  return {
    query: queryWithOriginalPaths,
    nativeAttachments: options.attachments.filter((attachment) => attachment.kind !== "image"),
  };
}

function resolveSelectedRuntimeModel(
  models: readonly RuntimeModel[],
  selection: RuntimeModelSelection | undefined,
): RuntimeModel | undefined {
  if (selection === undefined) return models.find((model) => model.default === true);
  return models.find(
    (model) =>
      model.id === selection.model.modelId && model.provider.id === selection.model.providerId,
  );
}

function ensureImagePathContext(query: string, images: readonly ExpertPromptAttachment[]): string {
  const missing = images.filter((image) => !query.includes(image.path));
  if (missing.length === 0) return query;
  const references = missing.map((image) => {
    const name = escapePromptLine(image.name);
    const path = escapePromptLine(image.path);
    const mime = image.mimeType === undefined ? "" : ` (${escapePromptLine(image.mimeType)})`;
    return `- ${name}${mime}: ${path}`;
  });
  return [query.trimEnd(), "# Images available as local paths", ...references]
    .filter((part) => part !== "")
    .join("\n\n");
}

function escapePromptLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
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
  readonly httpStatus?: number | undefined;
  readonly requestId?: string | undefined;
  readonly endpoint?: string | undefined;
} {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const record = error as {
    readonly code?: unknown;
    readonly retryable?: unknown;
    readonly httpStatus?: unknown;
    readonly statusCode?: unknown;
    readonly status?: unknown;
    readonly requestId?: unknown;
    readonly endpoint?: unknown;
  };
  const status = [record.httpStatus, record.statusCode, record.status].find(
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599,
  );
  return {
    ...(typeof record.code === "string" && record.code.trim() !== "" ? { code: record.code } : {}),
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(typeof record.requestId === "string" && record.requestId.trim() !== ""
      ? { requestId: record.requestId.trim().slice(0, 500) }
      : {}),
    ...sanitizeRuntimeEndpoint(record.endpoint),
  };
}

function sanitizeRuntimeEndpoint(value: unknown): { readonly endpoint?: string | undefined } {
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const endpoint = new URL(value);
    endpoint.username = "";
    endpoint.password = "";
    endpoint.search = "";
    endpoint.hash = "";
    return { endpoint: endpoint.toString().slice(0, 2_048) };
  } catch {
    return {};
  }
}
