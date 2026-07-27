import { ipcRenderer } from "electron";

import {
  DesktopSettingsSnapshotSchema,
  UpdateDesktopSettingsSchema,
} from "../../shared/contracts/settings.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
export const settingsApi = {
  getDesktopSettings: async () =>
    DesktopSettingsSnapshotSchema.parse(await ipcRenderer.invoke("desktop-settings:get")),
  updateDesktopSettings: async (input) =>
    DesktopSettingsSnapshotSchema.parse(
      await ipcRenderer.invoke("desktop-settings:update", UpdateDesktopSettingsSchema.parse(input)),
    ),
} satisfies Pick<PragmaDesktopAPI, "getDesktopSettings" | "updateDesktopSettings">;
