import {
  createLocalHostNodeMissionCompiler,
  createLocalHostProjectCatalogFromHome,
  createLocalHostBuiltInExecutorResolver,
  createLocalHostMissionBoardBindings,
  createLocalHostMissionMemoryLifecycle,
  createMissionSessionAssociationResolver,
  findMissionPinnedBinding,
} from "@pragma/local-host";
import { PragmaProjectSnapshotSchema } from "../../shared/contracts/index.ts";
import { createMissionAttentionRetirement } from "./mission-attention-retirement.ts";
import {
  createMissionDeletionService,
  readMissionDeletionRecord,
  MissionDeletionSourceExpiredError,
} from "@pragma/local-host";
import { readDeletedExecutionUsageSource } from "@pragma/local-host";
import type { Invocation } from "@pragma/shared";
import { createLocalHostUsageSink, type LocalHostUsageSink } from "@pragma/local-host";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { installAssetGitHandlers } from "../features/asset-git/asset-git-ipc.ts";
import {
  createAssetGitService,
  type AssetGitService,
} from "../features/asset-git/asset-git-service.ts";
import {
  createAssetSyncCoordinator,
  type AssetSyncCoordinator,
} from "../features/asset-git/asset-sync-coordinator.ts";
import { migrateLegacyRevisionProfile } from "../features/experts/legacy-revision-profile-migration.ts";
import { createHomeProjectStore } from "../features/missions/home-project-store.ts";
import { createMissionDeliveryRecovery } from "@pragma/local-host";
import {
  createMissionDelivery,
  createMissionTerminalMaterializer,
  createLocalHostMissionApplication,
  createLocalHostApplication,
} from "@pragma/local-host";
import { missionTargetRuntimeIds } from "@pragma/local-host";

import {
  BUILT_IN_PRAGMA_REF,
  builtInAgentFingerprint,
  EVALUATION_JUDGE_EXPERT_REF,
  pragmaManagementCapabilityResource,
  SKILL_REVISION_EXPERT_REF,
  STORE_REVISION_EXPERT_REF,
  type PragmaManagementToolPorts,
} from "@pragma/built-in-agents";
import {
  createMcpToolRegistryPool,
  createRuntimeTokenCounter,
  PragmaPaths,
  RuntimeUsageObservedSchema,
  type PragmaLogger,
  type PragmaLoggerProvider,
  type RuntimeUsageObservation,
} from "@pragma/core";
import {
  createLocalHostMissionController,
  createLocalHostMissionReadPorts,
  createMissionActivityReader,
  createNativeOsKeychain,
  createSecretStore,
  createRuntimeProcessEnvironmentSettingsStore,
  type MissionControllerStore,
} from "@pragma/local-host";
import { MEMORY_CURATOR_REF } from "@pragma/memory";
import { powerMonitor, type BrowserWindow } from "electron";
import {
  isUserFacingMissionOrigin,
  MissionExecutorOptionSchema,
  MissionSchema,
  MissionSummarySchema,
  type Mission,
} from "../../shared/contracts/index.ts";
import { createStorageCapacityInspection } from "../platform/storage/storage-capacity-inspection.ts";

import { installAutomationHandlers } from "../features/automations/automation-ipc.ts";
import { createAutomationService } from "../features/automations/automation-service.ts";
import { createAutomationStore } from "../features/automations/automation-store.ts";
import { createLocalHostPragmaAutomationPort } from "@pragma/local-host";
import { createDesktopPragmaAgentProjectPort } from "../features/built-in-agents/pragma-agent-project-adapter.ts";
import { createDesktopPragmaAgentResourceCatalogPort } from "../features/built-in-agents/pragma-agent-resource-adapter.ts";
import { createLocalHostPragmaMissionPort } from "@pragma/local-host";
import { installBundleRegistryHandlers } from "../features/bundle-registry/bundle-registry-ipc.ts";
import { createDesktopBundleRegistrySourceService } from "../features/bundle-registry/bundle-registry-source-service.ts";
import { createBundleSourcePublishingService } from "../features/bundle-registry/bundle-source-publishing-service.ts";
import { BundleSetupRequiredError } from "../features/bundles/pragma-bundle-errors.ts";
import { installPragmaBundleHandlers } from "../features/bundles/pragma-bundle-ipc.ts";
import { createPragmaBundleService } from "../features/bundles/pragma-bundle-service.ts";
import { createCapabilityCredentialStore } from "../features/capabilities/capability-credential-store.ts";
import { installCapabilityHandlers } from "../features/capabilities/capability-ipc.ts";
import { createCapabilityRevisionCoordinator } from "../features/capabilities/capability-revision-coordinator.ts";
import { createCapabilityStore } from "../features/capabilities/capability-store.ts";
import { createCapabilityVerifier } from "../features/capabilities/capability-verifier.ts";
import {
  createDesktopSkillAgents,
  type DesktopSkillAgents,
} from "../features/capabilities/skill-agents.ts";
import { createDesktopSkillRevisionSubmissionPort } from "../features/capabilities/skill-revision-capability.ts";
import {
  createSkillRevisionService,
  type SkillRevisionGenerator,
} from "../features/capabilities/skill-revision-service.ts";
import { createContextStoreEditorDraftService } from "../features/context-stores/context-store-editor-draft-service.ts";
import { installContextStoreHandlers } from "../features/context-stores/context-store-ipc.ts";
import {
  createContextStoreRevisionService,
  type ContextStoreRevisionGenerator,
  type ContextStoreRevisionService,
} from "../features/context-stores/context-store-revision-service.ts";
import { createContextStoreStore } from "../features/context-stores/context-store-store.ts";
import { createDesktopKnowledgeRevisionSubmissionPort } from "../features/context-stores/knowledge-revision-capability.ts";
import {
  createDesktopStoreRevisionAgent,
  type DesktopStoreRevisionAgent,
} from "../features/context-stores/store-revision-agent.ts";
import {
  createEvaluationMockAdapterRegistry,
  createMissionAgentEvaluationExecutor,
} from "../features/evaluations/evaluation-executor.ts";
import { installEvaluationHandlers } from "../features/evaluations/evaluation-ipc.ts";
import { createEvaluationService } from "../features/evaluations/evaluation-service.ts";
import { createEvaluationStore } from "../features/evaluations/evaluation-store.ts";
import { installExpertDefinitionHandlers } from "../features/experts/expert-definition-ipc.ts";
import { createExpertDefinitionStore } from "../features/experts/expert-definition-store.ts";
import { createDesktopSystemExpertRegistry } from "../features/experts/system-expert-registry.ts";
import {
  resolveSystemExpertRuntimeDefaults,
  withRuntimeDefaults,
} from "../features/experts/system-expert-runtime.ts";
import {
  createDesktopMemoryPlane,
  type DesktopMemoryPlane,
} from "../features/memory/desktop-memory-plane.ts";
import { installExpertMemoryContextStoreBrowserHandlers } from "../features/memory/expert-memory-context-store-browser-ipc.ts";
import { createExpertMemoryContextStoreBrowserService } from "../features/memory/expert-memory-context-store-browser.ts";
import {
  createDesktopMemoryCurator,
  type DesktopMemoryCurator,
} from "../features/memory/memory-curator.ts";
import { createMemoryLearningRevisions } from "../features/memory/memory-learning-revisions.ts";
import { installMemoryPolicyHandlers } from "../features/memory/memory-policy-ipc.ts";
import { createMemoryRevisionLearningPlanners } from "../features/memory/memory-revision-learning-planners.ts";
import { installTeamMemoryContextStoreBrowserHandlers } from "../features/memory/team-memory-context-store-browser-ipc.ts";
import { createTeamMemoryContextStoreBrowserService } from "../features/memory/team-memory-context-store-browser.ts";
import { createHomeExecutorCatalog } from "../features/missions/home-executor-catalog.ts";
import { createHomeExecutorPreferenceStore } from "../features/missions/home-executor-preference-store.ts";
import { createDesktopLocalHostExecutorResolver } from "../features/missions/local-host-mission-adapter.ts";
import { createDesktopAdapterHost } from "../features/missions/mission-adapter-host.ts";
import { createMissionExecutionEventProjector } from "@pragma/local-host";
import { installMissionContextStoreBrowserHandlers } from "../features/missions/mission-context-store-browser-ipc.ts";
import { createMissionContextStoreBrowserService } from "../features/missions/mission-context-store-browser.ts";
import { createMissionCreator } from "../features/missions/mission-creator.ts";
import { createMissionExecutorCatalog } from "../features/missions/mission-executor-catalog.ts";
import { installMissionHandlers } from "../features/missions/mission-ipc.ts";
import { createMissionReadModel } from "../features/missions/mission-read-model.ts";
import { createLocalHostIntegrationCapability } from "@pragma/local-host/node-application";
import { createDesktopMissionExecutionResources } from "../features/missions/desktop-mission-execution-resources.ts";
import { MissionStatusService } from "@pragma/local-host";
import { createFencedMissionStore } from "@pragma/local-host";
import { createMissionStore, MissionStoreError } from "@pragma/local-host";
import { installModelProviderHandlers } from "../features/model-providers/model-provider-ipc.ts";
import { createModelProviderStore } from "../features/model-providers/model-provider-store.ts";
import { createPluginCredentialStore } from "../features/plugins/plugin-credential-store.ts";
import { installPluginHandlers } from "../features/plugins/plugin-ipc.ts";
import { createPluginStore } from "../features/plugins/plugin-store.ts";
import { createDesktopPragmaBlueprintCacheStore } from "../features/projects/pragma-blueprint-cache-store.ts";
import { installPragmaProjectHandlers } from "../features/projects/pragma-project-ipc.ts";
import { createPragmaProjectStore } from "../features/projects/pragma-project-store.ts";
import { installWorkflowLayoutHandlers } from "../features/projects/workflow-layout-ipc.ts";
import { createWorkflowLayoutStore } from "../features/projects/workflow-layout-store.ts";
import { createDesktopRuntimeProcessEnvironment } from "../features/runtimes/desktop-runtime-process-environment.ts";
import {
  getRuntimeAvailability,
  getTargetRuntimeAvailability,
  invalidateTargetRuntimeAvailability,
} from "../features/runtimes/runtime-availability.ts";
import {
  createBuiltInRuntimeFactories,
  createRuntimeEnvironmentService,
} from "../features/runtimes/runtime-environment-service.ts";
import { createRuntimeEnvironmentStore } from "../features/runtimes/runtime-environment-store.ts";
import { installRuntimeHandlers } from "../features/runtimes/runtime-ipc.ts";
import { createAutomaticToolPermissionHandler } from "../features/runtimes/tool-permission-policy.ts";
import { installDesktopSettingsHandlers } from "../features/settings/desktop-settings-ipc.ts";
import { createDesktopSettingsStore } from "../features/settings/desktop-settings-store.ts";
import { installDesktopStorageCleanupHandlers } from "../features/settings/desktop-storage-cleanup-ipc.ts";
import { installCoreAssetSyncHandlers } from "../features/studio-sync/core-asset-sync-ipc.ts";
import {
  createCoreAssetSyncService,
  unavailableCoreAssetRuntimeBindings,
  type CoreAssetSyncService,
} from "../features/studio-sync/core-asset-sync-service.ts";
import { installUsageHandlers } from "../features/usage/usage-ipc.ts";
import {
  createDesktopUsageStore,
  createUnavailableDesktopUsageStore,
} from "../features/usage/usage-store.ts";
import { createWorkspaceFilesystemPort } from "../features/workspaces/workspace-filesystem-port.ts";
import { createWorkspaceHistoryStore } from "../features/workspaces/workspace-history-store.ts";
import { validateWorkspace } from "../features/workspaces/workspace-scope.ts";
import type { CredentialEncryption } from "../platform/security/credential-encryption.ts";
import { createElectronSafeStorageLegacyDecryptor } from "../platform/security/electron-safe-storage-legacy-decryptor.ts";
import { initializeDesktopStorage } from "../platform/storage/storage-bootstrap.ts";
import { createDesktopTrashMaintenance } from "../platform/storage/trash-maintenance.ts";
import { toContextStoreMissionDeletionError } from "./context-store-mission-deletion-error.ts";

