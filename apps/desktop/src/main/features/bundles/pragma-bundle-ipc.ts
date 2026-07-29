import { dialog, ipcMain, type BrowserWindow } from "electron";

import {
  ExportPragmaBundleSchema,
  InspectPragmaBundleSchema,
  PreparePragmaBundleExportSchema,
  PragmaBundleInstallationActionSchema,
  ResolvePragmaBundleInstallationSchema,
  StartPragmaBundleImportSchema,
} from "../../../shared/contracts/index.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";
import type { PragmaBundleService } from "./pragma-bundle-service.ts";

export function installPragmaBundleHandlers(
  service: PragmaBundleService,
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle("pragma-bundles:export:prepare", (_event, input: unknown) =>
    service.prepareExport(PreparePragmaBundleExportSchema.parse(input)),
  );
  ipcMain.handle("pragma-bundles:export", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = ExportPragmaBundleSchema.parse(input);
      const prepared = await service.prepareExport(parsed);
      const result = await showSaveBundleDialog(getWindow(), `${prepared.root.name}.pragma`);
      if (result.canceled || result.filePath === undefined) return { cancelled: true };
      const path = withBundleExtension(result.filePath);
      return {
        cancelled: false,
        ...(await service.exportTo(parsed, path)),
      };
    }),
  );
  ipcMain.handle("pragma-bundles:pick", async () => {
    const window = getWindow();
    const result =
      window === null
        ? await dialog.showOpenDialog({
            properties: ["openFile"],
            filters: [{ name: "Pragma", extensions: ["pragma"] }],
          })
        : await dialog.showOpenDialog(window, {
            properties: ["openFile"],
            filters: [{ name: "Pragma", extensions: ["pragma"] }],
          });
    return result.canceled || result.filePaths[0] === undefined
      ? { cancelled: true }
      : { cancelled: false, path: result.filePaths[0] };
  });
  ipcMain.handle("pragma-bundles:inspect", (_event, input: unknown) => {
    const parsed = InspectPragmaBundleSchema.parse(input);
    return service.inspect(parsed.sourcePath);
  });
  ipcMain.handle("pragma-bundles:import", (_event, input: unknown) =>
    runDesktopMutation(() => service.startImport(StartPragmaBundleImportSchema.parse(input))),
  );
  ipcMain.handle("pragma-bundles:installations:list", () => service.listInstallations());
  ipcMain.handle("pragma-bundles:installation:resolve", (_event, input: unknown) =>
    runDesktopMutation(() =>
      service.resolveInstallation(ResolvePragmaBundleInstallationSchema.parse(input)),
    ),
  );
  ipcMain.handle("pragma-bundles:installation:discard", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = PragmaBundleInstallationActionSchema.parse(input);
      await service.discardInstallation(parsed.installationId);
    }),
  );
}

async function showSaveBundleDialog(window: BrowserWindow | null, defaultPath: string) {
  const options = {
    defaultPath: sanitizeFilename(defaultPath),
    filters: [{ name: "Pragma", extensions: ["pragma"] }],
  };
  return window === null
    ? await dialog.showSaveDialog(options)
    : await dialog.showSaveDialog(window, options);
}

function withBundleExtension(path: string): string {
  return path.toLowerCase().endsWith(".pragma") ? path : `${path}.pragma`;
}

function sanitizeFilename(value: string): string {
  const sanitized = [...value]
    .map((character) =>
      character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? "_" : character,
    )
    .join("")
    .trim();
  return sanitized === "" ? "workflow.pragma" : sanitized;
}
