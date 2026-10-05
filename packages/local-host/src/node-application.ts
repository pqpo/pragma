import { PragmaPaths } from "@pragma/core";
import type { Mission } from "@pragma/shared";
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
  IntegrationErrorSchema,
  type IntegrationCapability,
} from "@pragma/shared/integration";

import {
  createExpertSessionPromptQueueProjection,
  createLocalHostApplication,
  createLocalHostBuiltInExecutorResolver,
  createLocalHostMissionBoardBindings,
  createLocalHostProjectCatalogFromHome,
  createLocalHostRuntimeResolver,
  createLocalHostStderrLoggerProvider,
  createLocalHostUsageSink,
  createLocalHostMissionController,
  findMissionPinnedBinding,
  listLocalHostBuiltInExecutorDescriptors,
  type LocalHostApplicationPort,
  type WorkspaceFilesystemPort,
  type MissionControlClient,
} from "./index.ts";
import type { LocalHostMissionControllerComposition } from "./missions/controller/composition.ts";
import { createMissionDelivery } from "./missions/mission-delivery.ts";
import { createMissionTerminalMaterializer } from "./missions/mission-terminal-materializer.ts";
import { createMissionSessionAssociationResolver } from "./missions/session-association.ts";
import { createMissionStore, MissionStoreError } from "./missions/repository/mission-store.ts";
import { createFencedMissionStore } from "./missions/repository/mission-store-fenced-adapter.ts";
import { createNodeMissionRepository } from "./missions/node-mission-repository.ts";
import { createLocalHostMissionReadPorts } from "./missions/read-ports.ts";
import { type LocalHostMissionExecutionServiceOptions } from "./missions/execution-service.ts";
import { createLocalHostNodeExecutionResourcePorts } from "./node-execution-resources.ts";
import { MissionExecutionOwner } from "./missions/execution-owner.ts";
import { createMissionExecutionEventProjector } from "./missions/mission-execution-event-projector.ts";
import { createLocalHostMissionApplication } from "./missions/application.ts";

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

