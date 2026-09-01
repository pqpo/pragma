import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeAdapter, RuntimeResolver } from "@pragma/core";
import {
  createIntegrationError,
  HumanInteractionRequestEnvelopeSchema,
  type IntegrationError,
  IntegrationErrorSchema,
  MissionIdSchema,
  type IntegrationCapability,
} from "@pragma/shared/integration";

import {
  LOCAL_HOST_SHARED_BOARD_STORE_ID,
  createControllerRunMissionPort,
  createCoreRunExecutorPort,
  createExpertSessionPromptQueueProjection,
  createLocalHostApplication,
  createLocalHostBuiltInExecutorResolver,
  createLocalHostCoreMissionControlAdapter,
  createLocalHostCoreStores,
  createLocalHostMissionBoardBindings,
  createLocalHostProjectCatalogFromHome,
  createLocalHostRunApplication,
  createLocalHostRuntimeResolver,
  createLocalHostStderrLoggerProvider,
  createLocalHostUsageSink,
  createMissionControlApplication,
  createMissionControllerStore,
  createMissionOwnerScope,
  createLocalHostMissionController,
  findMissionPinnedBinding,
  hashMissionResumePayload,
  listLocalHostBuiltInExecutorDescriptors,
  backfillMissionPinnedBinding,
  type LocalHostApplicationPort,
  type LocalHostSharedBoardListRequest,
  type LocalHostSharedBoardReadRequest,
  type LocalHostSharedBoardSearchRequest,
  type LocalHostMissionResumeRequest,
  type WorkspaceFilesystemPort,
  type MissionControlClient,
  type MissionControlExecutionOutcome,
  type MissionControlApplication,
  type LocalHostRunExecutorPort,
} from "./index.ts";
import type { LocalHostMissionControllerComposition } from "./missions/controller/composition.ts";
import type { MissionCommandConsumer } from "./missions/controller/mission-controller-store.ts";
import type { MissionWatchPort } from "./missions/controller/watch.ts";

/**
 * The Node Host composition shared by Desktop Main and the CLI.
 *
 * Concrete Runtime adapters remain at the surface because Local Host is not
 * allowed to depend on any runtime package. Every durable Mission, Board,
 * Project-catalog and Core-store decision belongs here instead of in an app.
 */
export interface LocalHostNodeApplicationOptions {
  readonly pragmaHome: string;
  /** Concrete adapters are supplied by CLI; Desktop may inject its resolver. */
  readonly runtimes: readonly RuntimeAdapter[] | RuntimeResolver;
  readonly defaultRuntimeId?: string | undefined;
  readonly runtimeAliases?: Readonly<Record<string, string>> | undefined;
  readonly client: MissionControlClient;
  readonly projectId?: string | undefined;
  readonly integrationCapability?: (() => Promise<IntegrationCapability>) | undefined;
  readonly workspace: WorkspaceFilesystemPort;
  /**
   * Optional Host-owned adapters used by Desktop's richer Mission services.
   * Supplying this skips the default file-backed composition while retaining
   * the same application facade and protocol policy.
   */
  readonly application?: LocalHostNodeApplicationPorts | undefined;
}

export interface LocalHostNodeApplicationPorts {
  readonly catalog: {
    readonly listProjects: LocalHostApplicationPort["listProjects"];
    readonly getProjectRevision: LocalHostApplicationPort["getProjectRevision"];
    readonly listExecutors: LocalHostApplicationPort["listExecutors"];
  };
  readonly missions: {
    readonly get: LocalHostApplicationPort["getMission"];
    readonly list: LocalHostApplicationPort["listMissions"];
    readonly query: LocalHostApplicationPort["queryMission"];
  };
  /** Optional Mission lifecycle supplied by a richer Host (for example Desktop). */
  readonly missionLifecycle?: LocalHostMissionControllerComposition | undefined;
  /** Mission command adapter supplied by a richer Host's domain runner. */
  readonly missionControlAdapter?: LocalHostNodeMissionControlAdapter | undefined;
  readonly assertMission?: ((missionId: string) => Promise<void>) | undefined;
  readonly onOwnerStartError?:
    | ((input: { readonly missionId: string; readonly error: unknown }) => Promise<void> | void)
    | undefined;
  readonly board: {
    readonly list: (input: LocalHostSharedBoardListRequest) => Promise<unknown>;
    readonly read: (input: LocalHostSharedBoardReadRequest) => Promise<unknown>;
    readonly search: (input: LocalHostSharedBoardSearchRequest) => Promise<unknown>;
  };
  readonly queue?: { readonly list: (missionId: string) => Promise<unknown> } | undefined;
  readonly watch?: MissionWatchPort | undefined;
  readonly missionControl?:
    | {
        readonly resume?: (input: LocalHostMissionResumeRequest) => Promise<unknown>;
        readonly commands?: MissionControlApplication;
      }
    | undefined;
  readonly runExecutor?: LocalHostRunExecutorPort | undefined;
  readonly run?: LocalHostApplicationPort["run"] | undefined;
}

