import { validateHostWorkspace as validateWorkspace } from "@pragma/local-host";
export { validateHostWorkspace as validateWorkspace } from "@pragma/local-host";
import { basename } from "node:path";

import { BrowserWindow, dialog, ipcMain } from "electron";

import {
  ValidateWorkspacePathSchema,
  type PickWorkspaceResult,
  type ValidateWorkspaceResult,
} from "../../../shared/contracts/index.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
