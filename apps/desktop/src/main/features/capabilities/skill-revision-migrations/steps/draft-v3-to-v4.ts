import {
  SkillRevisionDraftSchema,
  type SkillRevisionDraft,
} from "@pragma/built-in-agents/contracts";

import type { SkillRevisionDraftV3Stored } from "../schemas/draft-v3.ts";

export function migrateSkillRevisionDraftV3ToV4(
  source: SkillRevisionDraftV3Stored,
  workspacePath: string,
): SkillRevisionDraft {
  return SkillRevisionDraftSchema.parse({
    ...source,
    schemaVersion: "pragma.skill-revision-draft/v4",
    workspacePath,
  });
}