export interface LocalHostNodeMissionControlAdapter {
  readonly consumer: MissionCommandConsumer;
  readonly assertAcquisitionAllowed?: ((missionId: string) => Promise<void>) | undefined;
  readonly resolveStrictTarget?:
    | ((input: {
        readonly missionId: string;
        readonly expectedExecutionId?: string | undefined;
      }) => Promise<
        | {
            readonly executionId: string;
            readonly turnId: string;
          }
        | undefined
      >)
    | undefined;
  readonly resolveExecutionTarget?:
    | ((input: {
        readonly missionId: string;
        readonly expectedExecutionId?: string | undefined;
      }) => Promise<string | undefined>)
    | undefined;
  readonly waitExecution?: MissionControlApplication["waitExecution"];
}

const LOCAL_HOST_FEATURES = [
  "run",
  "human-interaction",
  "idempotency",
  "mission.query",
  "mission.watch",
  "mission.resume",
  "mission.send",
  "mission.steer",
  "mission.respond",
  "mission.interrupt",
  "mission.queue.list",
  "mission.queue.remove",
  "mission.queue.resume",
  "mission.queue.steer",
  "workspace.resolve",
  "board.shared.read",
] as const;

export function createLocalHostIntegrationCapability(): IntegrationCapability {
  return {
    schemaVersion: "pragma.integration-capability/v1",
    protocol: "pragma.integration/v2",
    readableVersions: ["pragma.integration/v1", "pragma.integration/v2"],
    migratableFromVersions: [],
    features: [...LOCAL_HOST_FEATURES],
  };
}

function resolveNodeRuntime(options: LocalHostNodeApplicationOptions): RuntimeResolver {
  if (isRuntimeResolver(options.runtimes)) return options.runtimes;
  if (options.defaultRuntimeId === undefined) {
    throw new Error("A default Runtime id is required when composing adapters.");
  }
  return createLocalHostRuntimeResolver({
    runtimes: options.runtimes,
    defaultRuntimeId: options.defaultRuntimeId,
    runtimeAliases: options.runtimeAliases,
  });
}

function isRuntimeResolver(
  value: readonly RuntimeAdapter[] | RuntimeResolver,
): value is RuntimeResolver {
  return !Array.isArray(value) && typeof value === "object" && value !== null;
}

function composeInjectedMissionControl(
  options: LocalHostNodeApplicationOptions,
): MissionControlApplication | undefined {
  const application = options.application;
  const lifecycle = application?.missionLifecycle;
  const adapter = application?.missionControlAdapter;
  if (application === undefined || lifecycle === undefined || adapter === undefined) {
    return undefined;
  }
  return createMissionControlApplication({
    controller: lifecycle.controller,
    ownerScope: lifecycle.ownerScope,
    consumer: adapter.consumer,
    client: options.client,
    ...(application.assertMission === undefined
      ? {}
      : { assertMission: application.assertMission }),
    ...(adapter.assertAcquisitionAllowed === undefined
      ? {}
      : { assertAcquisitionAllowed: adapter.assertAcquisitionAllowed }),
    ...(adapter.resolveStrictTarget === undefined
      ? {}
      : { resolveStrictTarget: adapter.resolveStrictTarget }),
    ...(adapter.resolveExecutionTarget === undefined
      ? {}
      : { resolveExecutionTarget: adapter.resolveExecutionTarget }),
    ...(adapter.waitExecution === undefined ? {} : { waitExecution: adapter.waitExecution }),
    ...(application.onOwnerStartError === undefined
      ? {}
      : { onOwnerStartError: application.onOwnerStartError }),
  });
}

