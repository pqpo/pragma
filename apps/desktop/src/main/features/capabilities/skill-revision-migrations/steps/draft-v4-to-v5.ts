import {
  SkillRevisionDraftSchema,
  type SkillRevisionDraft,
} from "@pragma/built-in-agents/contracts";

import type { SkillRevisionDraftV4Stored } from "../schemas/draft-v4.ts";

export function migrateSkillRevisionDraftV4ToV5(
  source: SkillRevisionDraftV4Stored,
): SkillRevisionDraft {
  return SkillRevisionDraftSchema.parse({
    ...source,
    schemaVersion: "pragma.skill-revision-draft/v5",
  });
}
