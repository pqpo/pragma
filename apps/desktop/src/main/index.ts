import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, app, ipcMain, safeStorage, shell } from "electron";
import {
  PragmaPaths,
  createCompositeLogHandler,
  createConsoleLogHandler,
  createLoggerProvider,
  runStorageMaintenance,
} from "@pragma/core";
import {
  BUILT_IN_PRAGMA_REF,
  compileBuiltInDefaultAgent,
  createDefaultAgentTools,
} from "@pragma/default-agent";

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
import { createMissionCreator } from "./mission-creator.ts";
import { createDesktopAdapterHost, createMissionRunner } from "./mission-runner.ts";
import { createMissionStore } from "./mission-store.ts";
import { createMissionExecutorCatalog } from "./mission-executor-catalog.ts";
import { installPragmaProjectHandlers } from "./pragma-project-ipc.ts";
import { createPragmaProjectStore } from "./pragma-project-store.ts";
import { getRuntimeAvailability } from "./runtime-availability.ts";
import { installWorkspaceScopeHandlers, validateWorkspace } from "./workspace-scope.ts";
import { createWorkspaceHistoryStore } from "./workspace-history-store.ts";
import { createDesktopDefaultAgentProjectPort } from "./default-agent-project-adapter.ts";
import { createDesktopDefaultAgentTaskPort } from "./default-agent-task-adapter.ts";
import { createDesktopDefaultAgentAutomationPort } from "./default-agent-automation-adapter.ts";
import { createDesktopSystemExpertRegistry } from "./system-expert-registry.ts";
import { initializeDesktopStorage } from "./storage-bootstrap.ts";
import {
  resolveSystemExpertRuntimeDefaults,
  withRuntimeDefaults,
} from "./system-expert-runtime.ts";
import { createAutomaticToolPermissionHandler } from "./tool-permission-policy.ts";
import { installWorkflowLayoutHandlers } from "./workflow-layout-ipc.ts";
import { createWorkflowLayoutStore } from "./workflow-layout-store.ts";
import { SetDefaultRuntimeSchema } from "../shared/desktop-api.ts";
import { installAutomationHandlers } from "./automation-ipc.ts";
import { createAutomationService } from "./automation-service.ts";
import { createAutomationStore } from "./automation-store.ts";
import { createDesktopLogHandler } from "./desktop-log-handler.ts";
import { DesktopRendererLogSchema } from "../shared/desktop-api.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const applicationId = "dev.pragma.desktop";
const pragmaPaths = new PragmaPaths();
const bootId = randomUUID();
const desktopLogHandler = createDesktopLogHandler({ paths: pragmaPaths, bootId });
const diagnosticLogHandler = app.isPackaged
  ? desktopLogHandler
  : createCompositeLogHandler([desktopLogHandler, createConsoleLogHandler()]);
