import { contextBridge } from "electron";

import type { PragmaDesktopAPI } from "../shared/contracts/api.ts";
import { automationsApi } from "./api/automations.ts";
import { capabilitiesApi } from "./api/capabilities.ts";
import { contextStoresApi } from "./api/context-stores.ts";
import { expertsApi } from "./api/experts.ts";
import { missionsApi } from "./api/missions.ts";
import { modelProvidersApi } from "./api/model-providers.ts";
import { pluginsApi } from "./api/plugins.ts";
import { projectsApi } from "./api/projects.ts";
import { runtimesApi } from "./api/runtimes.ts";
import { settingsApi } from "./api/settings.ts";
import { systemApi } from "./api/system.ts";
import { workspacesApi } from "./api/workspaces.ts";

const api = {
  ...systemApi,
  ...settingsApi,
  ...workspacesApi,
  ...modelProvidersApi,
  ...contextStoresApi,
  ...expertsApi,
  ...pluginsApi,
  ...projectsApi,
  ...automationsApi,
  ...missionsApi,
  ...capabilitiesApi,
  ...runtimesApi,
} satisfies PragmaDesktopAPI;

contextBridge.exposeInMainWorld("pragmaDesktop", api);
