import { decodePragmaPathSegment, PragmaPaths } from "@pragma/core";
import type { Mission } from "@pragma/shared";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  createFileExpertSessionStore,
  type RuntimeAdapter,
  type RuntimeResolver,
  type PragmaLogger,
} from "@pragma/core";
import { createLocalHostNodeMissionCompiler } from "./node-mission-compiler.ts";
import { createLocalHostRunMemory } from "./run-memory.ts";
import {
  createIntegrationError,
  type IntegrationError,
  IntegrationErrorSchema,
  MissionIdSchema,
  type IntegrationCapability,
} from "@pragma/shared/integration";

import {
  LOCAL_HOST_SHARED_BOARD_STORE_ID,
  createControllerRunMissionPort,
  createExpertSessionPromptQueueProjection,
  createLocalHostApplication,
  createLocalHostBuiltInExecutorResolver,
  createLocalHostMissionBoardBindings,
  createLocalHostProjectCatalogFromHome,
  createLocalHostRunApplication,
  createLocalHostRuntimeResolver,
  createLocalHostStderrLoggerProvider,
  createLocalHostUsageSink,
  createMissionControlApplication,
  createMissionControllerStore,
  createLocalHostMissionController,
  findMissionPinnedBinding,
  listLocalHostBuiltInExecutorDescriptors,
  type LocalHostApplicationPort,
  type LocalHostCoreMissionControlAdapter,
  type LocalHostSharedBoardListRequest,
  type LocalHostSharedBoardReadRequest,
  type LocalHostSharedBoardSearchRequest,
  type WorkspaceFilesystemPort,
  type MissionControlClient,
  type MissionControlApplication,
  type LocalHostRunExecutorPort,
} from "./index.ts";
import type { LocalHostMissionControllerComposition } from "./missions/controller/composition.ts";
import type { MissionWatchPort } from "./missions/controller/watch.ts";
import { createMissionSessionAssociationResolver } from "./missions/session-association.ts";
import {
  createMissionStore,
  MissionStoreError,
  type MissionStore,
} from "./missions/repository/mission-store.ts";
import { createFencedMissionStore } from "./missions/repository/mission-store-fenced-adapter.ts";
import { createNodeMissionRepository } from "./missions/node-mission-repository.ts";
import { projectMissionSummary } from "./missions/query.ts";
import {
  createLocalHostMissionExecutionService,
  type LocalHostMissionExecutionServiceOptions,
} from "./missions/execution-service.ts";
import { createLocalHostNodeExecutionResourcePorts } from "./node-execution-resources.ts";
import { MissionExecutionOwner } from "./missions/execution-owner.ts";
import { createMissionExecutionEventProjector } from "./missions/mission-execution-event-projector.ts";
import { createLocalHostMissionExecutionRunPort } from "./missions/execution-run-port.ts";
import type { LocalHostMissionExecutionService } from "./missions/execution-service.ts";

/**
 * The Node Host composition shared by Desktop Main and the CLI.
 *
 * Concrete Runtime adapters remain at the surface because Local Host is not
 * allowed to depend on any runtime package. Every durable Mission, Board,
 * Project-catalog and Core-store decision belongs here instead of in an app.
 */
