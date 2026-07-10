import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, app, ipcMain, shell } from "electron";

import { createBridgeSnapshot } from "./bridge-snapshot.ts";
import { installWorkspaceScopeHandlers } from "./workspace-scope.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: "Pragma Desktop",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(currentDir, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const window = mainWindow;

  window.on("ready-to-show", () => {
    window.show();
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
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
}

ipcMain.handle("bridge:snapshot", () => createBridgeSnapshot());
installWorkspaceScopeHandlers(() => mainWindow);

void app.whenReady().then(async () => {
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
