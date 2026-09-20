import { ipcRenderer } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  ListMemorySkillCandidatesSchema,
  MemorySkillCandidateRefSchema,
  MemorySkillCandidateSchema,
  ResolveMemorySkillTargetSchema,
  UpdateMemorySkillCandidateSchema,
} from "../../shared/contracts/skill-learning.ts";

export const skillLearningApi = {
  listMemorySkillCandidates: async (input = {}) =>
    MemorySkillCandidateSchema.array().parse(
      await ipcRenderer.invoke(
        "memory-skill-candidates:list",
        ListMemorySkillCandidatesSchema.parse(input),
      ),
    ),
  updateMemorySkillCandidate: async (input) =>
    MemorySkillCandidateSchema.parse(
      await ipcRenderer.invoke(
        "memory-skill-candidates:update",
        UpdateMemorySkillCandidateSchema.parse(input),
      ),
    ),
  resolveMemorySkillTarget: async (input) =>
    MemorySkillCandidateSchema.parse(
      await ipcRenderer.invoke(
        "memory-skill-candidates:resolve-target",
        ResolveMemorySkillTargetSchema.parse(input),
      ),
    ),
  rejectMemorySkillCandidate: async (input) =>
    MemorySkillCandidateSchema.parse(
      await ipcRenderer.invoke(
        "memory-skill-candidates:reject",
        MemorySkillCandidateRefSchema.parse(input),
      ),
    ),
  approveMemorySkillCandidate: async (input) =>
    MemorySkillCandidateSchema.parse(
      await ipcRenderer.invoke(
        "memory-skill-candidates:approve",
        MemorySkillCandidateRefSchema.parse(input),
      ),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  | "listMemorySkillCandidates"
  | "updateMemorySkillCandidate"
  | "resolveMemorySkillTarget"
  | "rejectMemorySkillCandidate"
  | "approveMemorySkillCandidate"
>;
