import { ipcRenderer } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  DesktopAssetMemoryPolicySnapshotSchema,
  DesktopGlobalMemoryPolicySnapshotSchema,
  DesktopMemoryPlaneStatusSchema,
  DesktopMemoryExtractorProfileSchema,
  GetDesktopAssetMemoryPolicySchema,
  UpdateDesktopAssetMemoryPolicySchema,
  UpdateDesktopGlobalMemoryPolicySchema,
  UpdateDesktopMemoryExtractorProfileSchema,
  DesktopSemanticFactListSchema,
  DesktopSemanticFactSchema,
  GetDesktopSemanticFactSchema,
  ListDesktopSemanticFactsSchema,
  SearchDesktopSemanticFactsSchema,
  ReviseDesktopSemanticFactSchema,
  ReviewDesktopSemanticFactSchema,
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
  getMemoryExtractorProfile: async () =>
    DesktopMemoryExtractorProfileSchema.parse(
      await ipcRenderer.invoke("memory-extractor-profile:get"),
    ),
  updateMemoryExtractorProfile: async (input) =>
    DesktopMemoryExtractorProfileSchema.parse(
      await ipcRenderer.invoke(
        "memory-extractor-profile:update",
        UpdateDesktopMemoryExtractorProfileSchema.parse(input),
      ),
    ),
  listSemanticFacts: async (input = {}) =>
    DesktopSemanticFactListSchema.parse(
      await ipcRenderer.invoke("memory-semantic:list", ListDesktopSemanticFactsSchema.parse(input)),
    ),
  searchSemanticFacts: async (input) =>
    DesktopSemanticFactListSchema.parse(
      await ipcRenderer.invoke(
        "memory-semantic:search",
        SearchDesktopSemanticFactsSchema.parse(input),
      ),
    ),
  getSemanticFact: async (input) =>
    DesktopSemanticFactSchema.parse(
      await ipcRenderer.invoke("memory-semantic:get", GetDesktopSemanticFactSchema.parse(input)),
    ),
  getSemanticFactHistory: async (input) =>
    DesktopSemanticFactListSchema.parse(
      await ipcRenderer.invoke(
        "memory-semantic:history",
        GetDesktopSemanticFactSchema.parse(input),
      ),
    ),
  reviseSemanticFact: async (input) =>
    DesktopSemanticFactSchema.parse(
      await ipcRenderer.invoke(
        "memory-semantic:revise",
        ReviseDesktopSemanticFactSchema.parse(input),
      ),
    ),
  verifySemanticFact: async (input) =>
    DesktopSemanticFactSchema.parse(
      await ipcRenderer.invoke(
        "memory-semantic:verify",
        ReviewDesktopSemanticFactSchema.parse(input),
      ),
    ),
  invalidateSemanticFact: async (input) =>
    DesktopSemanticFactSchema.parse(
      await ipcRenderer.invoke(
        "memory-semantic:invalidate",
        ReviewDesktopSemanticFactSchema.parse(input),
      ),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  | "getGlobalMemoryPolicy"
  | "updateGlobalMemoryPolicy"
  | "getAssetMemoryPolicy"
  | "updateAssetMemoryPolicy"
  | "getMemoryPlaneStatus"
  | "getMemoryExtractorProfile"
  | "updateMemoryExtractorProfile"
  | "listSemanticFacts"
  | "searchSemanticFacts"
  | "getSemanticFact"
  | "getSemanticFactHistory"
  | "reviseSemanticFact"
  | "verifySemanticFact"
  | "invalidateSemanticFact"
>;
