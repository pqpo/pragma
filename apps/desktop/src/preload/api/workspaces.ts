import { ipcRenderer } from "electron";

import {
  PickWorkspaceResultSchema,
  ValidateWorkspacePathSchema,
  ValidateWorkspaceResultSchema,
} from "../../shared/contracts/settings.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
export const workspacesApi = {
  pickWorkspace: async () =>
    PickWorkspaceResultSchema.parse(await ipcRenderer.invoke("workspace:pick")),
  validateWorkspace: async (path: string) =>
    ValidateWorkspaceResultSchema.parse(
      await ipcRenderer.invoke("workspace:validate", ValidateWorkspacePathSchema.parse(path)),
    ),
} satisfies Pick<PragmaDesktopAPI, "pickWorkspace" | "validateWorkspace">;
