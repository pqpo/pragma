import type { SkillRevisionJobV2Stored } from "../schemas/job-v2.ts";
import {
  SkillRevisionJobV3StoredSchema,
  type SkillRevisionJobV3Stored,
} from "../schemas/job-v3.ts";

export function migrateSkillRevisionJobV2ToV3(
  source: SkillRevisionJobV2Stored,
): SkillRevisionJobV3Stored {
  return SkillRevisionJobV3StoredSchema.parse({
    ...source,
    schemaVersion: "pragma.skill-revision-job/v3",
    revision: source.revision + 1,
    request: {
      ...source.request,
      schemaVersion: "pragma.skill-revision-request/v3",
      operation: "revise",
    },
    updatedAt: source.updatedAt,
  });
}
