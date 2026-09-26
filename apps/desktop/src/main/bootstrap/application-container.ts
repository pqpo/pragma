import { createHomeProjectStore } from "../features/missions/home-project-store.ts";
import {
  createAssetGitService,
  type AssetGitService,
} from "../features/asset-git/asset-git-service.ts";
import { installAssetGitHandlers } from "../features/asset-git/asset-git-ipc.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { BrowserWindow } from "electron";
import {
  createMcpToolRegistryPool,
  createRuntimeTokenCounter,
  createStorageCapacityGuard,
  PragmaPaths,
  type PragmaLogger,
  type PragmaLoggerProvider,
} from "@pragma/core";
import {
  BUILT_IN_PRAGMA_REF,
  EVALUATION_JUDGE_EXPERT_REF,
  SKILL_REVISION_EXPERT_REF,
  STORE_REVISION_EXPERT_REF,
  compileBuiltInAgent,
  builtInAgentFingerprint,
  pragmaManagementCapabilityResource,
  type PragmaManagementToolPorts,
} from "@pragma/built-in-agents";
import { MEMORY_CURATOR_REF } from "@pragma/memory";
import {
  createLocalHostMissionController,
  createMissionActivityReader,
  createNativeOsKeychain,
  createSecretStore,
  type MissionControllerStore,
  type LocalHostRunExecutorPort,
} from "@pragma/local-host";
import { createLocalHostNodeApplication } from "@pragma/local-host/node-application";
import {
  isUserFacingMissionOrigin,
  MissionExecutorOptionSchema,
  MissionSchema,
  MissionSummarySchema,
} from "../../shared/contracts/index.ts";

