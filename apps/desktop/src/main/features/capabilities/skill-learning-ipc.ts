import { ipcMain } from "electron";

import {
  ListMemorySkillCandidatesSchema,
  MemorySkillCandidateRefSchema,
  MemorySkillCandidateSchema,
  ResolveMemorySkillTargetSchema,
  SkillEvaluationProfileSchema,
  UpdateMemorySkillCandidateSchema,
  UpdateSkillEvaluationProfileSchema,
} from "../../../shared/contracts/index.ts";
import type { MemorySkillPromotionService } from "../memory/memory-skill-promotion.ts";
import type { SkillEvaluationProfileStore } from "./skill-agents.ts";

export function installSkillLearningHandlers(options: {
  readonly promotion: MemorySkillPromotionService;
  readonly evaluationProfiles: SkillEvaluationProfileStore;
}): void {
  ipcMain.handle("memory-skill-candidates:list", async (_event, input: unknown) =>
    MemorySkillCandidateSchema.array().parse(
      await options.promotion.list(
        (() => {
          const parsed = ListMemorySkillCandidatesSchema.parse(input ?? {});
          return parsed.state === undefined ? {} : { state: parsed.state };
        })(),
      ),
    ),
  );
  ipcMain.handle("memory-skill-candidates:update", async (_event, input: unknown) =>
    MemorySkillCandidateSchema.parse(
      await options.promotion.update(UpdateMemorySkillCandidateSchema.parse(input)),
    ),
  );
  ipcMain.handle("memory-skill-candidates:resolve-target", async (_event, input: unknown) =>
    MemorySkillCandidateSchema.parse(
      await options.promotion.resolveTarget(ResolveMemorySkillTargetSchema.parse(input)),
    ),
  );
  ipcMain.handle("memory-skill-candidates:reject", async (_event, input: unknown) =>
    MemorySkillCandidateSchema.parse(
      await options.promotion.reject(MemorySkillCandidateRefSchema.parse(input)),
    ),
  );
  ipcMain.handle("memory-skill-candidates:approve", async (_event, input: unknown) =>
    MemorySkillCandidateSchema.parse(
      await options.promotion.approve(MemorySkillCandidateRefSchema.parse(input)),
    ),
  );
  ipcMain.handle("memory-skill-candidates:retry", async (_event, input: unknown) =>
    MemorySkillCandidateSchema.parse(
      await options.promotion.retry(MemorySkillCandidateRefSchema.parse(input)),
    ),
  );
  ipcMain.handle("skill-evaluation-profile:get", async () =>
    SkillEvaluationProfileSchema.parse(await options.evaluationProfiles.get()),
  );
  ipcMain.handle("skill-evaluation-profile:update", async (_event, input: unknown) =>
    SkillEvaluationProfileSchema.parse(
      await options.evaluationProfiles.update(UpdateSkillEvaluationProfileSchema.parse(input)),
    ),
  );
}
