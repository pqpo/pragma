import { ipcRenderer } from "electron";

import {
  CreateModelProviderSchema,
  DeleteModelProviderSchema,
  DiscoverProviderModelsSchema,
  ModelCompatibilityProfileDescriptorSchema,
  ModelConnectionTestRequestSchema,
  ModelConnectionTestResultSchema,
  ModelDiscoveryResultSchema,
  ModelProviderSchema,
  ModelProviderSettingsSnapshotSchema,
  ResetModelProvidersResultSchema,
  UpdateModelProviderSchema,
} from "../../shared/contracts/model-provider.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
export const modelProvidersApi = {
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
} satisfies Pick<
  PragmaDesktopAPI,
  | "getModelProviderSettings"
  | "listModelCompatibilityProfiles"
  | "listModelProviders"
  | "createModelProvider"
  | "updateModelProvider"
  | "deleteModelProvider"
  | "discoverProviderModels"
  | "testModelConnection"
  | "resetModelProviders"
>;
