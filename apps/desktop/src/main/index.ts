import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, app, ipcMain, safeStorage, shell } from "electron";
import { PragmaPaths } from "@pragma/core";
import { BUILT_IN_STEWARD_REF, compileBuiltInSteward, createStewardTools } from "@pragma/steward";

import { createBridgeSnapshot } from "./bridge-snapshot.ts";
import { installCapabilityHandlers } from "./capability-ipc.ts";
import { createCapabilityCredentialStore } from "./capability-credential-store.ts";
import { createCapabilityStore } from "./capability-store.ts";
import { createCapabilityVerifier } from "./capability-verifier.ts";
import { installContextStoreHandlers } from "./context-store-ipc.ts";
import { createContextStoreStore } from "./context-store-store.ts";
import { installDesktopSettingsHandlers } from "./desktop-settings-ipc.ts";
import { createDesktopSettingsStore } from "./desktop-settings-store.ts";
import { installExpertDefinitionHandlers } from "./expert-definition-ipc.ts";
import { createExpertDefinitionStore } from "./expert-definition-store.ts";
import { installModelProviderHandlers } from "./model-provider-ipc.ts";
import { createModelProviderStore } from "./model-provider-store.ts";
import {
  createBuiltInRuntimeFactories,
  createRuntimeEnvironmentService,
} from "./runtime-environment-service.ts";
import { createRuntimeEnvironmentStore } from "./runtime-environment-store.ts";
import { installPluginHandlers } from "./plugin-ipc.ts";
import { createPluginCredentialStore } from "./plugin-credential-store.ts";
import { createPluginStore } from "./plugin-store.ts";
import { installMissionHandlers } from "./mission-ipc.ts";
import { createMissionRunner } from "./mission-runner.ts";
import { createMissionStore } from "./mission-store.ts";
import { createMissionExecutorCatalog } from "./mission-executor-catalog.ts";
import { installPragmaProjectHandlers } from "./pragma-project-ipc.ts";
import { createPragmaProjectStore } from "./pragma-project-store.ts";
import { getRuntimeAvailability } from "./runtime-availability.ts";
import { installWorkspaceScopeHandlers, validateWorkspace } from "./workspace-scope.ts";
import { createDesktopStewardProjectPort } from "./steward-project-adapter.ts";
import { createDesktopStewardTaskPort } from "./steward-task-adapter.ts";
import { createDesktopSystemExpertRegistry } from "./system-expert-registry.ts";
import {
  resolveSystemExpertRuntimeDefaults,
  withRuntimeDefaults,
} from "./system-expert-runtime.ts";
import { createAutomaticToolPermissionHandler } from "./tool-permission-policy.ts";
import { installWorkflowLayoutHandlers } from "./workflow-layout-ipc.ts";
import { createWorkflowLayoutStore } from "./workflow-layout-store.ts";
import { SetDefaultRuntimeSchema } from "../shared/desktop-api.ts";

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
  const isMac = process.platform === "darwin";

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: "Pragma Desktop",
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
  if (process.platform === "darwin") {
    app.dock?.setIcon(applicationIconPath());
  }

  const encryption = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plainText: string) => safeStorage.encryptString(plainText),
    decrypt: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
  };
  const pragmaPaths = new PragmaPaths();
  const defaultStewardWorkspace = join(pragmaPaths.root, "workspaces", "steward");
  const desktopSettings = createDesktopSettingsStore({
    settingsPath: join(pragmaPaths.stateRoot(), "desktop-settings.json"),
    defaultStewardWorkspace,
    warn: (message, error) => console.warn(message, error),
  });
  const getToolPermissionMode = async () =>
    (await desktopSettings.getSnapshot(app.getPreferredSystemLanguages())).toolPermissionMode;
  const automaticHumanInteractionHandler =
    createAutomaticToolPermissionHandler(getToolPermissionMode);
  const systemExperts = createDesktopSystemExpertRegistry();
  const pragmaProjectStore = createPragmaProjectStore({
    projectsPath: join(app.getPath("home"), ".pragma", "projects"),
    reservedResourceRefs: new Set([BUILT_IN_STEWARD_REF]),
  });
  const missionExecutors = createMissionExecutorCatalog({
    project: pragmaProjectStore,
    systemExperts,
  });
  installWorkflowLayoutHandlers(
    createWorkflowLayoutStore({
      projectsPath: join(app.getPath("home"), ".pragma", "projects"),
    }),
  );
  const pluginCredentials = createPluginCredentialStore({
    configPath: join(pragmaPaths.stateRoot(), "plugin-credentials.json"),
    encryption,
  });
  const missionStore = createMissionStore({
    missionsPath: join(app.getPath("home"), ".pragma", "missions"),
  });
  const modelProviderStore = createModelProviderStore({
    configPath: join(app.getPath("home"), ".pragma", "model-providers.json"),
    encryption,
  });
  const runtimeEnvironments = createRuntimeEnvironmentStore({
    pragmaHome: pragmaPaths.root,
  });
  await runtimeEnvironments.initialize();
  const runtimes = createRuntimeEnvironmentService({
    store: runtimeEnvironments,
    factories: createBuiltInRuntimeFactories(modelProviderStore, getToolPermissionMode),
  });
  ipcMain.handle("runtimes:availability", () => getRuntimeAvailability(runtimes));
  ipcMain.handle("runtimes:set-default", async (_event, input: unknown) => {
    const { runtimeId } = SetDefaultRuntimeSchema.parse(input);
    await runtimeEnvironments.setDefaultRuntimeId(runtimeId);
    return await getRuntimeAvailability(runtimes);
  });
  const expertStore = createExpertDefinitionStore({
    project: pragmaProjectStore,
    systemExperts,
    validateModel: async (selection) => {
      const availability = await getRuntimeAvailability(runtimes);
      const runtime = availability.find((candidate) => candidate.id === selection.runtimeId);
      if (runtime?.status !== "available") {
        throw new Error(runtime?.reason ?? `Runtime is unavailable: ${selection.runtimeId}.`);
      }
      const model = runtime.models?.find(
        (candidate) =>
          candidate.provider.id === selection.providerId && candidate.id === selection.modelId,
      );
      if (model === undefined) {
        throw new Error(
          `Runtime model is unavailable: ${selection.runtimeId}/${selection.providerId}/${selection.modelId}.`,
        );
      }
      if (
        selection.thinkingLevel !== undefined &&
        !model.thinking?.supportedLevels.some((level) => level.value === selection.thinkingLevel)
      ) {
        throw new Error(
          `Thinking level is unavailable: ${selection.modelId}/${selection.thinkingLevel}.`,
        );
      }
    },
  });
  const pluginStore = createPluginStore({
    builtInPluginsPath: app.isPackaged
      ? join(process.resourcesPath, "plugins")
      : join(currentDir, "../../.plugin-bundles/plugins"),
    userPluginsPath: pragmaPaths.pluginsRoot(),
    paths: pragmaPaths,
    credentials: pluginCredentials,
    isReferenced: async (ref) => {
      const definitions = await Promise.all(
        (await expertStore.list()).map((summary) => expertStore.get(summary.ref)),
      );
      return definitions.some((expert) => expert.plugins.some((plugin) => plugin.ref === ref));
    },
  });
  installPluginHandlers(pluginStore, () => mainWindow);
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
        (await expertStore.list()).map((summary) => expertStore.get(summary.ref)),
      );
      return definitions.some((expert) =>
        expert.capabilities.some((reference) => reference.capabilityId === capabilityId),
      );
    },
  });
  installCapabilityHandlers(capabilityStore, () => mainWindow);
  const contextStores = createContextStoreStore({
    storesPath: join(app.getPath("home"), ".pragma", "context-stores"),
    isReferenced: async (storeId) => {
      const definitions = await Promise.all(
        (await expertStore.list()).map((summary) => expertStore.get(summary.ref)),
      );
      return definitions.some((expert) =>
        expert.contextStoreMounts.some((mount) => mount.storeId === storeId),
      );
    },
  });
  installContextStoreHandlers(contextStores, () => mainWindow);
  installExpertDefinitionHandlers(expertStore);
  installPragmaProjectHandlers(pragmaProjectStore);
  const initialSettings = await desktopSettings.getSnapshot(app.getPreferredSystemLanguages());
  await mkdir(initialSettings.stewardWorkspace, { recursive: true, mode: 0o700 });
  const stewardStateRoot = join(pragmaPaths.stateRoot(), "steward");
  const stewardProject = createDesktopStewardProjectPort({
    project: pragmaProjectStore,
    stateRoot: stewardStateRoot,
    capabilities: capabilityStore,
    runtimes,
  });
  const stewardToolsRef: { current?: ReturnType<typeof createStewardTools> } = {};
  const missionRunner = createMissionRunner({
    missions: missionStore,
    project: pragmaProjectStore,
    capabilityStore,
    capabilityCredentials,
    capabilitiesPath: join(app.getPath("home"), ".pragma", "capabilities"),
    pragmaHome: join(app.getPath("home"), ".pragma"),
    contextStores,
    plugins: pluginStore,
    runtimes,
    automaticHumanInteractionHandler,
    runtimesForToolPermissionMode: (mode) => runtimes.forToolPermissionMode(mode),
    automaticHumanInteractionHandlerForToolPermissionMode: (mode) =>
      createAutomaticToolPermissionHandler(() => mode),
    compileSystemExecutor: async ({ mission, runtimes: scopedRuntimes }) => {
      if (mission.executor.ref !== BUILT_IN_STEWARD_REF) return undefined;
      if (stewardToolsRef.current === undefined) {
        throw new Error("The built-in Steward tools have not been initialized.");
      }
      const defaults = await resolveSystemExpertRuntimeDefaults(
        scopedRuntimes,
        mission.modelOverride,
      );
      return await compileBuiltInSteward({
        definitionStateRoot: join(stewardStateRoot, "definitions"),
        workspace: mission.workspace.path,
        pragmaHome: pragmaPaths.root,
        runtimes: withRuntimeDefaults(scopedRuntimes, defaults),
        ...(defaults.modelSelection === undefined
          ? {}
          : { defaultModelSelection: defaults.modelSelection }),
        tools: stewardToolsRef.current,
      });
    },
  });
  const stewardTasks = createDesktopStewardTaskPort({
    missions: missionStore,
    runner: missionRunner,
    project: pragmaProjectStore,
    executors: missionExecutors,
    stateRoot: stewardStateRoot,
    getToolPermissionMode,
  });
  stewardToolsRef.current = createStewardTools({ project: stewardProject, tasks: stewardTasks });
  installMissionHandlers({
    missions: missionStore,
    project: pragmaProjectStore,
    executors: missionExecutors,
    getWindow: () => mainWindow,
    runner: missionRunner,
    getDefaultToolPermissionMode: getToolPermissionMode,
    getDefaultWorkspace: async () =>
      (await desktopSettings.getSnapshot(app.getPreferredSystemLanguages())).stewardWorkspace,
    defaultExecutorRef: BUILT_IN_STEWARD_REF,
  });
  installDesktopSettingsHandlers({
    store: desktopSettings,
    validateStewardWorkspace: async (path) => {
      const validation = await validateWorkspace(path);
      if (!validation.ok) {
        throw new Error(
          "The selected Steward workspace must be an accessible, writable directory.",
        );
      }
    },
    onStewardWorkspaceChanged: async () => undefined,
    onToolPermissionModeChanged: async () => undefined,
  });
  installModelProviderHandlers(modelProviderStore, {
    isProviderReferenced: async (providerId) =>
      (await pragmaProjectStore.get()).resources.some(
        (resource) =>
          resource.kind === "RuntimeProfile" &&
          (resource.spec.config as Record<string, unknown>).providerId === providerId,
      ),
  });
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