export interface DesktopApplicationContainer {
  readonly startBackgroundTasks: () => void;
  readonly dispose: () => Promise<void>;
}

export interface DesktopApplicationContainerOptions {
  readonly paths: PragmaPaths;
  readonly loggerProvider: PragmaLoggerProvider;
  readonly logger: PragmaLogger;
  readonly encryption: CredentialEncryption;
  readonly builtInPluginsPath: string;
  readonly getPreferredSystemLanguages: () => readonly string[];
  readonly getWindow: () => BrowserWindow | null;
  readonly sendRuntimeModelCatalogUpdate: (runtimeId: string) => void;
  readonly trashItem: (path: string) => Promise<void>;
  readonly activateLogging: () => Promise<void>;
  readonly officialBundleRegistrySource?:
    | { readonly name: string; readonly remote: string; readonly ref?: string | undefined }
    | undefined;
}

export async function createDesktopApplicationContainer(
  options: DesktopApplicationContainerOptions,
): Promise<DesktopApplicationContainer> {
  const pragmaPaths = options.paths;
  const loggerProvider = options.loggerProvider;
  const mainLogger = options.logger;
  const encryption = options.encryption;
  const storageBootstrap = await initializeDesktopStorage({
    paths: pragmaPaths,
    trashItem: options.trashItem,
  });
  await options.activateLogging();
  mainLogger.info("desktop.storage_ready", "Desktop storage and persistent logging are ready.");
  if (storageBootstrap.legacyBackup !== undefined) {
    mainLogger.warn(
      "desktop.storage_legacy_backup",
      `Previous Pragma storage was backed up to ${storageBootstrap.legacyBackup}.`,
    );
  }
  const tokenCounter = createRuntimeTokenCounter({ logger: mainLogger });
  const mcpToolRegistryPool = createMcpToolRegistryPool();
  const trashMaintenance = createDesktopTrashMaintenance({
    paths: pragmaPaths,
    logger: mainLogger,
  });
  const builtInDefaultWorkspace = pragmaPaths.workspaceRoot();
  const projectsPath = pragmaPaths.projectsRoot();
  const missionsPath = pragmaPaths.missionsRoot();
  const modelProvidersPath = join(pragmaPaths.dataRoot(), "model-providers.json");
  const capabilityCredentialsPath = join(
    pragmaPaths.credentialsRoot(),
    "capability-credentials.json",
  );
  // Electron safeStorage is deliberately scoped to migration input. All normal
  // credential reads and writes below use the host-neutral keychain-backed store.
  const secretStore = createSecretStore({
    root: pragmaPaths.secretStoreRoot(),
    dataRoot: pragmaPaths.dataRoot(),
    keychain: createNativeOsKeychain(),
  });
  const legacyCredentialDecryptor = createElectronSafeStorageLegacyDecryptor(encryption);
  const capabilitiesPath = join(pragmaPaths.dataRoot(), "capabilities");
  const contextStoresPath = join(pragmaPaths.dataRoot(), "context-stores");
  const desktopSettings = createDesktopSettingsStore({
    settingsPath: join(pragmaPaths.stateRoot(), "desktop-settings.json"),
    builtInDefaultWorkspace,
    warn: (message, error) => mainLogger.warn("desktop.settings_warning", message, { error }),
  });
  const workspaceHistory = createWorkspaceHistoryStore({
    historyPath: join(pragmaPaths.stateRoot(), "workspace-history.json"),
    warn: (message, error) =>
      mainLogger.warn("desktop.workspace_history_warning", message, { error }),
  });
  const homeExecutorPreferences = createHomeExecutorPreferenceStore({
    preferencesPath: join(pragmaPaths.stateRoot(), "home-executor-preferences.json"),
    warn: (message, error) =>
      mainLogger.warn("desktop.home_executor_preference_warning", message, { error }),
  });
  const getToolPermissionMode = async () =>
    (await desktopSettings.getSnapshot(options.getPreferredSystemLanguages())).toolPermissionMode;
  const getAgentContextWindow = async () =>
    (await desktopSettings.getSnapshot(options.getPreferredSystemLanguages())).agentContextWindow;
  const automaticHumanInteractionHandler =
    createAutomaticToolPermissionHandler(getToolPermissionMode);
  const memoryPlaneRef: { current?: DesktopMemoryPlane } = {};
  const systemExperts = createDesktopSystemExpertRegistry({
    configPath: join(pragmaPaths.stateRoot(), "system-experts.json"),
    warn: (message, error) => mainLogger.warn("desktop.system_expert_warning", message, { error }),
    onChanged: async (ref) => {
      if (ref === STORE_REVISION_EXPERT_REF || ref === SKILL_REVISION_EXPERT_REF) {
        await memoryPlaneRef.current?.wakeRevisionLearningJobs();
      }
    },
  });
  await systemExperts.initialize();
  const systemExpertKnowledgeRevisionMountResources = () => {
    const resource = systemExperts.getResource(BUILT_IN_PRAGMA_REF);
    return [
      ...(resource === undefined ? [] : [resource]),
      ...systemExperts.getAdditionalResources(BUILT_IN_PRAGMA_REF),
    ];
  };
  const blueprintCache = createDesktopPragmaBlueprintCacheStore(pragmaPaths);
  const assetSyncRef: { current?: AssetSyncCoordinator } = {};
  const pragmaProjectStore = createPragmaProjectStore({
    onPublished: () => assetSyncRef.current?.scheduleCore("project-published"),
    projectsPath,
    objectsPath: pragmaPaths.contentObjectsRoot(),
    projectViewsPath: pragmaPaths.projectViewsCacheRoot(),
    loggerProvider,
    blueprintCache,
    reservedResourceRefs: new Set([
      BUILT_IN_PRAGMA_REF,
      MEMORY_CURATOR_REF,
      STORE_REVISION_EXPERT_REF,
      SKILL_REVISION_EXPERT_REF,
      EVALUATION_JUDGE_EXPERT_REF,
    ]),
    fixedResources: [pragmaManagementCapabilityResource()],
    externalResources: () => systemExperts.listResources(),
  });
  const workflowLayouts = createWorkflowLayoutStore({
    projectsPath,
    onChanged: () => assetSyncRef.current?.scheduleCore("flow-layout-changed"),
  });
  installWorkflowLayoutHandlers(workflowLayouts);
  const pluginCredentials = createPluginCredentialStore({
    configPath: join(pragmaPaths.credentialsRoot(), "plugin-credentials.json"),
    secretStore,
    legacyDecryptor: legacyCredentialDecryptor,
  });
  const missionStore = createMissionStore({
    isDeletionFenced: async (id) =>
      (await readMissionDeletionRecord(pragmaPaths, id)) !== undefined,
    missionsPath,
    getRevisionSource: async (jobId) => (await storeRevisions.get(jobId)).request.source,
    onReadIssue: ({ missionId, error }) =>
      mainLogger.warn(
        "mission.list_entry_unavailable",
        "A Mission could not be listed safely. Other readable Missions remain available.",
        { missionId, errorCode: error.code, error },
      ),
  });
  const missionApplicationRef: {
    current?: ReturnType<typeof createLocalHostMissionApplication>;
  } = {};
  const semanticWriteReplayRef: {
    current?: Parameters<MissionControllerStore["recoverSemanticWrite"]>[0]["replay"];
  } = {};
  const missionControllerRef: {
    current?: MissionControllerStore;
  } = {};
  const readMissionEnvelope = async (id: string): Promise<Mission | undefined> => {
    try {
      return await missionStore.get(id);
    } catch (error) {
      if (error instanceof MissionStoreError && error.code === "mission_not_found")
        return undefined;
      throw error;
    }
  };
  // Local Host owns aggregate lease persistence and the query/watch lifecycle;
  // Desktop supplies only Electron-facing stop/replay hooks.
  const missionLifecycle = createLocalHostMissionController({
    logger: mainLogger,
    missionsPath,
    readMission: readMissionEnvelope,
    onIdleError: (missionId, error) => {
      mainLogger.warn(
        "mission.idle_release_failed",
        "Idle Mission resources could not be safely released; ownership is retained",
        {
          missionId,
          error,
          errorCode: "MISSION_IDLE_RELEASE_FAILED",
          retryable: true,
        },
      );
    },
    onIdle: async ({ missionId, idleTimeoutMs, releaseOwner }): Promise<void> => {
      const runner = missionApplicationRef.current;
      if (runner === undefined) return;
      const released = await runner.releaseIdleSession(missionId, idleTimeoutMs, releaseOwner);
      mainLogger.info("mission.owner_resources", "Mission owner resource diagnostics", {
        released,
        ...missionLifecycle.ownerScope.diagnostics(),
        ...runner.getResourceDiagnostics(),
      });
    },
    ...(missionStore.storagePath === undefined ? {} : { missionPath: missionStore.storagePath }),
    onPollingError: ({ missionId, error, consecutiveFailures }) => {
      mainLogger.warn(
        "mission.controller_inbox_poll_failed",
        "Mission Inbox polling failed; the durable command will be retried while the owner remains healthy.",
        { missionId, consecutiveFailures, error },
      );
    },
    onLeaseRenewalError: ({ missionId, error, consecutiveFailures }) => {
      mainLogger.warn(
        "mission.controller_lease_renewal_delayed",
        "Mission heartbeat will retry; the running task has not been cancelled.",
        {
          missionId,
          error,
          consecutiveFailures,
          reasonCode: "MISSION_LEASE_RENEWAL_DELAYED",
          retryable: true,
        },
      );
    },
    onLeaseLost: async (missionId, error) => {
      await missionApplicationRef.current?.stopLocalController(missionId);
      mainLogger.warn(
        "mission.controller_lease_lost",
        "Mission controller lease was lost; local execution was stopped and subsequent semantic writes are fenced.",
        { missionId, error, reasonCode: "MISSION_CONTROLLER_LEASE_LOST" },
      );
    },
    recoverSemanticWrite: async ({ missionId, guard }) => {
      const replay = semanticWriteReplayRef.current;
      const controller = missionControllerRef.current;
      if (replay === undefined || controller === undefined) return;
      await controller.recoverSemanticWrite({ missionId, guard, replay });
    },
  });
  missionControllerRef.current = missionLifecycle.controller;
  const {
    controller: missionControllerStore,
    query: missionQuery,
    watch: missionWatch,
    ownerScope,
  } = missionLifecycle;
  const executionEventProjector = createMissionExecutionEventProjector({
    controller: missionControllerStore,
    ownerScope,
  });
  const missionStatus = new MissionStatusService(({ error, missionId }) => {
    mainLogger.warn(
      "mission.status_listener_failed",
      "A Mission status listener failed; the canonical execution state remains available.",
      { error, missionId },
    );
  });
  const guardedMissionStore = createFencedMissionStore(missionStore, {
    controller: missionControllerStore,
    ownerScope,
    setSemanticWriteReplay: (replay) => {
      semanticWriteReplayRef.current = replay;
    },
    onExecutionChanged: ({ missionId, execution }) =>
      missionStatus.publish(missionId, "user", execution),
  });
  const usageStore = await createDesktopUsageStore({
    databasePath: join(pragmaPaths.dataRoot(), "usage", "usage.sqlite"),
    deferred: true,
  }).catch((error: unknown) => {
    mainLogger.warn(
      "desktop.usage_store_unavailable",
      "Desktop usage accounting is unavailable; the existing usage database was preserved.",
      { error },
    );
    return createUnavailableDesktopUsageStore({ cause: error });
  });
  const unsubscribeUsageUpdates = installUsageHandlers(
    usageStore,
    options.getWindow,
    async (kind) => {
      const resourceKind = kind === "expert" ? "Expert" : kind === "team" ? "ExpertTeam" : "Flow";
      const snapshot = await pragmaProjectStore.get();
      const activeIds = new Set(
        snapshot.resources
          .filter((resource) => resource.kind === resourceKind)
          .map((resource) => resource.metadata.id),
      );
      if (kind === "expert") {
        systemExperts.list().forEach((expert) => activeIds.add(expert.id));
      }
      return activeIds;
    },
  );
  const modelProviderStore = createModelProviderStore({
    configPath: modelProvidersPath,
    secretStore,
    legacyDecryptor: legacyCredentialDecryptor,
  });
  const runtimeEnvironments = createRuntimeEnvironmentStore({
    pragmaHome: pragmaPaths.root,
  });
  const runtimeProcessEnvironmentSettings = createRuntimeProcessEnvironmentSettingsStore({
    pragmaHome: pragmaPaths.root,
  });
  const runtimeProcessEnvironment = createDesktopRuntimeProcessEnvironment({
    logger: mainLogger,
    settings: runtimeProcessEnvironmentSettings,
  });
  const runtimes = createRuntimeEnvironmentService({
    store: runtimeEnvironments,
    logger: mainLogger,
    getToolPermissionMode,
    getMaterializationCacheKey: runtimeProcessEnvironment.getCacheKey,
    factories: createBuiltInRuntimeFactories({
      modelProviders: modelProviderStore,
      modelCatalogCacheRoot: pragmaPaths.cacheRoot(),
      getToolPermissionMode,
      getAgentContextWindow,
      getRuntimeProcessEnvironment: runtimeProcessEnvironment.get,
      onModelCatalogUpdated: (runtimeId) => {
        options.sendRuntimeModelCatalogUpdate(runtimeId);
      },
      tokenCounter,
      mcpToolRegistryPool,
    }),
  });
  const missionExecutors = createMissionExecutorCatalog({
    project: pragmaProjectStore,
    systemExperts,
    runtimes,
    warn: (message, error) =>
      mainLogger.warn("desktop.mission_executor_presentation_failed", message, { error }),
  });
  const homeExecutors = createHomeExecutorCatalog({
    project: pragmaProjectStore,
    executors: missionExecutors,
    systemExperts,
    preferences: homeExecutorPreferences,
    defaultExecutorRef: BUILT_IN_PRAGMA_REF,
    validateWorkspace,
    warn: (message, error) =>
      mainLogger.warn("desktop.home_executor_usage_failed", message, { error }),
  });
  installRuntimeHandlers(runtimes, runtimeProcessEnvironment, runtimeProcessEnvironmentSettings);
  const memoryLearningRevisionsRef: { current?: ReturnType<typeof createMemoryLearningRevisions> } =
    {};
  const expertStore = createExpertDefinitionStore({
    project: pragmaProjectStore,
    systemExperts,
    validateModel: async (selection) => {
      const availability = await getRuntimeAvailability(runtimes);
      const runtime = availability.find((candidate) => candidate.id === selection.runtimeId);
      if (runtime?.status !== "available") {
        throw new Error(runtime?.reason ?? `Runtime is unavailable: ${selection.runtimeId}.`);
      }
      const model = runtime.models?.find(
        (candidate) =>
          candidate.provider.id === selection.providerId && candidate.id === selection.modelId,
      );
      if (model === undefined) {
        throw new Error(
          `Runtime model is unavailable: ${selection.runtimeId}/${selection.providerId}/${selection.modelId}.`,
        );
      }
      if (
        selection.thinkingLevel !== undefined &&
        !model.thinking?.supportedLevels.some((level) => level.value === selection.thinkingLevel)
      ) {
        throw new Error(
          `Thinking level is unavailable: ${selection.modelId}/${selection.thinkingLevel}.`,
        );
      }
    },
    onRemoved: async (expertRef) => {
      await memoryLearningRevisionsRef.current?.clearExpertBinding(expertRef);
    },
  });
  const pluginStore = createPluginStore({
    builtInPluginsPath: options.builtInPluginsPath,
    userPluginsPath: pragmaPaths.pluginsRoot(),
    paths: pragmaPaths,
    credentials: pluginCredentials,
    isReferenced: async (ref) => {
      const definitions = await Promise.all(
        (await expertStore.list()).map((summary) => expertStore.get(summary.ref)),
      );
      return definitions.some((expert) => expert.plugins.some((plugin) => plugin.ref === ref));
    },
  });
  installPluginHandlers(pluginStore, options.getWindow);
  const capabilityCredentials = createCapabilityCredentialStore({
    configPath: capabilityCredentialsPath,
    secretStore,
    legacyDecryptor: legacyCredentialDecryptor,
  });
  // Assigned after the repository-facing store is constructed; the callbacks are not invoked
  // during construction, which closes the coordinator/store composition cycle without a setter.
  // eslint-disable-next-line prefer-const
  let capabilityRevisionCoordinator: ReturnType<typeof createCapabilityRevisionCoordinator>;
  const assetGitRef: { current?: AssetGitService } = {};
  const capabilityStore = createCapabilityStore({
    capabilitiesPath,
    credentials: capabilityCredentials,
    mcpToolRegistryPool,
    verify: createCapabilityVerifier(capabilityCredentials, mcpToolRegistryPool),
    mutations: {
      publish: async (input) => {
        const published = await capabilityRevisionCoordinator.publish(input);
        if (published.definition.kind === "skill") {
          assetSyncRef.current?.scheduleAsset(
            { kind: "skill", id: published.manifest.id },
            "capability-published",
          );
        } else {
          assetSyncRef.current?.scheduleCore("capability-published");
        }
        return published;
      },
      publishHealth: async (input) => await capabilityRevisionCoordinator.publishHealth(input),
      mutate: async (input) => await capabilityRevisionCoordinator.mutate(input),
    },
    isReferenced: async (capabilityId) => {
      const definitions = await Promise.all(
        (await expertStore.list()).map((summary) => expertStore.get(summary.ref)),
      );
      return definitions.some((expert) =>
        expert.capabilities.some((reference) => reference.capabilityId === capabilityId),
      );
    },
    onSkillCreated: (capability) => {
      assetSyncRef.current?.scheduleAsset(
        { kind: "skill", id: capability.manifest.id },
        "skill-published",
      );
    },
  });
  capabilityRevisionCoordinator = createCapabilityRevisionCoordinator({
    journalRoot: join(pragmaPaths.stateRoot(), "capability-revision-propagation"),
    capabilities: capabilityStore,
    project: pragmaProjectStore,
    systemExperts,
    credentials: capabilityCredentials,
    onDeleted: async (capabilityId) => {
      await assetGitRef.current?.unbind({ kind: "skill", id: capabilityId });
      await memoryLearningRevisionsRef.current?.clearCapabilityBinding(capabilityId);
      assetSyncRef.current?.scheduleCore("skill-removed");
    },
    warn: (message, error) =>
      mainLogger.warn("desktop.capability_revision_recovery_failed", message, { error }),
  });
  const evaluationStore = createEvaluationStore(join(pragmaPaths.stateRoot(), "evaluations"));
  const evaluationMocks = createEvaluationMockAdapterRegistry(capabilityStore);
  const storeRevisionsRef: { current?: ContextStoreRevisionService } = {};
  const contextStores = createContextStoreStore({
    storesPath: contextStoresPath,
    project: pragmaProjectStore,
    externalResources: () => systemExperts.listResources(),
    trashItem: options.trashItem,
    isReferenced: async (storeId) => {
      const definitions = await Promise.all(
        (await expertStore.list()).map((summary) => expertStore.get(summary.ref)),
      );
      return definitions.some((expert) =>
        expert.contextStoreMounts.some((mount) => mount.storeId === storeId),
      );
    },
    removeMissionMounts: async (storeId) => {
      const references = await missionStore.listContextStoreReferences(storeId);
      const missionApplication = missionApplicationRef.current;
      if (references.length > 0 && missionApplication === undefined) {
        throw new Error(
          "Mission application is unavailable while removing Mission Knowledge mounts.",
        );
      }
      const assertSafeToUnmount = async (missionId: string): Promise<void> => {
        try {
          await missionApplication?.assertContextMountChangeAllowed(missionId);
        } catch (error) {
          const blocked = toContextStoreMissionDeletionError(error);
          if (blocked !== undefined) throw blocked;
          throw error;
        }
      };
      for (const reference of references) {
        await assertSafeToUnmount(reference.id);
      }
      for (const reference of references) {
        try {
          await missionApplication?.removeContextStoreMount({ id: reference.id, storeId });
        } catch (error) {
          const blocked = toContextStoreMissionDeletionError(error);
          if (blocked !== undefined) throw blocked;
          throw error;
        }
      }
    },
    hasMissionReferences: async (storeId) =>
      (await missionStore.listContextStoreReferences(storeId)).length > 0,
    onRemoved: async (storeId) => {
      await assetGitRef.current?.unbind({ kind: "knowledge", id: storeId });
      await memoryLearningRevisionsRef.current?.clearStoreBinding(storeId);
      assetSyncRef.current?.scheduleCore("knowledge-store-removed");
    },
    onPublished: (storeId) => {
      assetSyncRef.current?.scheduleAsset(
        { kind: "knowledge", id: storeId },
        "knowledge-store-published",
      );
    },
    hasUnmergedRevisionDrafts: async (storeId) =>
      (await storeRevisionsRef.current?.hasUnmergedDrafts(storeId)) ?? false,
  });
  const contextStoreEditorDrafts = createContextStoreEditorDraftService({
    draftsPath: join(pragmaPaths.stateRoot(), "context-store-editor-drafts"),
    stores: contextStores,
  });
  const assetGit = createAssetGitService({
    stateRoot: join(pragmaPaths.stateRoot(), "asset-git"),
    stores: contextStores,
    capabilities: capabilityStore,
    onAssociationChanged: (target) =>
      assetSyncRef.current?.scheduleAsset(target, "association-changed"),
    onStatusChanged: (status) => {
      const window = options.getWindow();
      if (window !== null && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        try {
          window.webContents.send("asset-git:status:updated", status);
        } catch (error) {
          mainLogger.warn(
            "desktop.asset_git_status_delivery_failed",
            "An Asset Git status update could not be delivered to the renderer.",
            { error },
          );
        }
      }
    },
    warn: (message, error) => mainLogger.warn("desktop.asset_git_sync_failed", message, { error }),
  });
  assetGitRef.current = assetGit;
  const coreAssetSync = createCoreAssetSyncService({
    configurationPath: join(pragmaPaths.stateRoot(), "asset-sync", "settings.json"),
    statePath: join(pragmaPaths.stateRoot(), "asset-sync", "state.json"),
    plugins: pluginStore,
    project: pragmaProjectStore,
    layouts: workflowLayouts,
    stores: contextStores,
    capabilities: capabilityStore,
    getRuntimes: async () => await getRuntimeAvailability(runtimes),
    warn: (message, error) => mainLogger.warn("desktop.core_asset_sync_failed", message, { error }),
    reportNameResolutionIssue: (issue) =>
      mainLogger.warn(
        "desktop.core_asset_sync_name_unresolved",
        "Core asset sync resource name resolution failed.",
        { ...issue },
      ),
  });
  const assetSync = createAssetSyncCoordinator({
    core: coreAssetSync,
    assets: assetGit,
    concurrency: 3,
    warn: (message, error) =>
      mainLogger.warn("desktop.asset_sync_coordinator_failed", message, { error }),
  });
  assetSyncRef.current = assetSync;
  const coordinatedAssetGit: AssetGitService = {
    status: async (target) => await assetGit.status(target),
    bind: async (input) => await assetSync.run(async () => await assetGit.bind(input)),
    unbind: async (target) => await assetSync.run(async () => await assetGit.unbind(target)),
    import: async (input) => await assetSync.run(async () => await assetGit.import(input)),
    sync: async (target) => await assetSync.syncAsset(target),
    conflicts: async (target) => await assetSync.run(async () => await assetGit.conflicts(target)),
    resolve: async (input) =>
      await assetSync.syncAsset(input.target, async () => await assetGit.resolve(input)),
    source: async (target) => await assetGit.source(target),
    listTargets: async () => await assetGit.listTargets(),
    restoreSource: async (target, source) =>
      await assetSync.run(async () => await assetGit.restoreSource(target, source)),
  };
  const coordinatedCoreAssetSync: CoreAssetSyncService = {
    overview: async () => await coreAssetSync.overview(),
    configure: async (input) =>
      await assetSync.run(async () => await coreAssetSync.configure(input)),
    removeConfiguration: async () =>
      await assetSync.run(async () => await coreAssetSync.removeConfiguration()),
    sync: async () => await assetSync.run(async () => await coreAssetSync.sync()),
    automatic: async () => await assetSync.run(async () => await coreAssetSync.automatic()),
    refresh: async () => await assetSync.run(async () => await coreAssetSync.refresh()),
    resolve: async (key, choice) =>
      await assetSync.run(async () => await coreAssetSync.resolve(key, choice)),
    restore: async (key) => await assetSync.run(async () => await coreAssetSync.restore(key)),
  };
  const storeRevisionAgentRef: { current?: DesktopStoreRevisionAgent } = {};
  const revisionGenerator: ContextStoreRevisionGenerator = {
    async generate(input) {
      if (storeRevisionAgentRef.current === undefined) {
        throw new Error("The Store Revision Agent has not been initialized.");
      }
      return await storeRevisionAgentRef.current.generator.generate(input);
    },
  };
  const storeRevisions = createContextStoreRevisionService({
    statePath: join(pragmaPaths.stateRoot(), "context-store-revisions"),
    draftsPath: join(pragmaPaths.dataRoot(), "context-store-drafts"),
    draftsTrashPath: join(pragmaPaths.trashRoot(), "context-store-drafts"),
    contextStores,
    generator: revisionGenerator,
    isMissionAvailable: async (missionId) => {
      try {
        await missionStore.get(missionId);
        return true;
      } catch (error) {
        if (error instanceof MissionStoreError && error.code === "mission_not_found") return false;
        throw error;
      }
    },
    onRevisionDetached: async ({ missionId, jobId, draftId, storeId }) => {
      try {
        await missionStore.restoreManagedRevisionStore({
          id: missionId,
          storeId,
          draftId,
          revisionJobId: jobId,
          preserveSession: true,
        });
      } catch (error) {
        if (!(error instanceof MissionStoreError) || error.code !== "mission_not_found")
          throw error;
      }
    },
    warn: (message, error) =>
      mainLogger.warn("desktop.context_store_revision_processing_failed", message, { error }),
  });
  await migrateLegacyRevisionProfile({
    stateRoot: pragmaPaths.stateRoot(),
    systemExperts,
  });
  storeRevisionsRef.current = storeRevisions;
  const pragmaManagementPortsRef: {
    current?: Omit<PragmaManagementToolPorts, "knowledgeRevisions">;
  } = {};
  const pragmaManagementKnowledgeRevisions = createDesktopKnowledgeRevisionSubmissionPort({
    project: pragmaProjectStore,
    contextStores,
    revisions: storeRevisions,
    additionalMountResources: systemExpertKnowledgeRevisionMountResources,
  });
  const skillAgentsRef: { current?: DesktopSkillAgents } = {};
  const skillRevisionGenerator: SkillRevisionGenerator = {
    async generate(input) {
      if (skillAgentsRef.current === undefined) {
        throw new Error("skill_revision_agent_unavailable");
      }
      return await skillAgentsRef.current.revisionGenerator.generate(input);
    },
  };
  const skillRevisionDraftsPath = join(pragmaPaths.dataRoot(), "skill-revision-drafts");
  const skillRevisions = createSkillRevisionService({
    statePath: join(pragmaPaths.stateRoot(), "skill-revisions"),
    draftsPath: skillRevisionDraftsPath,
    draftsTrashPath: join(pragmaPaths.trashRoot(), "skill-revision-drafts"),
    capabilities: capabilityStore,
    generator: skillRevisionGenerator,
    resolveWorkspacePath: async (missionId, draftId) => {
      if (missionId !== undefined) {
        try {
          const mission = await missionStore.get(missionId);
          const legacyWorkspace =
            draftId === undefined ? undefined : join(skillRevisionDraftsPath, draftId, "worktree");
          if (
            draftId !== undefined &&
            legacyWorkspace !== undefined &&
            mission.workspace.path === legacyWorkspace
          ) {
            const defaultWorkspace = (
              await desktopSettings.getSnapshot(options.getPreferredSystemLanguages())
            ).defaultWorkspace;
            if (defaultWorkspace === legacyWorkspace) {
              throw Object.assign(new Error("skill_revision_workspace_unavailable"), {
                code: "skill_revision_workspace_unavailable",
              });
            }
            await guardedMissionStore.rebindLegacySkillRevisionWorkspace({
              id: mission.id,
              draftId,
              expectedWorkspacePath: legacyWorkspace,
              workspace: { path: defaultWorkspace, basename: basename(defaultWorkspace) },
            });
            return defaultWorkspace;
          }
          return mission.workspace.path;
        } catch (error) {
          if (!(error instanceof MissionStoreError) || error.code !== "mission_not_found") {
            throw error;
          }
        }
      }
      return (await desktopSettings.getSnapshot(options.getPreferredSystemLanguages()))
        .defaultWorkspace;
    },
    warn: (message, error) =>
      mainLogger.warn("desktop.skill_revision_processing_failed", message, { error }),
  });
  const pragmaManagementSkillRevisions = createDesktopSkillRevisionSubmissionPort({
    capabilities: capabilityStore,
    revisions: skillRevisions,
  });
  installCapabilityHandlers(
    capabilityStore,
    options.getWindow,
    () => ({
      ...pragmaManagementPortsRef.current,
      knowledgeRevisions: pragmaManagementKnowledgeRevisions,
      skillRevisions: pragmaManagementSkillRevisions,
    }),
    skillRevisions,
  );
  const mountMemoryKnowledgeStore = async (expertRef: string, storeId: string) => {
    const expert = await expertStore.get(expertRef);
    if (expert.contextStoreMounts.some((mount) => mount.storeId === storeId)) return;
    const contextStoreMounts = [
      ...expert.contextStoreMounts,
      { storeId, enabled: true, priority: expert.contextStoreMounts.length },
    ];
    if (expert.origin === "built-in") {
      await expertStore.updateBuiltIn(expertRef, {
        name: expert.name,
        description: expert.description,
        tags: expert.tags,
        additionalInstructions: expert.additionalInstructions,
        ...(expert.executionProfile.mode === "pinned"
          ? { model: expert.executionProfile.model }
          : {}),
        capabilities: expert.capabilities,
        toolApprovals: expert.toolApprovals,
        plugins: expert.plugins,
        contextStoreMounts,
        resourceTools: expert.resourceTools,
      });
      return;
    }
    if (expert.executionProfile.mode !== "pinned") {
      throw new Error("Project Expert has no pinned execution profile.");
    }
    await expertStore.update(expertRef, {
      baseRevision: expert.revision,
      name: expert.name,
      description: expert.description,
      tags: expert.tags,
      scope: expert.scope,
      instructions: expert.instructions,
      model: expert.executionProfile.model,
      capabilities: expert.capabilities,
      toolApprovals: expert.toolApprovals,
      plugins: expert.plugins,
      contextStoreMounts,
      resourceTools: expert.resourceTools,
      opaqueCapabilities: expert.opaqueCapabilities,
      opaqueContextStores: expert.opaqueContextStores,
    });
  };
  const bindMemorySkill = async (expertRef: string, capabilityId: string) => {
    const expert = await expertStore.get(expertRef);
    if (
      expert.capabilities.some(
        (capability) => capability.kind === "skill" && capability.capabilityId === capabilityId,
      )
    ) {
      return;
    }
    const capabilities = [...expert.capabilities, { kind: "skill" as const, capabilityId }];
    if (expert.origin === "built-in") {
      await expertStore.updateBuiltIn(expertRef, {
        name: expert.name,
        description: expert.description,
        tags: expert.tags,
        additionalInstructions: expert.additionalInstructions,
        ...(expert.executionProfile.mode === "pinned"
          ? { model: expert.executionProfile.model }
          : {}),
        capabilities,
        toolApprovals: expert.toolApprovals,
        plugins: expert.plugins,
        contextStoreMounts: expert.contextStoreMounts,
        resourceTools: expert.resourceTools,
      });
      return;
    }
    if (expert.executionProfile.mode !== "pinned") {
      throw new Error("Project Expert has no pinned execution profile.");
    }
    await expertStore.update(expertRef, {
      baseRevision: expert.revision,
      name: expert.name,
      description: expert.description,
      tags: expert.tags,
      scope: expert.scope,
      instructions: expert.instructions,
      model: expert.executionProfile.model,
      capabilities,
      toolApprovals: expert.toolApprovals,
      plugins: expert.plugins,
      contextStoreMounts: expert.contextStoreMounts,
      resourceTools: expert.resourceTools,
      opaqueCapabilities: expert.opaqueCapabilities,
      opaqueContextStores: expert.opaqueContextStores,
    });
  };
  const memoryLearningRevisions = createMemoryLearningRevisions({
    statePath: join(pragmaPaths.stateRoot(), "memory-learning-revisions"),
    skillWorkspacePath: join(pragmaPaths.workspaceRoot(), "system-memory"),
    knowledgeRevisions: storeRevisions,
    skillRevisions,
    contextStores,
    capabilities: capabilityStore,
    expertExists: async (expertRef) =>
      (await expertStore.list()).some((expert) => expert.ref === expertRef),
    mountStore: mountMemoryKnowledgeStore,
    bindSkill: bindMemorySkill,
  });
  memoryLearningRevisionsRef.current = memoryLearningRevisions;
  installContextStoreHandlers(
    contextStores,
    options.getWindow,
    storeRevisions,
    contextStoreEditorDrafts,
  );
  installCoreAssetSyncHandlers(coordinatedCoreAssetSync);
  installAssetGitHandlers(coordinatedAssetGit);
  const missionDeliveryRef: {
    current: Awaited<ReturnType<typeof createMissionDelivery>> | undefined;
  } = { current: undefined };
  const localHostUsageRef: { current: LocalHostUsageSink | undefined } = { current: undefined };
  let missionDeliveryInitializationError: string | undefined;
  const retiringAttention = createMissionAttentionRetirement(
    async (missionId) => await memoryPlane.stopMissionAttention(missionId),
  );
  const missionDeletion = createMissionDeletionService({
    paths: pragmaPaths,
    logger: mainLogger,
    ports: {
      usage: async (record, signal) => {
        const mission = MissionSchema.parse(record.payload.mission);
        const observations: RuntimeUsageObservation[] = [];
        const invocations = new Map<string, readonly Invocation[]>();
        let expired = false;
        for (const executionId of record.executionIds) {
          signal.throwIfAborted();
          const source = await readDeletedExecutionUsageSource(
            pragmaPaths,
            record.deletionId,
            executionId,
          );
          if (source === undefined) {
            expired = true;
            continue;
          }
          invocations.set(executionId, source.invocations);
          for (const event of source.events) {
            if (event.type === "runtime.usage.observed")
              observations.push(RuntimeUsageObservedSchema.parse(event.data).observation);
          }
        }
        signal.throwIfAborted();
        await persistMissionUsageBatch(mission, observations, invocations);
        const localUsage = localHostUsageRef.current;
        if (localUsage === undefined) throw new Error("Local Host usage sink is unavailable.");
        signal.throwIfAborted();
        await localUsage.reconcile(observations);
        await usageStore.markSubjectDeleted("mission", mission.id);
        if (expired) throw new MissionDeletionSourceExpiredError();
      },
      memory: async (record) => {
        await memoryPlane.deleteExecutionState(record.executionIds);
      },
      drafts: async (record, signal) => {
        let cursor: string | undefined;
        do {
          signal.throwIfAborted();
          const page = await pragmaAgentProject.listDslDrafts({
            missionId: record.missionId,
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const draft of page.items) {
            if (!["editing", "conflicted", "prepared"].includes(draft.state)) continue;
            signal.throwIfAborted();
            await pragmaAgentProject.discardDslDraft({
              missionId: record.missionId,
              draftId: draft.draftId,
            });
          }
          cursor = page.nextCursor;
        } while (cursor !== undefined);
      },
      claims: async (record, signal) => {
        const mission = MissionSchema.parse(record.payload.mission);
        for (const mount of mission.contextMounts) {
          if (mount.kind !== "context-store-draft" || mount.revisionJobId === undefined) continue;
          signal.throwIfAborted();
          await storeRevisions.releaseMissionClaim({
            draftId: mount.draftId,
            jobId: mount.revisionJobId,
            missionId: record.missionId,
            reason: "mission_deleted",
          });
        }
      },
      settlement: async (record) => {
        await Promise.all([
          missionDeliveryRef.current?.deleteMission(record.missionId, {
            mission: MissionSchema.parse(record.payload.mission),
            executionIds: record.executionIds,
          }),
          retiringAttention.finish(record.missionId),
        ]);
      },
    },
  });
  const memoryPlane = await createDesktopMemoryPlane({
    hostDeliveryDiagnostics: () => [
      { moduleId: "pragma.mission-deletion", ...missionDeletion.inspect() },
      ...(missionDeliveryRef.current === undefined
        ? missionDeliveryInitializationError === undefined
          ? []
          : [
              {
                moduleId: "pragma.mission-delivery",
                state: "degraded" as const,
                pending: 0,
                errorCode: missionDeliveryInitializationError,
              },
            ]
        : [{ moduleId: "pragma.mission-delivery", ...missionDeliveryRef.current.inspect() }]),
      ...(localHostUsageRef.current === undefined
        ? []
        : [{ moduleId: "pragma.local-host-usage", ...localHostUsageRef.current.inspect() }]),
    ],
    deliverySafeThrough: () =>
      Math.min(
        missionDeliveryRef.current?.safeThrough() ?? 0,
        localHostUsageRef.current?.safeThrough() ?? 0,
      ),
    secrets: secretStore,
    pragmaHome: pragmaPaths.root,
    logger: mainLogger,
    onTick: async () => {
      if (await memoryLearningRevisions.reconcile()) {
        await memoryPlaneRef.current?.wakeRevisionLearningJobs();
      }
    },
    knowledgeLearningSink: {
      async submit(input) {
        await memoryLearningRevisions.submitKnowledge(input);
      },
    },
    skillLearningTargetReader: {
      async listTargets(input) {
        return await memoryLearningRevisions.listSkillTargets(input);
      },
    },
    skillLearningSink: {
      async submit(input) {
        await memoryLearningRevisions.submitSkills(input);
      },
    },
  });
  memoryPlaneRef.current = memoryPlane;
  const missionMemory = createLocalHostMissionMemoryLifecycle({
    ports: {
      bindings: async (input) =>
        (await memoryPlane.policies.getGlobal()).policy.enabled === "enabled"
          ? [{ namespace: "memory", store: memoryPlane.createMissionContextStore(input) }]
          : [],
      register: (input) => memoryPlane.registerMemoryExecutionContext(input),
      setConversationState: (input) => memoryPlane.setMemoryConversationState(input),
      stopMission: (missionId) => memoryPlane.stopMissionAttention(missionId),
    },
    onError: (error) =>
      mainLogger.warn(
        "mission.memory_terminal_projection_failed",
        "Optional Mission Memory projection needs recovery.",
        { error, subsystem: "memory", code: "memory_delivery_unavailable", retryable: true },
      ),
  });
  const bundleService = createPragmaBundleService({
    paths: pragmaPaths,
    project: pragmaProjectStore,
    capabilities: capabilityStore,
    contextStores,
    plugins: pluginStore,
    layouts: workflowLayouts,
    getRuntimes: async () => await getRuntimeAvailability(runtimes),
  });
  installPragmaBundleHandlers(bundleService, options.getWindow);
  const bundleRegistrySources = createDesktopBundleRegistrySourceService({
    sourcesPath: join(pragmaPaths.dataRoot(), "bundle-registry", "sources.json"),
    cacheRoot: join(pragmaPaths.cacheRoot(), "bundle-registry"),
    officialSource: options.officialBundleRegistrySource,
  });
  const bundleSourcePublishing = createBundleSourcePublishingService({
    bundles: bundleService,
    sources: bundleRegistrySources,
    cacheRoot: join(pragmaPaths.cacheRoot(), "bundle-registry", "publications"),
  });
  installBundleRegistryHandlers(bundleRegistrySources, bundleSourcePublishing);
  const assertBundleExecutorReady = async (
    ref: string,
    operation: "create_mission" | "run_mission",
    scope?: import("@pragma/local-host").LocalHostMissionCompileScope<Mission>,
  ): Promise<void> => {
    const measure = async <T>(phase: string, read: () => Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      try {
        return await read();
      } finally {
        mainLogger.info("mission.readiness_phase", "Executor readiness phase completed", {
          ref,
          operation,
          phase,
          elapsedMs: performance.now() - startedAt,
        });
      }
    };
    const projectSnapshot = await measure("project_snapshot", async () =>
      scope === undefined
        ? await pragmaProjectStore.get()
        : PragmaProjectSnapshotSchema.parse(await scope.getRevision()),
    );
    const runtimeIds = missionTargetRuntimeIds(ref, projectSnapshot.resources, (target) =>
      systemExperts.getDependencyResource(target),
    );
    const runtimesAvailable = await measure("runtime_availability", () =>
      getTargetRuntimeAvailability(runtimes, runtimeIds),
    );
    const dependencies = [
      ...(await measure("bundle_readiness", () =>
        bundleService.getReadinessForRef(ref, {
          snapshot: projectSnapshot,
          runtimes: runtimesAvailable,
        }),
      )),
    ];
    for (const missing of unavailableCoreAssetRuntimeBindings(
      ref,
      projectSnapshot.resources,
      runtimesAvailable,
      { validateModels: false },
    )) {
      dependencies.push({
        id: `core-asset-runtime:${missing.ref}`,
        kind: "runtime",
        resourceRef: missing.ref,
        name: missing.name,
        status: "action_required",
        code: "core_asset_runtime_binding_missing",
        action: "choose_runtime",
        message: "Choose an available local harness and model before running this asset.",
      });
    }
    if (dependencies.length === 0) return;
    throw new BundleSetupRequiredError(
      ref,
      operation,
      dependencies,
      dependencies.find((dependency) => dependency.installationId !== undefined)?.installationId,
    );
  };
  const missionCreator = createMissionCreator({
    logger: mainLogger,
    missions: missionStore,
    project: pragmaProjectStore,
    executors: missionExecutors,
    contextStores,
    contextStoreRevisions: storeRevisions,
    getDefaultToolPermissionMode: getToolPermissionMode,
    assertExecutorReady: async (ref) => await assertBundleExecutorReady(ref, "create_mission"),
  });
  installExpertDefinitionHandlers(expertStore, usageStore);
  installPragmaProjectHandlers(pragmaProjectStore, usageStore, contextStores, capabilityStore);
  const initialSettings = await desktopSettings.getSnapshot(options.getPreferredSystemLanguages());
  await mkdir(initialSettings.defaultWorkspace, { recursive: true, mode: 0o700 }).catch(
    (error: unknown) => {
      mainLogger.warn(
        "desktop.default_workspace_unavailable",
        `The default workspace could not be prepared: ${initialSettings.defaultWorkspace}.`,
        { error },
      );
    },
  );
  const defaultAgentStateRoot = join(pragmaPaths.stateRoot(), "pragma");
  const pragmaAgentProject = createDesktopPragmaAgentProjectPort({
    project: pragmaProjectStore,
    stateRoot: defaultAgentStateRoot,
    withMissionMutation: async (id, action) => await missionStore.withDeletionBarrier!(id, action),
    assertMissionWritable: async (id) => {
      if (await missionDeletion.read(id)) throw new Error("MISSION_DELETION_PENDING");
    },
    draftsRoot: join(pragmaPaths.dataRoot(), "dsl-resource-drafts"),
    draftsTrashRoot: join(pragmaPaths.trashRoot(), "dsl-resource-drafts"),
    capabilities: capabilityStore,
    runtimes,
    systemExperts,
  });
  const memoryCuratorRef: { current?: DesktopMemoryCurator } = {};
  const missionReadPorts = createLocalHostMissionReadPorts({
    pragmaHome: pragmaPaths.root,
    repository: missionStore,
    controller: missionControllerStore,
    query: missionQuery,
    watch: missionWatch,
  });
  const localHostRunExecutorResolver = createDesktopLocalHostExecutorResolver({
    executors: missionExecutors,
    project: pragmaProjectStore,
  });
  const closedResources = new Set<number>();
  const missionApplication = createLocalHostMissionApplication({
    closeResources: async () => {
      const errors: unknown[] = [];
      for (const [index, operation] of [
        async () => await missionDeliveryRecovery.close(),
        async () => {
          try {
            await localHostUsageRef.current?.drain();
          } finally {
            await localHostUsageRef.current?.close();
          }
        },
        async () => await memoryPlane.stop(),
        async () => await usageStore.close(),
        async () => {
          powerMonitor.removeListener("user-did-become-active", cancelCapacityInspection);
          powerMonitor.removeListener("resume", cancelCapacityInspection);
          storageCapacityInspection.close();
          tokenCounter.dispose();
        },
        async () => await mcpToolRegistryPool.close(),
      ].entries()) {
        if (closedResources.has(index)) continue;
        try {
          await operation();
          closedResources.add(index);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0)
        throw new AggregateError(errors, "Desktop Host resource shutdown failed.");
    },
    lifecycle: missionLifecycle,
    client: { surface: "desktop", version: "desktop", instanceId: randomUUID() },
    logger: mainLogger,
    resolveExecutor: localHostRunExecutorResolver,
    assertMission: missionReadPorts.assertMission,
    onOwnerStartError: ({ missionId, error }) =>
      mainLogger.warn(
        "mission.controller_owner_start_failed",
        "Mission command is durable, but its owner could not be started yet.",
        { missionId, error },
      ),
    execution: createDesktopMissionExecutionResources({
      get deferTerminalProjection() {
        return missionDeliveryRef.current !== undefined;
      },
      registerExecutionDelivery: (mission, executionId, requestId) =>
        missionDeliveryRef.current?.register(mission, executionId, requestId),
      wakeExecutionDelivery: () => missionDeliveryRef.current?.wake(),
      missions: guardedMissionStore,
      missionStatus,
      project: pragmaProjectStore,
      capabilityStore,
      capabilityCredentials,
      resolveSecret: (ref) => pluginCredentials.get(ref),
      secretFingerprint: (ref) => pluginCredentials.fingerprint([ref]),
      capabilitiesPath,
      mcpToolRegistryPool,
      pragmaHome: pragmaPaths.root,
      executionStore: memoryPlane.executionStore,
      contextStores,
      contextStoreRevisions: storeRevisions,
      knowledgeRevisionMountResources: systemExpertKnowledgeRevisionMountResources,
      hostContextStores: (mission, bindingId) =>
        missionMemory.bindings({
          missionId: mission.id,
          goal: mission.goal,
          projectId: mission.project.id,
          bindingId,
        }),
      plugins: pluginStore,
      runtimes,
      usage: usageStore,
      loggerProvider,
      automaticHumanInteractionHandler,
      runtimesForToolPermissionMode: (mode) => runtimes.forToolPermissionMode(mode),
      automaticHumanInteractionHandlerForToolPermissionMode: (mode) =>
        createAutomaticToolPermissionHandler(() => mode),
      adapterHostForMission: (mission, fallback) => evaluationMocks.forMission(mission, fallback),
      ownerScope,
      pragmaManagementPorts: () => {
        if (pragmaManagementPortsRef.current === undefined) {
          throw new Error("The Pragma management ports have not been initialized.");
        }
        return pragmaManagementPortsRef.current;
      },
      onStorageTrashed: () => trashMaintenance.schedule("mission-storage-trashed"),
      deletionService: missionDeletion,
      prepareOwnerDeletion: async ({ mission, executionIds }) => {
        await missionDeliveryRef.current?.fenceMission(mission.id, executionIds);
        void retiringAttention.stop(mission.id).catch(() => undefined);
      },
      onExecutionLinked: async ({ mission, executionId, requestId }) => {
        await executionEventProjector.link({ mission, executionId, requestId });
      },
      onExecutionContextLinked: async ({ mission, executionId }) => {
        if (!isUserFacingMissionOrigin(mission.origin)) return;
        await missionMemory.register({
          executionId,
          missionId: mission.id,
          projectId: mission.project.id,
        });
      },
      onPromptAdmitting: (missionId, requestId) => missionMemory.beginPrompt(missionId, requestId),
      onMissionActivity: async ({ mission }) => {
        if (!isUserFacingMissionOrigin(mission.origin)) return;
        await memoryPlane.setMemoryConversationState({
          missionId: mission.id,
          state: "active",
        });
      },
      getSystemExecutorMetadata: () =>
        systemExperts.list().map((expert) => ({
          id: expert.id,
          name: expert.name,
          avatarId: expert.avatarId,
        })),
      getSystemExecutorResource: (ref) => systemExperts.getResource(ref),
      getSystemDependencyResource: (ref) => systemExperts.getDependencyResource(ref),
      invalidateRuntimeReadiness: () => invalidateTargetRuntimeAvailability(runtimes),
      commitExecutionTerminal: (input) => executionEventProjector.terminal(input),
      onExecutionCheckpointed: async ({ mission, executionId }) => {
        if (!isUserFacingMissionOrigin(mission.origin)) return;
        await missionMemory.complete(mission.id, executionId, true);
      },
      onExecutionTerminal: async ({ mission, executionId }) => {
        if (!isUserFacingMissionOrigin(mission.origin)) return;
        await missionMemory.complete(
          mission.id,
          executionId,
          mission.lifecycleStatus !== "completed",
        );
      },
      getSystemExecutorFingerprint: async (ref) =>
        ref === MEMORY_CURATOR_REF
          ? await memoryCuratorRef.current?.fingerprint()
          : ref === STORE_REVISION_EXPERT_REF
            ? systemExperts.fingerprint(STORE_REVISION_EXPERT_REF)
            : ref === SKILL_REVISION_EXPERT_REF
              ? createHash("sha256")
                  .update((await skillAgentsRef.current?.fingerprint()) ?? "unavailable")
                  .update("\0")
                  .update(systemExperts.fingerprint(SKILL_REVISION_EXPERT_REF) ?? "unavailable")
                  .digest("hex")
              : ref === EVALUATION_JUDGE_EXPERT_REF
                ? builtInAgentFingerprint(EVALUATION_JUDGE_EXPERT_REF)
                : systemExperts.fingerprint(ref),
      assertExecutorReady: async (ref, scope) =>
        await assertBundleExecutorReady(ref, "run_mission", scope),
      systemExecutorSource: async ({
        mission,
        runtimes: scopedRuntimes,
        knowledgeRevisions,
        purpose,
        adapterHost,
      }) => {
        const planningRef = mission.executor.ref;
        if (purpose === "stop") {
          const resource = systemExperts.getResource(planningRef);
          if (resource === undefined) return undefined;
          return {
            ref: planningRef as import("@pragma/built-in-agents").BuiltInAgentRef,
            environmentId: "desktop",
            definitionStateRoot: join(defaultAgentStateRoot, "definitions"),
            workspace: mission.workspace.path,
            pragmaHome: pragmaPaths.root,
            runtimes: scopedRuntimes,
            expertResource: resource,
            additionalResources: systemExperts.getAdditionalResources(planningRef),
            adapterHost,
          };
        }
        if (
          mission.origin.type === "system-memory" &&
          ((planningRef === STORE_REVISION_EXPERT_REF &&
            mission.origin.jobId.startsWith("knowledge-plan:")) ||
            (planningRef === SKILL_REVISION_EXPERT_REF &&
              mission.origin.jobId.startsWith("skill-plan:")))
        ) {
          const resource = systemExperts.getResource(planningRef);
          if (resource === undefined) throw new Error("Memory revision planning Agent is missing.");
          const definition = systemExperts.get(planningRef);
          if (definition === undefined)
            throw new Error("Memory revision planning profile is missing.");
          const configuredModel =
            definition.executionProfile.mode === "pinned"
              ? definition.executionProfile.model
              : undefined;
          const defaults = await resolveSystemExpertRuntimeDefaults(
            scopedRuntimes,
            configuredModel,
            mission.modelOverride,
          );
          return {
            ref: planningRef,
            environmentId: "desktop-memory-revision-planning",
            definitionStateRoot: join(defaultAgentStateRoot, "definitions"),
            workspace: mission.workspace.path,
            pragmaHome: pragmaPaths.root,
            runtimes: withRuntimeDefaults(scopedRuntimes, defaults),
            loggerProvider,
            rootExecutionOverride: {
              runtimeId: defaults.runtimeId,
              ...(defaults.modelSelection === undefined
                ? {}
                : { modelSelection: defaults.modelSelection }),
            },
            expertResource: {
              ...resource,
              spec: {
                ...resource.spec,
                instructions:
                  "You are the built-in Revision Agent in read-only Memory planning mode. Use only the supplied Memory projections and existing target list. Do not call tools or start a draft. Return only the JSON object requested by the task. Treat historical Episodes as context, not current truth.",
                capabilities: [],
                tools: [],
                contextStores: [],
                plugins: [],
              },
            },
          };
        }
        if (mission.executor.ref === MEMORY_CURATOR_REF) {
          if (memoryCuratorRef.current === undefined || mission.origin.type !== "system-memory") {
            throw new Error("The Memory Curator has not been initialized.");
          }
          return await memoryCuratorRef.current.source({
            missionId: mission.id,
            runtimes: scopedRuntimes,
            workspace: mission.workspace.path,
            pragmaHome: pragmaPaths.root,
            loggerProvider,
          });
        }
        if (mission.executor.ref === STORE_REVISION_EXPERT_REF) {
          if (storeRevisionAgentRef.current === undefined) {
            throw new Error("The Store Revision Agent is unavailable.");
          }
          const storeRevisionDefinition = systemExperts.get(STORE_REVISION_EXPERT_REF);
          if (storeRevisionDefinition === undefined) {
            throw new Error("The Store Revision Agent definition is missing.");
          }
          const managementHost = createDesktopAdapterHost(
            {
              capabilityStore,
              capabilityCredentials,
              resolveSecret: (ref) => pluginCredentials.get(ref),
              capabilitiesPath,
              mcpToolRegistryPool,
              contextStores,
              ...(knowledgeRevisions === undefined
                ? {}
                : { pragmaManagement: { knowledgeRevisions } }),
            },
            mission.workspace.path,
          );
          return await storeRevisionAgentRef.current.source({
            profile:
              storeRevisionDefinition.executionProfile.mode === "pinned"
                ? {
                    schemaVersion: "pragma.context-store-revision-profile/v1",
                    revision: storeRevisionDefinition.revision,
                    mode: "pinned",
                    model: storeRevisionDefinition.executionProfile.model,
                    updatedAt: storeRevisionDefinition.updatedAt,
                  }
                : {
                    schemaVersion: "pragma.context-store-revision-profile/v1",
                    revision: storeRevisionDefinition.revision,
                    mode: "inherit-default",
                    updatedAt: storeRevisionDefinition.updatedAt,
                  },
            runtimes: scopedRuntimes,
            adapterHost: managementHost,
            expertResource: systemExperts.getResource(STORE_REVISION_EXPERT_REF),
            additionalResources: systemExperts.getAdditionalResources(STORE_REVISION_EXPERT_REF),
          });
        }
        if (mission.executor.ref === SKILL_REVISION_EXPERT_REF) {
          if (skillAgentsRef.current === undefined) {
            throw new Error("The Skill Revision Agent is unavailable.");
          }
          const definition = systemExperts.get(SKILL_REVISION_EXPERT_REF);
          if (definition === undefined)
            throw new Error("The Skill Revision Agent definition is missing.");
          const skillRevisionPort = createDesktopSkillRevisionSubmissionPort({
            capabilities: capabilityStore,
            revisions: skillRevisions,
            inlineMissionId: mission.id,
            inlineWorkspacePath: mission.workspace.path,
            mountDraft: async (input) => {
              await missionStore.mountSkillRevisionDraft({
                id: input.missionId,
                draftId: input.draftId,
                revisionJobId: input.jobId,
                capabilityId: input.capabilityId,
              });
            },
            unmountDraft: async (input) => {
              await missionStore.unmountSkillRevisionDraft({
                id: input.missionId,
                draftId: input.draftId,
              });
            },
            onUnmountDraftError: (error) =>
              mainLogger.warn(
                "desktop.skill_revision_unmount_failed",
                "Failed to unmount a submitted Skill draft from its Mission.",
                { error },
              ),
          });
          const mountedDrafts = mission.contextMounts.filter(
            (mount): mount is Extract<typeof mount, { kind: "skill-revision-draft" }> =>
              mount.kind === "skill-revision-draft",
          );
          const staleDraftIds: string[] = [];
          for (const mountedDraft of mountedDrafts) {
            let inspection = await skillRevisions.inspectDraft(mountedDraft.draftId, mission.id);
            const mountedJob = await skillRevisions.get(mountedDraft.revisionJobId);
            if (
              inspection.draft.state === "needs_attention" &&
              mountedJob.state === "needs_attention" &&
              mountedJob.error?.code === "skill_revision_validation_required"
            ) {
              await skillRevisions.start(mountedJob.request, {
                draftId: mountedDraft.draftId,
                missionId: mission.id,
              });
              inspection = await skillRevisions.inspectDraft(mountedDraft.draftId, mission.id);
            }
            if (inspection.draftPath !== undefined) {
              continue;
            }
            if (
              inspection.draft.submissionHash !== undefined ||
              ["pending_review", "publishing", "completed", "rejected", "needs_rebase"].includes(
                inspection.draft.state,
              )
            ) {
              staleDraftIds.push(mountedDraft.draftId);
              continue;
            }
            throw Object.assign(
              new Error("The mounted Skill draft is not writable by this Mission."),
              { code: "skill_revision_runtime_file_tools_unavailable" },
            );
          }
          if (
            staleDraftIds.length > 0 &&
            !["queued", "running", "waiting"].includes(mission.execution?.status ?? "")
          ) {
            for (const draftId of staleDraftIds) {
              await missionStore.unmountSkillRevisionDraft({ id: mission.id, draftId });
            }
          }
          const expertResource = systemExperts.getResource(SKILL_REVISION_EXPERT_REF);
          const additionalResources =
            systemExperts.getAdditionalResources(SKILL_REVISION_EXPERT_REF);
          return await skillAgentsRef.current.source({
            runtimes: scopedRuntimes,
            workspace: mission.workspace.path,
            adapterHost: createDesktopAdapterHost(
              {
                capabilityStore,
                capabilityCredentials,
                resolveSecret: (ref) => pluginCredentials.get(ref),
                capabilitiesPath,
                mcpToolRegistryPool,
                contextStores,
                pragmaManagement: { skillRevisions: skillRevisionPort },
              },
              mission.workspace.path,
            ),
            ...(expertResource === undefined ? {} : { expertResource }),
            ...(additionalResources === undefined ? {} : { additionalResources }),
          });
        }
        if (mission.executor.ref === EVALUATION_JUDGE_EXPERT_REF) {
          if (mission.origin.type !== "system-evaluation" || mission.origin.phase !== "judge") {
            throw new Error("The Evaluation Judge Agent mission is invalid.");
          }
          const settings = await evaluationStore.getSettings();
          const configuredModel =
            settings.judge.mode === "pinned" ? settings.judge.model : undefined;
          const defaults = await resolveSystemExpertRuntimeDefaults(
            scopedRuntimes,
            configuredModel,
            mission.modelOverride,
          );
          return {
            ref: EVALUATION_JUDGE_EXPERT_REF,
            environmentId: "desktop-evaluation",
            definitionStateRoot: join(defaultAgentStateRoot, "definitions"),
            workspace: mission.workspace.path,
            pragmaHome: pragmaPaths.root,
            runtimes: withRuntimeDefaults(scopedRuntimes, defaults),
            loggerProvider,
            rootExecutionOverride: {
              runtimeId: defaults.runtimeId,
              ...(defaults.modelSelection === undefined
                ? {}
                : { modelSelection: defaults.modelSelection }),
            },
            ...(defaults.modelSelection === undefined
              ? {}
              : { defaultModelSelection: defaults.modelSelection }),
          };
        }
        if (mission.executor.ref !== BUILT_IN_PRAGMA_REF) return undefined;
        if (pragmaManagementPortsRef.current === undefined) {
          throw new Error("The Pragma management ports have not been initialized.");
        }
        const definition = systemExperts.get(BUILT_IN_PRAGMA_REF);
        if (definition === undefined) throw new Error("The built-in Pragma definition is missing.");
        const createsSession = mission.execution?.sessionId === undefined;
        const configuredModel =
          createsSession && definition.executionProfile.mode === "pinned"
            ? definition.executionProfile.model
            : undefined;
        const defaults = await resolveSystemExpertRuntimeDefaults(
          scopedRuntimes,
          configuredModel,
          createsSession ? mission.modelOverride : undefined,
        );
        return {
          ref: BUILT_IN_PRAGMA_REF,
          environmentId: "desktop-system-expert",
          definitionStateRoot: join(defaultAgentStateRoot, "definitions"),
          workspace: mission.workspace.path,
          pragmaHome: pragmaPaths.root,
          runtimes: withRuntimeDefaults(scopedRuntimes, defaults),
          loggerProvider,
          ...(defaults.modelSelection === undefined
            ? {}
            : { defaultModelSelection: defaults.modelSelection }),
          rootExecutionOverride: {
            runtimeId: defaults.runtimeId,
            ...(defaults.modelSelection === undefined
              ? {}
              : { modelSelection: defaults.modelSelection }),
          },
          blueprintCache,
          ...(definition.customized
            ? { expertResource: systemExperts.getResource(BUILT_IN_PRAGMA_REF) }
            : {}),
          additionalResources: systemExperts.getAdditionalResources(BUILT_IN_PRAGMA_REF),
          adapterHost: createDesktopAdapterHost(
            {
              capabilityStore,
              capabilityCredentials,
              resolveSecret: (ref) => pluginCredentials.get(ref),
              capabilitiesPath,
              pragmaHome: pragmaPaths.root,
              mcpToolRegistryPool,
              contextStores,
              pragmaManagement: {
                ...pragmaManagementPortsRef.current,
                ...(knowledgeRevisions === undefined ? {} : { knowledgeRevisions }),
              },
              pragmaManagementScope: {
                missionId: mission.id,
                workspacePath: mission.workspace.path,
              },
            },
            mission.workspace.path,
          ),
          plugins: {
            inspect: async ({ binding }) =>
              await pluginStore.inspect({
                ref: binding.ref,
                config: binding.config,
                secretBindings: binding.secretBindings,
              }),
            resolve: async ({ binding }) =>
              await pluginStore.resolve({
                ref: binding.ref,
                config: binding.config,
                secretBindings: binding.secretBindings,
              }),
          },
        };
      },
    }),
  });
  const usageProjectNames = new Map<string, ReadonlyMap<string, string>>();
  const usageInvocationOwners = new Map<string, Map<string, import("@pragma/shared").Invocation>>();
  const persistMissionUsageBatch = async (
    registered: Mission,
    observations: readonly RuntimeUsageObservation[],
    deletedInvocations?: ReadonlyMap<string, readonly Invocation[]>,
  ) => {
    if (observations.length === 0) return;
    const mission =
      deletedInvocations === undefined ? await missionStore.get(registered.id) : registered;
    // Check accounting availability without running a cumulative SUM.
    await usageStore.assertAvailable();
    const projectKey = JSON.stringify(mission.project.revision);
    let projectNames = usageProjectNames.get(projectKey);
    if (projectNames === undefined) {
      const project = await pragmaProjectStore.openRevision(mission.project.revision);
      try {
        projectNames = new Map(
          project
            .listResources()
            .map((resource) => [resource.metadata.id, resource.metadata.name] as const),
        );
      } finally {
        await project.dispose();
      }
      usageProjectNames.set(projectKey, projectNames);
      while (usageProjectNames.size > 32)
        usageProjectNames.delete(usageProjectNames.keys().next().value!);
    }
    const names = new Map(projectNames);
    names.set(mission.executor.ref, mission.executor.name);
    const deletedOwnerIndexes = new Map<string, Map<string, Invocation>>();
    for (const observation of observations) {
      let owners = usageInvocationOwners.get(observation.executionId);
      const deleted = deletedInvocations?.get(observation.executionId);
      if (deleted !== undefined) {
        owners = deletedOwnerIndexes.get(observation.executionId);
        if (owners === undefined) {
          owners = new Map(deleted.map((invocation) => [invocation.invocationId, invocation]));
          deletedOwnerIndexes.set(observation.executionId, owners);
        }
      }
      if (owners === undefined) owners = new Map();
      usageInvocationOwners.set(observation.executionId, owners);
      // Invocation ancestry and definition identities are stable. Load only new
      // members, never the full Invocation tree for each observation.
      let invocationId: string | undefined = observation.invocationId;
      const visited = new Set<string>();
      const ancestry = [];
      while (invocationId !== undefined && !visited.has(invocationId)) {
        visited.add(invocationId);
        let invocation = owners.get(invocationId);
        if (invocation === undefined) {
          if (deleted !== undefined) throw new Error("MISSION_USAGE_INVOCATION_UNAVAILABLE");
          invocation = await memoryPlane.executionStore.getInvocation(
            observation.executionId,
            invocationId,
          );
          if (invocation === undefined) throw new Error("MISSION_USAGE_INVOCATION_UNAVAILABLE");
          owners.set(invocationId, invocation);
        }
        ancestry.push(invocation);
        invocationId = invocation.parentInvocationId;
      }
      await usageStore.record(observation, {
        mission: { id: mission.id, title: mission.title },
        invocations: ancestry,
        names,
      });
      while (usageInvocationOwners.size > 64)
        usageInvocationOwners.delete(usageInvocationOwners.keys().next().value!);
    }
  };
  const missionDeliveryRecovery = createMissionDeliveryRecovery({
    delivery: missionDeliveryRef,
    create: async () =>
      await createMissionDelivery({
        path: pragmaPaths.missionDelivery(),
        feed: memoryPlane.canonical,
        logger: mainLogger,
        onDegraded: (missionId) => missionApplication.markDeliveryDegraded?.(missionId),
        onRecovered: (missionId) => missionApplication.markDeliveryRecovered?.(missionId),
        usage: async (mission, observation) =>
          await persistMissionUsageBatch(mission, [observation]),
        terminal: createMissionTerminalMaterializer({
          ownerScope,
          missions: guardedMissionStore,
          executions: memoryPlane.executionStore,
          projector: executionEventProjector,
          memory: async (mission, executionId) => {
            const detached = await missionApplication.coordinateMemoryTerminal!(
              mission.id,
              async () => {
                const current = await missionStore.get(mission.id);
                if (
                  isUserFacingMissionOrigin(current.origin) &&
                  current.execution?.id === executionId
                ) {
                  return {
                    cleanup: missionMemory.reconcile(
                      current.id,
                      executionId,
                      current.lifecycleStatus !== "completed",
                    ),
                  };
                }
                return undefined;
              },
            );
            await detached?.cleanup;
          },
          onProjectionChanged: (missionId) =>
            missionApplication.notifyProjectionChanged?.(missionId),
        }),
      }),
    onRecovered: () => {
      missionDeliveryInitializationError = undefined;
    },
    onUnavailable: (error) => {
      missionDeliveryInitializationError = "MISSION_DELIVERY_UNAVAILABLE";
      mainLogger.warn(
        "mission.delivery_degraded",
        "Mission delivery is unavailable; direct projection remains enabled",
        {
          moduleId: "pragma.mission-delivery",
          errorCode: missionDeliveryInitializationError,
          error,
        },
      );
    },
  });
  await missionDeliveryRecovery.initialize();
  localHostUsageRef.current = createLocalHostUsageSink({
    path: join(pragmaPaths.dataRoot(), "usage", "observations.json"),
    feed: memoryPlane.canonical,
    deliveryPath: pragmaPaths.localHostUsageDelivery(),
    onError: (error) =>
      mainLogger.warn("usage.delivery_degraded", "Local Host usage delivery needs recovery", {
        moduleId: "pragma.local-host-usage",
        errorCode: "USAGE_DELIVERY_RETRY_PENDING",
        error,
      }),
  });
  missionApplicationRef.current = missionApplication;
  const controllerFactCompiler = createLocalHostNodeMissionCompiler({
    pragmaHome: pragmaPaths.root,
    runtimes,
    loggerProvider,
  });
  const controllerFactCatalog = createLocalHostProjectCatalogFromHome({
    pragmaHome: pragmaPaths.root,
    runtimes,
    loggerProvider,
    compiler: controllerFactCompiler,
  });
  const controllerFactBuiltIns = createLocalHostBuiltInExecutorResolver({
    pragmaHome: pragmaPaths.root,
    runtimes,
    loggerProvider,
    compiler: controllerFactCompiler,
  });
  const hasMissionEnvelope = async (id: string): Promise<boolean> =>
    (await readMissionEnvelope(id)) !== undefined;
  const resolveControllerFactSession = createMissionSessionAssociationResolver({
    controller: missionControllerStore,
    executions: memoryPlane.executionStore,
    sessions: missionApplication.controllerFactSessionStore,
    repositorySessionId: async (id) => {
      try {
        return (await missionStore.get(id)).execution?.sessionId;
      } catch (error) {
        if (error instanceof MissionStoreError && error.code === "mission_not_found")
          return undefined;
        throw error;
      }
    },
  });
  missionApplication.bindControllerFacts({
    controller: missionControllerStore,
    hasEnvelope: hasMissionEnvelope,
    resolveSessionId: resolveControllerFactSession,
    resolveMissionBinding: async (id) =>
      findMissionPinnedBinding(
        (await missionControllerStore.readSnapshot({ missionId: id })).events,
      ),
    executors: async (input) =>
      (await controllerFactBuiltIns(input)) ?? (await controllerFactCatalog.resolve(input)),
    compiler: controllerFactCompiler,
    usageSink: localHostUsageRef.current,
    createHostContextBindings: async ({ missionId, request }) => [
      ...(await createLocalHostMissionBoardBindings({ pragmaHome: pragmaPaths.root, missionId })),
      ...(await missionMemory.bindings({
        missionId,
        goal: request.prompt ?? "",
        bindingId: request.requestId,
        ...(request.project === undefined ? {} : { projectId: request.project.projectId }),
      })),
    ],
    memory: {
      linked: (input) => missionMemory.register(input),
      recovering: (missionId, executionId) => missionMemory.resume(missionId, executionId),
      admitting: (missionId, requestId) => missionMemory.beginPrompt(missionId, requestId),
      terminal: (missionId, executionId, waiting) =>
        missionMemory.complete(missionId, executionId, waiting),
    },
  });
  const memoryCurator = createDesktopMemoryCurator({
    profiles: memoryPlane.extractorProfiles,
    missions: missionStore,
    application: missionApplication,
    project: pragmaProjectStore,
    runtimes,
    workspace: initialSettings.defaultWorkspace,
    pragmaHome: pragmaPaths.root,
    loggerProvider,
  });
  memoryCuratorRef.current = memoryCurator;
  storeRevisionAgentRef.current = createDesktopStoreRevisionAgent({
    missions: missionStore,
    application: missionApplication,
    project: pragmaProjectStore,
    runtimes,
    pragmaHome: pragmaPaths.root,
    loggerProvider,
    onMissionCreated: async ({ jobId, missionId }) => {
      await storeRevisions.attachMission(jobId, missionId);
    },
    isDraftSubmitted: async (jobId) => (await storeRevisions.get(jobId)).state === "pending_review",
  });
  skillAgentsRef.current = createDesktopSkillAgents({
    systemExperts,
    missions: missionStore,
    application: missionApplication,
    project: pragmaProjectStore,
    runtimes,
    pragmaHome: pragmaPaths.root,
    loggerProvider,
    resolveDraftWorkspace: async (draftId) =>
      (await skillRevisions.getDraft(draftId)).workspacePath,
    onMissionCreated: async ({ jobId, missionId }) => {
      await skillRevisions.attachMission(jobId, missionId);
    },
    isDraftSubmitted: async (jobId) => (await skillRevisions.get(jobId)).state === "pending_review",
  });
  const evaluationService = createEvaluationService({
    store: evaluationStore,
    project: pragmaProjectStore,
    executor: createMissionAgentEvaluationExecutor({
      missions: missionStore,
      application: missionApplication,
      project: pragmaProjectStore,
      store: evaluationStore,
      mocks: evaluationMocks,
      workspaceRoot: join(pragmaPaths.temporaryRoot(), "evaluations"),
    }),
    warn: (message, error) =>
      mainLogger.warn("desktop.evaluation_queue_failed", message, { error }),
  });
  installEvaluationHandlers(evaluationService, pragmaProjectStore);
  await Promise.all([
    memoryPlane.setEpisodicExtractor(memoryCurator.episodicExtractor),
    memoryPlane.setSemanticExtractor(memoryCurator.semanticExtractor),
  ]);
  const memoryRevisionPlanners = createMemoryRevisionLearningPlanners({
    pragmaHome: pragmaPaths.root,
    missions: missionStore,
    application: missionApplication,
    project: pragmaProjectStore,
  });
  await Promise.all([
    memoryPlane.setKnowledgePlanner(memoryRevisionPlanners.knowledge),
    memoryPlane.setSkillPlanner(memoryRevisionPlanners.skill),
  ]);
  const unsubscribeTokenCounter = tokenCounter.subscribe(() => {
    void missionApplication.invalidateEstimatedContextWindows().catch((error: unknown) => {
      mainLogger.warn(
        "desktop.tokenizer_context_refresh_failed",
        "Mission context windows could not be refreshed after a tokenizer update.",
        { error },
      );
    });
  });
  const automationService = createAutomationService({
    paths: pragmaPaths,
    project: pragmaProjectStore,
    store: createAutomationStore(pragmaPaths, pragmaProjectStore.projectId),
    missions: missionStore,
    creator: missionCreator,
    application: missionApplication,
    loggerProvider,
    onStorageTrashed: () => trashMaintenance.schedule("automation-storage-trashed"),
  });
  installAutomationHandlers(automationService);
  const homeProjects = createHomeProjectStore(join(pragmaPaths.dataRoot(), "home-projects.json"));
  const pragmaAgentMissions = createLocalHostPragmaMissionPort({
    missions: missionStore,
    application: missionApplication,
    creator: missionCreator,
    stateRoot: defaultAgentStateRoot,
  });
  pragmaManagementPortsRef.current = {
    project: pragmaAgentProject,
    missions: pragmaAgentMissions,
    resources: createDesktopPragmaAgentResourceCatalogPort({
      homeProjects,
      contextStores,
      executors: missionExecutors,
      workspaceHistory,
      workspacePreferences: homeExecutorPreferences,
      getDefaultWorkspace: async () =>
        (await desktopSettings.getSnapshot(options.getPreferredSystemLanguages())).defaultWorkspace,
    }),
    skillRevisions: pragmaManagementSkillRevisions,
    automations: createLocalHostPragmaAutomationPort({
      service: automationService,
      project: pragmaProjectStore,
      stateRoot: defaultAgentStateRoot,
    }),
  };
  const missionContextStoreBrowser = createMissionContextStoreBrowserService({
    missions: missionStore,
    project: pragmaProjectStore,
    systemExperts,
    memory: memoryPlane,
    application: missionApplication,
  });
  const missionActivity = createMissionActivityReader({
    controller: missionControllerStore,
    executions: memoryPlane.executionStore,
    onReadFailure: ({ missionId, source, error }) => {
      mainLogger.warn(
        "mission.read_projection_degraded",
        "Mission activity was returned with a degraded authority read.",
        { missionId, source, error, retryable: true },
      );
    },
  });
  const missionReadModel = createMissionReadModel({
    missions: missionStore,
    activity: missionActivity,
  });

  const localHost = createLocalHostApplication({
    integrationCapability: async () => createLocalHostIntegrationCapability(),
    catalog: {
      listProjects: async () => [{ id: pragmaProjectStore.projectId }],
      getProjectRevision: async (projectId, revision) =>
        projectId === pragmaProjectStore.projectId
          ? await pragmaProjectStore.getRevision(revision)
          : undefined,
      listExecutors: async () => await missionExecutors.list(),
    },
    missions: missionReadPorts.missions,
    workspace: createWorkspaceFilesystemPort(),
    board: missionReadPorts.board,
    queue: {
      list: async (missionId) => {
        if (missionApplication.listPromptQueue === undefined)
          throw new Error("Desktop ExpertSession prompt queue projection is unavailable.");
        return await missionApplication.listPromptQueue(missionId);
      },
    },
    watch: missionReadPorts.watch,
    runtime: { resolver: runtimes },
    missionApplication,
  });
  if (localHost.missionControl === undefined || localHost.run === undefined) {
    throw new Error("Desktop Local Host control and run ports were not composed.");
  }
  // The shared Node composition intentionally exposes unknown application
  // payloads so it stays independent from Desktop's renderer contracts. Parse
  // the three Desktop-facing projections once at this boundary instead of
  // leaking casts throughout IPC handlers.
  const desktopLocalHost = {
    ...localHost,
    getMission: async (missionId: string) =>
      MissionSchema.parse(await missionReadModel.get(missionId)),
    listMissions: async () => MissionSummarySchema.array().parse(await missionReadModel.list()),
    listExecutors: async () =>
      MissionExecutorOptionSchema.array().parse(await localHost.listExecutors()),
    missionControl: localHost.missionControl,
    run: localHost.run,
  };
  installMissionHandlers({
    logger: mainLogger,
    homeProjects,
    localHost: desktopLocalHost,
    missions: missionStore,
    creator: missionCreator,
    executors: missionExecutors,
    homeExecutors,
    project: pragmaProjectStore,
    systemExperts,
    getWindow: options.getWindow,
    application: missionApplication,
    getAutomationMissionSources: () => automationService.listMissionSources(),
    getDefaultToolPermissionMode: getToolPermissionMode,
    getDefaultWorkspace: async () =>
      (await desktopSettings.getSnapshot(options.getPreferredSystemLanguages())).defaultWorkspace,
    getRecentWorkspaces: () => workspaceHistory.list(),
    recordWorkspaceUsage: async (path) => {
      try {
        await workspaceHistory.record(path);
      } catch (error) {
        mainLogger.warn(
          "desktop.workspace_usage_failed",
          "Workspace usage could not be recorded.",
          { error },
        );
      }
    },
    defaultExecutorRef: BUILT_IN_PRAGMA_REF,
    temporaryRoot: pragmaPaths.temporaryRoot(),
    onMissionLifecycleChange: async ({ missionId, state }) => {
      await memoryPlane.setMemoryConversationState({ missionId, state });
    },
  });
  installMissionContextStoreBrowserHandlers(missionContextStoreBrowser);
  installDesktopSettingsHandlers({
    store: desktopSettings,
    validateDefaultWorkspace: async (path) => {
      const validation = await validateWorkspace(path);
      if (!validation.ok) {
        throw new Error("The default workspace must be an accessible, writable directory.");
      }
    },
  });
  installDesktopStorageCleanupHandlers({
    paths: pragmaPaths,
    missions: missionStore,
    application: missionApplication,
  });
  installMemoryPolicyHandlers(memoryPlane, {
    missions: missionStore,
    project: pragmaProjectStore,
    systemExperts,
    curator: memoryCurator,
    getWindow: options.getWindow,
    onGlobalPolicyUpdated: () => missionApplication.refreshMemoryContextBindings(),
  });
  installExpertMemoryContextStoreBrowserHandlers(
    createExpertMemoryContextStoreBrowserService({
      project: pragmaProjectStore,
      systemExperts,
      memory: memoryPlane,
    }),
  );
  installTeamMemoryContextStoreBrowserHandlers(
    createTeamMemoryContextStoreBrowserService({
      project: pragmaProjectStore,
      memory: memoryPlane,
    }),
  );
  installModelProviderHandlers(modelProviderStore, {
    beforeConnectionChange: () => memoryPlane.retrieval?.cancel(),
    isProviderReferenced: async (providerId) =>
      (await pragmaProjectStore.get()).resources.some(
        (resource) =>
          resource.kind === "RuntimeProfile" &&
          (resource.spec.config as Record<string, unknown>).providerId === providerId,
      ),
  });
  const storageCapacityInspection = createStorageCapacityInspection({
    paths: pragmaPaths,
    logger: mainLogger,
    isIdle: () => {
      const resources = missionApplication.getResourceDiagnostics();
      return (
        powerMonitor.getSystemIdleTime() >= 300 &&
        resources.warmSessionCount === 0 &&
        resources.busyMissionCount === 0
      );
    },
  });
  const cancelCapacityInspection = () => storageCapacityInspection.cancel();
  powerMonitor.on("user-did-become-active", cancelCapacityInspection);
  powerMonitor.on("resume", cancelCapacityInspection);
  let backgroundTasksStarted = false;
  return {
    startBackgroundTasks() {
      if (backgroundTasksStarted) return;
      backgroundTasksStarted = true;
      void usageStore.start().catch((error) =>
        mainLogger.warn("desktop.usage_store_unavailable", "Usage initialization deferred", {
          error,
          errorCode: "desktop_usage_unavailable",
        }),
      );
      storageCapacityInspection.start();
      trashMaintenance.schedule("startup");
      void assetSync.start().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.asset_sync_start_failed",
          "Asset synchronization could not be initialized.",
          { error },
        );
      });
      runtimeProcessEnvironment.warmUp();
      // This starts only after the first window is available.  The three fixed
      // credential aggregates are targeted explicitly; it never scans Projects,
      // Missions, workspaces, or arbitrary data-home entries on startup.
      for (const [family, migrate] of [
        ["model_provider", () => modelProviderStore.migrateLegacy?.()],
        ["capability", () => capabilityCredentials.migrateLegacy?.()],
        ["plugin", () => pluginCredentials.migrateLegacy?.()],
      ] as const) {
        void Promise.resolve(migrate()).catch((error: unknown) => {
          mainLogger.warn(
            "desktop.credential_migration_degraded",
            "A credential migration needs attention; unrelated subsystems remain available.",
            { family, error },
          );
        });
      }
      void runtimeEnvironments.initialize().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.runtime_environment_warmup_failed",
          "Runtime environments could not be warmed up.",
          { error },
        );
      });
      void capabilityRevisionCoordinator.recover().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.capability_revision_recovery_failed",
          "Capability revision propagation could not be recovered.",
          { error },
        );
      });
      void bundleService.initialize().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.bundle_warmup_failed",
          "Desktop Bundle state could not be warmed up.",
          { error },
        );
      });
      missionDeletion.start();
      missionDeliveryRecovery.start();
      localHostUsageRef.current?.start();
      void automationService.start().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.automation_start_failed",
          "Desktop automations could not be initialized.",
          { error },
        );
      });
      void evaluationService.start().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.evaluation_start_failed",
          "The evaluation queue could not be initialized.",
          { error },
        );
      });
      void tokenCounter.load().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.tokenizer_warmup_failed",
          "The Runtime token counter could not be warmed up.",
          { error },
        );
      });
      void memoryCurator.recoverOrphans().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.memory_curator_orphan_cleanup_failed",
          "Orphaned Memory Curator Missions could not be cleaned up.",
          { error },
        );
      });
      void memoryRevisionPlanners.recoverOrphans().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.memory_revision_planning_orphan_cleanup_failed",
          "Orphaned Memory revision planning Missions could not be cleaned up.",
          { error },
        );
      });
      void skillAgentsRef.current?.recoverOrphans().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.skill_agent_orphan_cleanup_failed",
          "Orphaned Skill Revision or Evaluation Agent Missions could not be cleaned up.",
          { error },
        );
      });
      void storeRevisions.processPending().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.context_store_revision_resume_failed",
          "Pending Context Store revisions could not be resumed.",
          { error },
        );
      });
      void skillRevisions.processPending().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.skill_revision_resume_failed",
          "Pending Skill revisions could not be resumed.",
          { error },
        );
      });
      memoryPlane.start();
    },
    dispose: async () => {
      // Stop producers before the shared kernel seals admission. Runtime owners
      // and platform resources remain installed if Native stop is unconfirmed.
      missionDeletion.close();
      assetSync.stop();
      evaluationService.dispose();
      automationService.stop();
      await missionApplication.dispose();
      unsubscribeUsageUpdates();
      unsubscribeTokenCounter();
    },
  };
}
