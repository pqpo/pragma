import { contextBridge, ipcRenderer } from "electron";

import {
  DesktopBridgeSnapshotSchema,
  AddContextNoteEntrySchema,
  DesktopRuntimeAvailabilitySchema,
  ContextStoreSchema,
  CreateExpertDefinitionSchema,
  CreateContextStoreSchema,
  DeleteExpertDefinitionSchema,
  ExpertDefinitionSchema,
  ExpertIdSchema,
  ExpertSummarySchema,
  CreateModelProviderSchema,
  DeleteModelProviderSchema,
  ModelConnectionTestRequestSchema,
  ModelConnectionTestResultSchema,
  ModelProviderSchema,
  PickWorkspaceResultSchema,
  UpdateModelProviderSchema,
  UpdateExpertDefinitionSchema,
  ValidateWorkspacePathSchema,
  ValidateWorkspaceResultSchema,
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
  pickContextStoreFolder: async () =>
    PickWorkspaceResultSchema.parse(await ipcRenderer.invoke("context-stores:pick-folder")),
  listExperts: async () =>
    ExpertSummarySchema.array().parse(await ipcRenderer.invoke("experts:list")),
  getExpert: async (id) =>
    ExpertDefinitionSchema.parse(await ipcRenderer.invoke("experts:get", ExpertIdSchema.parse(id))),
  createExpert: async (input) =>
    ExpertDefinitionSchema.parse(
      await ipcRenderer.invoke("experts:create", CreateExpertDefinitionSchema.parse(input)),
    ),
  updateExpert: async (id, input) =>
    ExpertDefinitionSchema.parse(
      await ipcRenderer.invoke(
        "experts:update",
        ExpertIdSchema.parse(id),
        UpdateExpertDefinitionSchema.parse(input),
      ),
    ),
  deleteExpert: async (id) => {
    await ipcRenderer.invoke("experts:delete", DeleteExpertDefinitionSchema.parse({ id }));
  },
  getRuntimeAvailability: async () =>
    DesktopRuntimeAvailabilitySchema.array().parse(
      await ipcRenderer.invoke("runtimes:availability"),
    ),
};

contextBridge.exposeInMainWorld("pragmaDesktop", api);
