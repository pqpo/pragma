import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  DesktopRuntimeAvailabilitySchema,
  DesktopRuntimeIdSchema,
  DesktopRuntimeProcessEnvironmentStatusSchema,
  GetDesktopRuntimeAvailabilityOptionsSchema,
  RuntimeProcessEnvironmentSettingsSchema,
  UpdateRuntimeProcessEnvironmentPolicySchema,
} from "../../shared/contracts/runtime.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
export const runtimesApi = {
  subscribeRuntimeModelCatalog: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      listener(DesktopRuntimeIdSchema.parse(value));
    };
    ipcRenderer.on("runtimes:model-catalog:updated", handler);
    return () => ipcRenderer.removeListener("runtimes:model-catalog:updated", handler);
  },
  getRuntimeAvailability: async (options) => {
    const parsedOptions =
      options === undefined ? undefined : GetDesktopRuntimeAvailabilityOptionsSchema.parse(options);
    return DesktopRuntimeAvailabilitySchema.array().parse(
      await ipcRenderer.invoke("runtimes:availability", parsedOptions),
    );
  },
  getRuntimeProcessEnvironmentStatus: async () =>
    DesktopRuntimeProcessEnvironmentStatusSchema.parse(
      await ipcRenderer.invoke("runtimes:process-environment:status"),
    ),
  refreshRuntimeProcessEnvironment: async () =>
    DesktopRuntimeProcessEnvironmentStatusSchema.parse(
      await ipcRenderer.invoke("runtimes:process-environment:refresh"),
    ),
  getRuntimeProcessEnvironmentSettings: async () =>
    RuntimeProcessEnvironmentSettingsSchema.parse(
      await ipcRenderer.invoke("runtimes:process-environment:settings:get"),
    ),
  updateRuntimeProcessEnvironmentPolicy: async (input) =>
    RuntimeProcessEnvironmentSettingsSchema.parse(
      await ipcRenderer.invoke(
        "runtimes:process-environment:settings:update",
        UpdateRuntimeProcessEnvironmentPolicySchema.parse(input),
      ),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  | "subscribeRuntimeModelCatalog"
  | "getRuntimeAvailability"
  | "getRuntimeProcessEnvironmentStatus"
  | "refreshRuntimeProcessEnvironment"
  | "getRuntimeProcessEnvironmentSettings"
  | "updateRuntimeProcessEnvironmentPolicy"
>;