import { installAutomationHandlers } from "../features/automations/automation-ipc.ts";
import { createAutomationService } from "../features/automations/automation-service.ts";
import { createAutomationStore } from "../features/automations/automation-store.ts";
import { installPragmaBundleHandlers } from "../features/bundles/pragma-bundle-ipc.ts";
import { BundleSetupRequiredError } from "../features/bundles/pragma-bundle-errors.ts";
import { createPragmaBundleService } from "../features/bundles/pragma-bundle-service.ts";
import { installBundleRegistryHandlers } from "../features/bundle-registry/bundle-registry-ipc.ts";
import { createDesktopBundleRegistrySourceService } from "../features/bundle-registry/bundle-registry-source-service.ts";
import { createBundleSourcePublishingService } from "../features/bundle-registry/bundle-source-publishing-service.ts";
import { createCapabilityCredentialStore } from "../features/capabilities/capability-credential-store.ts";
import { installCapabilityHandlers } from "../features/capabilities/capability-ipc.ts";
import { createCapabilityRevisionCoordinator } from "../features/capabilities/capability-revision-coordinator.ts";
import { createCapabilityStore } from "../features/capabilities/capability-store.ts";
import { createDesktopSkillRevisionSubmissionPort } from "../features/capabilities/skill-revision-capability.ts";
import {
  createDesktopSkillAgents,
  type DesktopSkillAgents,
} from "../features/capabilities/skill-agents.ts";
import {
  createSkillRevisionService,
  type SkillRevisionGenerator,
} from "../features/capabilities/skill-revision-service.ts";
import { createCapabilityVerifier } from "../features/capabilities/capability-verifier.ts";
import { installContextStoreHandlers } from "../features/context-stores/context-store-ipc.ts";
import { installCoreAssetSyncHandlers } from "../features/studio-sync/core-asset-sync-ipc.ts";
import {
  createCoreAssetSyncService,
  unavailableCoreAssetRuntimeBindings,
  type CoreAssetSyncService,
} from "../features/studio-sync/core-asset-sync-service.ts";
import {
  createContextStoreRevisionService,
  type ContextStoreRevisionGenerator,
  type ContextStoreRevisionService,
} from "../features/context-stores/context-store-revision-service.ts";
import { createContextStoreStore } from "../features/context-stores/context-store-store.ts";
import { createContextStoreEditorDraftService } from "../features/context-stores/context-store-editor-draft-service.ts";
import { toContextStoreMissionDeletionError } from "./context-store-mission-deletion-error.ts";
import {
  createDesktopStoreRevisionAgent,
  type DesktopStoreRevisionAgent,
} from "../features/context-stores/store-revision-agent.ts";
import { createDesktopKnowledgeRevisionSubmissionPort } from "../features/context-stores/knowledge-revision-capability.ts";
import { createDesktopPragmaAgentAutomationPort } from "../features/built-in-agents/pragma-agent-automation-adapter.ts";
import { createDesktopPragmaAgentProjectPort } from "../features/built-in-agents/pragma-agent-project-adapter.ts";
import { createDesktopPragmaAgentMissionPort } from "../features/built-in-agents/pragma-agent-task-adapter.ts";
import { installExpertDefinitionHandlers } from "../features/experts/expert-definition-ipc.ts";
import { installEvaluationHandlers } from "../features/evaluations/evaluation-ipc.ts";
import {
  createEvaluationMockAdapterRegistry,
  createMissionAgentEvaluationExecutor,
} from "../features/evaluations/evaluation-executor.ts";
import { createEvaluationService } from "../features/evaluations/evaluation-service.ts";
import { createEvaluationStore } from "../features/evaluations/evaluation-store.ts";
import { createExpertDefinitionStore } from "../features/experts/expert-definition-store.ts";
import {
  createDesktopSystemExpertRegistry,
  type DesktopSystemExpertRegistry,
} from "../features/experts/system-expert-registry.ts";
import {
  resolveSystemExpertRuntimeDefaults,
  withRuntimeDefaults,
} from "../features/experts/system-expert-runtime.ts";
import { createMissionCreator } from "../features/missions/mission-creator.ts";
import { createHomeExecutorCatalog } from "../features/missions/home-executor-catalog.ts";
import { createHomeExecutorPreferenceStore } from "../features/missions/home-executor-preference-store.ts";
import { createMissionExecutorCatalog } from "../features/missions/mission-executor-catalog.ts";
import { installMissionHandlers } from "../features/missions/mission-ipc.ts";
import { installMissionContextStoreBrowserHandlers } from "../features/missions/mission-context-store-browser-ipc.ts";
import { createMissionContextStoreBrowserService } from "../features/missions/mission-context-store-browser.ts";
import { createDesktopAdapterHost } from "../features/missions/mission-adapter-host.ts";
import { createMissionRunner } from "../features/missions/mission-runner.ts";
import { createMissionExecutionEventProjector } from "../features/missions/mission-command-execution-projector.ts";
import { createMissionStore, MissionStoreError } from "../features/missions/mission-store.ts";
import { createFencedMissionStore } from "../features/missions/mission-store-fenced-adapter.ts";
import { MissionStatusService } from "../features/missions/mission-status-service.ts";
import { createDesktopLocalHostExecutorResolver } from "../features/missions/local-host-mission-adapter.ts";
import { createMissionReadModel } from "../features/missions/mission-read-model.ts";
import {
  createDesktopMemoryPlane,
  type DesktopMemoryPlane,
} from "../features/memory/desktop-memory-plane.ts";
import { createMemoryLearningRevisions } from "../features/memory/memory-learning-revisions.ts";
import { createMemoryRevisionLearningPlanners } from "../features/memory/memory-revision-learning-planners.ts";
import {
  createDesktopMemoryCurator,
  type DesktopMemoryCurator,
} from "../features/memory/memory-curator.ts";
import { installExpertMemoryContextStoreBrowserHandlers } from "../features/memory/expert-memory-context-store-browser-ipc.ts";
import { createExpertMemoryContextStoreBrowserService } from "../features/memory/expert-memory-context-store-browser.ts";
import { installTeamMemoryContextStoreBrowserHandlers } from "../features/memory/team-memory-context-store-browser-ipc.ts";
import { createTeamMemoryContextStoreBrowserService } from "../features/memory/team-memory-context-store-browser.ts";
import { installMemoryPolicyHandlers } from "../features/memory/memory-policy-ipc.ts";
import { installModelProviderHandlers } from "../features/model-providers/model-provider-ipc.ts";
import { createModelProviderStore } from "../features/model-providers/model-provider-store.ts";
import { createPluginCredentialStore } from "../features/plugins/plugin-credential-store.ts";
import { installPluginHandlers } from "../features/plugins/plugin-ipc.ts";
import { createPluginStore } from "../features/plugins/plugin-store.ts";
import { installPragmaProjectHandlers } from "../features/projects/pragma-project-ipc.ts";
import { createDesktopPragmaBlueprintCacheStore } from "../features/projects/pragma-blueprint-cache-store.ts";
import { createPragmaProjectStore } from "../features/projects/pragma-project-store.ts";
import { installWorkflowLayoutHandlers } from "../features/projects/workflow-layout-ipc.ts";
import { createWorkflowLayoutStore } from "../features/projects/workflow-layout-store.ts";
import { createDesktopRuntimeProcessEnvironment } from "../features/runtimes/desktop-runtime-process-environment.ts";
import { getRuntimeAvailability } from "../features/runtimes/runtime-availability.ts";
import {
  createBuiltInRuntimeFactories,
  createRuntimeEnvironmentService,
} from "../features/runtimes/runtime-environment-service.ts";
import { createRuntimeEnvironmentStore } from "../features/runtimes/runtime-environment-store.ts";
import { installRuntimeHandlers } from "../features/runtimes/runtime-ipc.ts";
import { createAutomaticToolPermissionHandler } from "../features/runtimes/tool-permission-policy.ts";
import { installDesktopSettingsHandlers } from "../features/settings/desktop-settings-ipc.ts";
import { createDesktopSettingsStore } from "../features/settings/desktop-settings-store.ts";
import { createWorkspaceHistoryStore } from "../features/workspaces/workspace-history-store.ts";
import { installUsageHandlers } from "../features/usage/usage-ipc.ts";
import {
  createDesktopUsageStore,
  createUnavailableDesktopUsageStore,
} from "../features/usage/usage-store.ts";
import { validateWorkspace } from "../features/workspaces/workspace-scope.ts";
import { createWorkspaceFilesystemPort } from "../features/workspaces/workspace-filesystem-port.ts";
import type { CredentialEncryption } from "../platform/security/credential-encryption.ts";
import { createElectronSafeStorageLegacyDecryptor } from "../platform/security/electron-safe-storage-legacy-decryptor.ts";
import { initializeDesktopStorage } from "../platform/storage/storage-bootstrap.ts";
import { createDesktopTrashMaintenance } from "../platform/storage/trash-maintenance.ts";

