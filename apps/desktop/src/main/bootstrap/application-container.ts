import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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
  compileBuiltInDefaultAgent,
  createDefaultAgentTools,
} from "@pragma/default-agent";
import { MEMORY_CURATOR_REF } from "@pragma/memory";

import { installAutomationHandlers } from "../features/automations/automation-ipc.ts";
import { createAutomationService } from "../features/automations/automation-service.ts";
import { createAutomationStore } from "../features/automations/automation-store.ts";
import { installPragmaBundleHandlers } from "../features/bundles/pragma-bundle-ipc.ts";
import { createPragmaBundleService } from "../features/bundles/pragma-bundle-service.ts";
import { createCapabilityCredentialStore } from "../features/capabilities/capability-credential-store.ts";
import { installCapabilityHandlers } from "../features/capabilities/capability-ipc.ts";
import { createCapabilityRevisionCoordinator } from "../features/capabilities/capability-revision-coordinator.ts";
import { createCapabilityStore } from "../features/capabilities/capability-store.ts";
import { createCapabilityVerifier } from "../features/capabilities/capability-verifier.ts";
import { installContextStoreHandlers } from "../features/context-stores/context-store-ipc.ts";
import { createContextStoreStore } from "../features/context-stores/context-store-store.ts";
import { createDesktopDefaultAgentAutomationPort } from "../features/default-agent/default-agent-automation-adapter.ts";
import { createDesktopDefaultAgentProjectPort } from "../features/default-agent/default-agent-project-adapter.ts";
import { createDesktopDefaultAgentTaskPort } from "../features/default-agent/default-agent-task-adapter.ts";
import { installExpertDefinitionHandlers } from "../features/experts/expert-definition-ipc.ts";
import { createExpertDefinitionStore } from "../features/experts/expert-definition-store.ts";
import { createDesktopSystemExpertRegistry } from "../features/experts/system-expert-registry.ts";
import {
  resolveSystemExpertRuntimeDefaults,
  withRuntimeDefaults,
} from "../features/experts/system-expert-runtime.ts";
import { createMissionCreator } from "../features/missions/mission-creator.ts";
import { createHomeExecutorCatalog } from "../features/missions/home-executor-catalog.ts";
import { createHomeExecutorPreferenceStore } from "../features/missions/home-executor-preference-store.ts";
import { createMissionExecutorCatalog } from "../features/missions/mission-executor-catalog.ts";
import { installMissionHandlers } from "../features/missions/mission-ipc.ts";
import {
  createDesktopAdapterHost,
  createMissionRunner,
} from "../features/missions/mission-runner.ts";
import { createMissionStore } from "../features/missions/mission-store.ts";
import { createDesktopMemoryPlane } from "../features/memory/desktop-memory-plane.ts";
import {
  createDesktopMemoryCurator,
  type DesktopMemoryCurator,
} from "../features/memory/memory-curator.ts";
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
import type { CredentialEncryption } from "../platform/security/credential-encryption.ts";
import { initializeDesktopStorage } from "../platform/storage/storage-bootstrap.ts";
import { createDesktopTrashMaintenance } from "../platform/storage/trash-maintenance.ts";

