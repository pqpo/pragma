import { ipcMain } from "electron";

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
} from "../../../shared/contracts/index.ts";
import type { MemorySkillPromotionService } from "../memory/memory-skill-promotion.ts";
import type { SkillEvaluationProfileStore } from "./skill-agents.ts";
import type { SkillRevisionService } from "./skill-revision-service.ts";

export function installSkillLearningHandlers(options: {
  readonly promotion: MemorySkillPromotionService;
  readonly revisions: SkillRevisionService;
  readonly evaluationProfiles: SkillEvaluationProfileStore;
}): void {
  ipcMain.handle("memory-skill-candidates:list", async (_event, input: unknown) =>
    MemorySkillCandidateSchema.array().parse(
      await options.promotion.list((() => {
        const parsed = ListMemorySkillCandidatesSchema.parse(input ?? {});
        return parsed.state === undefined ? {} : { state: parsed.state };
      })()),
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
  ipcMain.handle("skill-revisions:submit", async (_event, input: unknown) => {
    const job = await options.revisions.submit(SkillRevisionRequestSchema.parse(input));
    options.revisions.scheduleProcessing();
    return SkillRevisionJobSchema.parse(job);
  });
  ipcMain.handle("skill-revisions:list", async (_event, input: unknown) =>
    SkillRevisionJobSchema.array().parse(
      await options.revisions.list(ListSkillRevisionJobsSchema.parse(input ?? {})),
    ),
  );
  for (const [channel, action] of [
    ["approve", options.revisions.approve.bind(options.revisions)],
    ["reject", options.revisions.reject.bind(options.revisions)],
    ["retry", options.revisions.retry.bind(options.revisions)],
  ] as const) {
    ipcMain.handle(`skill-revisions:${channel}`, async (_event, input: unknown) => {
      const ref = SkillRevisionJobRefSchema.parse(input);
      return SkillRevisionJobSchema.parse(await action(ref.jobId, ref.expectedRevision));
    });
  }
  ipcMain.handle("skill-revisions:delete", async (_event, input: unknown) => {
    const ref = SkillRevisionJobRefSchema.parse(input);
    await options.revisions.delete(ref.jobId, ref.expectedRevision);
  });
  ipcMain.handle("skill-evaluation-profile:get", async () =>
    SkillEvaluationProfileSchema.parse(await options.evaluationProfiles.get()),
  );
  ipcMain.handle("skill-evaluation-profile:update", async (_event, input: unknown) =>
    SkillEvaluationProfileSchema.parse(
      await options.evaluationProfiles.update(UpdateSkillEvaluationProfileSchema.parse(input)),
    ),
  );
}
