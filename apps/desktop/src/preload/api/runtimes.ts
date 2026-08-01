import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  DesktopRuntimeAvailabilitySchema,
  DesktopRuntimeIdSchema,
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
} satisfies Pick<PragmaDesktopAPI, "subscribeRuntimeModelCatalog" | "getRuntimeAvailability">;
