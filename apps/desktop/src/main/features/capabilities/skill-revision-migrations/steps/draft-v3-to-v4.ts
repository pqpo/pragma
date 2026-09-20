import type { SkillRevisionDraftV3Stored } from "../schemas/draft-v3.ts";
import {
  SkillRevisionDraftV4StoredSchema,
  type SkillRevisionDraftV4Stored,
} from "../schemas/draft-v4.ts";

export function migrateSkillRevisionDraftV3ToV4(
  source: SkillRevisionDraftV3Stored,
  workspacePath: string,
): SkillRevisionDraftV4Stored {
  return SkillRevisionDraftV4StoredSchema.parse({
    ...source,
    schemaVersion: "pragma.skill-revision-draft/v4",
    workspacePath,
  });
}
