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
  ListDesktopMemoryExtractionJobsSchema,
  ManageDesktopMemoryExtractionTaskSchema,
  MemoryKnowledgeInitializationCandidateSchema,
  ListMemoryKnowledgeInitializationCandidatesSchema,
  MemoryKnowledgeInitializationCandidateRefSchema,
  UpdateMemoryKnowledgeInitializationCandidateSchema,
} from "../../shared/contracts/memory.ts";
import { ContextStoreSchema } from "../../shared/contracts/context-stores.ts";
import {
  ExpertMemoryContextStoreContentSchema,
  ExpertMemoryContextStoreDescriptorSchema,
  ExpertMemoryContextStoreEntrySchema,
  ExpertMemoryContextStoreSearchMatchSchema,
  GetExpertMemoryContextStoreSchema,
  ListExpertMemoryContextStoreEntriesSchema,
  ReadExpertMemoryContextStoreEntrySchema,
  SearchExpertMemoryContextStoreSchema,
  GetTeamMemoryContextStoreSchema,
  ListTeamMemoryContextStoreEntriesSchema,
  ReadTeamMemoryContextStoreEntrySchema,
  SearchTeamMemoryContextStoreSchema,
  TeamMemoryContextStoreDescriptorSchema,
  TeamMemoryContextStoreEntrySchema,
  TeamMemoryContextStoreContentSchema,
  TeamMemoryContextStoreSearchMatchSchema,
} from "../../shared/contracts/context-store-browser.ts";

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
  listMemoryExtractionJobs: async (input) =>
    DesktopMemoryExtractionBoardSchema.parse(
      await ipcRenderer.invoke(
        "memory-extraction-jobs:list",
        ListDesktopMemoryExtractionJobsSchema.parse(input),
      ),
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
  listMemoryKnowledgeInitializations: async (input = {}) =>
    MemoryKnowledgeInitializationCandidateSchema.array().parse(
      await ipcRenderer.invoke(
        "memory-knowledge-initializations:list",
        ListMemoryKnowledgeInitializationCandidatesSchema.parse(input),
      ),
    ),
  updateMemoryKnowledgeInitialization: async (input) =>
    MemoryKnowledgeInitializationCandidateSchema.parse(
      await ipcRenderer.invoke(
        "memory-knowledge-initializations:update",
        UpdateMemoryKnowledgeInitializationCandidateSchema.parse(input),
      ),
    ),
  rejectMemoryKnowledgeInitialization: async (input) =>
    MemoryKnowledgeInitializationCandidateSchema.parse(
      await ipcRenderer.invoke(
        "memory-knowledge-initializations:reject",
        MemoryKnowledgeInitializationCandidateRefSchema.parse(input),
      ),
    ),
  createMemoryKnowledgeStore: async (input) =>
    ContextStoreSchema.parse(
      await ipcRenderer.invoke(
        "memory-knowledge-initializations:create-store",
        MemoryKnowledgeInitializationCandidateRefSchema.parse(input),
      ),
    ),
  getMissionMemoryActivity: async (missionId) =>
    DesktopMissionMemoryActivitySchema.parse(
      await ipcRenderer.invoke("memory-mission:activity", { missionId }),
    ),
  getExpertMemoryContextStore: async (input) =>
    ExpertMemoryContextStoreDescriptorSchema.parse(
      await ipcRenderer.invoke(
        "expert-memory-context-stores:get",
        GetExpertMemoryContextStoreSchema.parse(input),
      ),
    ),
  listExpertMemoryContextStoreEntries: async (input) =>
    ExpertMemoryContextStoreEntrySchema.array().parse(
      await ipcRenderer.invoke(
        "expert-memory-context-stores:list",
        ListExpertMemoryContextStoreEntriesSchema.parse(input),
      ),
    ),
  readExpertMemoryContextStoreEntry: async (input) =>
    ExpertMemoryContextStoreContentSchema.parse(
      await ipcRenderer.invoke(
        "expert-memory-context-stores:read",
        ReadExpertMemoryContextStoreEntrySchema.parse(input),
      ),
    ),
  searchExpertMemoryContextStore: async (input) =>
    ExpertMemoryContextStoreSearchMatchSchema.array().parse(
      await ipcRenderer.invoke(
        "expert-memory-context-stores:search",
        SearchExpertMemoryContextStoreSchema.parse(input),
      ),
    ),
  getTeamMemoryContextStore: async (input) =>
    TeamMemoryContextStoreDescriptorSchema.parse(
      await ipcRenderer.invoke(
        "team-memory-context-stores:get",
        GetTeamMemoryContextStoreSchema.parse(input),
      ),
    ),
  listTeamMemoryContextStoreEntries: async (input) =>
    TeamMemoryContextStoreEntrySchema.array().parse(
      await ipcRenderer.invoke(
        "team-memory-context-stores:list",
        ListTeamMemoryContextStoreEntriesSchema.parse(input),
      ),
    ),
  readTeamMemoryContextStoreEntry: async (input) =>
    TeamMemoryContextStoreContentSchema.parse(
      await ipcRenderer.invoke(
        "team-memory-context-stores:read",
        ReadTeamMemoryContextStoreEntrySchema.parse(input),
      ),
    ),
  searchTeamMemoryContextStore: async (input) =>
    TeamMemoryContextStoreSearchMatchSchema.array().parse(
      await ipcRenderer.invoke(
        "team-memory-context-stores:search",
        SearchTeamMemoryContextStoreSchema.parse(input),
      ),
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
  | "listMemoryKnowledgeInitializations"
  | "updateMemoryKnowledgeInitialization"
  | "rejectMemoryKnowledgeInitialization"
  | "createMemoryKnowledgeStore"
  | "getMissionMemoryActivity"
  | "getExpertMemoryContextStore"
  | "listExpertMemoryContextStoreEntries"
  | "readExpertMemoryContextStoreEntry"
  | "searchExpertMemoryContextStore"
  | "getTeamMemoryContextStore"
  | "listTeamMemoryContextStoreEntries"
  | "readTeamMemoryContextStoreEntry"
  | "searchTeamMemoryContextStore"
>;
