import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  DesktopBridgeSnapshotSchema,
  DesktopMutationError,
  DesktopMutationResultSchema,
  DesktopSettingsSnapshotSchema,
  CapabilityActionSchema,
  CapabilityDeleteResultSchema,
  CapabilityIdSchema,
  CapabilitySchema,
  CapabilityTestRequestSchema,
  CapabilityTestResultSchema,
  CreateCapabilitySchema,
  DesktopRuntimeAvailabilitySchema,
  SetDefaultRuntimeSchema,
  DeleteWorkflowLayoutSchema,
  ContextStoreSchema,
  ContextStoreContentSchema,
  ContextStoreEntrySchema,
  ContextStoreImportInspectionSchema,
  CreateContextStoreFileSchema,
  CreateContextStoreFolderSchema,
  CreateExpertDefinitionSchema,
  CreateContextStoreSchema,
  DeleteContextStoreEntrySchema,
  DeleteContextStoreSchema,
  GetContextStoreContentSchema,
  InspectContextStoreImportSchema,
  GetSkillDocumentSchema,
  ListContextStoreEntriesSchema,
  RenameContextStoreEntrySchema,
  SubscribeContextStoreChangesSchema,
  UpdateContextStoreFileSchema,
  DeleteExpertDefinitionSchema,
  DesktopPluginRefSchema,
  DesktopPluginSchema,
  ExpertDefinitionSchema,
  ExpertRefSchema,
  ExpertSummarySchema,
  GetWorkflowLayoutSchema,
  ImportSkillCapabilitySchema,
  ImportPluginZipSchema,
  InspectPluginZipSchema,
  PreviewCodeServiceRequestSchema,
  PreviewCodeServiceResultSchema,
  PluginActionSchema,
  PluginZipInspectionSchema,
  CreateModelProviderSchema,
  DeleteModelProviderSchema,
  DiscoverProviderModelsSchema,
  ModelDiscoveryResultSchema,
  ModelConnectionTestRequestSchema,
  ModelConnectionTestResultSchema,
  ModelCompatibilityProfileDescriptorSchema,
  ModelProviderSchema,
  ModelProviderSettingsSnapshotSchema,
  ResetModelProvidersResultSchema,
  ResetBuiltInExpertDefinitionSchema,
  CreateMissionSchema,
  DesktopRuntimeIdSchema,
  GetMissionChatSchema,
  GetMissionWorkConversationSchema,
  MissionActionSchema,
  MissionChatSnapshotSchema,
  MissionChatUpdateSchema,
  MissionContextWindowStateSchema,
  MissionCreationDefaultsSchema,
  MissionExecutorOptionSchema,
  MissionModelOptionsRequestSchema,
  MissionModelOptionsSchema,
  MissionIdSchema,
  MissionSchema,
  MissionSummarySchema,
  MissionUpdateSchema,
  MissionHumanInteractionSchema,
  MissionWorkConversationSnapshotSchema,
  MissionWorkSnapshotSchema,
  MissionWorkUpdateSchema,
  PickWorkspaceResultSchema,
  RespondMissionHumanInteractionSchema,
  SendMissionMessageSchema,
  SkillDocumentSchema,
  SetPluginSecretsSchema,
  DeletePragmaResourceSchema,
  AllocatePragmaResourceIdResultSchema,
  PragmaProjectChangesSchema,
  PragmaProjectChangesValidationResultSchema,
  PragmaProjectSnapshotSchema,
  PragmaYamlValidationResultSchema,
  PublishPragmaProjectSchema,
  UpsertPragmaResourceSchema,
  ValidatePragmaYamlSchema,
  UpdateModelProviderSchema,
  UpdateMissionOptionsSchema,
  UpdateExpertDefinitionSchema,
  UpdateBuiltInExpertDefinitionSchema,
  UpdatePluginDefaultsSchema,
  UpdateCapabilitySchema,
  UpdateDesktopSettingsSchema,
  ValidateWorkspacePathSchema,
  ValidateWorkspaceResultSchema,
  ValidatePragmaResourceSchema,
  WorkflowLayoutSchema,
  AutomationActionSchema,
  AutomationAdapterOptionSchema,
  AutomationSchedulePreviewSchema,
  AutomationSummarySchema,
  DeleteAutomationSchema,
  PreviewAutomationScheduleSchema,
  SaveAutomationSchema,
  type PragmaDesktopAPI,
  DesktopRendererLogSchema,
} from "../shared/desktop-api.ts";

