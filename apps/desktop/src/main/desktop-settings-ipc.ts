import { app, ipcMain } from "electron";

import { UpdateDesktopSettingsSchema } from "../shared/desktop-api.ts";
import type { DesktopSettingsStore } from "./desktop-settings-store.ts";

export function installDesktopSettingsHandlers(options: {
  readonly store: DesktopSettingsStore;
  readonly validateDefaultWorkspace: (path: string) => Promise<void>;
}): void {
  const preferredLanguages = () => app.getPreferredSystemLanguages();
  ipcMain.handle("desktop-settings:get", () => options.store.getSnapshot(preferredLanguages()));
  ipcMain.handle("desktop-settings:update", async (_event, input: unknown) => {
    const parsed = UpdateDesktopSettingsSchema.parse(input);
    if (typeof parsed.defaultWorkspace === "string") {
      await options.validateDefaultWorkspace(parsed.defaultWorkspace);
    }
    return await options.store.update(parsed, preferredLanguages());
  });
}
