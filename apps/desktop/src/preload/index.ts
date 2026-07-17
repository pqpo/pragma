import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  DesktopBridgeSnapshotSchema,
  AddContextNoteEntrySchema,
  CapabilityActionSchema,
  CapabilityIdSchema,
  CapabilitySchema,
  CapabilityTestRequestSchema,
  CapabilityTestResultSchema,
  CreateCapabilitySchema,
  DesktopRuntimeAvailabilitySchema,
  DeleteWorkflowLayoutSchema,
  ContextStoreSchema,
  ContextStoreContentSchema,
  ContextStoreContentSummarySchema,
  CreateExpertDefinitionSchema,
  CreateContextStoreSchema,
  GetContextStoreContentSchema,
  ListContextStoreContentsSchema,
  DeleteExpertDefinitionSchema,
  ExpertDefinitionSchema,
  ExpertRefSchema,
  ExpertSummarySchema,
  GetWorkflowLayoutSchema,
  ImportSkillCapabilitySchema,
  PreviewCodeServiceRequestSchema,
  PreviewCodeServiceResultSchema,
  CreateModelProviderSchema,
  DeleteModelProviderSchema,
  ModelConnectionTestRequestSchema,
  ModelConnectionTestResultSchema,
  ModelProviderSchema,
  CreateMissionSchema,
  MissionActionSchema,
  MissionChatSnapshotSchema,
  MissionChatUpdateSchema,
  MissionIdSchema,
  MissionSchema,
  MissionHumanInteractionSchema,
  MissionWorkItemSchema,
  PickWorkspaceResultSchema,
  RespondMissionHumanInteractionSchema,
  SendMissionMessageSchema,
  DeletePragmaResourceSchema,
  PragmaProjectSnapshotSchema,
  PragmaYamlValidationResultSchema,
  PublishPragmaProjectSchema,
  UpsertPragmaResourceSchema,
  ValidatePragmaYamlSchema,
  UpdateModelProviderSchema,
  UpdateExpertDefinitionSchema,
  UpdateCapabilitySchema,
  ValidateWorkspacePathSchema,
  ValidateWorkspaceResultSchema,
  ValidatePragmaResourceSchema,
  WorkflowLayoutSchema,
  type PragmaDesktopAPI,
} from "../shared/desktop-api.ts";

