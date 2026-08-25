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
  EVALUATION_JUDGE_EXPERT_REF,
  SKILL_EVALUATION_EXPERT_REF,
  SKILL_REVISION_EXPERT_REF,
  STORE_REVISION_EXPERT_REF,
  STORE_REVISION_TARGET_CONTEXT_REF,
  compileBuiltInAgent,
  builtInAgentFingerprint,
  createPragmaAgentTools,
} from "@pragma/built-in-agents";
import { MEMORY_CURATOR_REF } from "@pragma/memory";
import {
  createLocalHostApplication,
  createMissionControllerStore,
  createNativeOsKeychain,
  createSecretStore,
} from "@pragma/local-host";
import { createIntegrationError } from "@pragma/shared/integration";
import { isUserFacingMissionOrigin } from "../../shared/contracts/index.ts";

import { installAutomationHandlers } from "../features/automations/automation-ipc.ts";
import { createAutomationService } from "../features/automations/automation-service.ts";
import { createAutomationStore } from "../features/automations/automation-store.ts";
import { installPragmaBundleHandlers } from "../features/bundles/pragma-bundle-ipc.ts";
import { BundleSetupRequiredError } from "../features/bundles/pragma-bundle-errors.ts";
import { createPragmaBundleService } from "../features/bundles/pragma-bundle-service.ts";
import { createCapabilityCredentialStore } from "../features/capabilities/capability-credential-store.ts";
import { installCapabilityHandlers } from "../features/capabilities/capability-ipc.ts";
import { createCapabilityRevisionCoordinator } from "../features/capabilities/capability-revision-coordinator.ts";
import { createCapabilityStore } from "../features/capabilities/capability-store.ts";
import {
  createDesktopSkillAgents,
  createSkillEvaluationProfileStore,
  type DesktopSkillAgents,
} from "../features/capabilities/skill-agents.ts";
import {
  createSkillRevisionService,
  type SkillRevisionEvaluator,
  type SkillRevisionGenerator,
} from "../features/capabilities/skill-revision-service.ts";
import { installSkillLearningHandlers } from "../features/capabilities/skill-learning-ipc.ts";
import { createCapabilityVerifier } from "../features/capabilities/capability-verifier.ts";
import { installContextStoreHandlers } from "../features/context-stores/context-store-ipc.ts";
import {
  createContextStoreRevisionService,
  type ContextStoreRevisionGenerator,
  type ContextStoreRevisionService,
} from "../features/context-stores/context-store-revision-service.ts";
import { createContextStoreStore } from "../features/context-stores/context-store-store.ts";
import {
  createDesktopStoreRevisionAgent,
  type DesktopStoreRevisionAgent,
} from "../features/context-stores/store-revision-agent.ts";
import { createDesktopPragmaAgentAutomationPort } from "../features/built-in-agents/pragma-agent-automation-adapter.ts";
import { createDesktopPragmaAgentProjectPort } from "../features/built-in-agents/pragma-agent-project-adapter.ts";
import { createDesktopPragmaAgentTaskPort } from "../features/built-in-agents/pragma-agent-task-adapter.ts";
import { installExpertDefinitionHandlers } from "../features/experts/expert-definition-ipc.ts";
import { installEvaluationHandlers } from "../features/evaluations/evaluation-ipc.ts";
import {
  createEvaluationMockAdapterRegistry,
  createMissionAgentEvaluationExecutor,
} from "../features/evaluations/evaluation-executor.ts";
import { createEvaluationService } from "../features/evaluations/evaluation-service.ts";
import { createEvaluationStore } from "../features/evaluations/evaluation-store.ts";
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
import { installMissionContextStoreBrowserHandlers } from "../features/missions/mission-context-store-browser-ipc.ts";
import { createMissionContextStoreBrowserService } from "../features/missions/mission-context-store-browser.ts";
import {
  createDesktopAdapterHost,
  createMissionRunner,
} from "../features/missions/mission-runner.ts";
import { createMissionStore } from "../features/missions/mission-store.ts";
import {
  createDesktopMissionCommandConsumer,
  createDesktopMissionController,
  createGuardedMissionStore,
} from "../features/missions/mission-controller-adapter.ts";
import { createDesktopMemoryPlane } from "../features/memory/desktop-memory-plane.ts";
import {
  createDesktopMemoryCurator,
  type DesktopMemoryCurator,
} from "../features/memory/memory-curator.ts";
import { installExpertMemoryContextStoreBrowserHandlers } from "../features/memory/expert-memory-context-store-browser-ipc.ts";
import { createExpertMemoryContextStoreBrowserService } from "../features/memory/expert-memory-context-store-browser.ts";
import { installTeamMemoryContextStoreBrowserHandlers } from "../features/memory/team-memory-context-store-browser-ipc.ts";
import { createTeamMemoryContextStoreBrowserService } from "../features/memory/team-memory-context-store-browser.ts";
import { installMemoryPolicyHandlers } from "../features/memory/memory-policy-ipc.ts";
import {
  createMemoryKnowledgePromotionService,
  groupMemoryKnowledgeProposalsByExpert,
  type MemoryKnowledgePromotionService,
} from "../features/memory/memory-knowledge-promotion.ts";
import {
  createMemorySkillPromotionService,
  groupMemorySkillCandidatesByExpert,
  type MemorySkillPromotionService,
} from "../features/memory/memory-skill-promotion.ts";
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
    reservedResourceRefs: new Set([
      BUILT_IN_PRAGMA_REF,
      MEMORY_CURATOR_REF,
      STORE_REVISION_EXPERT_REF,
      SKILL_REVISION_EXPERT_REF,
      SKILL_EVALUATION_EXPERT_REF,
      EVALUATION_JUDGE_EXPERT_REF,
      STORE_REVISION_TARGET_CONTEXT_REF,
    ]),
  });
  const workflowLayouts = createWorkflowLayoutStore({ projectsPath });
  installWorkflowLayoutHandlers(workflowLayouts);
  const pluginCredentials = createPluginCredentialStore({
    configPath: join(pragmaPaths.credentialsRoot(), "plugin-credentials.json"),
    secretStore,
    legacyDecryptor: legacyCredentialDecryptor,
  });
  const missionStore = createMissionStore({
    missionsPath,
    onReadIssue: ({ missionId, error }) =>
      mainLogger.warn(
        "mission.list_entry_unavailable",
        "A Mission could not be listed safely. Other readable Missions remain available.",
        { missionId, errorCode: error.code, error },
      ),
  });
  // Local Host owns aggregate lease persistence; Desktop Main composes it with
  // the existing MissionStore without moving Electron or Runtime concerns into
  // @pragma/local-host.
  const desktopMissionController = createDesktopMissionController({
    controller: createMissionControllerStore({ missionsPath }),
    onLeaseLost: async (missionId) => {
      await missionRunner.stopLocalController(missionId);
      mainLogger.warn(
        "mission.controller_lease_lost",
        "Mission controller lease was lost; local execution was stopped and subsequent semantic writes are fenced.",
        { missionId },
      );
    },
  });
  const guardedMissionStore = createGuardedMissionStore(missionStore, desktopMissionController);
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
    factories: createBuiltInRuntimeFactories({
      modelProviders: modelProviderStore,
      modelCatalogCacheRoot: pragmaPaths.cacheRoot(),
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
  const knowledgePromotionRef: { current?: MemoryKnowledgePromotionService } = {};
  const skillPromotionRef: { current?: MemorySkillPromotionService } = {};
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
      await knowledgePromotionRef.current?.clearExpertBinding(expertRef);
      await skillPromotionRef.current?.clearExpertBinding(expertRef);
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
    onRemoved: async (capabilityId) => {
      await skillPromotionRef.current?.clearCapabilityBinding(capabilityId);
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
  const evaluationStore = createEvaluationStore(join(pragmaPaths.stateRoot(), "evaluations"));
  const evaluationMocks = createEvaluationMockAdapterRegistry(capabilityStore);
  installCapabilityHandlers(capabilityStore, options.getWindow);
  const storeRevisionsRef: { current?: ContextStoreRevisionService } = {};
  const contextStores = createContextStoreStore({
    storesPath: contextStoresPath,
    trashItem: options.trashItem,
    isReferenced: async (storeId) => {
      const definitions = await Promise.all(
        (await expertStore.list()).map((summary) => expertStore.get(summary.ref)),
      );
      return (
        definitions.some((expert) =>
          expert.contextStoreMounts.some((mount) => mount.storeId === storeId),
        ) || (await missionStore.isContextStoreReferenced(storeId))
      );
    },
    onRemoved: async (storeId) => {
      await knowledgePromotionRef.current?.clearStoreBinding(storeId);
    },
    hasActiveRevisions: async (storeId) =>
      (await storeRevisionsRef.current?.hasActiveJobs(storeId)) ?? false,
  });
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
    contextStores,
    generator: revisionGenerator,
    warn: (message, error) =>
      mainLogger.warn("desktop.context_store_revision_processing_failed", message, { error }),
  });
  storeRevisionsRef.current = storeRevisions;
  const skillAgentsRef: { current?: DesktopSkillAgents } = {};
  const skillEvaluationProfiles = createSkillEvaluationProfileStore(
    join(pragmaPaths.stateRoot(), "skill-evaluation", "profile.json"),
  );
  const skillRevisionGenerator: SkillRevisionGenerator = {
    async generate(input) {
      if (skillAgentsRef.current === undefined) {
        throw new Error("skill_revision_agent_unavailable");
      }
      return await skillAgentsRef.current.revisionGenerator.generate(input);
    },
  };
  const skillRevisionEvaluator: SkillRevisionEvaluator = {
    async evaluate(input) {
      if (skillAgentsRef.current === undefined) {
        throw new Error("skill_evaluation_agent_unavailable");
      }
      return await skillAgentsRef.current.revisionEvaluator.evaluate(input);
    },
  };
  const skillRevisions = createSkillRevisionService({
    statePath: join(pragmaPaths.stateRoot(), "skill-revisions"),
    capabilities: capabilityStore,
    generator: skillRevisionGenerator,
    evaluator: skillRevisionEvaluator,
    warn: (message, error) =>
      mainLogger.warn("desktop.skill_revision_processing_failed", message, { error }),
  });
  const knowledgePromotion = createMemoryKnowledgePromotionService({
    statePath: join(pragmaPaths.stateRoot(), "memory-knowledge-promotion"),
    contextStores,
    revisions: storeRevisions,
    expertExists: async (expertRef) =>
      (await expertStore.list()).some((expert) => expert.ref === expertRef),
    mountStore: async (expertRef, storeId) => {
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
    },
  });
  knowledgePromotionRef.current = knowledgePromotion;
  const skillPromotion = createMemorySkillPromotionService({
    statePath: join(pragmaPaths.stateRoot(), "memory-skill-promotion"),
    capabilities: capabilityStore,
    revisions: skillRevisions,
    evaluator: {
      async evaluate(input) {
        if (skillAgentsRef.current === undefined) {
          throw new Error("skill_evaluation_agent_unavailable");
        }
        return await skillAgentsRef.current.evaluateCandidate(input);
      },
    },
    expertExists: async (expertRef) =>
      (await expertStore.list()).some((expert) => expert.ref === expertRef),
    bindSkill: async (expertRef, capabilityId, revision) => {
      const expert = await expertStore.get(expertRef);
      if (
        expert.capabilities.some(
          (capability) => capability.kind === "skill" && capability.capabilityId === capabilityId,
        )
      ) {
        return;
      }
      const capabilities = [
        ...expert.capabilities,
        { kind: "skill" as const, capabilityId, revision },
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
          capabilities,
          toolApprovals: expert.toolApprovals,
          plugins: expert.plugins,
          contextStoreMounts: expert.contextStoreMounts,
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
    },
  });
  skillPromotionRef.current = skillPromotion;
  installSkillLearningHandlers({
    promotion: skillPromotion,
    revisions: skillRevisions,
    evaluationProfiles: skillEvaluationProfiles,
  });
  installContextStoreHandlers(contextStores, options.getWindow, storeRevisions);
  const memoryPlane = await createDesktopMemoryPlane({
    pragmaHome: pragmaPaths.root,
    logger: mainLogger,
    knowledgeLearningSink: {
      async submit(input) {
        const proposalsByExpert = groupMemoryKnowledgeProposalsByExpert(input);
        if (proposalsByExpert.size === 0) throw new Error("knowledge_producer_expert_missing");
        for (const [expertRef, proposals] of proposalsByExpert) {
          await knowledgePromotion.routeLearning({
            expertRefs: [expertRef],
            sourceDigest: input.sourceDigest,
            proposals,
          });
        }
      },
    },
    skillLearningTargetReader: skillPromotion.targetReader,
    skillLearningSink: {
      async submit(input) {
        const candidatesByExpert = groupMemorySkillCandidatesByExpert(input);
        if (candidatesByExpert.size === 0) throw new Error("skill_producer_expert_missing");
        for (const [expertRef, candidates] of candidatesByExpert) {
          await skillPromotion.routeLearning({
            expertRef,
            sourceDigest: input.sourceDigest,
            candidates,
          });
        }
      },
    },
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
  const assertBundleExecutorReady = async (
    ref: string,
    operation: "create_mission" | "run_mission",
  ): Promise<void> => {
    const dependencies = await bundleService.getReadinessForRef(ref);
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
    getDefaultToolPermissionMode: getToolPermissionMode,
    assertExecutorReady: async (ref) => await assertBundleExecutorReady(ref, "create_mission"),
    assertStorageWriteAllowed: async () => await storageCapacityGuard.assertWriteAllowed(),
  });
  installExpertDefinitionHandlers(expertStore, usageStore);
  installPragmaProjectHandlers(pragmaProjectStore, usageStore, contextStores);
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
    capabilities: capabilityStore,
    runtimes,
  });
  const pragmaAgentToolsRef: { current?: ReturnType<typeof createPragmaAgentTools> } = {};
  const memoryCuratorRef: { current?: DesktopMemoryCurator } = {};
  const missionRunner = createMissionRunner({
    missions: guardedMissionStore,
    project: pragmaProjectStore,
    capabilityStore,
    capabilityCredentials,
    capabilitiesPath,
    mcpToolRegistryPool,
    pragmaHome: pragmaPaths.root,
    executionStore: memoryPlane.executionStore,
    contextStores,
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
    missionController: desktopMissionController,
    assertStorageWriteAllowed: async () => await storageCapacityGuard.assertWriteAllowed(),
    onStorageTrashed: () => trashMaintenance.schedule("mission-storage-trashed"),
    onOwnerDeleting: async ({ executionIds }) => {
      await memoryPlane.deleteExecutionState(executionIds);
    },
    onExecutionLinked: async ({ mission, executionId }) => {
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
    onExecutionTerminal: async ({ mission }) => {
      if (!isUserFacingMissionOrigin(mission.origin)) return;
      await memoryPlane.setMemoryConversationState({
        missionId: mission.id,
        state: mission.lifecycleStatus === "completed" ? "completed" : "active",
      });
    },
    getSystemExecutorFingerprint: async (mission) =>
      mission.executor.ref === MEMORY_CURATOR_REF
        ? await memoryCuratorRef.current?.fingerprint()
        : mission.executor.ref === STORE_REVISION_EXPERT_REF
          ? await storeRevisionAgentRef.current?.fingerprint(await storeRevisions.getProfile())
          : mission.executor.ref === SKILL_REVISION_EXPERT_REF
            ? await skillAgentsRef.current?.fingerprint("revision")
            : mission.executor.ref === SKILL_EVALUATION_EXPERT_REF
              ? await skillAgentsRef.current?.fingerprint("evaluation")
              : mission.executor.ref === EVALUATION_JUDGE_EXPERT_REF
                ? builtInAgentFingerprint(EVALUATION_JUDGE_EXPERT_REF)
                : systemExperts.fingerprint(mission.executor.ref),
    assertExecutorReady: async (ref) => await assertBundleExecutorReady(ref, "run_mission"),
    compileSystemExecutor: async ({ mission, runtimes: scopedRuntimes }) => {
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
        if (
          storeRevisionAgentRef.current === undefined ||
          mission.origin.type !== "system-store-revision"
        ) {
          throw new Error("The Store Revision Agent mission is invalid or unavailable.");
        }
        return await storeRevisionAgentRef.current.compile({
          storeId: mission.origin.storeId,
          profile: await storeRevisions.getProfile(),
          runtimes: scopedRuntimes,
        });
      }
      if (mission.executor.ref === SKILL_REVISION_EXPERT_REF) {
        if (
          skillAgentsRef.current === undefined ||
          mission.origin.type !== "system-skill-revision"
        ) {
          throw new Error("The Skill Revision Agent mission is invalid or unavailable.");
        }
        return await skillAgentsRef.current.compile({ kind: "revision", runtimes: scopedRuntimes });
      }
      if (mission.executor.ref === SKILL_EVALUATION_EXPERT_REF) {
        if (
          skillAgentsRef.current === undefined ||
          mission.origin.type !== "system-skill-evaluation"
        ) {
          throw new Error("The Skill Evaluation Agent mission is invalid or unavailable.");
        }
        return await skillAgentsRef.current.compile({
          kind: "evaluation",
          runtimes: scopedRuntimes,
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
      if (pragmaAgentToolsRef.current === undefined) {
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
        tools: pragmaAgentToolsRef.current,
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
  desktopMissionController.setCommandConsumer(
    createDesktopMissionCommandConsumer({
      commands: {
        send: async (input) => {
          const accepted = await missionRunner.sendMessage({
            id: input.missionId,
            content: input.prompt,
            requestId: input.requestId,
            mode: input.mode,
          });
          return {
            missionId: accepted.mission.id,
            ...(accepted.mission.execution === undefined
              ? {}
              : { executionId: accepted.mission.execution.id }),
          };
        },
        respond: async (input) => {
          await missionRunner.respondToHumanInteraction({
            missionId: input.missionId,
            interactionId: input.interactionId,
            requestId: input.requestId,
            response: input.response,
          });
          return { missionId: input.missionId, interactionId: input.interactionId };
        },
        interrupt: async (input) => {
          const mission = await missionRunner.interrupt(input.missionId);
          return { missionId: mission.id };
        },
        removeQueued: async (input) => {
          const mission = await missionRunner.removeQueuedMessage({
            id: input.missionId,
            requestId: input.requestId,
          });
          return { missionId: mission.id };
        },
        resumeQueue: async (input) => {
          const mission = await missionRunner.resumeQueue(input.missionId);
          return { missionId: mission.id };
        },
        steerQueued: async (input) => {
          const mission = await missionRunner.steerQueuedMessage({
            id: input.missionId,
            requestId: input.requestId,
          });
          return { missionId: mission.id };
        },
      },
      validateStrictTarget: async (input) => {
        const current = await missionRunner.getCanonicalStrictTarget(input.missionId);
        if (current === undefined) {
          throw createIntegrationError({
            code: "STEER_TARGET_NOT_ACTIVE",
            category: "conflict",
            message: "Mission has no active Expert or Team turn for strict steer.",
          });
        }
        if (current.executionId !== input.executionId || current.turnId !== input.turnId) {
          throw createIntegrationError({
            code: "STEER_TARGET_CHANGED",
            category: "conflict",
            message: "Strict Mission steer target changed before command apply.",
          });
        }
      },
    }),
  );
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
    profiles: storeRevisions,
    contextStores,
    missions: missionStore,
    runner: missionRunner,
    project: pragmaProjectStore,
    runtimes,
    pragmaHome: pragmaPaths.root,
    loggerProvider,
  });
  skillAgentsRef.current = createDesktopSkillAgents({
    revisionProfiles: storeRevisions,
    evaluationProfiles: skillEvaluationProfiles,
    missions: missionStore,
    runner: missionRunner,
    project: pragmaProjectStore,
    runtimes,
    pragmaHome: pragmaPaths.root,
    loggerProvider,
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
    memoryPlane.setKnowledgeExtractor(memoryCurator.knowledgeExtractor),
    memoryPlane.setSkillExtractor(memoryCurator.skillExtractor),
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
  const pragmaAgentTasks = createDesktopPragmaAgentTaskPort({
    missions: missionStore,
    runner: missionRunner,
    creator: missionCreator,
    stateRoot: defaultAgentStateRoot,
  });
  pragmaAgentToolsRef.current = createPragmaAgentTools({
    project: pragmaAgentProject,
    tasks: pragmaAgentTasks,
    automations: createDesktopPragmaAgentAutomationPort({
      service: automationService,
      project: pragmaProjectStore,
      stateRoot: defaultAgentStateRoot,
    }),
  });
  const missionContextStoreBrowser = createMissionContextStoreBrowserService({
    missions: missionStore,
    project: pragmaProjectStore,
    systemExperts,
    memory: memoryPlane,
    runner: missionRunner,
  });
  const localHost = createLocalHostApplication({
    integrationCapability: async () => ({
      schemaVersion: "pragma.integration-capability/v1",
      protocol: "pragma.integration/v1",
      readableVersions: ["pragma.integration/v1"],
      migratableFromVersions: [],
      features: ["catalog.query", "mission.query", "workspace.resolve", "board.shared.read"],
    }),
    catalog: {
      listProjects: async () => [{ id: pragmaProjectStore.projectId }],
      getProjectRevision: async (projectId, revision) =>
        projectId === pragmaProjectStore.projectId
          ? await pragmaProjectStore.openRevision(revision)
          : undefined,
      listExecutors: async () => await missionExecutors.list(),
    },
    missions: {
      get: async (missionId) => await missionStore.get(missionId),
      list: async () => await missionStore.list(),
    },
    workspace: createWorkspaceFilesystemPort(),
    board: {
      list: async (input) => await missionContextStoreBrowser.list(input),
      read: async (input) => await missionContextStoreBrowser.read(input),
      search: async (input) => await missionContextStoreBrowser.search(input),
    },
    runtime: { resolver: runtimes },
  });
  installMissionHandlers({
    localHost,
    missions: missionStore,
    creator: missionCreator,
    executors: missionExecutors,
    homeExecutors,
    project: pragmaProjectStore,
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
    knowledgePromotion,
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
      void knowledgePromotion.recover().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.memory_knowledge_promotion_recovery_failed",
          "An interrupted Memory knowledge-store initialization could not be recovered.",
          { error },
        );
      });
      void skillPromotion.recover().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.memory_skill_promotion_recovery_failed",
          "An interrupted Memory Skill initialization could not be recovered.",
          { error },
        );
      });
      void storeRevisionAgentRef.current?.recoverOrphans().catch((error: unknown) => {
        mainLogger.warn(
          "desktop.context_store_revision_orphan_cleanup_failed",
          "Orphaned Store Revision Agent Missions could not be cleaned up.",
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
