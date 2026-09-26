import { ipcRenderer } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  CoreAssetSyncOverviewSchema,
  ResolveCoreAssetSyncConflictSchema,
  UpdateCoreAssetSyncConfigurationSchema,
} from "../../shared/contracts/index.ts";
import { invokeMutation } from "../invoke-mutation.ts";

export const coreAssetSyncApi = {
  getCoreAssetSyncOverview: async () =>
    CoreAssetSyncOverviewSchema.parse(await ipcRenderer.invoke("core-asset-sync:get")),
  updateCoreAssetSyncConfiguration: async (input) =>
    CoreAssetSyncOverviewSchema.parse(
      await invokeMutation(
        "core-asset-sync:configure",
        UpdateCoreAssetSyncConfigurationSchema.parse(input),
      ),
    ),
  removeCoreAssetSyncConfiguration: async () => {
    await invokeMutation("core-asset-sync:remove");
  },
  syncCoreAssets: async () =>
    CoreAssetSyncOverviewSchema.parse(await invokeMutation("core-asset-sync:run")),
  refreshCoreAssets: async () =>
    CoreAssetSyncOverviewSchema.parse(await invokeMutation("core-asset-sync:refresh")),
  resolveCoreAssetSyncConflict: async (input) =>
    CoreAssetSyncOverviewSchema.parse(
      await invokeMutation(
        "core-asset-sync:resolve",
        ResolveCoreAssetSyncConflictSchema.parse(input),
      ),
    ),
  restoreIgnoredCoreAsset: async (key) =>
    CoreAssetSyncOverviewSchema.parse(await invokeMutation("core-asset-sync:restore", key)),
} satisfies Pick<
  PragmaDesktopAPI,
  | "getCoreAssetSyncOverview"
  | "updateCoreAssetSyncConfiguration"
  | "removeCoreAssetSyncConfiguration"
  | "syncCoreAssets"
  | "refreshCoreAssets"
  | "resolveCoreAssetSyncConflict"
  | "restoreIgnoredCoreAsset"
>;
