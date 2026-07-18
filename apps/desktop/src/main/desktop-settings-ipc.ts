import { app, ipcMain } from "electron";

import { UpdateDesktopSettingsSchema } from "../shared/desktop-api.ts";
import type { DesktopSettingsStore } from "./desktop-settings-store.ts";

export function installDesktopSettingsHandlers(store: DesktopSettingsStore): void {
  const preferredLanguages = () => app.getPreferredSystemLanguages();
  ipcMain.handle("desktop-settings:get", () => store.getSnapshot(preferredLanguages()));
  ipcMain.handle("desktop-settings:update", (_event, input: unknown) =>
    store.update(UpdateDesktopSettingsSchema.parse(input), preferredLanguages()),
  );
}
