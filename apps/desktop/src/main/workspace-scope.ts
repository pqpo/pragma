import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import { BrowserWindow, dialog, ipcMain } from "electron";

import {
  ValidateWorkspacePathSchema,
  type PickWorkspaceResult,
  type ValidateWorkspaceResult,
} from "../shared/desktop-api.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function validateWorkspace(path: string): Promise<ValidateWorkspaceResult> {
  if (!path || !isAbsolute(path)) {
    return { ok: false, reason: "not_absolute" };
  }

  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      return { ok: false, reason: "not_directory" };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "not_found" };
    }
    return { ok: false, reason: "error", error: errorMessage(error) };
  }

  try {
    await access(path, fsConstants.R_OK);
  } catch {
    return { ok: false, reason: "not_readable" };
  }

  try {
    await access(path, fsConstants.W_OK);
  } catch {
    return { ok: false, reason: "not_writable" };
  }

  return { ok: true };
}

export function installWorkspaceScopeHandlers(windowGetter: () => BrowserWindow | null): void {
  ipcMain.handle("workspace:pick", async (): Promise<PickWorkspaceResult> => {
    const window = windowGetter();
    if (!window) {
      return { ok: false, reason: "no_window" };
    }

    try {
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
      });
      const path = result.filePaths[0];
      if (result.canceled || !path) {
        return { ok: false, reason: "cancelled" };
      }

      const validation = await validateWorkspace(path);
      if (!validation.ok) {
        const reason = validation.reason === "not_directory" ? "not_directory" : "not_accessible";
        return {
          ok: false,
          reason,
          ...(validation.error ? { error: validation.error } : {}),
        };
      }

      return { ok: true, path, basename: basename(path) };
    } catch (error) {
      return { ok: false, reason: "error", error: errorMessage(error) };
    }
  });

  ipcMain.handle(
    "workspace:validate",
    (_event, path: unknown): Promise<ValidateWorkspaceResult> => {
      const parsed = ValidateWorkspacePathSchema.safeParse(path);
      if (!parsed.success) {
        return Promise.resolve({ ok: false, reason: "not_absolute" });
      }

      return validateWorkspace(parsed.data);
    },
  );
}
