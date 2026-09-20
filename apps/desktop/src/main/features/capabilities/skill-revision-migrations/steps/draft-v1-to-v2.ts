import {
  SkillRevisionDraftV2StoredSchema,
  type SkillRevisionDraftV2Stored,
} from "../schemas/draft-v2.ts";
import type { SkillRevisionDraftV1 } from "../schemas/draft-v1.ts";

export function migrateSkillRevisionDraftV1ToV2(
  source: SkillRevisionDraftV1,
): SkillRevisionDraftV2Stored {
  return SkillRevisionDraftV2StoredSchema.parse({
    ...source,
    schemaVersion: "pragma.skill-revision-draft/v2",
    operation: "revise",
  });
}