function composeInjectedRun(
  options: LocalHostNodeApplicationOptions,
): LocalHostApplicationPort["run"] | undefined {
  const application = options.application;
  const lifecycle = application?.missionLifecycle;
  const adapter = application?.missionControlAdapter;
  const executors = application?.runExecutor;
  if (
    application === undefined ||
    lifecycle === undefined ||
    adapter === undefined ||
    executors === undefined
  ) {
    return undefined;
  }
  return createLocalHostRunApplication({
    executors,
    mission: createControllerRunMissionPort(lifecycle.controller, {
      ownerScope: lifecycle.ownerScope,
    }),
    commandConsumer: adapter.consumer,
  });
}

export function createLocalHostNodeApplication(
  options: LocalHostNodeApplicationOptions,
): LocalHostApplicationPort {
  const runtimeResolver = resolveNodeRuntime(options);
  const integrationCapability =
    options.integrationCapability ?? (async () => createLocalHostIntegrationCapability());

  if (options.application !== undefined) {
    const missionControl = composeInjectedMissionControl(options);
    const run = options.application.run ?? composeInjectedRun(options);
    const commands = options.application.missionControl?.commands ?? missionControl;
    return createLocalHostApplication({
      integrationCapability,
      catalog: options.application.catalog,
      missions: options.application.missions,
      workspace: options.workspace,
      board: options.application.board,
      ...(options.application.queue === undefined ? {} : { queue: options.application.queue }),
      ...(options.application.watch === undefined ? {} : { watch: options.application.watch }),
      ...(options.application.missionControl === undefined && commands === undefined
        ? {}
        : {
            missionControl: {
              ...(options.application.missionControl?.resume === undefined
                ? {}
                : { resume: options.application.missionControl.resume }),
              ...(commands === undefined ? {} : { commands }),
            },
          }),
      runtime: { resolver: runtimeResolver },
      ...(run === undefined ? {} : { run }),
    });
  }
  const loggerProvider = createLocalHostStderrLoggerProvider();
  const missionLogger = loggerProvider.createLogger({ component: "local-host.mission-controller" });
  const resolveBuiltInExecutor = createLocalHostBuiltInExecutorResolver({
    pragmaHome: options.pragmaHome,
    runtimes: runtimeResolver,
    loggerProvider,
  });
  const projectCatalog = createLocalHostProjectCatalogFromHome({
    pragmaHome: options.pragmaHome,
    projectId: options.projectId,
    runtimes: runtimeResolver,
    loggerProvider,
  });
  const missionLifecycle = createLocalHostMissionController({
    missionsPath: join(options.pragmaHome, "data", "missions"),
    onPollingError: ({ missionId, error, consecutiveFailures }) =>
      missionLogger.warn(
        "mission.controller_inbox_poll_failed",
        "Mission Inbox polling failed; the durable command remains recoverable.",
        { missionId, consecutiveFailures, error },
      ),
    onLeaseLost: (missionId) =>
      missionLogger.warn(
        "mission.controller_lease_lost",
        "Mission controller lease was lost; pending durable work can be reacquired.",
        { missionId },
      ),
  });
  const {
    controller: missionController,
    query: missionQuery,
    watch: missionWatch,
    ownerScope,
  } = missionLifecycle;
  const { executions: executionStore, sessions: expertSessionStore } = createLocalHostCoreStores({
    pragmaHome: options.pragmaHome,
  });
  const promptQueueProjection = createExpertSessionPromptQueueProjection({
    sessions: expertSessionStore,
    resolveSessionId: async (missionId) => (await expertSessionStore.get(missionId))?.sessionId,
    supportsSteer: async (sessionId) => {
      const session = await expertSessionStore.get(sessionId);
      if (session === undefined) return false;
      const rootContext = session.contexts[session.rootContextId];
      if (rootContext === undefined) return false;
      const resolved = await runtimeResolver
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
  const usageSink = createLocalHostUsageSink({
    path: join(options.pragmaHome, "data", "usage", "observations.json"),
  });
  const resolveExecutor = async (input: Parameters<typeof projectCatalog.resolve>[0]) =>
    (await resolveBuiltInExecutor({ ref: input.ref, workspace: input.workspace })) ??
    (await projectCatalog.resolve(input));
  const executorPort = createCoreRunExecutorPort({
    pragmaHome: options.pragmaHome,
    runtimes: runtimeResolver,
    usageSink,
    loggerProvider,
    executions: executionStore,
    sessions: expertSessionStore,
    createHostContextBindings: async ({ missionId }) =>
      await createLocalHostMissionBoardBindings({ pragmaHome: options.pragmaHome, missionId }),
    executors: resolveExecutor,
  });
  const missionPort = createControllerRunMissionPort(missionController, { ownerScope });
  const coreControl = createLocalHostCoreMissionControlAdapter({
    pragmaHome: options.pragmaHome,
    runtimes: runtimeResolver,
    usageSink,
    loggerProvider,
    executions: executionStore,
    sessions: expertSessionStore,
    mission: missionPort,
    createHostContextBindings: async ({ missionId }) =>
      await createLocalHostMissionBoardBindings({ pragmaHome: options.pragmaHome, missionId }),
    executors: resolveExecutor,
    resolveActiveOwner: executorPort.resolveActiveOwner,
    resolveMissionBinding: async (missionId) =>
      findMissionPinnedBinding((await missionController.readSnapshot({ missionId })).events),
    hasPendingMissionCommands: async (missionId) =>
      (await missionController.listOperations({ missionId })).some(
        (operation) => operation.state === "queued" || operation.state === "applying",
      ),
    releaseMissionOwner: async (missionId) => {
      const hasPending = (await missionController.listOperations({ missionId })).some(
        (operation) => operation.state === "queued" || operation.state === "applying",
      );
      if (hasPending) return;
      await ownerScope.release(missionId);
    },
  });
  const missionControl = createMissionControlApplication({
    controller: missionController,
    ownerScope,
    consumer: coreControl.consumer,
    client: options.client,
    assertMission: async (missionId) => {
      const snapshot = await missionController.readSnapshot({ missionId });
      if (!snapshot.events.some((event) => event.type === "mission.created")) {
        throw createIntegrationError({
          code: "MISSION_NOT_FOUND",
          category: "not_found",
          message: `Mission not found: ${missionId}.`,
          details: { missionId },
        });
      }
    },
    assertAcquisitionAllowed: coreControl.assertAcquisitionAllowed,
    resolveStrictTarget: coreControl.resolveStrictTarget,
    resolveExecutionTarget: coreControl.resolveExecutionTarget,
    waitExecution: coreControl.waitExecution,
    onOwnerStartError: ({ missionId, error }) =>
      missionLogger.warn(
        "mission.controller_owner_start_failed",
        "Mission command is durable, but its owner could not be started yet.",
        { missionId, error },
      ),
  });
  const run = createLocalHostRunApplication({
    executors: executorPort,
    mission: missionPort,
    commandConsumer: coreControl.consumer,
  });

  return createLocalHostApplication({
    integrationCapability,
    catalog: {
      listProjects: async () => await projectCatalog.listProjects(),
      getProjectRevision: async (projectId, revision) =>
        await projectCatalog.getProjectRevision(projectId, revision),
      listExecutors: async () =>
        await [
          ...(await listLocalHostBuiltInExecutorDescriptors({ runtimes: runtimeResolver })),
          ...(await projectCatalog.listExecutors()),
        ],
    },
    missions: {
      get: async (missionId) => await missionController.readSnapshot({ missionId }),
      list: async () =>
        await listMissionSnapshots(missionController, join(options.pragmaHome, "data", "missions")),
      query: missionQuery.queryMission,
    },
    workspace: options.workspace,
    board: {
      list: async ({ missionId }) =>
        await readProductionSharedBoardList(missionController, options.pragmaHome, missionId),
      read: async ({ missionId, id, start, maxBytes }) =>
        await readProductionSharedBoardItem(
          missionController,
          options.pragmaHome,
          missionId,
          id,
          start,
          maxBytes,
        ),
      search: async ({ missionId, query, maxResults, contextLines, caseSensitive }) =>
        await searchProductionSharedBoard(
          missionController,
          options.pragmaHome,
          missionId,
          query,
          maxResults,
          contextLines,
          caseSensitive,
        ),
    },
    queue: { list: async (missionId) => await promptQueueProjection.list(missionId) },
    watch: missionWatch,
    missionControl: {
      resume: async (input) =>
        await resumeMission({
          input,
          missionController,
          missionControl,
          coreControl,
          ownerScope,
          projectCatalog,
          resolveBuiltInExecutor,
          expertSessionStore,
          executionStore,
        }),
      commands: missionControl,
    },
    runtime: { resolver: runtimeResolver },
    run,
  });
}

async function resumeMission(input: {
  readonly input: LocalHostMissionResumeRequest;
  readonly missionController: ReturnType<typeof createMissionControllerStore>;
  readonly missionControl: MissionControlApplication;
  readonly coreControl: ReturnType<typeof createLocalHostCoreMissionControlAdapter>;
  readonly ownerScope: ReturnType<typeof createMissionOwnerScope>;
  readonly projectCatalog: ReturnType<typeof createLocalHostProjectCatalogFromHome>;
  readonly resolveBuiltInExecutor: ReturnType<typeof createLocalHostBuiltInExecutorResolver>;
  readonly expertSessionStore: ReturnType<typeof createLocalHostCoreStores>["sessions"];
  readonly executionStore: ReturnType<typeof createLocalHostCoreStores>["executions"];
}): Promise<unknown> {
  const { input: request } = input;
  await backfillMissionPinnedBinding(
    {
      controller: input.missionController,
      catalog: input.projectCatalog,
      builtInResolver: async ({ ref, workspace }) =>
        await input.resolveBuiltInExecutor({ ref, workspace }),
      sessions: input.expertSessionStore,
      executions: input.executionStore,
    },
    request,
  );
  await input.coreControl.assertAcquisitionAllowed(request.missionId);
  const requestId = request.requestId ?? globalThis.crypto.randomUUID();
  const payloadHash = hashMissionResumePayload({
    missionId: request.missionId,
    ...(request.project === undefined ? {} : { project: request.project }),
    ...(request.expectedFingerprint === undefined
      ? {}
      : { expectedFingerprint: request.expectedFingerprint }),
  });
  const reserved = await input.missionControl.reserveOperation({
    missionId: request.missionId,
    requestId,
    payloadHash,
    kind: "resume",
  });
  if (reserved.operation.state === "applied") {
    return reserved.operation.result ?? { missionId: request.missionId, status: "resumed" };
  }
  if (reserved.operation.state === "rejected" || reserved.operation.state === "failed") {
    throw resumeOperationError(reserved.operation.error, request.missionId);
  }
  const snapshot = await input.missionController.readSnapshot({ missionId: request.missionId });
  if (
    snapshot.snapshot.lease !== undefined &&
    Date.parse(snapshot.snapshot.lease.expiresAt) > Date.now()
  ) {
    const error = createIntegrationError({
      code: "MISSION_LEASE_HELD",
      category: "conflict",
      message: "Mission already has a live owner.",
      details: { missionId: request.missionId },
    });
    await input.missionControl.completeOperation({
      missionId: request.missionId,
      requestId,
      payloadHash,
      state: "rejected",
      error,
    });
    throw error;
  }
  if (request.detach) {
    // Resume is represented by a reserved Local Host operation rather than a
    // Mission command. Preserve the same durable-receipt contract as command
    // mutations: schedule owner acquisition/recovery and return the queued
    // operation without waiting for the owner or Runtime execution.
    void resumeMission({
      ...input,
      input: {
        ...request,
        requestId,
        detach: false,
        onHumanInteraction: undefined,
      },
    }).catch(() => undefined);
    return {
      missionId: request.missionId,
      status: "accepted",
      operation: reserved.operation,
    };
  }
  let acquired = false;
  let recovered = false;
  let operationCompleted = false;
  try {
    const owner = await input.missionControl.startOwner(request.missionId);
    if (owner === "live") {
      const error = createIntegrationError({
        code: "MISSION_LEASE_HELD",
        category: "conflict",
        message: "Mission already has a live owner.",
        details: { missionId: request.missionId },
      });
      await input.missionControl.completeOperation({
        missionId: request.missionId,
        requestId,
        payloadHash,
        state: "rejected",
        error,
      });
      operationCompleted = true;
      throw error;
    }
    acquired = true;
    await input.coreControl.recoverMission(request.missionId);
    recovered = true;
    const base = {
      missionId: request.missionId,
      status: request.detach ? "accepted" : "resumed",
    } as const;
    let result: Record<string, unknown> = base;
    if (!request.detach) {
      const executionId = await input.coreControl.resolveExecutionTarget({
        missionId: request.missionId,
      });
      if (executionId !== undefined) {
        const execution = await waitForResumedExecution({
          missionId: request.missionId,
          executionId,
          control: input.missionControl,
          onHumanInteraction: request.onHumanInteraction,
        });
        if (execution.status === "failed") {
          throw (
            execution.error ??
            createIntegrationError({
              code: "EXECUTION_FAILED",
              category: "execution",
              retryable: false,
              message: "The resumed Mission execution failed.",
            })
          );
        }
        result = {
          ...base,
          ...(execution.status === "waiting" ? { status: "input_required" as const } : {}),
          execution,
        };
      }
    }
    const operation = await input.missionControl.completeOperation({
      missionId: request.missionId,
      requestId,
      payloadHash,
      state: "applied",
      result,
      guard: input.ownerScope.currentGuard(request.missionId),
    });
    operationCompleted = true;
    const completed = { ...result, operation };
    if (!request.detach) {
      await releaseRecoveredOwner({
        missionId: request.missionId,
        coreControl: input.coreControl,
        ownerScope: input.ownerScope,
      });
    }
    return completed;
  } catch (error) {
    const parsedError = IntegrationErrorSchema.safeParse(error);
    const integrationError = parsedError.success
      ? parsedError.data
      : createIntegrationError({
          code: "COMMAND_REJECTED",
          category: "conflict",
          message: error instanceof Error ? error.message : "Mission resume failed.",
        });
    if (!operationCompleted) {
      await input.missionControl
        .completeOperation({
          missionId: request.missionId,
          requestId,
          payloadHash,
          state: "rejected",
          error: integrationError,
          guard: input.ownerScope.currentGuard(request.missionId),
        })
        .catch(() => undefined);
    }
    if (acquired && recovered) {
      await releaseRecoveredOwner({
        missionId: request.missionId,
        coreControl: input.coreControl,
        ownerScope: input.ownerScope,
      }).catch(() => undefined);
    } else if (acquired) {
      await input.coreControl.release(request.missionId).catch(() => undefined);
      await input.ownerScope.release(request.missionId).catch(() => undefined);
    }
    throw error;
  }
}

async function waitForResumedExecution(options: {
  readonly missionId: string;
  readonly executionId: string;
  readonly control: MissionControlApplication;
  readonly onHumanInteraction?: LocalHostMissionResumeRequest["onHumanInteraction"];
}): Promise<MissionControlExecutionOutcome> {
  for (;;) {
    const execution = await options.control.waitExecution!({
      missionId: options.missionId,
      executionId: options.executionId,
    });
    if (execution.status !== "waiting" || execution.interaction === undefined) return execution;
    const interaction = HumanInteractionRequestEnvelopeSchema.parse(execution.interaction);
    if (options.onHumanInteraction === undefined) return execution;
    const decision = await options.onHumanInteraction(interaction);
    if (decision.kind === "checkpoint") return execution;
    const responseRequestId = globalThis.crypto.randomUUID();
    await options.control.submit({
      missionId: options.missionId,
      requestId: responseRequestId,
      kind: "respond",
      payload: { kind: "respond", response: decision.response },
      target: { interactionId: interaction.interactionId },
    });
    const responseOperation = await options.control.waitForTerminal({
      missionId: options.missionId,
      requestId: responseRequestId,
    });
    assertAppliedOperation(responseOperation, options.missionId);
  }
}

function assertAppliedOperation(
  operation: { readonly state: string; readonly error?: Record<string, unknown> },
  missionId: string,
): void {
  if (operation.state === "applied") return;
  throw resumeOperationError(operation.error, missionId);
}

async function releaseRecoveredOwner(options: {
  readonly missionId: string;
  readonly coreControl: ReturnType<typeof createLocalHostCoreMissionControlAdapter>;
  readonly ownerScope: ReturnType<typeof createMissionOwnerScope>;
}): Promise<void> {
  const guard = options.ownerScope.currentGuard(options.missionId);
  if (guard === undefined) {
    await options.coreControl.release(options.missionId);
    return;
  }
  try {
    await options.coreControl.releaseAfterHumanCheckpoint(options.missionId, guard);
  } catch (error) {
    // A recovered owner may have started a subsequent queued execution while
    // the requested execution was being observed. Keep that owner alive and
    // let its poller continue; the command outcome is already durable.
    if (!(error instanceof Error) || !error.message.includes("active execution")) throw error;
    return;
  }
  await options.ownerScope.release(options.missionId);
}

function resumeOperationError(error: Record<string, unknown> | undefined, missionId: string) {
  const parsed = IntegrationErrorSchema.safeParse(error);
  return parsed.success
    ? parsed.data
    : createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "Mission resume was rejected: " + missionId + ".",
      });
}

async function openProductionSharedBoardStore(
  controller: ReturnType<typeof createMissionControllerStore>,
  pragmaHome: string,
  missionId: string,
) {
  let snapshot;
  try {
    snapshot = await controller.readSnapshot({ missionId });
  } catch (error) {
    return rethrowBoardStorageError(error);
  }
  if (!snapshot.events.some((event) => event.type === "mission.created")) {
    throw createIntegrationError({
      code: "MISSION_NOT_FOUND",
      category: "not_found",
      message: `Mission not found: ${missionId}.`,
      details: { missionId },
    });
  }
  let bindings;
  try {
    bindings = await createLocalHostMissionBoardBindings({ pragmaHome, missionId });
  } catch (error) {
    return rethrowBoardStorageError(error);
  }
  const shared = bindings.find((binding) => binding.namespace === LOCAL_HOST_SHARED_BOARD_STORE_ID);
  if (shared === undefined) {
    throw createIntegrationError({
      code: "DEPENDENCY_UNAVAILABLE",
      category: "dependency",
      message: "The Local Host shared Mission Board is unavailable.",
    });
  }
  return shared.store;
}

async function readProductionSharedBoardList(
  controller: ReturnType<typeof createMissionControllerStore>,
  pragmaHome: string,
  missionId: string,
) {
  const store = await openProductionSharedBoardStore(controller, pragmaHome, missionId);
  const result = await store.listContext({});
  return unwrapBoardContextResult(result).map((item) => ({
    ...item,
    namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID,
  }));
}

async function readProductionSharedBoardItem(
  controller: ReturnType<typeof createMissionControllerStore>,
  pragmaHome: string,
  missionId: string,
  id: string,
  start: number,
  maxBytes: number,
) {
  const store = await openProductionSharedBoardStore(controller, pragmaHome, missionId);
  const result = await store.readContext({ id, start, offset: maxBytes });
  return { ...unwrapBoardContextResult(result), namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID };
}

async function searchProductionSharedBoard(
  controller: ReturnType<typeof createMissionControllerStore>,
  pragmaHome: string,
  missionId: string,
  query: string,
  maxResults: number,
  contextLines: number,
  caseSensitive: boolean | undefined,
) {
  const store = await openProductionSharedBoardStore(controller, pragmaHome, missionId);
  const [searchResult, listResult] = await Promise.all([
    store.searchContext({ query, maxResults, contextLines, caseSensitive }),
    store.listContext({}),
  ]);
  const summaries = unwrapBoardContextResult(listResult);
  const summariesById = new Map(
    summaries.map((item) => [item.id, { ...item, namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID }]),
  );
  return unwrapBoardContextResult(searchResult).map((match) => ({
    ...match,
    item: summariesById.get(match.id) ?? {
      id: match.id,
      namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID,
      metadata: { trigger: "manual" as const, priority: "normal" as const },
      revision: "unknown",
      sizeBytes: 0,
    },
  }));
}

function unwrapBoardContextResult<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string } },
): T {
  if (result.ok) return result.value;
  switch (result.error.code) {
    case "context_not_found":
      throw createIntegrationError({
        code: "BOARD_ITEM_NOT_FOUND",
        category: "not_found",
        message: "Mission Board item not found.",
      });
    case "permission_denied":
      throw createIntegrationError({
        code: "PERMISSION_DENIED",
        category: "permission",
        message: "Private Mission Board namespaces are not readable.",
      });
    case "invalid_input":
    case "context_too_large":
    case "context_budget_exceeded":
      throw createIntegrationError({
        code: "INVALID_ARGUMENT",
        category: "usage",
        message: "The Mission Board request is invalid.",
      });
    case "store_unavailable":
      throw createIntegrationError({
        code: "DEPENDENCY_UNAVAILABLE",
        category: "dependency",
        message: "The Mission Board storage is unavailable.",
      });
    case "store_error":
    default:
      throw createIntegrationError({
        code: "STORAGE_CORRUPTED",
        category: "protocol",
        message: "The Mission Board storage is corrupted.",
      });
  }
}

