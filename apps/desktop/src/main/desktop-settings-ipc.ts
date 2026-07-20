import { app, ipcMain } from "electron";

import { UpdateDesktopSettingsSchema } from "../shared/desktop-api.ts";
import type { DesktopSettingsSnapshot } from "../shared/desktop-api.ts";
import type { DesktopSettingsStore } from "./desktop-settings-store.ts";

export function installDesktopSettingsHandlers(options: {
  readonly store: DesktopSettingsStore;
  readonly validateStewardWorkspace: (path: string) => Promise<void>;
  readonly onStewardWorkspaceChanged: (
    previous: DesktopSettingsSnapshot,
    next: DesktopSettingsSnapshot,
  ) => Promise<void>;
  readonly onToolPermissionModeChanged: (
    previous: DesktopSettingsSnapshot,
    next: DesktopSettingsSnapshot,
  ) => Promise<void>;
}): void {
  const preferredLanguages = () => app.getPreferredSystemLanguages();
  ipcMain.handle("desktop-settings:get", () => options.store.getSnapshot(preferredLanguages()));
  ipcMain.handle("desktop-settings:update", async (_event, input: unknown) => {
    const parsed = UpdateDesktopSettingsSchema.parse(input);
    const previous = await options.store.getSnapshot(preferredLanguages());
    if (typeof parsed.stewardWorkspace === "string") {
      await options.validateStewardWorkspace(parsed.stewardWorkspace);
    }
    const next = await options.store.update(parsed, preferredLanguages());
    if (next.stewardWorkspace !== previous.stewardWorkspace) {
      await options.onStewardWorkspaceChanged(previous, next);
    } else if (next.toolPermissionMode !== previous.toolPermissionMode) {
      await options.onToolPermissionModeChanged(previous, next);
    }
    return next;
  });
}