export interface DesktopApplicationContainer {
  readonly startBackgroundTasks: () => void;
  readonly dispose: () => void;
}

async function migrateLegacyStoreRevisionProfile(options: {
  readonly stateRoot: string;
  readonly revisions: ContextStoreRevisionService;
  readonly systemExperts: DesktopSystemExpertRegistry;
}): Promise<void> {
  const profile = await options.revisions.getProfile();
  if (profile.mode !== "pinned") return;
  const current = options.systemExperts.get(STORE_REVISION_EXPERT_REF);
  if (current === undefined) throw new Error("The Store Revision Agent definition is missing.");
  const journalPath = join(options.stateRoot, "migrations", "store-revision-profile-split.json");
  if (current.customized) {
    await rm(journalPath, { force: true });
    return;
  }
  const backupPath = join(
    options.stateRoot,
    "migration-backups",
    "context-store-revision-profile-v1.json",
  );
  await writeBootstrapJson(backupPath, profile);
  await writeBootstrapJson(journalPath, {
    schemaVersion: "pragma.store-revision-profile-split/v1",
    sourceProfile: backupPath,
    targets: [STORE_REVISION_EXPERT_REF, "skill-revision-profile"],
  });
  await options.systemExperts.update(STORE_REVISION_EXPERT_REF, {
    ...(current.avatarId === undefined ? {} : { avatarId: current.avatarId }),
    name: current.name,
    description: current.description,
    tags: current.tags,
    additionalInstructions: current.additionalInstructions,
    model: profile.model,
    capabilities: current.capabilities,
    toolApprovals: current.toolApprovals,
    plugins: current.plugins,
    contextStoreMounts: current.contextStoreMounts,
    resourceTools: current.resourceTools,
  });
  await rm(journalPath, { force: true });
}

