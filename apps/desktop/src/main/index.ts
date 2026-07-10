import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, app, ipcMain, safeStorage, shell } from "electron";

import { createBridgeSnapshot } from "./bridge-snapshot.ts";
import { installModelProviderHandlers } from "./model-provider-ipc.ts";
import { createModelProviderStore } from "./model-provider-store.ts";
import { getRuntimeAvailability } from "./runtime-availability.ts";
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
      preload: join(currentDir, "../preload/index.mjs"),
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
ipcMain.handle("runtimes:availability", () => getRuntimeAvailability());
installWorkspaceScopeHandlers(() => mainWindow);

void app.whenReady().then(async () => {
  installModelProviderHandlers(
    createModelProviderStore({
      configPath: join(app.getPath("home"), ".pragma", "model-providers.json"),
      encryption: {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plainText) => safeStorage.encryptString(plainText),
        decrypt: (encrypted) => safeStorage.decryptString(encrypted),
      },
    }),
  );
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
