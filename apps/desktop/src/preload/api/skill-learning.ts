import { ipcRenderer } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  ListMemorySkillCandidatesSchema,
  ListSkillRevisionJobsSchema,
  MemorySkillCandidateRefSchema,
  MemorySkillCandidateSchema,
  ResolveMemorySkillTargetSchema,
  SkillEvaluationProfileSchema,
  SkillRevisionJobRefSchema,
  SkillRevisionJobSchema,
  SkillRevisionRequestSchema,
  UpdateMemorySkillCandidateSchema,
  UpdateSkillEvaluationProfileSchema,
} from "../../shared/contracts/skill-learning.ts";

export const skillLearningApi = {
  listMemorySkillCandidates: async (input = {}) => MemorySkillCandidateSchema.array().parse(await ipcRenderer.invoke("memory-skill-candidates:list", ListMemorySkillCandidatesSchema.parse(input))),
  updateMemorySkillCandidate: async (input) => MemorySkillCandidateSchema.parse(await ipcRenderer.invoke("memory-skill-candidates:update", UpdateMemorySkillCandidateSchema.parse(input))),
  resolveMemorySkillTarget: async (input) => MemorySkillCandidateSchema.parse(await ipcRenderer.invoke("memory-skill-candidates:resolve-target", ResolveMemorySkillTargetSchema.parse(input))),
  rejectMemorySkillCandidate: async (input) => MemorySkillCandidateSchema.parse(await ipcRenderer.invoke("memory-skill-candidates:reject", MemorySkillCandidateRefSchema.parse(input))),
  approveMemorySkillCandidate: async (input) => MemorySkillCandidateSchema.parse(await ipcRenderer.invoke("memory-skill-candidates:approve", MemorySkillCandidateRefSchema.parse(input))),
  retryMemorySkillCandidate: async (input) => MemorySkillCandidateSchema.parse(await ipcRenderer.invoke("memory-skill-candidates:retry", MemorySkillCandidateRefSchema.parse(input))),
  submitSkillRevision: async (input) => SkillRevisionJobSchema.parse(await ipcRenderer.invoke("skill-revisions:submit", SkillRevisionRequestSchema.parse(input))),
  listSkillRevisions: async (input = {}) => SkillRevisionJobSchema.array().parse(await ipcRenderer.invoke("skill-revisions:list", ListSkillRevisionJobsSchema.parse(input))),
  approveSkillRevision: async (input) => SkillRevisionJobSchema.parse(await ipcRenderer.invoke("skill-revisions:approve", SkillRevisionJobRefSchema.parse(input))),
  rejectSkillRevision: async (input) => SkillRevisionJobSchema.parse(await ipcRenderer.invoke("skill-revisions:reject", SkillRevisionJobRefSchema.parse(input))),
  retrySkillRevision: async (input) => SkillRevisionJobSchema.parse(await ipcRenderer.invoke("skill-revisions:retry", SkillRevisionJobRefSchema.parse(input))),
  deleteSkillRevision: async (input) => { await ipcRenderer.invoke("skill-revisions:delete", SkillRevisionJobRefSchema.parse(input)); },
  getSkillEvaluationProfile: async () => SkillEvaluationProfileSchema.parse(await ipcRenderer.invoke("skill-evaluation-profile:get")),
  updateSkillEvaluationProfile: async (input) => SkillEvaluationProfileSchema.parse(await ipcRenderer.invoke("skill-evaluation-profile:update", UpdateSkillEvaluationProfileSchema.parse(input))),
} satisfies Pick<PragmaDesktopAPI,
  | "listMemorySkillCandidates" | "updateMemorySkillCandidate" | "resolveMemorySkillTarget"
  | "rejectMemorySkillCandidate" | "approveMemorySkillCandidate" | "retryMemorySkillCandidate"
  | "submitSkillRevision" | "listSkillRevisions" | "approveSkillRevision" | "rejectSkillRevision"
  | "retrySkillRevision" | "deleteSkillRevision" | "getSkillEvaluationProfile" | "updateSkillEvaluationProfile"
>;
