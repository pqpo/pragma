import { BrowserWindow, dialog, ipcMain } from "electron";
import { basename } from "node:path";

import {
  CapabilityActionSchema,
  CapabilityIdSchema,
  CapabilityTestRequestSchema,
  CreateCapabilitySchema,
  ImportSkillCapabilitySchema,
  UpdateCapabilitySchema,
  type PickWorkspaceResult,
} from "../shared/desktop-api.ts";
import type { CapabilityStore } from "./capability-store.ts";

export function installCapabilityHandlers(
  store: CapabilityStore,
  windowGetter: () => BrowserWindow | null,
): void {
  ipcMain.handle("capabilities:list", () => store.list());
  ipcMain.handle("capabilities:get", (_event, id: unknown, revision: unknown) =>
    store.get(CapabilityIdSchema.parse(id), revision === undefined ? undefined : Number(revision)),
  );
  ipcMain.handle("capabilities:import-skill", (_event, input: unknown) =>
    store.importSkill(ImportSkillCapabilitySchema.parse(input)),
  );
  ipcMain.handle("capabilities:create", (_event, input: unknown) =>
    store.create(CreateCapabilitySchema.parse(input)),
  );
  ipcMain.handle("capabilities:update", (_event, input: unknown) =>
    store.update(UpdateCapabilitySchema.parse(input)),
  );
  ipcMain.handle("capabilities:retry", (_event, input: unknown) =>
    store.retry(CapabilityActionSchema.parse(input).id),
  );
  ipcMain.handle("capabilities:test", (_event, input: unknown) =>
    store.test(CapabilityTestRequestSchema.parse(input)),
  );
  ipcMain.handle("capabilities:delete", async (_event, input: unknown) => {
    await store.remove(CapabilityActionSchema.parse(input).id);
  });
  ipcMain.handle("capabilities:pick-skill", async (): Promise<PickWorkspaceResult> => {
    const window = windowGetter();
    if (!window) return { ok: false, reason: "no_window" };
    try {
      const result = await dialog.showOpenDialog(window, {
        title: "Select a Skill directory or ZIP",
        properties: ["openFile", "openDirectory"],
        filters: [{ name: "Skill packages", extensions: ["zip"] }],
      });
      const path = result.filePaths[0];
      if (result.canceled || !path) return { ok: false, reason: "cancelled" };
      return { ok: true, path, basename: basename(path) };
    } catch (error) {
      return {
        ok: false,
        reason: "error",
        error: error instanceof Error ? error.message : "The Skill source could not be selected.",
      };
    }
  });
}
