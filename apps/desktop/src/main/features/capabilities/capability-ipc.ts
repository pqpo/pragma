import { BrowserWindow, dialog, ipcMain } from "electron";
import { basename } from "node:path";

import type { PragmaManagementToolPorts } from "@pragma/built-in-agents";

import {
  CapabilityActionSchema,
  CapabilityIdSchema,
  CapabilityTestRequestSchema,
  CreateCapabilitySchema,
  GetSkillFileSchema,
  GetSkillDocumentSchema,
  ImportSkillCapabilitySchema,
  ListSkillFilesSchema,
  PreviewCodeServiceRequestSchema,
  UpdateCapabilitySchema,
  UpdateSkillCapabilitySchema,
  type PickWorkspaceResult,
} from "../../../shared/contracts/index.ts";
import { CapabilityStoreError, type CapabilityStore } from "./capability-store.ts";
import {
  BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY,
  isBuiltInCapabilityId,
  listCapabilitiesWithBuiltIns,
  testBuiltInCapability,
} from "./built-in-capabilities.ts";

export function installCapabilityHandlers(
  store: CapabilityStore,
  windowGetter: () => BrowserWindow | null,
  builtInManagementPorts: () => PragmaManagementToolPorts,
): void {
  ipcMain.handle("capabilities:list", () => listCapabilitiesWithBuiltIns(store));
  ipcMain.handle("capabilities:get", (_event, id: unknown, revision: unknown) => {
    const parsedId = CapabilityIdSchema.parse(id);
    return isBuiltInCapabilityId(parsedId)
      ? BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY
      : store.get(parsedId, revision === undefined ? undefined : Number(revision));
  });
  ipcMain.handle("capabilities:get-skill-document", (_event, input: unknown) =>
    store.getSkillDocument(GetSkillDocumentSchema.parse(input)),
  );
  ipcMain.handle("capabilities:list-skill-files", (_event, input: unknown) =>
    store.listSkillFiles(ListSkillFilesSchema.parse(input)),
  );
  ipcMain.handle("capabilities:get-skill-file", (_event, input: unknown) =>
    store.getSkillFile(GetSkillFileSchema.parse(input)),
  );
  ipcMain.handle("capabilities:import-skill", (_event, input: unknown) =>
    store.importSkill(ImportSkillCapabilitySchema.parse(input)),
  );
  ipcMain.handle("capabilities:update-skill", (_event, input: unknown) =>
    store.updateSkill(UpdateSkillCapabilitySchema.parse(input)),
  );
  ipcMain.handle("capabilities:create", (_event, input: unknown) =>
    store.create(CreateCapabilitySchema.parse(input)),
  );
  ipcMain.handle("capabilities:update", (_event, input: unknown) =>
    store.update(UpdateCapabilitySchema.parse(input)),
  );
  ipcMain.handle("capabilities:retry", (_event, input: unknown) => {
    const id = CapabilityActionSchema.parse(input).id;
    return isBuiltInCapabilityId(id) ? BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY : store.retry(id);
  });
  ipcMain.handle("capabilities:test", async (_event, input: unknown) => {
    const parsed = CapabilityTestRequestSchema.parse(input);
    if (!isBuiltInCapabilityId(parsed.id)) return await store.test(parsed);
    return await testBuiltInCapability(parsed, builtInManagementPorts(), async (approval) => {
      const options = {
        type: "warning" as const,
        title: "Run Pragma management tool?",
        message: `This test will execute ${approval.toolName} against live Desktop data.`,
        detail: managementApprovalDetail(approval.reason, approval.toolInput),
        buttons: ["Run", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const window = windowGetter();
      const result = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    });
  });
  ipcMain.handle("capabilities:preview-code", (_event, input: unknown) =>
    store.previewCode(PreviewCodeServiceRequestSchema.parse(input)),
  );
  ipcMain.handle("capabilities:delete", async (_event, input: unknown) => {
    try {
      await store.remove(CapabilityActionSchema.parse(input).id);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof CapabilityStoreError && error.code === "capability_referenced") {
        return { ok: false as const, code: error.code };
      }
      throw error;
    }
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

function managementApprovalDetail(reason: string, input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input ?? {}, null, 2) ?? "{}";
  } catch {
    serialized = "[Input could not be serialized]";
  }
  const maxInputLength = 4_000;
  const visibleInput =
    serialized.length <= maxInputLength
      ? serialized
      : `${serialized.slice(0, maxInputLength)}\n… input truncated`;
  return `${reason}\n\nInput:\n${visibleInput}`;
}
