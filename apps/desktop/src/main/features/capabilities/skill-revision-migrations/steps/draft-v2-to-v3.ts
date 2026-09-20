import type { SkillRevisionDraftV2Stored } from "../schemas/draft-v2.ts";
import {
  SkillRevisionDraftV3StoredSchema,
  type SkillRevisionDraftV3Stored,
} from "../schemas/draft-v3.ts";

export function migrateSkillRevisionDraftV2ToV3(
  source: SkillRevisionDraftV2Stored,
): SkillRevisionDraftV3Stored {
  const requiresResubmission = source.state === "evaluating";
  return SkillRevisionDraftV3StoredSchema.parse({
    ...source,
    schemaVersion: "pragma.skill-revision-draft/v3",
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
  });
}