async function invokeMutation(channel: string, ...args: readonly unknown[]): Promise<unknown> {
  const result = DesktopMutationResultSchema.parse(await ipcRenderer.invoke(channel, ...args));
  if (!result.ok) throw new DesktopMutationError(result.error);
  return result.value;
}

const api: PragmaDesktopAPI = {
  reportRendererLog: (input) => {
    const record = DesktopRendererLogSchema.safeParse(input);
    if (record.success) ipcRenderer.send("logs:renderer", record.data);
  },
  getBridgeSnapshot: async () =>
    DesktopBridgeSnapshotSchema.parse(await ipcRenderer.invoke("bridge:snapshot")),
  getDesktopSettings: async () =>
    DesktopSettingsSnapshotSchema.parse(await ipcRenderer.invoke("desktop-settings:get")),
  updateDesktopSettings: async (input) =>
    DesktopSettingsSnapshotSchema.parse(
      await ipcRenderer.invoke("desktop-settings:update", UpdateDesktopSettingsSchema.parse(input)),
    ),
  pickWorkspace: async () =>
    PickWorkspaceResultSchema.parse(await ipcRenderer.invoke("workspace:pick")),
  validateWorkspace: async (path: string) =>
    ValidateWorkspaceResultSchema.parse(
      await ipcRenderer.invoke("workspace:validate", ValidateWorkspacePathSchema.parse(path)),
    ),
  getModelProviderSettings: async () =>
    ModelProviderSettingsSnapshotSchema.parse(await ipcRenderer.invoke("model-providers:settings")),
  listModelCompatibilityProfiles: async () =>
    ModelCompatibilityProfileDescriptorSchema.array().parse(
      await ipcRenderer.invoke("model-providers:compatibility-profiles"),
    ),
  listModelProviders: async () =>
    ModelProviderSchema.array().parse(await ipcRenderer.invoke("model-providers:list")),
  createModelProvider: async (input) =>
    ModelProviderSchema.parse(
      await ipcRenderer.invoke("model-providers:create", CreateModelProviderSchema.parse(input)),
    ),
  updateModelProvider: async (input) =>
    ModelProviderSchema.parse(
      await ipcRenderer.invoke("model-providers:update", UpdateModelProviderSchema.parse(input)),
    ),
  deleteModelProvider: async (input) => {
    await ipcRenderer.invoke("model-providers:delete", DeleteModelProviderSchema.parse(input));
  },
  discoverProviderModels: async (input) =>
    ModelDiscoveryResultSchema.parse(
      await ipcRenderer.invoke(
        "model-providers:discover",
        DiscoverProviderModelsSchema.parse(input),
      ),
    ),
  testModelConnection: async (input) =>
    ModelConnectionTestResultSchema.parse(
      await ipcRenderer.invoke(
        "model-providers:test",
        ModelConnectionTestRequestSchema.parse(input),
      ),
    ),
  resetModelProviders: async () =>
    ResetModelProvidersResultSchema.parse(await ipcRenderer.invoke("model-providers:reset")),
  listContextStores: async () =>
    ContextStoreSchema.array().parse(await ipcRenderer.invoke("context-stores:list")),
  createContextStore: async (input) =>
    ContextStoreSchema.parse(
      await ipcRenderer.invoke("context-stores:create", CreateContextStoreSchema.parse(input)),
    ),
  inspectContextStoreImport: async (input) =>
    ContextStoreImportInspectionSchema.parse(
      await ipcRenderer.invoke(
        "context-stores:inspect-import",
        InspectContextStoreImportSchema.parse(input),
      ),
    ),
  deleteContextStore: async (input) => {
    await ipcRenderer.invoke("context-stores:delete", DeleteContextStoreSchema.parse(input));
  },
  getContextStoreContent: async (input) =>
    ContextStoreContentSchema.parse(
      await ipcRenderer.invoke(
        "context-stores:get-content",
        GetContextStoreContentSchema.parse(input),
      ),
    ),
  listContextStoreEntries: async (input) =>
    ContextStoreEntrySchema.array().parse(
      await ipcRenderer.invoke(
        "context-stores:list-entries",
        ListContextStoreEntriesSchema.parse(input),
      ),
    ),
  createContextStoreFolder: async (input) => {
    await ipcRenderer.invoke(
      "context-stores:create-folder",
      CreateContextStoreFolderSchema.parse(input),
    );
  },
  createContextStoreFile: async (input) =>
    ContextStoreContentSchema.parse(
      await ipcRenderer.invoke(
        "context-stores:create-file",
        CreateContextStoreFileSchema.parse(input),
      ),
    ),
  updateContextStoreFile: async (input) =>
    ContextStoreContentSchema.parse(
      await ipcRenderer.invoke(
        "context-stores:update-file",
        UpdateContextStoreFileSchema.parse(input),
      ),
    ),
  renameContextStoreEntry: async (input) => {
    await ipcRenderer.invoke(
      "context-stores:rename-entry",
      RenameContextStoreEntrySchema.parse(input),
    );
  },
  deleteContextStoreEntry: async (input) => {
    await ipcRenderer.invoke(
      "context-stores:delete-entry",
      DeleteContextStoreEntrySchema.parse(input),
    );
  },
  subscribeContextStoreChanges: (storeId, listener) => {
    const input = SubscribeContextStoreChangesSchema.parse({ storeId });
    const handler = (_event: IpcRendererEvent, payload: unknown) => {
      const changed = SubscribeContextStoreChangesSchema.parse(payload);
      if (changed.storeId === storeId) listener();
    };
    ipcRenderer.on("context-stores:changed", handler);
    ipcRenderer.send("context-stores:watch", input);
    return () => {
      ipcRenderer.removeListener("context-stores:changed", handler);
      ipcRenderer.send("context-stores:unwatch", input);
    };
  },
  pickContextStoreFolder: async () =>
    PickWorkspaceResultSchema.parse(await ipcRenderer.invoke("context-stores:pick-folder")),
  listExperts: async () =>
    ExpertSummarySchema.array().parse(await ipcRenderer.invoke("experts:list")),
  getExpert: async (ref) =>
    ExpertDefinitionSchema.parse(
      await ipcRenderer.invoke("experts:get", ExpertRefSchema.parse(ref)),
    ),
  createExpert: async (input) =>
    ExpertDefinitionSchema.parse(
      await invokeMutation("experts:create", CreateExpertDefinitionSchema.parse(input)),
    ),
  updateExpert: async (ref, input) =>
    ExpertDefinitionSchema.parse(
      await invokeMutation(
        "experts:update",
        ExpertRefSchema.parse(ref),
        UpdateExpertDefinitionSchema.parse(input),
      ),
    ),
  updateBuiltInExpert: async (ref, input) =>
    ExpertDefinitionSchema.parse(
      await invokeMutation(
        "experts:update-built-in",
        ExpertRefSchema.parse(ref),
        UpdateBuiltInExpertDefinitionSchema.parse(input),
      ),
    ),
  resetBuiltInExpert: async (ref) =>
    ExpertDefinitionSchema.parse(
      await invokeMutation(
        "experts:reset-built-in",
        ResetBuiltInExpertDefinitionSchema.parse({ ref }),
      ),
    ),
  deleteExpert: async (ref) => {
    await invokeMutation("experts:delete", DeleteExpertDefinitionSchema.parse({ ref }));
  },
  listPlugins: async () =>
    DesktopPluginSchema.array().parse(await ipcRenderer.invoke("plugins:list")),
  getPlugin: async (ref) =>
    DesktopPluginSchema.parse(
      await ipcRenderer.invoke("plugins:get", DesktopPluginRefSchema.parse(ref)),
    ),
  pickPluginZip: async () =>
    PickWorkspaceResultSchema.parse(await ipcRenderer.invoke("plugins:pick-zip")),
  inspectPluginZip: async (sourcePath) =>
    PluginZipInspectionSchema.parse(
      await ipcRenderer.invoke("plugins:inspect", InspectPluginZipSchema.parse({ sourcePath })),
    ),
  importPluginZip: async (input) =>
    DesktopPluginSchema.parse(
      await ipcRenderer.invoke("plugins:import", ImportPluginZipSchema.parse(input)),
    ),
  updatePluginDefaults: async (input) =>
    DesktopPluginSchema.parse(
      await ipcRenderer.invoke("plugins:update-defaults", UpdatePluginDefaultsSchema.parse(input)),
    ),
  setPluginSecrets: async (secrets) => {
    await ipcRenderer.invoke("plugins:set-secrets", SetPluginSecretsSchema.parse({ secrets }));
  },
  deletePlugin: async (ref) => {
    await ipcRenderer.invoke("plugins:delete", PluginActionSchema.parse({ ref }));
  },
  getPragmaProject: async () =>
    PragmaProjectSnapshotSchema.parse(await ipcRenderer.invoke("pragma-project:get")),
  allocatePragmaResourceId: async () =>
    AllocatePragmaResourceIdResultSchema.parse(
      await ipcRenderer.invoke("pragma-project:allocate-id"),
    ),
  publishPragmaProject: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await invokeMutation("pragma-project:publish", PublishPragmaProjectSchema.parse(input)),
    ),
  upsertPragmaResource: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await invokeMutation("pragma-project:upsert", UpsertPragmaResourceSchema.parse(input)),
    ),
  applyPragmaProjectChanges: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await invokeMutation("pragma-project:apply-changes", PragmaProjectChangesSchema.parse(input)),
    ),
  deletePragmaResource: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await invokeMutation("pragma-project:delete", DeletePragmaResourceSchema.parse(input)),
    ),
  validatePragmaYaml: async (source) =>
    PragmaYamlValidationResultSchema.parse(
      await ipcRenderer.invoke(
        "pragma-project:validate-yaml",
        ValidatePragmaYamlSchema.parse({ source }),
      ),
    ),
  validatePragmaResource: async (input) =>
    PragmaYamlValidationResultSchema.parse(
      await invokeMutation(
        "pragma-project:validate-resource",
        ValidatePragmaResourceSchema.parse(input),
      ),
    ),
  validatePragmaProjectChanges: async (input) =>
    PragmaProjectChangesValidationResultSchema.parse(
      await invokeMutation(
        "pragma-project:validate-changes",
        PragmaProjectChangesSchema.parse(input),
      ),
    ),
  getWorkflowLayout: async (input) => {
    const result: unknown = await ipcRenderer.invoke(
      "workflow-layout:get",
      GetWorkflowLayoutSchema.parse(input),
    );
    return result === null ? null : WorkflowLayoutSchema.parse(result);
  },
  saveWorkflowLayout: async (layout) =>
    WorkflowLayoutSchema.parse(
      await ipcRenderer.invoke("workflow-layout:save", WorkflowLayoutSchema.parse(layout)),
    ),
  deleteWorkflowLayout: async (input) => {
    await ipcRenderer.invoke("workflow-layout:delete", DeleteWorkflowLayoutSchema.parse(input));
  },
  listAutomationAdapters: async () =>
    AutomationAdapterOptionSchema.array().parse(
      await ipcRenderer.invoke("automations:adapters:list"),
    ),
  listAutomations: async () =>
    AutomationSummarySchema.array().parse(await ipcRenderer.invoke("automations:list")),
  saveAutomation: async (input) =>
    AutomationSummarySchema.parse(
      await ipcRenderer.invoke("automations:save", SaveAutomationSchema.parse(input)),
    ),
  deleteAutomation: async (input) => {
    await ipcRenderer.invoke("automations:delete", DeleteAutomationSchema.parse(input));
  },
  resetAutomationSession: async (ref) =>
    AutomationSummarySchema.parse(
      await ipcRenderer.invoke("automations:session:reset", AutomationActionSchema.parse({ ref })),
    ),
  previewAutomationSchedule: async (input) =>
    AutomationSchedulePreviewSchema.parse(
      await ipcRenderer.invoke(
        "automations:schedule:preview",
        PreviewAutomationScheduleSchema.parse(input),
      ),
    ),
  listMissions: async () =>
    MissionSummarySchema.array().parse(await ipcRenderer.invoke("missions:list")),
  listMissionExecutors: async () =>
    MissionExecutorOptionSchema.array().parse(await ipcRenderer.invoke("missions:executors:list")),
  getMissionModelOptions: async (executorRef, missionId) =>
    MissionModelOptionsSchema.parse(
      await ipcRenderer.invoke(
        "missions:model-options:get",
        MissionModelOptionsRequestSchema.parse({
          executorRef,
          ...(missionId === undefined ? {} : { missionId }),
        }),
      ),
    ),
  subscribeRuntimeModelCatalog: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      listener(DesktopRuntimeIdSchema.parse(value));
    };
    ipcRenderer.on("runtimes:model-catalog:updated", handler);
    return () => ipcRenderer.removeListener("runtimes:model-catalog:updated", handler);
  },
  getMissionCreationDefaults: async () =>
    MissionCreationDefaultsSchema.parse(await ipcRenderer.invoke("missions:create-defaults:get")),
  getMission: async (id) =>
    MissionSchema.parse(await ipcRenderer.invoke("missions:get", MissionIdSchema.parse(id))),
  subscribeMissionUpdates: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      listener(MissionUpdateSchema.parse(value));
    };
    ipcRenderer.on("missions:updated", handler);
    return () => ipcRenderer.removeListener("missions:updated", handler);
  },
  createMission: async (input) =>
    MissionSchema.parse(
      await ipcRenderer.invoke("missions:create", CreateMissionSchema.parse(input)),
    ),
  updateMissionOptions: async (input) =>
    MissionSchema.parse(
      await invokeMutation("missions:options:update", UpdateMissionOptionsSchema.parse(input)),
    ),
  runMission: async (id) =>
    MissionSchema.parse(await invokeMutation("missions:run", MissionActionSchema.parse({ id }))),
  sendMissionMessage: async (input) =>
    MissionSchema.parse(
      await invokeMutation("missions:message:send", SendMissionMessageSchema.parse(input)),
    ),
  getMissionChat: async (input) =>
    MissionChatSnapshotSchema.parse(
      await ipcRenderer.invoke("missions:chat:get", GetMissionChatSchema.parse(input)),
    ),
  compactMissionContext: async (id) =>
    MissionContextWindowStateSchema.parse(
      await invokeMutation("missions:context:compact", MissionActionSchema.parse({ id })),
    ),
  subscribeMissionChat: (id, listener) => {
    const missionId = MissionIdSchema.parse(id);
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      const update = MissionChatUpdateSchema.parse(value);
      if (update.missionId === missionId) listener(update);
    };
    ipcRenderer.on("missions:chat:updated", handler);
    return () => ipcRenderer.removeListener("missions:chat:updated", handler);
  },
  interruptMission: async (id) =>
    MissionSchema.parse(
      await invokeMutation("missions:interrupt", MissionActionSchema.parse({ id })),
    ),
  getMissionWork: async (id) =>
    MissionWorkSnapshotSchema.parse(
      await ipcRenderer.invoke("missions:work:get", MissionActionSchema.parse({ id })),
    ),
  getMissionWorkConversation: async (input) =>
    MissionWorkConversationSnapshotSchema.parse(
      await ipcRenderer.invoke(
        "missions:work:conversation:get",
        GetMissionWorkConversationSchema.parse(input),
      ),
    ),
  subscribeMissionWork: (id, listener) => {
    const missionId = MissionIdSchema.parse(id);
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      const update = MissionWorkUpdateSchema.parse(value);
      if (update.missionId === missionId) listener(update);
    };
    ipcRenderer.on("missions:work:updated", handler);
    return () => ipcRenderer.removeListener("missions:work:updated", handler);
  },
  deleteMission: async (id) => {
    await invokeMutation("missions:delete", MissionActionSchema.parse({ id }));
  },
  listMissionHumanInteractions: async (id) =>
    MissionHumanInteractionSchema.array().parse(
      await ipcRenderer.invoke("missions:human:list", MissionActionSchema.parse({ id })),
    ),
  respondToMissionHumanInteraction: async (input) => {
    await invokeMutation(
      "missions:human:respond",
      RespondMissionHumanInteractionSchema.parse(input),
    );
  },
  markMissionComplete: async (id) =>
    MissionSchema.parse(
      await ipcRenderer.invoke("missions:complete", MissionActionSchema.parse({ id })),
    ),
  reopenMission: async (id) =>
    MissionSchema.parse(
      await ipcRenderer.invoke("missions:reopen", MissionActionSchema.parse({ id })),
    ),
  listCapabilities: async () =>
    CapabilitySchema.array().parse(await ipcRenderer.invoke("capabilities:list")),
  getCapability: async (id, revision) =>
    CapabilitySchema.parse(
      await ipcRenderer.invoke("capabilities:get", CapabilityIdSchema.parse(id), revision),
    ),
  getSkillDocument: async (input) =>
    SkillDocumentSchema.parse(
      await ipcRenderer.invoke(
        "capabilities:get-skill-document",
        GetSkillDocumentSchema.parse(input),
      ),
    ),
  importSkillCapability: async (input) =>
    CapabilitySchema.parse(
      await ipcRenderer.invoke(
        "capabilities:import-skill",
        ImportSkillCapabilitySchema.parse(input),
      ),
    ),
  createCapability: async (input) =>
    CapabilitySchema.parse(
      await ipcRenderer.invoke("capabilities:create", CreateCapabilitySchema.parse(input)),
    ),
  updateCapability: async (input) =>
    CapabilitySchema.parse(
      await ipcRenderer.invoke("capabilities:update", UpdateCapabilitySchema.parse(input)),
    ),
  retryCapability: async (id) =>
    CapabilitySchema.parse(
      await ipcRenderer.invoke("capabilities:retry", CapabilityActionSchema.parse({ id })),
    ),
  testCapability: async (input) =>
    CapabilityTestResultSchema.parse(
      await ipcRenderer.invoke("capabilities:test", CapabilityTestRequestSchema.parse(input)),
    ),
  previewCodeService: async (input) =>
    PreviewCodeServiceResultSchema.parse(
      await ipcRenderer.invoke(
        "capabilities:preview-code",
        PreviewCodeServiceRequestSchema.parse(input),
      ),
    ),
  deleteCapability: async (id) =>
    CapabilityDeleteResultSchema.parse(
      await ipcRenderer.invoke("capabilities:delete", CapabilityActionSchema.parse({ id })),
    ),
  pickSkillSource: async () =>
    PickWorkspaceResultSchema.parse(await ipcRenderer.invoke("capabilities:pick-skill")),
  getRuntimeAvailability: async () =>
    DesktopRuntimeAvailabilitySchema.array().parse(
      await ipcRenderer.invoke("runtimes:availability"),
    ),
  setDefaultRuntime: async (input) =>
    DesktopRuntimeAvailabilitySchema.array().parse(
      await ipcRenderer.invoke("runtimes:set-default", SetDefaultRuntimeSchema.parse(input)),
    ),
};

contextBridge.exposeInMainWorld("pragmaDesktop", api);