function rethrowBoardStorageError(error: unknown): never {
  const parsed = IntegrationErrorSchema.safeParse(error);
  if (parsed.success) throw parsed.data;
  throw createIntegrationError({
    code: "STORAGE_CORRUPTED",
    category: "protocol",
    message: "The Mission Board storage is corrupted.",
  });
}

function hasPromptAttachments(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attachments = (value as { readonly attachments?: unknown }).attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}

async function listMissionSnapshots(
  controller: ReturnType<typeof createMissionControllerStore>,
  missionsPath: string,
): Promise<readonly Record<string, unknown>[]> {
  let directories;
  try {
    directories = await readdir(missionsPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const missionIds: string[] = [];
  for (const entry of directories) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!MissionIdSchema.safeParse(entry.name).success) continue;
    const localHostPath = join(missionsPath, entry.name, "local-host");
    let localHostDirectory: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      localHostDirectory = await stat(localHostPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw localHostStorageError(entry.name);
    }
    if (!localHostDirectory.isDirectory()) throw localHostStorageError(entry.name);
    let aggregate: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      aggregate = await stat(join(localHostPath, "aggregate.json"));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) throw localHostStorageError(entry.name);
      throw localHostStorageError(entry.name);
    }
    if (!aggregate.isFile()) throw localHostStorageError(entry.name);
    missionIds.push(entry.name);
  }
  const snapshots: Array<Record<string, unknown> | undefined> = await Promise.all(
    missionIds.map(async (missionId) => {
      let snapshot;
      try {
        snapshot = await controller.readSnapshot({ missionId });
      } catch (error) {
        if (IntegrationErrorSchema.safeParse(error).success) throw error;
        throw localHostStorageError(missionId);
      }
      const created = snapshot.events.find((event) => event.type === "mission.created");
      if (created === undefined) return undefined;
      const latest = snapshot.events.at(-1);
      const status = missionStatus(snapshot.events.map((event) => event.type));
      const executor = created.data["executor"];
      return {
        id: missionId,
        missionId,
        title: missionId,
        ...(executor === undefined ? {} : { executor }),
        ...(created.data["workspace"] === undefined
          ? {}
          : { workspace: { canonicalPath: created.data["workspace"] } }),
        status,
        lifecycleStatus: ["succeeded", "failed", "cancelled"].includes(status)
          ? "completed"
          : status === "queued"
            ? "queued"
            : "active",
        execution: executionSummary(snapshot.events),
        createdAt: created.occurredAt,
        updatedAt: latest?.occurredAt ?? created.occurredAt,
        eventSequence: snapshot.snapshot.eventSequence,
        cursor: snapshot.cursor,
      };
    }),
  );
  return snapshots
    .filter((snapshot): snapshot is Record<string, unknown> => snapshot !== undefined)
    .toSorted((left, right) => String(right["updatedAt"]).localeCompare(String(left["updatedAt"])));
}

function localHostStorageError(missionId: string): IntegrationError {
  return createIntegrationError({
    code: "STORAGE_CORRUPTED",
    category: "protocol",
    message: "A Local Host Mission aggregate is corrupted.",
    details: { missionId },
  });
}

function missionStatus(
  eventTypes: readonly string[],
): "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" {
  for (const type of eventTypes.toReversed()) {
    switch (type) {
      case "run.succeeded":
        return "succeeded";
      case "run.failed":
        return "failed";
      case "run.interrupted":
        return "cancelled";
      case "run.input_required":
      case "human.requested":
      case "human.interaction.requested":
        return "waiting";
      case "run.started":
      case "execution.started":
        return "running";
      case "run.accepted":
        return "queued";
    }
  }
  return "queued";
}

function executionSummary(
  events: readonly { readonly type: string; readonly data: Record<string, unknown> }[],
): Record<string, unknown> | undefined {
  const started = events.toReversed().find((event) => event.type === "run.started");
  if (started === undefined) return undefined;
  const executionId = started.data["executionId"];
  const status = missionStatus(events.map((event) => event.type));
  return {
    ...(typeof executionId === "string" ? { id: executionId } : {}),
    status: status === "cancelled" ? "interrupted" : status,
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
