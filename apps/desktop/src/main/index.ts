import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, app, ipcMain, safeStorage, shell } from "electron";

import { createBridgeSnapshot } from "./bridge-snapshot.ts";
import { installCapabilityHandlers } from "./capability-ipc.ts";
import { createCapabilityCredentialStore } from "./capability-credential-store.ts";
import { createCapabilityStore } from "./capability-store.ts";
import { createCapabilityVerifier } from "./capability-verifier.ts";
import { installContextStoreHandlers } from "./context-store-ipc.ts";
import { createContextStoreStore } from "./context-store-store.ts";
import { installExpertDefinitionHandlers } from "./expert-definition-ipc.ts";
import { createExpertDefinitionStore } from "./expert-definition-store.ts";
import { installModelProviderHandlers } from "./model-provider-ipc.ts";
import { createModelProviderStore } from "./model-provider-store.ts";
import { installMissionHandlers } from "./mission-ipc.ts";
import { createMissionRunner } from "./mission-runner.ts";
import { createMissionStore } from "./mission-store.ts";
import { installPragmaProjectHandlers } from "./pragma-project-ipc.ts";
import { createPragmaProjectStore } from "./pragma-project-store.ts";
import { getRuntimeAvailability } from "./runtime-availability.ts";
import { installWorkspaceScopeHandlers } from "./workspace-scope.ts";
import { installWorkflowLayoutHandlers } from "./workflow-layout-ipc.ts";
import { createWorkflowLayoutStore } from "./workflow-layout-store.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const applicationId = "dev.pragma.desktop";

if (process.platform === "win32") {
  app.setAppUserModelId(applicationId);
}

let mainWindow: BrowserWindow | null = null;

function applicationIconPath(): string {
  const fileName = process.platform === "darwin" ? "icon-mac.png" : "icon-windows.png";
  return app.isPackaged
    ? join(process.resourcesPath, "icons", fileName)
    : join(currentDir, "../../build", fileName);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: "Pragma Desktop",
    icon: applicationIconPath(),
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
  if (process.platform === "darwin") {
    app.dock?.setIcon(applicationIconPath());
  }

  const encryption = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plainText: string) => safeStorage.encryptString(plainText),
    decrypt: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
  };
  const pragmaProjectStore = createPragmaProjectStore({
    projectsPath: join(app.getPath("home"), ".pragma", "projects"),
  });
  installWorkflowLayoutHandlers(
    createWorkflowLayoutStore({
      projectsPath: join(app.getPath("home"), ".pragma", "projects"),
    }),
  );
  const expertStore = createExpertDefinitionStore({ project: pragmaProjectStore });
  const missionStore = createMissionStore({
    missionsPath: join(app.getPath("home"), ".pragma", "missions"),
  });
  const modelProviderStore = createModelProviderStore({
    configPath: join(app.getPath("home"), ".pragma", "model-providers.json"),
    encryption,
  });
  const capabilityCredentials = createCapabilityCredentialStore({
    configPath: join(app.getPath("home"), ".pragma", "capability-credentials.json"),
    encryption,
  });
  const capabilityStore = createCapabilityStore({
    capabilitiesPath: join(app.getPath("home"), ".pragma", "capabilities"),
    credentials: capabilityCredentials,
    verify: createCapabilityVerifier(capabilityCredentials),
    isReferenced: async (capabilityId) => {
      const definitions = await Promise.all(
        (await expertStore.list()).map((summary) => expertStore.get(summary.id)),
      );
      return definitions.some((expert) =>
        expert.capabilities.some((reference) => reference.capabilityId === capabilityId),
      );
    },
  });
  installCapabilityHandlers(capabilityStore, () => mainWindow);
  installContextStoreHandlers(
    createContextStoreStore({
      storesPath: join(app.getPath("home"), ".pragma", "context-stores"),
    }),
    () => mainWindow,
  );
  installExpertDefinitionHandlers(expertStore);
  installPragmaProjectHandlers(pragmaProjectStore);
  installMissionHandlers({
    missions: missionStore,
    project: pragmaProjectStore,
    getWindow: () => mainWindow,
    runner: createMissionRunner({
      missions: missionStore,
      project: pragmaProjectStore,
      capabilityStore,
      capabilityCredentials,
      capabilitiesPath: join(app.getPath("home"), ".pragma", "capabilities"),
      pragmaHome: join(app.getPath("home"), ".pragma"),
      modelProviders: modelProviderStore,
    }),
  });
  installModelProviderHandlers(modelProviderStore);
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
