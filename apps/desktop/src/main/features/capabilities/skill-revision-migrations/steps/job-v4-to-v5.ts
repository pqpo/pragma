import {
  ManagedSkillRevisionJobSchema,
  type ManagedSkillRevisionJob,
} from "@pragma/built-in-agents/contracts";

import type { SkillRevisionJobV4Stored } from "../schemas/job-v4.ts";

export function migrateSkillRevisionJobV4ToV5(
  source: SkillRevisionJobV4Stored,
): ManagedSkillRevisionJob {
  return ManagedSkillRevisionJobSchema.parse({
    ...source,
    schemaVersion: "pragma.skill-revision-job/v5",
  });
}