export interface DesktopApplicationContainer {
  readonly startBackgroundTasks: () => void;
  readonly dispose: () => void;
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
  const automaticHumanInteractionHandler =
    createAutomaticToolPermissionHandler(getToolPermissionMode);
  const systemExperts = createDesktopSystemExpertRegistry({
    configPath: join(pragmaPaths.stateRoot(), "system-experts.json"),
    warn: (message, error) => mainLogger.warn("desktop.system_expert_warning", message, { error }),
  });
  await systemExperts.initialize();
  const blueprintCache = createDesktopPragmaBlueprintCacheStore(pragmaPaths);
  const pragmaProjectStore = createPragmaProjectStore({
    projectsPath,
    objectsPath: pragmaPaths.contentObjectsRoot(),
    projectViewsPath: pragmaPaths.projectViewsCacheRoot(),
    storagePaths: pragmaPaths,
    loggerProvider,
    blueprintCache,
    reservedResourceRefs: new Set([BUILT_IN_PRAGMA_REF]),
  });
  const workflowLayouts = createWorkflowLayoutStore({ projectsPath });
  installWorkflowLayoutHandlers(workflowLayouts);
  const pluginCredentials = createPluginCredentialStore({
    configPath: join(pragmaPaths.credentialsRoot(), "plugin-credentials.json"),
    encryption,
  });
  const missionStore = createMissionStore({
    missionsPath,
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
    encryption,
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
    factories: createBuiltInRuntimeFactories({
      modelProviders: modelProviderStore,
      getToolPermissionMode,
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
  installRuntimeHandlers(runtimes);
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
    encryption,
  });
  const capabilityStore = createCapabilityStore({
    capabilitiesPath,
    credentials: capabilityCredentials,
    mcpToolRegistryPool,
    verify: createCapabilityVerifier(capabilityCredentials, mcpToolRegistryPool),
    isReferenced: async (capabilityId) => {
      const definitions = await Promise.all(
        (await expertStore.list()).map((summary) => expertStore.get(summary.ref)),
      );
      return definitions.some((expert) =>
        expert.capabilities.some((reference) => reference.capabilityId === capabilityId),
      );
    },
  });
  const capabilityRevisionCoordinator = createCapabilityRevisionCoordinator({
    journalRoot: join(pragmaPaths.stateRoot(), "capability-revision-propagation"),
    capabilities: capabilityStore,
    project: pragmaProjectStore,
    systemExperts,
    warn: (message, error) =>
      mainLogger.warn("desktop.capability_revision_recovery_failed", message, { error }),
  });
  capabilityStore.setRevisionPublisher(capabilityRevisionCoordinator);
  installCapabilityHandlers(capabilityStore, options.getWindow);
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
  });
  installContextStoreHandlers(contextStores, options.getWindow);
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
  const missionCreator = createMissionCreator({
    missions: missionStore,
    project: pragmaProjectStore,
    executors: missionExecutors,
    getDefaultToolPermissionMode: getToolPermissionMode,
    assertExecutorReady: async (ref) => {
      if (await bundleService.isRefPending(ref)) {
        throw new Error(
          "This imported Expert, Team, or Flow still has unresolved local dependencies. Complete bundle setup before creating a Mission.",
        );
      }
    },
  });
  installExpertDefinitionHandlers(expertStore, usageStore);
  installPragmaProjectHandlers(pragmaProjectStore, usageStore);
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
  const memoryPlane = await createDesktopMemoryPlane({
    pragmaHome: pragmaPaths.root,
    logger: mainLogger,
  });
  const defaultAgentProject = createDesktopDefaultAgentProjectPort({
    project: pragmaProjectStore,
    stateRoot: defaultAgentStateRoot,
    capabilities: capabilityStore,
    runtimes,
  });
  const defaultAgentToolsRef: { current?: ReturnType<typeof createDefaultAgentTools> } = {};
  const memoryCuratorRef: { current?: DesktopMemoryCurator } = {};
  const missionRunner = createMissionRunner({
    missions: missionStore,
    project: pragmaProjectStore,
    capabilityStore,
    capabilityCredentials,
    capabilitiesPath,
    mcpToolRegistryPool,
    pragmaHome: pragmaPaths.root,
    executionStore: memoryPlane.executionStore,
    contextStores,
    hostContextStores: [{ namespace: "memory", store: memoryPlane.contextStore }],
    plugins: pluginStore,
    runtimes,
    usage: usageStore,
    loggerProvider,
    automaticHumanInteractionHandler,
    runtimesForToolPermissionMode: (mode) => runtimes.forToolPermissionMode(mode),
    automaticHumanInteractionHandlerForToolPermissionMode: (mode) =>
      createAutomaticToolPermissionHandler(() => mode),
    assertStorageWriteAllowed: async () => await storageCapacityGuard.assertWriteAllowed(),
    onStorageTrashed: () => trashMaintenance.schedule("mission-storage-trashed"),
    onExecutionLinked: async ({ mission, executionId }) => {
      if (mission.origin.type === "system-memory") return;
      await memoryPlane.registerSemanticExecutionContext({
        executionId,
        projectId: mission.project.id,
      });
    },
    getSystemExecutorFingerprint: async (mission) =>
      mission.executor.ref === MEMORY_CURATOR_REF
        ? await memoryCuratorRef.current?.fingerprint()
        : systemExperts.fingerprint(mission.executor.ref),
    assertExecutorReady: async (ref) => {
      if (await bundleService.isRefPending(ref)) {
        throw new Error(
          "This imported Expert, Team, or Flow still has unresolved local dependencies. Complete bundle setup before running it.",
        );
      }
    },
    compileSystemExecutor: async ({ mission, runtimes: scopedRuntimes }) => {
      if (mission.executor.ref === MEMORY_CURATOR_REF) {
        if (memoryCuratorRef.current === undefined) {
          throw new Error("The Memory Curator has not been initialized.");
        }
        return await memoryCuratorRef.current.compile({
          runtimes: scopedRuntimes,
          workspace: mission.workspace.path,
          pragmaHome: pragmaPaths.root,
          loggerProvider,
        });
      }
      if (mission.executor.ref !== BUILT_IN_PRAGMA_REF) return undefined;
      if (defaultAgentToolsRef.current === undefined) {
        throw new Error("The built-in Pragma tools have not been initialized.");
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
      return await compileBuiltInDefaultAgent({
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
        tools: defaultAgentToolsRef.current,
        blueprintCache,
        ...(definition.customized
          ? { expertResource: systemExperts.getResource(BUILT_IN_PRAGMA_REF) }
          : {}),
        additionalResources: systemExperts.getAdditionalResources(BUILT_IN_PRAGMA_REF),
        adapterHost: createDesktopAdapterHost(
          {
            capabilityStore,
            capabilityCredentials,
            capabilitiesPath,
            mcpToolRegistryPool,
            contextStores,
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
  await Promise.all([
    memoryPlane.setEpisodicExtractor(memoryCurator.episodicExtractor),
    memoryPlane.setSemanticExtractor(memoryCurator.semanticExtractor),
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
  const defaultAgentTasks = createDesktopDefaultAgentTaskPort({
    missions: missionStore,
    runner: missionRunner,
    creator: missionCreator,
    stateRoot: defaultAgentStateRoot,
  });
  defaultAgentToolsRef.current = createDefaultAgentTools({
    project: defaultAgentProject,
    tasks: defaultAgentTasks,
    automations: createDesktopDefaultAgentAutomationPort({
      service: automationService,
      project: pragmaProjectStore,
      stateRoot: defaultAgentStateRoot,
    }),
  });
  installMissionHandlers({
    missions: missionStore,
    creator: missionCreator,
    executors: missionExecutors,
    homeExecutors,
    project: pragmaProjectStore,
    getWindow: options.getWindow,
    runner: missionRunner,
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
  });
  installDesktopSettingsHandlers({
    store: desktopSettings,
    validateDefaultWorkspace: async (path) => {
      const validation = await validateWorkspace(path);
      if (!validation.ok) {
        throw new Error("The default workspace must be an accessible, writable directory.");
      }
    },
  });
  installMemoryPolicyHandlers(memoryPlane);
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
      runtimeProcessEnvironment.warmUp();
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
      void tokenCounter.load().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.tokenizer_warmup_failed",
          "The Runtime token counter could not be warmed up.",
          { error },
        );
      });
      memoryPlane.start();
    },
    dispose: () => {
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
