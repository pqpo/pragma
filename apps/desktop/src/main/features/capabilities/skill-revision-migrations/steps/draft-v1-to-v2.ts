import {
  SkillRevisionDraftSchema,
  type SkillRevisionDraft,
} from "@pragma/built-in-agents/contracts";

import type { SkillRevisionDraftV1 } from "../schemas/draft-v1.ts";

export function migrateSkillRevisionDraftV1ToV2(source: SkillRevisionDraftV1): SkillRevisionDraft {
  return SkillRevisionDraftSchema.parse({
    ...source,
    schemaVersion: "pragma.skill-revision-draft/v2",
    operation: "revise",
  });
}
