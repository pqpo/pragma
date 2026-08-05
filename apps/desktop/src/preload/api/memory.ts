import { ipcRenderer } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  DesktopAssetMemoryPolicySnapshotSchema,
  DesktopGlobalMemoryPolicySnapshotSchema,
  DesktopMemoryPlaneStatusSchema,
  DesktopMemoryExtractorProfileSchema,
  DesktopMemoryExtractionSettingsSchema,
  GetDesktopAssetMemoryPolicySchema,
  UpdateDesktopAssetMemoryPolicySchema,
  UpdateDesktopGlobalMemoryPolicySchema,
  UpdateDesktopMemoryExtractorProfileSchema,
  UpdateDesktopMemoryExtractionSettingsSchema,
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
  DesktopMemoryExtractionBoardSchema,
  ManageDesktopMemoryExtractionTaskSchema,
  DesktopKnowledgeCandidateSchema,
  DesktopKnowledgeCandidateListSchema,
  ListDesktopKnowledgeCandidatesSchema,
  UpdateDesktopKnowledgeCandidateSchema,
  RejectDesktopKnowledgeCandidateSchema,
  PublishDesktopKnowledgeCandidateSchema,
  CreateDesktopKnowledgeSuccessorSchema,
  DesktopKnowledgeSchema,
  GetDesktopKnowledgeSourceSchema,
  DesktopKnowledgeSourceSchema,
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
    DesktopMemoryExtractionBoardSchema.parse(
      await ipcRenderer.invoke("memory-extraction-jobs:list"),
    ),
  manageMemoryExtractionTask: async (input) => {
    await ipcRenderer.invoke(
      "memory-extraction-jobs:manage",
      ManageDesktopMemoryExtractionTaskSchema.parse(input),
    );
  },
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
  getMemoryExtractionSettings: async () =>
    DesktopMemoryExtractionSettingsSchema.parse(
      await ipcRenderer.invoke("memory-extraction-settings:get"),
    ),
  updateMemoryExtractionSettings: async (input) =>
    DesktopMemoryExtractionSettingsSchema.parse(
      await ipcRenderer.invoke(
        "memory-extraction-settings:update",
        UpdateDesktopMemoryExtractionSettingsSchema.parse(input),
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
  listKnowledgeCandidates: async (input = {}) =>
    DesktopKnowledgeCandidateListSchema.parse(
      await ipcRenderer.invoke(
        "memory-knowledge-candidates:list",
        ListDesktopKnowledgeCandidatesSchema.parse(input),
      ),
    ),
  updateKnowledgeCandidate: async (input) =>
    DesktopKnowledgeCandidateSchema.parse(
      await ipcRenderer.invoke(
        "memory-knowledge-candidates:update",
        UpdateDesktopKnowledgeCandidateSchema.parse(input),
      ),
    ),
  rejectKnowledgeCandidate: async (input) =>
    DesktopKnowledgeCandidateSchema.parse(
      await ipcRenderer.invoke(
        "memory-knowledge-candidates:reject",
        RejectDesktopKnowledgeCandidateSchema.parse(input),
      ),
    ),
  publishKnowledgeCandidate: async (input) =>
    DesktopKnowledgeSchema.parse(
      await ipcRenderer.invoke(
        "memory-knowledge-candidates:publish",
        PublishDesktopKnowledgeCandidateSchema.parse(input),
      ),
    ),
  createKnowledgeSuccessor: async (input) =>
    DesktopKnowledgeCandidateSchema.parse(
      await ipcRenderer.invoke(
        "memory-knowledge:successor",
        CreateDesktopKnowledgeSuccessorSchema.parse(input),
      ),
    ),
  getKnowledgeSource: async (input) =>
    DesktopKnowledgeSourceSchema.parse(
      await ipcRenderer.invoke(
        "memory-knowledge-source:get",
        GetDesktopKnowledgeSourceSchema.parse(input),
      ),
    ),
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
  | "manageMemoryExtractionTask"
  | "getMemoryExtractorProfile"
  | "updateMemoryExtractorProfile"
  | "getMemoryExtractionSettings"
  | "updateMemoryExtractionSettings"
  | "reviseSemanticFact"
  | "verifySemanticFact"
  | "listMemoryItems"
  | "getMemoryItem"
  | "getMemoryItemHistory"
  | "getMemoryEvidence"
  | "tightenMemoryAccess"
  | "invalidateMemoryItem"
  | "forgetMemoryItem"
  | "listKnowledgeCandidates"
  | "updateKnowledgeCandidate"
  | "rejectKnowledgeCandidate"
  | "publishKnowledgeCandidate"
  | "createKnowledgeSuccessor"
  | "getKnowledgeSource"
  | "getMissionMemoryActivity"
>;