const loggerProvider = createLoggerProvider({
  handler: diagnosticLogHandler,
  minimumLevel: readDesktopLogLevel(),
  host: {
    kind: "desktop",
    bootId,
    pid: process.pid,
    version: app.getVersion(),
  },
  baseScope: { processKind: "desktop-main" },
});
const mainLogger = loggerProvider.createLogger({ component: "desktop.main" });

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

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    mainLogger.error("desktop.preload_failed", `Desktop preload failed: ${preloadPath}`, error);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    mainLogger.error(
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
      mainLogger.error(
        "desktop.renderer_load_failed",
        `Desktop renderer failed to load ${validatedUrl} (${errorCode}): ${errorDescription}.`,
        new Error(errorDescription),
        { errorCode, validatedUrl },
      );
    },
  );

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
ipcMain.on("logs:renderer", (_event, input: unknown) => {
  const record = DesktopRendererLogSchema.safeParse(input);
  if (!record.success) {
    mainLogger.warn("renderer.invalid_log_report", "Rejected an invalid Renderer log report.");
    return;
  }
  const logger = loggerProvider.createLogger({
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
installWorkspaceScopeHandlers(() => mainWindow);

const LOG_CLOSE_TIMEOUT_MS = 2_000;
let desktopLogsClosed = false;
let desktopLogsClosePromise: Promise<void> | undefined;
app.on("will-quit", (event) => {
  if (desktopLogsClosed) return;
  event.preventDefault();
  void closeDesktopLogs()
    .catch(reportLogShutdownFailure)
    .finally(() => app.quit());
});

const desktopStartup = app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.dock?.setIcon(applicationIconPath());
  }

  const encryption = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plainText: string) => safeStorage.encryptString(plainText),
    decrypt: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
  };
  const storageBootstrap = await initializeDesktopStorage({
    paths: pragmaPaths,
    trashItem: async (path) => await shell.trashItem(path),
  });
  await desktopLogHandler.activate();
  mainLogger.info("desktop.storage_ready", "Desktop storage and persistent logging are ready.");
  if (storageBootstrap.legacyBackup !== undefined) {
    mainLogger.warn(
      "desktop.storage_legacy_backup",
      `Previous Pragma storage was backed up to ${storageBootstrap.legacyBackup}.`,
    );
  }
  const maintenance = await runStorageMaintenance({ paths: pragmaPaths });
  if (maintenance.before.totalBytes >= maintenance.before.softLimitBytes) {
    mainLogger.warn(
      "desktop.storage_pressure_gc",
      `Pragma storage pressure GC reclaimed ${maintenance.before.totalBytes - maintenance.after.totalBytes} bytes.`,
    );
  }
  const builtInDefaultWorkspace = pragmaPaths.workspaceRoot();
  const projectsPath = pragmaPaths.projectsRoot();
  const missionsPath = pragmaPaths.missionsRoot();
  const modelProvidersPath = join(pragmaPaths.dataRoot(), "model-providers.json");
  const capabilityCredentialsPath = join(
    pragmaPaths.credentialsRoot(),
    "capability-credentials.json",
  );
  const capabilitiesPath = join(pragmaPaths.dataRoot(), "capabilities");
  const contextStoresPath = join(pragmaPaths.dataRoot(), "context-stores");
  const desktopSettings = createDesktopSettingsStore({
    settingsPath: join(pragmaPaths.stateRoot(), "desktop-settings.json"),
    builtInDefaultWorkspace,
    warn: (message, error) => mainLogger.warn("desktop.settings_warning", message, { error }),
  });
  const workspaceHistory = createWorkspaceHistoryStore({
    historyPath: join(pragmaPaths.stateRoot(), "workspace-history.json"),
    warn: (message, error) =>
      mainLogger.warn("desktop.workspace_history_warning", message, { error }),
  });
  const getToolPermissionMode = async () =>
    (await desktopSettings.getSnapshot(app.getPreferredSystemLanguages())).toolPermissionMode;
  const automaticHumanInteractionHandler =
    createAutomaticToolPermissionHandler(getToolPermissionMode);
  const systemExperts = createDesktopSystemExpertRegistry({
    configPath: join(pragmaPaths.stateRoot(), "system-experts.json"),
    warn: (message, error) => mainLogger.warn("desktop.system_expert_warning", message, { error }),
  });
  await systemExperts.initialize();
  const pragmaProjectStore = createPragmaProjectStore({
    projectsPath,
    objectsPath: pragmaPaths.contentObjectsRoot(),
    projectViewsPath: pragmaPaths.projectViewsCacheRoot(),
    storagePaths: pragmaPaths,
    loggerProvider,
    reservedResourceRefs: new Set([BUILT_IN_PRAGMA_REF]),
  });
  installWorkflowLayoutHandlers(
    createWorkflowLayoutStore({
      projectsPath,
    }),
  );
  const pluginCredentials = createPluginCredentialStore({
    configPath: join(pragmaPaths.credentialsRoot(), "plugin-credentials.json"),
    encryption,
  });
  const missionStore = createMissionStore({
    missionsPath,
  });
  const modelProviderStore = createModelProviderStore({
    configPath: modelProvidersPath,
    encryption,
  });
  const runtimeEnvironments = createRuntimeEnvironmentStore({
    pragmaHome: pragmaPaths.root,
  });
  await runtimeEnvironments.initialize();
  const runtimes = createRuntimeEnvironmentService({
    store: runtimeEnvironments,
    factories: createBuiltInRuntimeFactories(
      modelProviderStore,
      getToolPermissionMode,
      (runtimeId) => {
        if (
          mainWindow !== null &&
          !mainWindow.isDestroyed() &&
          !mainWindow.webContents.isDestroyed()
        ) {
          mainWindow.webContents.send("runtimes:model-catalog:updated", runtimeId);
        }
      },
    ),
  });
  const missionExecutors = createMissionExecutorCatalog({
    project: pragmaProjectStore,
    systemExperts,
    runtimes,
  });
  const missionCreator = createMissionCreator({
    missions: missionStore,
    project: pragmaProjectStore,
    executors: missionExecutors,
    getDefaultToolPermissionMode: getToolPermissionMode,
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
    configPath: capabilityCredentialsPath,
    encryption,
  });
  const capabilityStore = createCapabilityStore({
    capabilitiesPath,
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
    storesPath: contextStoresPath,
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
  await mkdir(initialSettings.defaultWorkspace, { recursive: true, mode: 0o700 });
  const defaultAgentStateRoot = join(pragmaPaths.stateRoot(), "pragma");
  const defaultAgentProject = createDesktopDefaultAgentProjectPort({
    project: pragmaProjectStore,
    stateRoot: defaultAgentStateRoot,
    capabilities: capabilityStore,
    runtimes,
  });
  const defaultAgentToolsRef: { current?: ReturnType<typeof createDefaultAgentTools> } = {};
  const missionRunner = createMissionRunner({
    missions: missionStore,
    project: pragmaProjectStore,
    capabilityStore,
    capabilityCredentials,
    capabilitiesPath,
    pragmaHome: pragmaPaths.root,
    contextStores,
    plugins: pluginStore,
    runtimes,
    loggerProvider,
    automaticHumanInteractionHandler,
    runtimesForToolPermissionMode: (mode) => runtimes.forToolPermissionMode(mode),
    automaticHumanInteractionHandlerForToolPermissionMode: (mode) =>
      createAutomaticToolPermissionHandler(() => mode),
    compileSystemExecutor: async ({ mission, runtimes: scopedRuntimes }) => {
      if (mission.executor.ref !== BUILT_IN_PRAGMA_REF) return undefined;
      if (defaultAgentToolsRef.current === undefined) {
        throw new Error("The built-in Pragma tools have not been initialized.");
      }
      const definition = systemExperts.get(BUILT_IN_PRAGMA_REF);
      if (definition === undefined) throw new Error("The built-in Pragma definition is missing.");
      const createsSession = mission.execution?.sessionId === undefined;
      const configuredModel =
        createsSession && definition.executionProfile.mode === "pinned"
          ? definition.executionProfile.model
          : undefined;
      const defaults = await resolveSystemExpertRuntimeDefaults(
        scopedRuntimes,
        configuredModel,
        createsSession ? mission.modelOverride : undefined,
      );
      return await compileBuiltInDefaultAgent({
        definitionStateRoot: join(defaultAgentStateRoot, "definitions"),
        workspace: mission.workspace.path,
        pragmaHome: pragmaPaths.root,
        runtimes: withRuntimeDefaults(scopedRuntimes, defaults),
        loggerProvider,
        ...(defaults.modelSelection === undefined
          ? {}
          : { defaultModelSelection: defaults.modelSelection }),
        rootExecutionOverride: {
          runtimeId: defaults.runtimeId,
          ...(defaults.modelSelection === undefined
            ? {}
            : { modelSelection: defaults.modelSelection }),
        },
        tools: defaultAgentToolsRef.current,
        ...(definition.customized
          ? { expertResource: systemExperts.getResource(BUILT_IN_PRAGMA_REF) }
          : {}),
        additionalResources: systemExperts.getAdditionalResources(BUILT_IN_PRAGMA_REF),
        adapterHost: createDesktopAdapterHost(
          {
            capabilityStore,
            capabilityCredentials,
            capabilitiesPath,
            contextStores,
          },
          mission.workspace.path,
        ),
        plugins: {
          inspect: async ({ binding }) =>
            await pluginStore.inspect({
              ref: binding.ref,
              config: binding.config,
              secretBindings: binding.secretBindings,
            }),
          resolve: async ({ binding }) =>
            await pluginStore.resolve({
              ref: binding.ref,
              config: binding.config,
              secretBindings: binding.secretBindings,
            }),
        },
      });
    },
  });
  const automationService = createAutomationService({
    paths: pragmaPaths,
    project: pragmaProjectStore,
    store: createAutomationStore(pragmaPaths, pragmaProjectStore.projectId),
    missions: missionStore,
    creator: missionCreator,
    runner: missionRunner,
    loggerProvider,
  });
  installAutomationHandlers(automationService);
  await automationService.start();
  app.once("before-quit", () => automationService.stop());
  const defaultAgentTasks = createDesktopDefaultAgentTaskPort({
    missions: missionStore,
    runner: missionRunner,
    creator: missionCreator,
    stateRoot: defaultAgentStateRoot,
  });
  defaultAgentToolsRef.current = createDefaultAgentTools({
    project: defaultAgentProject,
    tasks: defaultAgentTasks,
    automations: createDesktopDefaultAgentAutomationPort({
      service: automationService,
      project: pragmaProjectStore,
      stateRoot: defaultAgentStateRoot,
    }),
  });
  installMissionHandlers({
    missions: missionStore,
    creator: missionCreator,
    executors: missionExecutors,
    project: pragmaProjectStore,
    getWindow: () => mainWindow,
    runner: missionRunner,
    getDefaultToolPermissionMode: getToolPermissionMode,
    getDefaultWorkspace: async () =>
      (await desktopSettings.getSnapshot(app.getPreferredSystemLanguages())).defaultWorkspace,
    getRecentWorkspaces: () => workspaceHistory.list(),
    recordWorkspaceUsage: async (path) => {
      try {
        await workspaceHistory.record(path);
      } catch (error) {
        mainLogger.warn(
          "desktop.workspace_usage_failed",
          "Workspace usage could not be recorded.",
          { error },
        );
      }
    },
    defaultExecutorRef: BUILT_IN_PRAGMA_REF,
  });
  installDesktopSettingsHandlers({
    store: desktopSettings,
    validateDefaultWorkspace: async (path) => {
      const validation = await validateWorkspace(path);
      if (!validation.ok) {
        throw new Error("The default workspace must be an accessible, writable directory.");
      }
    },
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
      void createWindow().catch((error: unknown) => {
        mainLogger.error(
          "desktop.window_reopen_failed",
          "Desktop window could not be reopened.",
          error,
        );
      });
    }
  });
});
void desktopStartup.catch((error: unknown) => {
  mainLogger.fatal("desktop.startup_failed", "Desktop startup failed.", error);
  void closeDesktopLogs()
    .catch(reportLogShutdownFailure)
    .finally(() => app.exit(1));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function readDesktopLogLevel(): "debug" | "info" | "warn" | "error" | "fatal" | "silent" {
  const configured = process.env["PRAGMA_LOG_LEVEL"];
  return configured === "debug" ||
    configured === "info" ||
    configured === "warn" ||
    configured === "error" ||
    configured === "fatal" ||
    configured === "silent"
    ? configured
    : "info";
}

function closeDesktopLogs(): Promise<void> {
  desktopLogsClosePromise ??= withDeadline(
    diagnosticLogHandler.close?.() ?? Promise.resolve(),
    LOG_CLOSE_TIMEOUT_MS,
  ).finally(() => {
    desktopLogsClosed = true;
  });
  return desktopLogsClosePromise;
}

async function withDeadline(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Diagnostic log shutdown exceeded ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

let logShutdownFailureReported = false;
function reportLogShutdownFailure(error: unknown): void {
  if (logShutdownFailureReported) return;
  logShutdownFailureReported = true;
  try {
    console.error(
      JSON.stringify({
        level: "error",
        component: "desktop.logging",
        event: "log_shutdown_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } catch {
    // This is the final non-recursive fallback during process shutdown.
  }
}
