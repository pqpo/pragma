import {
  ManagedSkillRevisionJobSchema,
  type ManagedSkillRevisionJob,
} from "@pragma/built-in-agents/contracts";

import type { SkillRevisionJobV3Stored } from "../schemas/job-v3.ts";

export function migrateSkillRevisionJobV3ToV4(
  source: SkillRevisionJobV3Stored,
): ManagedSkillRevisionJob {
  const requiresResubmission =
    source.state === "evaluating" || source.error?.code === "skill_evaluation_failed";
  const request: Record<string, unknown> = { ...source.request };
  delete request["replayCases"];
  delete request["boundaryCase"];
  const job: Record<string, unknown> = { ...source };
  delete job["evaluation"];
  return ManagedSkillRevisionJobSchema.parse({
    ...job,
    schemaVersion: "pragma.skill-revision-job/v4",
    revision: source.revision + 1,
    request: {
      ...request,
      schemaVersion: "pragma.skill-revision-request/v4",
    },
    state: requiresResubmission ? "needs_attention" : source.state,
    ...(requiresResubmission
      ? {
          error: {
            code: "skill_revision_validation_required",
            message:
              "Skill evaluation was removed. Re-submit the draft for synchronous validation.",
          },
        }
      : {}),
    updatedAt: source.updatedAt,
  });
}
