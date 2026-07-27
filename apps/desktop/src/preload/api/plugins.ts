import { ipcRenderer } from "electron";

import {
  DesktopPluginRefSchema,
  DesktopPluginSchema,
  ImportPluginZipSchema,
  InspectPluginZipSchema,
  PluginActionSchema,
  PluginZipInspectionSchema,
  SetPluginSecretsSchema,
  UpdatePluginDefaultsSchema,
} from "../../shared/contracts/plugins.ts";
import { PickWorkspaceResultSchema } from "../../shared/contracts/settings.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
export const pluginsApi = {
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
} satisfies Pick<
  PragmaDesktopAPI,
  | "listPlugins"
  | "getPlugin"
  | "pickPluginZip"
  | "inspectPluginZip"
  | "importPluginZip"
  | "updatePluginDefaults"
  | "setPluginSecrets"
  | "deletePlugin"
>;
