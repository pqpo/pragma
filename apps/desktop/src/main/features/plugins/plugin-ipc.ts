import { basename } from "node:path";

import { BrowserWindow, dialog, ipcMain } from "electron";

import {
  DesktopPluginRefSchema,
  ImportPluginZipSchema,
  InspectPluginZipSchema,
  PluginActionSchema,
  SetPluginSecretsSchema,
  UpdatePluginDefaultsSchema,
  type PickWorkspaceResult,
} from "../../../shared/contracts/index.ts";
import type { PluginStore } from "./plugin-store.ts";

export function installPluginHandlers(
  store: PluginStore,
  windowGetter: () => BrowserWindow | null,
): void {
  ipcMain.handle("plugins:list", () => store.list());
  ipcMain.handle("plugins:get", (_event, ref: unknown) =>
    store.get(DesktopPluginRefSchema.parse(ref)),
  );
  ipcMain.handle("plugins:inspect", (_event, input: unknown) =>
    store.inspectZip(InspectPluginZipSchema.parse(input).sourcePath),
  );
  ipcMain.handle("plugins:import", (_event, input: unknown) =>
    store.importZip(ImportPluginZipSchema.parse(input)),
  );
  ipcMain.handle("plugins:update-defaults", (_event, input: unknown) =>
    store.updateDefaults(UpdatePluginDefaultsSchema.parse(input)),
  );
  ipcMain.handle("plugins:set-secrets", (_event, input: unknown) =>
    store.setSecrets(SetPluginSecretsSchema.parse(input).secrets),
  );
  ipcMain.handle("plugins:delete", (_event, input: unknown) =>
    store.remove(PluginActionSchema.parse(input).ref),
  );
  ipcMain.handle("plugins:pick-zip", async (): Promise<PickWorkspaceResult> => {
    const window = windowGetter();
    if (window === null) return { ok: false, reason: "no_window" };
    try {
      const result = await dialog.showOpenDialog(window, {
        title: "Select a prebuilt Pragma plugin ZIP",
        properties: ["openFile"],
        filters: [{ name: "Pragma plugin packages", extensions: ["zip"] }],
      });
      const path = result.filePaths[0];
      if (result.canceled || path === undefined) return { ok: false, reason: "cancelled" };
      return { ok: true, path, basename: basename(path) };
    } catch (error) {
      return {
        ok: false,
        reason: "error",
        error: error instanceof Error ? error.message : "The plugin ZIP could not be selected.",
      };
    }
  });
}
