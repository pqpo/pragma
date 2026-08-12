import { contextBridge } from "electron";

import type { PragmaDesktopAPI } from "../shared/contracts/api.ts";
import { automationsApi } from "./api/automations.ts";
import { bundlesApi } from "./api/bundles.ts";
import { capabilitiesApi } from "./api/capabilities.ts";
import { contextStoresApi } from "./api/context-stores.ts";
import { expertsApi } from "./api/experts.ts";
import { evaluationsApi } from "./api/evaluations.ts";
import { missionsApi } from "./api/missions.ts";
import { memoryApi } from "./api/memory.ts";
import { modelProvidersApi } from "./api/model-providers.ts";
import { pluginsApi } from "./api/plugins.ts";
import { projectsApi } from "./api/projects.ts";
import { runtimesApi } from "./api/runtimes.ts";
import { settingsApi } from "./api/settings.ts";
import { skillLearningApi } from "./api/skill-learning.ts";
import { systemApi } from "./api/system.ts";
import { usageApi } from "./api/usage.ts";
import { workspacesApi } from "./api/workspaces.ts";

const api = {
  ...systemApi,
  ...settingsApi,
  ...skillLearningApi,
  ...memoryApi,
  ...workspacesApi,
  ...modelProvidersApi,
  ...contextStoresApi,
  ...expertsApi,
  ...evaluationsApi,
  ...pluginsApi,
  ...projectsApi,
  ...automationsApi,
  ...bundlesApi,
  ...missionsApi,
  ...usageApi,
  ...capabilitiesApi,
  ...runtimesApi,
} satisfies PragmaDesktopAPI;

contextBridge.exposeInMainWorld("pragmaDesktop", api);
