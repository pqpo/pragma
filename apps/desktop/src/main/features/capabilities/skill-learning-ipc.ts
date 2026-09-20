import { ipcMain } from "electron";

import {
  ListMemorySkillCandidatesSchema,
  MemorySkillCandidateRefSchema,
  MemorySkillCandidateSchema,
  ResolveMemorySkillTargetSchema,
  UpdateMemorySkillCandidateSchema,
} from "../../../shared/contracts/index.ts";
import type { MemorySkillPromotionService } from "../memory/memory-skill-promotion.ts";

export function installSkillLearningHandlers(options: {
  readonly promotion: MemorySkillPromotionService;
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
}
