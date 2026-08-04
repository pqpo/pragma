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
  DesktopSemanticFactSchema,
  ReviseDesktopSemanticFactSchema,
  ReviewDesktopSemanticFactSchema,
  DesktopMemoryItemListSchema,
  DesktopMemoryItemSchema,
  ListDesktopMemoryItemsSchema,
  DesktopMemoryItemRefSchema,
  GetDesktopMemoryEvidenceSchema,
  DesktopMemoryEvidenceSchema,
  TightenDesktopMemoryAccessSchema,
  ReviewDesktopMemoryItemSchema,
  DesktopMissionMemoryActivitySchema,
  DesktopMemoryExtractionJobListSchema,
  DesktopMemoryExtractionJobSchema,
  RetryDesktopMemoryExtractionJobSchema,
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
  listMemoryExtractionJobs: async () =>
    DesktopMemoryExtractionJobListSchema.parse(
      await ipcRenderer.invoke("memory-extraction-jobs:list"),
    ),
  retryMemoryExtractionJob: async (input) =>
    DesktopMemoryExtractionJobSchema.parse(
      await ipcRenderer.invoke(
        "memory-extraction-jobs:retry",
        RetryDesktopMemoryExtractionJobSchema.parse(input),
      ),
    ),
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
  listMemoryItems: async (input = {}) =>
    DesktopMemoryItemListSchema.parse(
      await ipcRenderer.invoke("memory-items:list", ListDesktopMemoryItemsSchema.parse(input)),
    ),
  getMemoryItem: async (input) =>
    DesktopMemoryItemSchema.parse(
      await ipcRenderer.invoke("memory-items:get", DesktopMemoryItemRefSchema.parse(input)),
    ),
  getMemoryItemHistory: async (input) =>
    DesktopMemoryItemListSchema.parse(
      await ipcRenderer.invoke("memory-items:history", DesktopMemoryItemRefSchema.parse(input)),
    ),
  getMemoryEvidence: async (input) =>
    DesktopMemoryEvidenceSchema.parse(
      await ipcRenderer.invoke(
        "memory-items:evidence",
        GetDesktopMemoryEvidenceSchema.parse(input),
      ),
    ),
  tightenMemoryAccess: async (input) =>
    DesktopMemoryItemSchema.parse(
      await ipcRenderer.invoke(
        "memory-items:tighten",
        TightenDesktopMemoryAccessSchema.parse(input),
      ),
    ),
  invalidateMemoryItem: async (input) =>
    DesktopMemoryItemSchema.parse(
      await ipcRenderer.invoke(
        "memory-items:invalidate",
        ReviewDesktopMemoryItemSchema.parse(input),
      ),
    ),
  forgetMemoryItem: async (input) => {
    await ipcRenderer.invoke("memory-items:forget", ReviewDesktopMemoryItemSchema.parse(input));
  },
  getMissionMemoryActivity: async (missionId) =>
    DesktopMissionMemoryActivitySchema.parse(
      await ipcRenderer.invoke("memory-mission:activity", { missionId }),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  | "getGlobalMemoryPolicy"
  | "updateGlobalMemoryPolicy"
  | "getAssetMemoryPolicy"
  | "updateAssetMemoryPolicy"
  | "getMemoryPlaneStatus"
  | "listMemoryExtractionJobs"
  | "retryMemoryExtractionJob"
  | "getMemoryExtractorProfile"
  | "updateMemoryExtractorProfile"
  | "reviseSemanticFact"
  | "verifySemanticFact"
  | "listMemoryItems"
  | "getMemoryItem"
  | "getMemoryItemHistory"
  | "getMemoryEvidence"
  | "tightenMemoryAccess"
  | "invalidateMemoryItem"
  | "forgetMemoryItem"
  | "getMissionMemoryActivity"
>;
