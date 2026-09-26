import { contextBridge } from "electron";
import { assetGitApi } from "./api/asset-git.ts";
import { coreAssetSyncApi } from "./api/core-asset-sync.ts";

import type { PragmaDesktopAPI } from "../shared/contracts/api.ts";
import { automationsApi } from "./api/automations.ts";
import { bundlesApi } from "./api/bundles.ts";
import { bundleRegistryApi } from "./api/bundle-registry.ts";
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
import { systemApi } from "./api/system.ts";
import { usageApi } from "./api/usage.ts";
import { workspacesApi } from "./api/workspaces.ts";

const api = {
  ...coreAssetSyncApi,
  ...assetGitApi,
  ...systemApi,
  ...settingsApi,
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
  ...bundleRegistryApi,
  ...missionsApi,
  ...usageApi,
  ...capabilitiesApi,
  ...runtimesApi,
} satisfies PragmaDesktopAPI;

contextBridge.exposeInMainWorld("pragmaDesktop", api);
