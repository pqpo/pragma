import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  DesktopRuntimeAvailabilitySchema,
  DesktopRuntimeIdSchema,
  SetDefaultRuntimeSchema,
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
  getRuntimeAvailability: async () =>
    DesktopRuntimeAvailabilitySchema.array().parse(
      await ipcRenderer.invoke("runtimes:availability"),
    ),
  setDefaultRuntime: async (input) =>
    DesktopRuntimeAvailabilitySchema.array().parse(
      await ipcRenderer.invoke("runtimes:set-default", SetDefaultRuntimeSchema.parse(input)),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  "subscribeRuntimeModelCatalog" | "getRuntimeAvailability" | "setDefaultRuntime"
>;
