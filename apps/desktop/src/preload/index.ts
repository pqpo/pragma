import { contextBridge, ipcRenderer } from "electron";

import {
  DesktopBridgeSnapshotSchema,
  DesktopRuntimeAvailabilitySchema,
  CreateModelProviderSchema,
  DeleteModelProviderSchema,
  ModelConnectionTestRequestSchema,
  ModelConnectionTestResultSchema,
  ModelProviderSchema,
  PickWorkspaceResultSchema,
  UpdateModelProviderSchema,
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
  getRuntimeAvailability: async () =>
    DesktopRuntimeAvailabilitySchema.array().parse(
      await ipcRenderer.invoke("runtimes:availability"),
    ),
};

contextBridge.exposeInMainWorld("pragmaDesktop", api);