async function writeBootstrapJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
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
  const storageCapacityGuard = createStorageCapacityGuard({
    paths: pragmaPaths,
    refreshIntervalMs: 0,
    maxSnapshotAgeMs: 30_000,
  });
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
  const coreSyncRef: { current?: CoreAssetSyncService } = {};
  const pragmaProjectStore = createPragmaProjectStore({
    onPublished: () => coreSyncRef.current?.schedule("project-published"),
    projectsPath,
    objectsPath: pragmaPaths.contentObjectsRoot(),
    projectViewsPath: pragmaPaths.projectViewsCacheRoot(),
    storagePaths: pragmaPaths,
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
    onChanged: () => coreSyncRef.current?.schedule("flow-layout-changed"),
  });
  installWorkflowLayoutHandlers(workflowLayouts);
  const pluginCredentials = createPluginCredentialStore({
    configPath: join(pragmaPaths.credentialsRoot(), "plugin-credentials.json"),
    secretStore,
    legacyDecryptor: legacyCredentialDecryptor,
  });
  const missionStore = createMissionStore({
    missionsPath,
    getRevisionSource: async (jobId) => (await storeRevisions.get(jobId)).request.source,
    onReadIssue: ({ missionId, error }) =>
      mainLogger.warn(
        "mission.list_entry_unavailable",
        "A Mission could not be listed safely. Other readable Missions remain available.",
        { missionId, errorCode: error.code, error },
      ),
  });
  const missionRunnerRef: {
    current?: ReturnType<typeof createMissionRunner>;
  } = {};
  const semanticWriteReplayRef: {
    current?: Parameters<MissionControllerStore["recoverSemanticWrite"]>[0]["replay"];
  } = {};
  const missionControllerRef: {
    current?: MissionControllerStore;
  } = {};
  // Local Host owns aggregate lease persistence and the query/watch lifecycle;
  // Desktop supplies only Electron-facing stop/replay hooks.
  const missionLifecycle = createLocalHostMissionController({
    missionsPath,
    ...(missionStore.storagePath === undefined ? {} : { missionPath: missionStore.storagePath }),
    onPollingError: ({ missionId, error, consecutiveFailures }) => {
      mainLogger.warn(
        "mission.controller_inbox_poll_failed",
        "Mission Inbox polling failed; the durable command will be retried while the owner remains healthy.",
        { missionId, consecutiveFailures, error },
      );
    },
    onLeaseLost: async (missionId) => {
      await missionRunnerRef.current?.stopLocalController(missionId);
      mainLogger.warn(
        "mission.controller_lease_lost",
        "Mission controller lease was lost; local execution was stopped and subsequent semantic writes are fenced.",
        { missionId },
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
  const runtimeProcessEnvironment = createDesktopRuntimeProcessEnvironment({
    logger: mainLogger,
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
  installRuntimeHandlers(runtimes, runtimeProcessEnvironment);
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
        coreSyncRef.current?.schedule("capability-published");
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
    onSkillCreated: () => coreSyncRef.current?.schedule("skill-published"),
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
      coreSyncRef.current?.schedule("skill-removed");
    },
    warn: (message, error) =>
      mainLogger.warn("desktop.capability_revision_recovery_failed", message, { error }),
  });
  const evaluationStore = createEvaluationStore(join(pragmaPaths.stateRoot(), "evaluations"));
  const evaluationMocks = createEvaluationMockAdapterRegistry(capabilityStore);
  const storeRevisionsRef: { current?: ContextStoreRevisionService } = {};
  const contextStores = createContextStoreStore({
    storesPath: contextStoresPath,
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
      const missionRunner = missionRunnerRef.current;
      if (references.length > 0 && missionRunner === undefined) {
        throw new Error("Mission runner is unavailable while removing Mission Knowledge mounts.");
      }
      const assertSafeToUnmount = async (missionId: string): Promise<void> => {
        try {
          await missionRunner?.assertContextMountChangeAllowed(missionId);
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
          await missionRunner?.removeContextStoreMount({ id: reference.id, storeId });
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
      coreSyncRef.current?.schedule("knowledge-store-removed");
    },
    onPublished: () => coreSyncRef.current?.schedule("knowledge-store-published"),
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
  });
  assetGitRef.current = assetGit;
  const coreAssetSync = createCoreAssetSyncService({
    configurationPath: join(pragmaPaths.stateRoot(), "core-asset-sync-settings.json"),
    legacyConfigurationPaths: [
      join(pragmaPaths.stateRoot(), "knowledge-sync-settings.json"),
      join(pragmaPaths.stateRoot(), "skill-sync-settings.json"),
    ],
    statePath: join(pragmaPaths.stateRoot(), "core-asset-sync-state.json"),
    project: pragmaProjectStore,
    layouts: workflowLayouts,
    stores: contextStores,
    capabilities: capabilityStore,
    getRuntimes: async () => await getRuntimeAvailability(runtimes),
    warn: (message, error) => mainLogger.warn("desktop.core_asset_sync_failed", message, { error }),
  });
  coreSyncRef.current = coreAssetSync;
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
  await migrateLegacyStoreRevisionProfile({
    stateRoot: pragmaPaths.stateRoot(),
    revisions: storeRevisions,
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
  installCoreAssetSyncHandlers(coreAssetSync);
  installAssetGitHandlers(assetGit);
  const memoryPlane = await createDesktopMemoryPlane({
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
  ): Promise<void> => {
    const dependencies = [...(await bundleService.getReadinessForRef(ref))];
    const projectSnapshot = await pragmaProjectStore.get();
    const runtimesAvailable = await getRuntimeAvailability(runtimes);
    for (const missing of unavailableCoreAssetRuntimeBindings(
      ref,
      projectSnapshot.resources,
      runtimesAvailable,
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
    missions: missionStore,
    project: pragmaProjectStore,
    executors: missionExecutors,
    contextStores,
    contextStoreRevisions: storeRevisions,
    getDefaultToolPermissionMode: getToolPermissionMode,
    assertExecutorReady: async (ref) => await assertBundleExecutorReady(ref, "create_mission"),
    assertStorageWriteAllowed: async () => await storageCapacityGuard.assertWriteAllowed(),
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
    draftsRoot: join(pragmaPaths.dataRoot(), "dsl-resource-drafts"),
    draftsTrashRoot: join(pragmaPaths.trashRoot(), "dsl-resource-drafts"),
    capabilities: capabilityStore,
    runtimes,
    systemExperts,
  });
  const memoryCuratorRef: { current?: DesktopMemoryCurator } = {};
  const missionRunner = createMissionRunner({
    missions: guardedMissionStore,
    missionStatus,
    project: pragmaProjectStore,
    capabilityStore,
    capabilityCredentials,
    capabilitiesPath,
    mcpToolRegistryPool,
    pragmaHome: pragmaPaths.root,
    executionStore: memoryPlane.executionStore,
    contextStores,
    contextStoreRevisions: storeRevisions,
    knowledgeRevisionMountResources: systemExpertKnowledgeRevisionMountResources,
    hostContextStores: async () => {
      const globalPolicy = await memoryPlane.policies.getGlobal();
      return globalPolicy.policy.enabled === "enabled"
        ? [{ namespace: "memory", store: memoryPlane.contextStore }]
        : [];
    },
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
    assertStorageWriteAllowed: async () => await storageCapacityGuard.assertWriteAllowed(),
    pragmaManagementPorts: () => {
      if (pragmaManagementPortsRef.current === undefined) {
        throw new Error("The Pragma management ports have not been initialized.");
      }
      return pragmaManagementPortsRef.current;
    },
    onStorageTrashed: () => trashMaintenance.schedule("mission-storage-trashed"),
    onOwnerDeleting: async ({ mission, executionIds }) => {
      let cursor: string | undefined;
      const draftIds: string[] = [];
      do {
        const page = await pragmaAgentProject.listDslDrafts({
          missionId: mission.id,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const draft of page.items) {
          if (
            draft.state !== "editing" &&
            draft.state !== "conflicted" &&
            draft.state !== "prepared"
          )
            continue;
          draftIds.push(draft.draftId);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      for (const draftId of draftIds) {
        await pragmaAgentProject.discardDslDraft({ missionId: mission.id, draftId });
      }
      await memoryPlane.deleteExecutionState(executionIds);
    },
    onExecutionLinked: async ({ mission, executionId, requestId }) => {
      await executionEventProjector.link({ mission, executionId, requestId });
    },
    onExecutionContextLinked: async ({ mission, executionId }) => {
      if (!isUserFacingMissionOrigin(mission.origin)) return;
      await memoryPlane.registerMemoryExecutionContext({
        executionId,
        missionId: mission.id,
        projectId: mission.project.id,
      });
    },
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
    onExecutionTerminal: async ({ mission, executionId, status, result, error }) => {
      await executionEventProjector.terminal({ mission, executionId, status, result, error });
      if (!isUserFacingMissionOrigin(mission.origin)) return;
      try {
        await memoryPlane.setMemoryConversationState({
          missionId: mission.id,
          state: mission.lifecycleStatus === "completed" ? "completed" : "active",
        });
      } catch (memoryError) {
        mainLogger.warn(
          "mission.memory_terminal_projection_failed",
          "Mission terminal state committed while its Memory conversation projection remained stale.",
          { error: memoryError, missionId: mission.id, executionId, retryable: true },
        );
      }
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
    assertExecutorReady: async (ref) => await assertBundleExecutorReady(ref, "run_mission"),
    compileSystemExecutor: async ({
      mission,
      runtimes: scopedRuntimes,
      knowledgeRevisions,
      resolveExternalInvocable,
    }) => {
      const planningRef = mission.executor.ref;
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
        return await compileBuiltInAgent({
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
        });
      }
      if (mission.executor.ref === MEMORY_CURATOR_REF) {
        if (memoryCuratorRef.current === undefined || mission.origin.type !== "system-memory") {
          throw new Error("The Memory Curator has not been initialized.");
        }
        return await memoryCuratorRef.current.compile({
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
            capabilitiesPath,
            mcpToolRegistryPool,
            contextStores,
            ...(knowledgeRevisions === undefined
              ? {}
              : { pragmaManagement: { knowledgeRevisions } }),
          },
          mission.workspace.path,
        );
        return await storeRevisionAgentRef.current.compile({
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
          resolveExternalInvocable,
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
        const additionalResources = systemExperts.getAdditionalResources(SKILL_REVISION_EXPERT_REF);
        return await skillAgentsRef.current.compile({
          runtimes: scopedRuntimes,
          workspace: mission.workspace.path,
          adapterHost: createDesktopAdapterHost(
            {
              capabilityStore,
              capabilityCredentials,
              capabilitiesPath,
              mcpToolRegistryPool,
              contextStores,
              pragmaManagement: { skillRevisions: skillRevisionPort },
            },
            mission.workspace.path,
          ),
          ...(expertResource === undefined ? {} : { expertResource }),
          ...(additionalResources === undefined ? {} : { additionalResources }),
          resolveExternalInvocable,
        });
      }
      if (mission.executor.ref === EVALUATION_JUDGE_EXPERT_REF) {
        if (mission.origin.type !== "system-evaluation" || mission.origin.phase !== "judge") {
          throw new Error("The Evaluation Judge Agent mission is invalid.");
        }
        const settings = await evaluationStore.getSettings();
        const configuredModel = settings.judge.mode === "pinned" ? settings.judge.model : undefined;
        const defaults = await resolveSystemExpertRuntimeDefaults(
          scopedRuntimes,
          configuredModel,
          mission.modelOverride,
        );
        return await compileBuiltInAgent({
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
        });
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
      return await compileBuiltInAgent({
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
        resolveExternalInvocable,
        adapterHost: createDesktopAdapterHost(
          {
            capabilityStore,
            capabilityCredentials,
            capabilitiesPath,
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
      });
    },
  });
  missionRunnerRef.current = missionRunner;
  const localHostMissionControlAdapter = missionRunner.createLocalHostMissionControlAdapter();
  const localHostRunExecutorResolver = createDesktopLocalHostExecutorResolver({
    executors: missionExecutors,
    project: pragmaProjectStore,
  });
  const localHostRunExecutor: LocalHostRunExecutorPort = {
    resolve: localHostRunExecutorResolver,
    assertStartAllowed: async (input) => await missionRunner.assertLocalHostRunAllowed(input),
    start: async (input) => await missionRunner.startLocalHostRun(input),
  };
  const memoryCurator = createDesktopMemoryCurator({
    profiles: memoryPlane.extractorProfiles,
    missions: missionStore,
    runner: missionRunner,
    project: pragmaProjectStore,
    runtimes,
    workspace: initialSettings.defaultWorkspace,
    pragmaHome: pragmaPaths.root,
    loggerProvider,
  });
  memoryCuratorRef.current = memoryCurator;
  storeRevisionAgentRef.current = createDesktopStoreRevisionAgent({
    missions: missionStore,
    runner: missionRunner,
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
    revisionProfiles: storeRevisions,
    missions: missionStore,
    runner: missionRunner,
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
      runner: missionRunner,
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
    runner: missionRunner,
    project: pragmaProjectStore,
  });
  await Promise.all([
    memoryPlane.setKnowledgePlanner(memoryRevisionPlanners.knowledge),
    memoryPlane.setSkillPlanner(memoryRevisionPlanners.skill),
  ]);
  const unsubscribeTokenCounter = tokenCounter.subscribe(() => {
    void missionRunner.invalidateEstimatedContextWindows().catch((error: unknown) => {
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
    runner: missionRunner,
    loggerProvider,
    onStorageTrashed: () => trashMaintenance.schedule("automation-storage-trashed"),
  });
  installAutomationHandlers(automationService);
  const pragmaAgentMissions = createDesktopPragmaAgentMissionPort({
    missions: missionStore,
    runner: missionRunner,
    creator: missionCreator,
    stateRoot: defaultAgentStateRoot,
  });
  pragmaManagementPortsRef.current = {
    project: pragmaAgentProject,
    missions: pragmaAgentMissions,
    skillRevisions: pragmaManagementSkillRevisions,
    automations: createDesktopPragmaAgentAutomationPort({
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
    runner: missionRunner,
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
  const localHost = createLocalHostNodeApplication({
    pragmaHome: pragmaPaths.root,
    runtimes,
    client: {
      surface: "desktop",
      version: "desktop",
      instanceId: randomUUID(),
    },
    workspace: createWorkspaceFilesystemPort(),
    application: {
      catalog: {
        listProjects: async () => [{ id: pragmaProjectStore.projectId }],
        getProjectRevision: async (projectId, revision) =>
          projectId === pragmaProjectStore.projectId
            ? await pragmaProjectStore.openRevision(revision)
            : undefined,
        listExecutors: async () => await missionExecutors.list(),
      },
      missions: {
        get: async (missionId) => await missionReadModel.get(missionId),
        list: async () => await missionReadModel.list(),
        query: missionQuery.queryMission,
      },
      missionLifecycle,
      missionControlAdapter: localHostMissionControlAdapter,
      assertMission: async (missionId) => {
        await missionStore.get(missionId);
      },
      onOwnerStartError: ({ missionId, error }) =>
        mainLogger.warn(
          "mission.controller_owner_start_failed",
          "Mission command is durable, but its owner could not be started yet.",
          { missionId, error },
        ),
      board: {
        list: async ({ missionId, storeId, scopeId }) =>
          await missionContextStoreBrowser.list({ missionId, storeId, scopeId }),
        read: async ({ missionId, storeId, scopeId, id, start, maxBytes }) =>
          await missionContextStoreBrowser.read({
            missionId,
            storeId,
            scopeId,
            id,
            start,
            maxBytes,
          }),
        search: async ({
          missionId,
          storeId,
          scopeId,
          query,
          maxResults,
          contextLines,
          caseSensitive,
        }) =>
          await missionContextStoreBrowser.search({
            missionId,
            storeId,
            scopeId,
            query,
            maxResults,
            contextLines,
            caseSensitive: caseSensitive ?? false,
          }),
      },
      queue: {
        list: async (missionId) => {
          if (missionRunner.listPromptQueue === undefined) {
            throw new Error("Desktop ExpertSession prompt queue projection is unavailable.");
          }
          return await missionRunner.listPromptQueue(missionId);
        },
      },
      watch: missionWatch,
      runExecutor: localHostRunExecutor,
    },
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
      MissionSchema.parse(await localHost.getMission(missionId)),
    listMissions: async () => MissionSummarySchema.array().parse(await localHost.listMissions()),
    listExecutors: async () =>
      MissionExecutorOptionSchema.array().parse(await localHost.listExecutors()),
    missionControl: localHost.missionControl,
    run: localHost.run,
  };
  installMissionHandlers({
    homeProjects: createHomeProjectStore(join(pragmaPaths.dataRoot(), "home-projects.json")),
    localHost: desktopLocalHost,
    missions: missionStore,
    creator: missionCreator,
    executors: missionExecutors,
    homeExecutors,
    project: pragmaProjectStore,
    systemExperts,
    getWindow: options.getWindow,
    runner: missionRunner,
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
  installMemoryPolicyHandlers(memoryPlane, {
    missions: missionStore,
    project: pragmaProjectStore,
    systemExperts,
    curator: memoryCurator,
    getWindow: options.getWindow,
    onGlobalPolicyUpdated: () => missionRunner.refreshMemoryContextBindings(),
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
    isProviderReferenced: async (providerId) =>
      (await pragmaProjectStore.get()).resources.some(
        (resource) =>
          resource.kind === "RuntimeProfile" &&
          (resource.spec.config as Record<string, unknown>).providerId === providerId,
      ),
  });
  let backgroundTasksStarted = false;
  return {
    startBackgroundTasks() {
      if (backgroundTasksStarted) return;
      backgroundTasksStarted = true;
      trashMaintenance.schedule("startup");
      coreAssetSync.schedule("startup");
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
      void missionRunner.reconcileUsage().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.usage_reconciliation_failed",
          "Desktop usage reconciliation could not be completed.",
          { error },
        );
      });
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
    dispose: () => {
      evaluationService.dispose();
      unsubscribeUsageUpdates();
      unsubscribeTokenCounter();
      automationService.stop();
      void memoryPlane.stop().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.memory_shutdown_failed",
          "The Memory pipeline could not be stopped cleanly.",
          { error },
        );
      });
      storageCapacityGuard.close();
      tokenCounter.dispose();
      void mcpToolRegistryPool.close().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.mcp_pool_close_failed",
          "Desktop MCP connections could not be closed cleanly.",
          { error },
        );
      });
      usageStore.close();
    },
  };
}
