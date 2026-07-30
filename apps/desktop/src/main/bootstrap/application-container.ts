import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { BrowserWindow } from "electron";
import {
  createRuntimeTokenCounter,
  createStorageCapacityGuard,
  PragmaPaths,
  runStorageMaintenance,
  type PragmaLogger,
  type PragmaLoggerProvider,
} from "@pragma/core";
import {
  BUILT_IN_PRAGMA_REF,
  compileBuiltInDefaultAgent,
  createDefaultAgentTools,
} from "@pragma/default-agent";

import { installAutomationHandlers } from "../features/automations/automation-ipc.ts";
import { createAutomationService } from "../features/automations/automation-service.ts";
import { createAutomationStore } from "../features/automations/automation-store.ts";
import { createCapabilityCredentialStore } from "../features/capabilities/capability-credential-store.ts";
import { installCapabilityHandlers } from "../features/capabilities/capability-ipc.ts";
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
import { createDesktopUsageStore } from "../features/usage/usage-store.ts";
import { validateWorkspace } from "../features/workspaces/workspace-scope.ts";
import type { CredentialEncryption } from "../platform/security/credential-encryption.ts";
import { runPersistentStateUpgradeCoordinator } from "../platform/storage/persistent-state-upgrade-coordinator.ts";
import { initializeDesktopStorage } from "../platform/storage/storage-bootstrap.ts";

export interface DesktopApplicationContainer {
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
  const maintenance = await runStorageMaintenance({ paths: pragmaPaths });
  const tokenCounter = createRuntimeTokenCounter({ logger: mainLogger });
  const storageCapacityGuard = createStorageCapacityGuard({
    paths: pragmaPaths,
    initialOverview: maintenance.after,
  });
  if (maintenance.before.totalBytes >= maintenance.before.softLimitBytes) {
    mainLogger.warn(
      "desktop.storage_pressure_gc",
      `Pragma storage pressure GC reclaimed ${maintenance.before.totalBytes - maintenance.after.totalBytes} bytes.`,
    );
  }
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
  installWorkflowLayoutHandlers(
    createWorkflowLayoutStore({
      projectsPath,
    }),
  );
  const pluginCredentials = createPluginCredentialStore({
    configPath: join(pragmaPaths.credentialsRoot(), "plugin-credentials.json"),
    encryption,
  });
  const missionStore = createMissionStore({
    missionsPath,
  });
  const usageStore = await createDesktopUsageStore({
    databasePath: join(pragmaPaths.dataRoot(), "usage", "usage.sqlite"),
  });
  const unsubscribeUsageUpdates = installUsageHandlers(usageStore, options.getWindow);
  await runPersistentStateUpgradeCoordinator({
    project: pragmaProjectStore,
    missions: missionStore,
    logger: mainLogger,
  });
  const modelProviderStore = createModelProviderStore({
    configPath: modelProvidersPath,
    encryption,
  });
  const runtimeEnvironments = createRuntimeEnvironmentStore({
    pragmaHome: pragmaPaths.root,
  });
  await runtimeEnvironments.initialize();
  const runtimes = createRuntimeEnvironmentService({
    store: runtimeEnvironments,
    logger: mainLogger,
    getToolPermissionMode,
    factories: createBuiltInRuntimeFactories(
      modelProviderStore,
      getToolPermissionMode,
      (runtimeId) => {
        options.sendRuntimeModelCatalogUpdate(runtimeId);
      },
      tokenCounter,
    ),
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
  const missionCreator = createMissionCreator({
    missions: missionStore,
    project: pragmaProjectStore,
    executors: missionExecutors,
    getDefaultToolPermissionMode: getToolPermissionMode,
  });
  installRuntimeHandlers(runtimeEnvironments, runtimes);
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
    verify: createCapabilityVerifier(capabilityCredentials),
    isReferenced: async (capabilityId) => {
      const definitions = await Promise.all(
        (await expertStore.list()).map((summary) => expertStore.get(summary.ref)),
      );
      return definitions.some((expert) =>
        expert.capabilities.some((reference) => reference.capabilityId === capabilityId),
      );
    },
  });
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
  installExpertDefinitionHandlers(expertStore);
  installPragmaProjectHandlers(pragmaProjectStore);
  const initialSettings = await desktopSettings.getSnapshot(options.getPreferredSystemLanguages());
  await mkdir(initialSettings.defaultWorkspace, { recursive: true, mode: 0o700 });
  const defaultAgentStateRoot = join(pragmaPaths.stateRoot(), "pragma");
  const defaultAgentProject = createDesktopDefaultAgentProjectPort({
    project: pragmaProjectStore,
    stateRoot: defaultAgentStateRoot,
    capabilities: capabilityStore,
    runtimes,
  });
  const defaultAgentToolsRef: { current?: ReturnType<typeof createDefaultAgentTools> } = {};
  const missionRunner = createMissionRunner({
    missions: missionStore,
    project: pragmaProjectStore,
    capabilityStore,
    capabilityCredentials,
    capabilitiesPath,
    pragmaHome: pragmaPaths.root,
    contextStores,
    plugins: pluginStore,
    runtimes,
    usage: usageStore,
    loggerProvider,
    automaticHumanInteractionHandler,
    runtimesForToolPermissionMode: (mode) => runtimes.forToolPermissionMode(mode),
    automaticHumanInteractionHandlerForToolPermissionMode: (mode) =>
      createAutomaticToolPermissionHandler(() => mode),
    assertStorageWriteAllowed: async () => await storageCapacityGuard.assertWriteAllowed(),
    getSystemExecutorFingerprint: (mission) => systemExperts.fingerprint(mission.executor.ref),
    compileSystemExecutor: async ({ mission, runtimes: scopedRuntimes }) => {
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
  const unsubscribeTokenCounter = tokenCounter.subscribe(() => {
    void missionRunner.invalidateEstimatedContextWindows().catch((error: unknown) => {
      mainLogger.warn(
        "desktop.tokenizer_context_refresh_failed",
        "Mission context windows could not be refreshed after a tokenizer update.",
        { error },
      );
    });
  });
  await missionRunner.reconcileUsage().catch((error: unknown) => {
    mainLogger.warn(
      "desktop.usage_reconciliation_failed",
      "Desktop usage reconciliation could not be completed.",
      { error },
    );
  });
  const automationService = createAutomationService({
    paths: pragmaPaths,
    project: pragmaProjectStore,
    store: createAutomationStore(pragmaPaths, pragmaProjectStore.projectId),
    missions: missionStore,
    creator: missionCreator,
    runner: missionRunner,
    loggerProvider,
  });
  installAutomationHandlers(automationService);
  await automationService.start();
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
  installModelProviderHandlers(modelProviderStore, {
    isProviderReferenced: async (providerId) =>
      (await pragmaProjectStore.get()).resources.some(
        (resource) =>
          resource.kind === "RuntimeProfile" &&
          (resource.spec.config as Record<string, unknown>).providerId === providerId,
      ),
  });
  void tokenCounter.load();
  return {
    dispose: () => {
      unsubscribeUsageUpdates();
      unsubscribeTokenCounter();
      automationService.stop();
      storageCapacityGuard.close();
      tokenCounter.dispose();
      usageStore.close();
    },
  };
}