export interface LocalHostNodeApplicationOptions {
  readonly logger?: PragmaLogger | undefined;
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
  readonly missionControlAdapter?: LocalHostCoreMissionControlAdapter | undefined;
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
        readonly commands?: MissionControlApplication;
      }
    | undefined;
  readonly executionService?: LocalHostMissionExecutionService | undefined;
  readonly executorResolver?: LocalHostRunExecutorPort["resolve"] | undefined;
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
  const adapter =
    application?.executionService?.missionControl ?? application?.missionControlAdapter;
  if (application === undefined || lifecycle === undefined || adapter === undefined) {
    return undefined;
  }
  const control = createMissionControlApplication({
    logger: options.logger,
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
  adapter.bindApplication(control);
  return control;
}

function composeInjectedRun(
  options: LocalHostNodeApplicationOptions,
): LocalHostApplicationPort["run"] | undefined {
  const application = options.application;
  const lifecycle = application?.missionLifecycle;
  const adapter =
    application?.executionService?.missionControl ?? application?.missionControlAdapter;
  const service = application?.executionService;
  const resolve = application?.executorResolver;
  if (
    application === undefined ||
    lifecycle === undefined ||
    adapter === undefined ||
    service === undefined ||
    resolve === undefined
  ) {
    return undefined;
  }
  return createLocalHostRunApplication({
    executors: createLocalHostMissionExecutionRunPort(service, resolve),
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
    const run = composeInjectedRun(options);
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
              ...(options.application.executionService === undefined
                ? {}
                : {
                    resume: (input) =>
                      options.application!.executionService!.resumeLocalHostMission(input),
                  }),
              ...(commands === undefined ? {} : { commands }),
            },
          }),
      runtime: { resolver: runtimeResolver },
      ...(run === undefined ? {} : { run }),
    });
  }
  const loggerProvider = createLocalHostStderrLoggerProvider();
  const missionLogger = loggerProvider.createLogger({ component: "local-host.mission-controller" });
  const compiler = createLocalHostNodeMissionCompiler({
    pragmaHome: options.pragmaHome,
    runtimes: runtimeResolver,
    loggerProvider,
  });
  const resolveBuiltInExecutor = createLocalHostBuiltInExecutorResolver({
    pragmaHome: options.pragmaHome,
    runtimes: runtimeResolver,
    loggerProvider,
    compiler,
  });
  const projectCatalog = createLocalHostProjectCatalogFromHome({
    pragmaHome: options.pragmaHome,
    projectId: options.projectId,
    runtimes: runtimeResolver,
    loggerProvider,
    compiler,
    reader: compiler.reader,
  });
  const rawMissionRepository = createMissionStore({
    missionsPath: join(options.pragmaHome, "data", "missions"),
  });
  const readMissionEnvelope = async (id: string): Promise<Mission | undefined> => {
    try {
      return await rawMissionRepository.get(id);
    } catch (error) {
      if (error instanceof MissionStoreError && error.code === "mission_not_found")
        return undefined;
      throw error;
    }
  };
  let replaySemanticWrite:
    | Parameters<
        import("./missions/controller/mission-controller-store.ts").MissionControllerStore["recoverSemanticWrite"]
      >[0]["replay"]
    | undefined;
  const missionLifecycle: LocalHostMissionControllerComposition = createLocalHostMissionController({
    logger: missionLogger,
    missionsPath: join(options.pragmaHome, "data", "missions"),
    missionPath: rawMissionRepository.storagePath,
    readMission: readMissionEnvelope,
    recoverSemanticWrite: async ({ missionId, guard }) => {
      if (replaySemanticWrite === undefined)
        throw new Error("Mission repository replay is not initialized.");
      await missionLifecycle.controller.recoverSemanticWrite({
        missionId,
        guard,
        replay: replaySemanticWrite,
      });
    },
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
  const missionRepository = createFencedMissionStore(rawMissionRepository, {
    controller: missionController,
    ownerScope,
    setSemanticWriteReplay: (replay) => {
      replaySemanticWrite = replay;
    },
  });
  const nodeMissionRepository = createNodeMissionRepository({
    store: missionRepository,
    controller: missionController,
    readDefaultProject: async () => {
      const revision = await compiler.reader.getHead(options.projectId ?? "studio");
      return revision === undefined
        ? undefined
        : { id: revision.projectId, revision: revision.revision };
    },
  });
  const runMemory = createLocalHostRunMemory({
    pragmaHome: options.pragmaHome,
    loggerProvider,
    beforeFeedClose: async () => {
      await usageSink.drain();
      await usageSink.close();
    },
  });
  const executionStore = runMemory.executionStore;
  const expertSessionStore = createFileExpertSessionStore({
    pragmaHome: options.pragmaHome,
    executions: executionStore,
  });
  const resolveMissionSessionId = createMissionSessionAssociationResolver({
    controller: missionController,
    executions: executionStore,
    sessions: expertSessionStore,
    repositorySessionId: async (id) => {
      try {
        return (await rawMissionRepository.get(id)).execution?.sessionId;
      } catch (error) {
        if (error instanceof MissionStoreError && error.code === "mission_not_found")
          return undefined;
        throw error;
      }
    },
  });
  const promptQueueProjection = createExpertSessionPromptQueueProjection({
    sessions: expertSessionStore,
    resolveSessionId: resolveMissionSessionId,
    steeringFeatures: async (_sessionId, session) => {
      const rootContext = session.contexts[session.rootContextId];
      if (rootContext === undefined) return { supportsSteer: false };
      const resolved = await runtimeResolver
        .resolve({ binding: rootContext.runtime, modelSelection: rootContext.modelSelection })
        .catch(() => undefined);
      return {
        supportsSteer: resolved?.adapter.descriptor.capabilities?.supportsSteer === true,
        steeringRecovery: resolved?.adapter.features.steering.steeringRecovery,
      };
    },
    resolvePromptMetadata: async (prompt) => ({
      hasAttachments: hasPromptAttachments(
        (await executionStore.getInvocation(prompt.executionId, prompt.executionId))?.input,
      ),
    }),
  });
  const usageSink = createLocalHostUsageSink({
    path: join(options.pragmaHome, "data", "usage", "observations.json"),
    feed: runMemory.canonical,
    deliveryPath: new PragmaPaths(options).localHostUsageDelivery(),
    onError: (error) =>
      missionLogger.warn("usage.delivery_degraded", "Usage delivery needs recovery", {
        moduleId: "pragma.local-host-usage",
        errorCode: "USAGE_DELIVERY_RETRY_PENDING",
        error,
      }),
  });
  const resolveExecutor = async (input: Parameters<typeof projectCatalog.resolve>[0]) =>
    (await resolveBuiltInExecutor({
      ref: input.ref,
      workspace: input.workspace,
      purpose: input.purpose,
    })) ?? (await projectCatalog.resolve(input));
  const executionOwner: NonNullable<LocalHostMissionExecutionServiceOptions["executionOwner"]> =
    new MissionExecutionOwner();
  const executionProjector = createMissionExecutionEventProjector({
    controller: missionController,
    ownerScope,
  });
  const hasEnvelope = async (id: string): Promise<boolean> =>
    (await readMissionEnvelope(id)) !== undefined;
  const executionService = createLocalHostMissionExecutionService({
    pragmaHome: options.pragmaHome,
    missions: missionRepository,
    executionStore,
    expertSessionStore,
    executionOwner,
    ownerScope,
    ownerLifetime: "request",
    controllerFacts: {
      controller: missionController,
      hasEnvelope,
      resolveSessionId: resolveMissionSessionId,
      resolveMissionBinding: async (missionId) =>
        findMissionPinnedBinding((await missionController.readSnapshot({ missionId })).events),
      executors: resolveExecutor,
      compiler,
      usageSink,
      createHostContextBindings: async ({ missionId, request }) => [
        ...(await createLocalHostMissionBoardBindings({
          pragmaHome: options.pragmaHome,
          missionId,
        })),
        ...(await runMemory.bindings({
          missionId,
          goal: request.prompt ?? "",
          ...(request.project === undefined ? {} : { projectId: request.project.projectId }),
        })),
      ],
      memory: {
        linked: ({ missionId, executionId, projectId }) =>
          runMemory.register({
            missionId,
            executionId,
            ...(projectId === undefined ? {} : { projectId }),
          }),
        recovering: (id) => runMemory.resume(id),
        terminal: (id, waiting) => runMemory.complete(id, waiting),
        release: () => runMemory.pause(),
      },
    },
    runtimes: runtimeResolver,
    loggerProvider,
    resourcePorts: createLocalHostNodeExecutionResourcePorts({
      pragmaHome: options.pragmaHome,
      runtimes: runtimeResolver,
      compiler,
      memory: runMemory,
      usageSink,
      loggerProvider,
      missions: missionRepository,
    }),
    assertExecutorReady: async (_ref, scope) => {
      if (scope !== undefined) await compiler.assertReady(scope);
    },
    invalidateRuntimeReadiness: () => compiler.readiness.invalidate(),
    onExecutionLinked: (input) => executionProjector.link(input),
    onExecutionContextLinked: async ({ mission, executionId }) =>
      await runMemory.register({
        missionId: mission.id,
        executionId,
        projectId: mission.project.id,
      }),
    commitExecutionTerminal: (input) => executionProjector.terminal(input),
    onExecutionTerminal: async (input) => {
      await runMemory.complete(input.mission.id);
      await runMemory.pause();
    },
  });
  const missionPort = createControllerRunMissionPort(missionController, { ownerScope });
  const coreControl = executionService.missionControl;
  const sharedExecutorPort = createLocalHostMissionExecutionRunPort(
    executionService,
    resolveExecutor,
  );
  const executorPort = {
    ...sharedExecutorPort,
    assertStartAllowed: async (
      input: Parameters<NonNullable<LocalHostRunExecutorPort["assertStartAllowed"]>>[0],
    ) => {
      await nodeMissionRepository.ensureFreshMission(input);
      await sharedExecutorPort.assertStartAllowed?.(input);
    },
  };
  const missionControl = createMissionControlApplication({
    logger: missionLogger,
    controller: missionController,
    ownerScope,
    consumer: coreControl.consumer,
    client: options.client,
    assertMission: async (missionId) => {
      const envelope = await hasEnvelope(missionId);
      const snapshot = await missionController.readSnapshot({ missionId });
      if (!envelope && !snapshot.events.some((event) => event.type === "mission.created")) {
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
  coreControl.bindApplication(missionControl);

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
      get: async (missionId) => {
        await hasEnvelope(missionId);
        return await missionController.readSnapshot({ missionId });
      },
      list: async () =>
        await listMissionSnapshots(
          missionController,
          rawMissionRepository,
          join(options.pragmaHome, "data", "missions"),
        ),
      query: async (input) => {
        await hasEnvelope(input.missionId);
        return await missionQuery.queryMission(input);
      },
    },
    workspace: options.workspace,
    board: {
      list: async ({ missionId }) =>
        await readProductionSharedBoardList(
          missionController,
          options.pragmaHome,
          missionId,
          await hasEnvelope(missionId),
        ),
      read: async ({ missionId, id, start, maxBytes }) =>
        await readProductionSharedBoardItem(
          missionController,
          options.pragmaHome,
          missionId,
          id,
          start,
          maxBytes,
          await hasEnvelope(missionId),
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
          await hasEnvelope(missionId),
        ),
    },
    queue: { list: async (missionId) => await promptQueueProjection.list(missionId) },
    watch: {
      watch: async (input) => {
        await hasEnvelope(input.missionId);
        return await missionWatch.watch(input);
      },
    },
    missionControl: {
      resume: (input) => executionService.resumeLocalHostMission(input),
      commands: missionControl,
    },
    runtime: { resolver: runtimeResolver },
    run,
  });
}

async function openProductionSharedBoardStore(
  controller: ReturnType<typeof createMissionControllerStore>,
  pragmaHome: string,
  missionId: string,
  hasEnvelope: boolean,
) {
  let snapshot;
  try {
    snapshot = await controller.readSnapshot({ missionId });
  } catch (error) {
    return rethrowBoardStorageError(error);
  }
  if (!hasEnvelope && !snapshot.events.some((event) => event.type === "mission.created")) {
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
  if (shared?.store === undefined) {
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
  hasEnvelope: boolean,
) {
  const store = await openProductionSharedBoardStore(
    controller,
    pragmaHome,
    missionId,
    hasEnvelope,
  );
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
  hasEnvelope: boolean,
) {
  const store = await openProductionSharedBoardStore(
    controller,
    pragmaHome,
    missionId,
    hasEnvelope,
  );
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
  hasEnvelope: boolean,
) {
  const store = await openProductionSharedBoardStore(
    controller,
    pragmaHome,
    missionId,
    hasEnvelope,
  );
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
  repository: MissionStore,
  missionsPath: string,
): Promise<readonly Record<string, unknown>[]> {
  let directories;
  try {
    directories = await readdir(missionsPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const missionIds = new Set<string>();
  for (const entry of directories) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    let missionId: string;
    try {
      missionId = MissionIdSchema.parse(decodePragmaPathSegment(entry.name));
    } catch {
      const legacy = MissionIdSchema.safeParse(entry.name);
      if (!legacy.success) continue;
      missionId = legacy.data;
    }
    const ownerPath = join(missionsPath, entry.name);
    const controllerPath = join(ownerPath, "local-host");
    const controllerDirectory = await stat(controllerPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw localHostStorageError(missionId);
    });
    const manifest = await stat(join(ownerPath, "mission.yaml")).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw localHostStorageError(missionId);
    });
    if (controllerDirectory === undefined && manifest === undefined) continue;
    if (controllerDirectory !== undefined) {
      if (!controllerDirectory.isDirectory()) throw localHostStorageError(missionId);
      const aggregate = await stat(join(controllerPath, "aggregate.json")).catch(() => undefined);
      if (aggregate === undefined || !aggregate.isFile()) throw localHostStorageError(missionId);
    }
    missionIds.add(missionId);
  }
  const snapshots: Array<Record<string, unknown> | undefined> = await Promise.all(
    [...missionIds].map(async (missionId) => {
      let envelope: Mission | undefined;
      try {
        // The repository owns the locked, journaled legacy-path upgrade even
        // when this Mission has only controller facts and no envelope.
        envelope = await repository.get(missionId);
      } catch (error) {
        if (IntegrationErrorSchema.safeParse(error).success) throw error;
        if (!(error instanceof MissionStoreError) || error.code !== "mission_not_found")
          throw localHostStorageError(missionId);
      }
      let snapshot;
      try {
        snapshot = await controller.readSnapshot({ missionId });
      } catch (error) {
        if (IntegrationErrorSchema.safeParse(error).success) throw error;
        throw localHostStorageError(missionId);
      }
      const created = snapshot.events.find((event) => event.type === "mission.created");
      if (created === undefined && envelope === undefined) return undefined;
      const latest = snapshot.events.at(-1);
      const envelopeSummary =
        envelope === undefined
          ? undefined
          : projectMissionSummary({ missionId, snapshot, mission: envelope });
      const status =
        envelopeSummary?.status ?? missionStatus(snapshot.events.map((event) => event.type));
      const executor =
        envelope === undefined
          ? created?.data["executor"]
          : {
              kind: envelope.executor.kind,
              id: envelope.executor.ref.slice(envelope.executor.ref.indexOf(":") + 1),
            };
      return {
        id: missionId,
        missionId,
        title: envelope?.title ?? missionId,
        ...(executor === undefined ? {} : { executor }),
        ...(envelope === undefined
          ? created?.data["workspace"] === undefined
            ? {}
            : { workspace: { canonicalPath: created.data["workspace"] } }
          : { workspace: { canonicalPath: envelope.workspace.path } }),
        status,
        lifecycleStatus:
          envelope?.lifecycleStatus ??
          (["succeeded", "failed", "cancelled"].includes(status)
            ? "completed"
            : status === "queued"
              ? "queued"
              : "active"),
        execution:
          envelopeSummary === undefined
            ? executionSummary(snapshot.events)
            : envelopeSummary.execution,
        createdAt: envelope?.createdAt ?? created!.occurredAt,
        updatedAt: envelope?.updatedAt ?? latest?.occurredAt ?? created!.occurredAt,
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