export function createLocalHostNodeApplication(
  options: LocalHostNodeApplicationOptions,
): LocalHostApplicationPort {
  const runtimeResolver = resolveNodeRuntime(options);
  const integrationCapability =
    options.integrationCapability ?? (async () => createLocalHostIntegrationCapability());

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
  let missionDelivery: Promise<Awaited<ReturnType<typeof createMissionDelivery>>> | undefined;
  let resourcesClosing = false;
  const receiptRecovery = new Set<Promise<void>>();
  const recoveringMissions = new Set<string>();
  const runMemory = createLocalHostRunMemory({
    pragmaHome: options.pragmaHome,
    loggerProvider,
    beforeFeedClose: async () => {
      await Promise.all(receiptRecovery);
      // Native settlement can have committed its terminal after the last scheduler tick.
      // Shutdown hands off those facts before closing the feed, without waiting for enrichment.
      await executionStore.drainCanonicalEvents();
      if (missionDelivery !== undefined) {
        const delivery = await missionDelivery;
        delivery.pause();
        await delivery.takeCustody();
        await delivery.close();
      }
      if (runMemory.hasCanonicalSource()) await usageSink.drain();
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
  // Open custody only on explicit owner access. No global recovery scan runs at construction.
  const getMissionDelivery = () =>
    (missionDelivery ??= createMissionDelivery({
      path: new PragmaPaths(options).missionDelivery(),
      feed: runMemory.canonical,
      logger: missionLogger,
      usage: async (_mission, observation) => await usageSink.reconcile([observation]),
      terminal: createMissionTerminalMaterializer({
        ownerScope,
        ownerLifetime: "request",
        withAdmission: (missionId, operation) => executionOwner.admit(missionId, operation),
        missions: missionRepository,
        executions: executionStore,
        projector: executionProjector,
        memory: async (mission, executionId) => await runMemory.reconcile(mission.id, executionId),
      }),
    }).catch((error: unknown) => {
      missionDelivery = undefined;
      throw error;
    }));
  const hasEnvelope = async (id: string): Promise<boolean> =>
    (await readMissionEnvelope(id)) !== undefined;
  const wakeReceiptRecovery = (missionId: string): void => {
    if (resourcesClosing || recoveringMissions.has(missionId)) return;
    recoveringMissions.add(missionId);
    const recovery = (async () => {
      const mission = await readMissionEnvelope(missionId);
      if (mission?.execution === undefined) return;
      const delivery = await getMissionDelivery();
      await delivery.register(mission, mission.execution.id, mission.execution.inputMessageId);
      const existing = ownerScope.currentGuard(missionId);
      const guard = existing ?? (await ownerScope.acquireForRecovery(missionId));
      try {
        await delivery.settleMission(missionId);
      } finally {
        // Once disposal owns cleanup, leave this exact claim in the shared
        // owner inventory so its normal release retry/fencing rules apply.
        if (existing === undefined && !resourcesClosing) await ownerScope.release(missionId, guard);
      }
    })().catch((error: unknown) => {
      // Reading an owner held by another Host is normal; its consumer retains
      // custody. Leave the tasks untouched rather than marking this Module down.
      if (IntegrationErrorSchema.safeParse(error).data?.code === "MISSION_LEASE_HELD") return;
      missionLogger.warn("mission.delivery_degraded", "Mission receipt recovery needs attention", {
        missionId,
        moduleId: "pragma.mission-delivery",
        errorCode: "MISSION_DELIVERY_UNAVAILABLE",
        error,
      });
    });
    receiptRecovery.add(recovery);
    void recovery.finally(() => {
      receiptRecovery.delete(recovery);
      recoveringMissions.delete(missionId);
    });
  };
  const executionService = createLocalHostMissionApplication({
    lifecycle: missionLifecycle,
    prepareShutdown: async () => {
      // New accesses cannot enqueue recovery after this snapshot. Quiesce permits
      // only already accepted recovery claims while their bounded work settles.
      resourcesClosing = true;
      await Promise.all(receiptRecovery);
    },
    closeResources: () => runMemory.dispose(),
    client: options.client,
    logger: missionLogger,
    resolveExecutor,
    beforeStart: async (input) => {
      await nodeMissionRepository.ensureFreshMission(input);
    },
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
    onOwnerStartError: ({ missionId, error }) =>
      missionLogger.warn(
        "mission.controller_owner_start_failed",
        "Mission command is durable, but its owner could not be started yet.",
        { missionId, error },
      ),
    execution: {
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
            bindingId: request.requestId,
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
          recovering: (id, executionId) => runMemory.resume(id, executionId),
          admitting: (id, requestId) => runMemory.beginPrompt(id, requestId),
          terminal: (id, executionId, waiting) => runMemory.complete(id, executionId, waiting),
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
      onPromptAdmitting: (missionId, requestId) => runMemory.beginPrompt(missionId, requestId),
      onExecutionContextLinked: async ({ mission, executionId, requestId }) => {
        try {
          // Historical controller-only owners have no product envelope/history to materialize.
          if (await hasEnvelope(mission.id)) {
            const delivery = await getMissionDelivery();
            await delivery.register(mission, executionId, requestId);
            delivery.start();
          }
        } catch (error) {
          missionLogger.warn("mission.delivery_degraded", "Mission delivery needs recovery", {
            missionId: mission.id,
            moduleId: "pragma.mission-delivery",
            errorCode: "MISSION_DELIVERY_UNAVAILABLE",
            error,
          });
        }
        await runMemory.register({
          missionId: mission.id,
          executionId,
          projectId: mission.project.id,
        });
      },
      commitExecutionTerminal: (input) => executionProjector.terminal(input),
      onExecutionCheckpointed: async ({ mission, executionId }) => {
        await runMemory.complete(mission.id, executionId, true);
        await runMemory.pause();
      },
      onExecutionTerminal: async (input) => {
        await runMemory.complete(input.mission.id, input.executionId);
        await runMemory.pause();
      },
    },
  });
  const readPorts = createLocalHostMissionReadPorts({
    pragmaHome: options.pragmaHome,
    repository: rawMissionRepository,
    controller: missionController,
    query: missionQuery,
    watch: missionWatch,
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
      ...readPorts.missions,
      get: async (id) => {
        const mission = await readPorts.missions.get(id);
        wakeReceiptRecovery(id);
        return mission;
      },
      query: async (input) => {
        const result = await readPorts.missions.query(input);
        wakeReceiptRecovery(input.missionId);
        return result;
      },
    },
    workspace: options.workspace,
    board: readPorts.board,
    queue: { list: async (missionId) => await promptQueueProjection.list(missionId) },
    watch: readPorts.watch,
    missionApplication: executionService,
    runtime: { resolver: runtimeResolver },
  });
}

function hasPromptAttachments(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attachments = (value as { readonly attachments?: unknown }).attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}
