import { ipcRenderer } from "electron";

import {
  AssetGitBindSchema,
  AssetGitImportSchema,
  AssetGitStatusSchema,
  AssetGitTargetSchema,
} from "../../shared/contracts/asset-git.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import { invokeMutation } from "../invoke-mutation.ts";

export const assetGitApi = {
  getAssetGitStatus: async (target) =>
    AssetGitStatusSchema.parse(
      await ipcRenderer.invoke("asset-git:status", AssetGitTargetSchema.parse(target)),
    ),
  bindAssetGit: async (input) =>
    AssetGitStatusSchema.parse(
      await invokeMutation("asset-git:bind", AssetGitBindSchema.parse(input)),
    ),
  unbindAssetGit: async (target) => {
    await invokeMutation("asset-git:unbind", AssetGitTargetSchema.parse(target));
  },
  importAssetGit: async (input) =>
    AssetGitTargetSchema.parse(
      await invokeMutation("asset-git:import", AssetGitImportSchema.parse(input)),
    ),
  syncAssetGit: async (target) =>
    AssetGitStatusSchema.parse(
      await invokeMutation("asset-git:sync", AssetGitTargetSchema.parse(target)),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  "getAssetGitStatus" | "bindAssetGit" | "unbindAssetGit" | "importAssetGit" | "syncAssetGit"
>;
