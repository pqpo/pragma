import {
  ManagedSkillRevisionJobSchema,
  type ManagedSkillRevisionJob,
} from "@pragma/built-in-agents/contracts";

import type { SkillRevisionJobV2Stored } from "../schemas/job-v2.ts";

export function migrateSkillRevisionJobV2ToV3(
  source: SkillRevisionJobV2Stored,
): ManagedSkillRevisionJob {
  return ManagedSkillRevisionJobSchema.parse({
    ...source,
    schemaVersion: "pragma.skill-revision-job/v3",
    revision: source.revision + 1,
    request: {
      ...source.request,
      schemaVersion: "pragma.skill-revision-request/v3",
      operation: "revise",
    },
    updatedAt: new Date().toISOString(),
  });
}
