import { ipcRenderer } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  DesktopAssetMemoryPolicySnapshotSchema,
  DesktopGlobalMemoryPolicySnapshotSchema,
  DesktopMemoryPlaneStatusSchema,
  GetDesktopAssetMemoryPolicySchema,
  UpdateDesktopAssetMemoryPolicySchema,
  UpdateDesktopGlobalMemoryPolicySchema,
} from "../../shared/contracts/memory.ts";

export const memoryApi = {
  getGlobalMemoryPolicy: async () =>
    DesktopGlobalMemoryPolicySnapshotSchema.parse(
      await ipcRenderer.invoke("memory-policy:global:get"),
    ),
  updateGlobalMemoryPolicy: async (input) =>
    DesktopGlobalMemoryPolicySnapshotSchema.parse(
      await ipcRenderer.invoke(
        "memory-policy:global:update",
        UpdateDesktopGlobalMemoryPolicySchema.parse(input),
      ),
    ),
  getAssetMemoryPolicy: async (input) =>
    DesktopAssetMemoryPolicySnapshotSchema.parse(
      await ipcRenderer.invoke(
        "memory-policy:asset:get",
        GetDesktopAssetMemoryPolicySchema.parse(input),
      ),
    ),
  updateAssetMemoryPolicy: async (input) =>
    DesktopAssetMemoryPolicySnapshotSchema.parse(
      await ipcRenderer.invoke(
        "memory-policy:asset:update",
        UpdateDesktopAssetMemoryPolicySchema.parse(input),
      ),
    ),
  getMemoryPlaneStatus: async () =>
    DesktopMemoryPlaneStatusSchema.parse(await ipcRenderer.invoke("memory-plane:status")),
} satisfies Pick<
  PragmaDesktopAPI,
  | "getGlobalMemoryPolicy"
  | "updateGlobalMemoryPolicy"
  | "getAssetMemoryPolicy"
  | "updateAssetMemoryPolicy"
  | "getMemoryPlaneStatus"
>;
