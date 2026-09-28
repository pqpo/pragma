import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  AssetGitBindSchema,
  AssetGitConflictsSchema,
  ResolveAssetGitConflictsSchema,
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
  getAssetGitConflicts: async (target) =>
    AssetGitConflictsSchema.parse(
      await ipcRenderer.invoke("asset-git:conflicts", AssetGitTargetSchema.parse(target)),
    ),
  resolveAssetGitConflicts: async (input) =>
    AssetGitStatusSchema.parse(
      await invokeMutation("asset-git:resolve", ResolveAssetGitConflictsSchema.parse(input)),
    ),
  syncAssetGit: async (target) =>
    AssetGitStatusSchema.parse(
      await invokeMutation("asset-git:sync", AssetGitTargetSchema.parse(target)),
    ),
  subscribeAssetGitStatusUpdates: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      listener(AssetGitStatusSchema.parse(value));
    };
    ipcRenderer.on("asset-git:status:updated", handler);
    return () => ipcRenderer.removeListener("asset-git:status:updated", handler);
  },
} satisfies Pick<
  PragmaDesktopAPI,
  | "getAssetGitStatus"
  | "bindAssetGit"
  | "unbindAssetGit"
  | "importAssetGit"
  | "syncAssetGit"
  | "getAssetGitConflicts"
  | "resolveAssetGitConflicts"
  | "subscribeAssetGitStatusUpdates"
>;
