import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, app, shell } from "electron";
import type { PragmaLogger } from "@pragma/core";

const currentDir = dirname(fileURLToPath(import.meta.url));

export interface DesktopWindowManager {
  readonly getWindow: () => BrowserWindow | null;
  readonly createWindow: () => Promise<void>;
  readonly applicationIconPath: () => string;
  readonly builtInPluginsPath: () => string;
  readonly sendRuntimeModelCatalogUpdate: (runtimeId: string) => void;
}

export function createDesktopWindowManager(logger: PragmaLogger): DesktopWindowManager {
  let mainWindow: BrowserWindow | null = null;

  const applicationIconPath = (): string => {
    const fileName = process.platform === "darwin" ? "icon-mac.png" : "icon-windows.png";
    return app.isPackaged
      ? join(process.resourcesPath, "icons", fileName)
      : join(currentDir, "../../build", fileName);
  };

  const createWindow = async (): Promise<void> => {
    const isMac = process.platform === "darwin";
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1080,
      minHeight: 700,
      title: "Pragma",
      icon: applicationIconPath(),
      autoHideMenuBar: true,
      show: false,
      titleBarStyle: isMac ? "hiddenInset" : "hidden",
      ...(isMac
        ? { trafficLightPosition: { x: 18, y: 18 } }
        : {
            titleBarOverlay: {
              color: "#f1f3f2",
              symbolColor: "#67706a",
              height: 36,
            },
          }),
      webPreferences: {
        preload: join(currentDir, "../preload/index.mjs"),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const window = mainWindow;
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
      logger.error("desktop.preload_failed", `Desktop preload failed: ${preloadPath}`, error);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      logger.error(
        "desktop.renderer_process_gone",
        `Desktop renderer process exited because ${details.reason}.`,
        new Error(`Renderer exited with code ${details.exitCode}.`),
        { reason: details.reason, exitCode: details.exitCode },
      );
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame) return;
        logger.error(
          "desktop.renderer_load_failed",
          `Desktop renderer failed to load ${validatedUrl} (${errorCode}): ${errorDescription}.`,
          new Error(errorDescription),
          { errorCode, validatedUrl },
        );
      },
    );
    window.on("ready-to-show", () => window.show());
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      await window.loadFile(join(currentDir, "../renderer/index.html"));
    }
  };

  return {
    getWindow: () => mainWindow,
    createWindow,
    applicationIconPath,
    builtInPluginsPath: () =>
      app.isPackaged
        ? join(process.resourcesPath, "plugins")
        : join(currentDir, "../../.plugin-bundles/plugins"),
    sendRuntimeModelCatalogUpdate(runtimeId) {
      if (
        mainWindow !== null &&
        !mainWindow.isDestroyed() &&
        !mainWindow.webContents.isDestroyed()
      ) {
        mainWindow.webContents.send("runtimes:model-catalog:updated", runtimeId);
      }
    },
  };
}
