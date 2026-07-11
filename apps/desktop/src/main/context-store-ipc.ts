import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename } from "node:path";

import { BrowserWindow, dialog, ipcMain } from "electron";

import {
  CreateContextStoreSchema,
  type PickWorkspaceResult,
} from "../shared/desktop-api.ts";
import type { ContextStoreStore } from "./context-store-store.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function installContextStoreHandlers(
  store: ContextStoreStore,
  windowGetter: () => BrowserWindow | null,
): void {
  ipcMain.handle("context-stores:list", () => store.list());
  ipcMain.handle("context-stores:create", (_event, input: unknown) =>
    store.create(CreateContextStoreSchema.parse(input)),
  );
  ipcMain.handle("context-stores:pick-folder", async (): Promise<PickWorkspaceResult> => {
    const window = windowGetter();
    if (!window) return { ok: false, reason: "no_window" };

    try {
      const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
      const path = result.filePaths[0];
      if (result.canceled || !path) return { ok: false, reason: "cancelled" };
      if (!(await stat(path)).isDirectory()) return { ok: false, reason: "not_directory" };
      await access(path, fsConstants.R_OK);
      return { ok: true, path, basename: basename(path) };
    } catch (error) {
      return { ok: false, reason: "not_accessible", error: errorMessage(error) };
    }
  });
}
