import { BrowserWindow, app, ipcMain, safeStorage, shell } from "electron";
import { PragmaPaths } from "@pragma/core";

import { DesktopRendererLogSchema } from "../../shared/contracts/index.ts";
import { installWorkspaceScopeHandlers } from "../features/workspaces/workspace-scope.ts";
import { createBridgeSnapshot } from "../platform/ipc/bridge-snapshot.ts";
import { createDesktopLogging } from "../platform/logging/desktop-logging.ts";
import { createDesktopWindowManager } from "../platform/window/desktop-window.ts";
import {
  createDesktopApplicationContainer,
  type DesktopApplicationContainer,
} from "./application-container.ts";

const applicationId = "dev.pragma.desktop";

export function startDesktopApplication(): void {
  const paths = new PragmaPaths();
  const logging = createDesktopLogging(paths);
  const windows = createDesktopWindowManager(logging.mainLogger);
  let container: DesktopApplicationContainer | undefined;

  if (process.platform === "win32") {
    app.setAppUserModelId(applicationId);
  }

  ipcMain.handle("bridge:snapshot", () => createBridgeSnapshot());
  ipcMain.on("logs:renderer", (_event, input: unknown) => {
    const record = DesktopRendererLogSchema.safeParse(input);
    if (!record.success) {
      logging.mainLogger.warn(
        "renderer.invalid_log_report",
        "Rejected an invalid Renderer log report.",
      );
      return;
    }
    const logger = logging.loggerProvider.createLogger({
      component: "desktop.renderer",
      scope: { processKind: "desktop-renderer" },
    });
    if (record.data.level === "warn") {
      logger.warn(record.data.event, record.data.message, {
        errorMessage: record.data.errorMessage,
        stack: record.data.stack,
      });
      return;
    }
    const error = new Error(record.data.errorMessage ?? record.data.message);
    if (record.data.stack !== undefined) error.stack = record.data.stack;
    logger.error(record.data.event, record.data.message, error);
  });
  installWorkspaceScopeHandlers(windows.getWindow);

  app.on("will-quit", (event) => {
    if (logging.isClosed()) return;
    event.preventDefault();
    void logging
      .close()
      .catch(logging.reportShutdownFailure)
      .finally(() => app.quit());
  });

  const startup = app.whenReady().then(async () => {
    if (process.platform === "darwin") {
      app.dock?.setIcon(windows.applicationIconPath());
    }
    container = await createDesktopApplicationContainer({
      paths,
      loggerProvider: logging.loggerProvider,
      logger: logging.mainLogger,
      encryption: {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plainText) => safeStorage.encryptString(plainText),
        decrypt: (encrypted) => safeStorage.decryptString(encrypted),
      },
      builtInPluginsPath: windows.builtInPluginsPath(),
      getPreferredSystemLanguages: () => app.getPreferredSystemLanguages(),
      getWindow: windows.getWindow,
      sendRuntimeModelCatalogUpdate: windows.sendRuntimeModelCatalogUpdate,
      trashItem: async (path) => await shell.trashItem(path),
      activateLogging: logging.activate,
    });
    app.once("before-quit", () => container?.dispose());
    await windows.createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void windows.createWindow().catch((error: unknown) => {
          logging.mainLogger.error(
            "desktop.window_reopen_failed",
            "Desktop window could not be reopened.",
            error,
          );
        });
      }
    });
  });

  void startup.catch((error: unknown) => {
    logging.mainLogger.fatal("desktop.startup_failed", "Desktop startup failed.", error);
    void logging
      .close()
      .catch(logging.reportShutdownFailure)
      .finally(() => app.exit(1));
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