const api: PragmaDesktopAPI = {
  getBridgeSnapshot: async () =>
    DesktopBridgeSnapshotSchema.parse(await ipcRenderer.invoke("bridge:snapshot")),
  pickWorkspace: async () =>
    PickWorkspaceResultSchema.parse(await ipcRenderer.invoke("workspace:pick")),
  validateWorkspace: async (path: string) =>
    ValidateWorkspaceResultSchema.parse(
      await ipcRenderer.invoke("workspace:validate", ValidateWorkspacePathSchema.parse(path)),
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
  testModelConnection: async (input) =>
    ModelConnectionTestResultSchema.parse(
      await ipcRenderer.invoke(
        "model-providers:test",
        ModelConnectionTestRequestSchema.parse(input),
      ),
    ),
  listContextStores: async () =>
    ContextStoreSchema.array().parse(await ipcRenderer.invoke("context-stores:list")),
  createContextStore: async (input) =>
    ContextStoreSchema.parse(
      await ipcRenderer.invoke("context-stores:create", CreateContextStoreSchema.parse(input)),
    ),
  addContextNoteEntry: async (input) =>
    ContextStoreSchema.parse(
      await ipcRenderer.invoke(
        "context-stores:add-note-entry",
        AddContextNoteEntrySchema.parse(input),
      ),
    ),
  listContextStoreContents: async (input) =>
    ContextStoreContentSummarySchema.array().parse(
      await ipcRenderer.invoke(
        "context-stores:list-contents",
        ListContextStoreContentsSchema.parse(input),
      ),
    ),
  getContextStoreContent: async (input) =>
    ContextStoreContentSchema.parse(
      await ipcRenderer.invoke(
        "context-stores:get-content",
        GetContextStoreContentSchema.parse(input),
      ),
    ),
  pickContextStoreFolder: async () =>
    PickWorkspaceResultSchema.parse(await ipcRenderer.invoke("context-stores:pick-folder")),
  listExperts: async () =>
    ExpertSummarySchema.array().parse(await ipcRenderer.invoke("experts:list")),
  getExpert: async (ref) =>
    ExpertDefinitionSchema.parse(await ipcRenderer.invoke("experts:get", ExpertRefSchema.parse(ref))),
  createExpert: async (input) =>
    ExpertDefinitionSchema.parse(
      await ipcRenderer.invoke("experts:create", CreateExpertDefinitionSchema.parse(input)),
    ),
  updateExpert: async (ref, input) =>
    ExpertDefinitionSchema.parse(
      await ipcRenderer.invoke(
        "experts:update",
        ExpertRefSchema.parse(ref),
        UpdateExpertDefinitionSchema.parse(input),
      ),
    ),
  deleteExpert: async (ref) => {
    await ipcRenderer.invoke("experts:delete", DeleteExpertDefinitionSchema.parse({ ref }));
  },
  getPragmaProject: async () =>
    PragmaProjectSnapshotSchema.parse(await ipcRenderer.invoke("pragma-project:get")),
  publishPragmaProject: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await ipcRenderer.invoke("pragma-project:publish", PublishPragmaProjectSchema.parse(input)),
    ),
  upsertPragmaResource: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await ipcRenderer.invoke("pragma-project:upsert", UpsertPragmaResourceSchema.parse(input)),
    ),
  deletePragmaResource: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await ipcRenderer.invoke("pragma-project:delete", DeletePragmaResourceSchema.parse(input)),
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
      await ipcRenderer.invoke(
        "pragma-project:validate-resource",
        ValidatePragmaResourceSchema.parse(input),
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
  listMissions: async () => MissionSchema.array().parse(await ipcRenderer.invoke("missions:list")),
  getMission: async (id) =>
    MissionSchema.parse(await ipcRenderer.invoke("missions:get", MissionIdSchema.parse(id))),
  createMission: async (input) =>
    MissionSchema.parse(
      await ipcRenderer.invoke("missions:create", CreateMissionSchema.parse(input)),
    ),
  runMission: async (id) =>
    MissionSchema.parse(
      await ipcRenderer.invoke("missions:run", MissionActionSchema.parse({ id })),
    ),
  sendMissionMessage: async (input) =>
    MissionSchema.parse(
      await ipcRenderer.invoke("missions:message:send", SendMissionMessageSchema.parse(input)),
    ),
  getMissionChat: async (id) =>
    MissionChatSnapshotSchema.parse(
      await ipcRenderer.invoke("missions:chat:get", MissionActionSchema.parse({ id })),
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
      await ipcRenderer.invoke("missions:interrupt", MissionActionSchema.parse({ id })),
    ),
  listMissionWorkItems: async (id) =>
    MissionWorkItemSchema.array().parse(
      await ipcRenderer.invoke("missions:work:list", MissionActionSchema.parse({ id })),
    ),
  deleteMission: async (id) => {
    await ipcRenderer.invoke("missions:delete", MissionActionSchema.parse({ id }));
  },
  listMissionHumanInteractions: async (id) =>
    MissionHumanInteractionSchema.array().parse(
      await ipcRenderer.invoke("missions:human:list", MissionActionSchema.parse({ id })),
    ),
  respondToMissionHumanInteraction: async (input) => {
    await ipcRenderer.invoke(
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
  deleteCapability: async (id) => {
    await ipcRenderer.invoke("capabilities:delete", CapabilityActionSchema.parse({ id }));
  },
  pickSkillSource: async () =>
    PickWorkspaceResultSchema.parse(await ipcRenderer.invoke("capabilities:pick-skill")),
  getRuntimeAvailability: async () =>
    DesktopRuntimeAvailabilitySchema.array().parse(
      await ipcRenderer.invoke("runtimes:availability"),
    ),
};

contextBridge.exposeInMainWorld("pragmaDesktop", api);
