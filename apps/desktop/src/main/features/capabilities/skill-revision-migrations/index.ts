export { SkillRevisionDraftV1Schema } from "./schemas/draft-v1.ts";
export { SkillRevisionDraftV2StoredSchema } from "./schemas/draft-v2.ts";
export {
  SkillRevisionDraftV3StoredSchema,
  type SkillRevisionDraftV3Stored,
} from "./schemas/draft-v3.ts";
export {
  SkillRevisionDraftV4StoredSchema,
  type SkillRevisionDraftV4Stored,
} from "./schemas/draft-v4.ts";
export {
  SkillRevisionJobV1StoredSchema,
  SkillRevisionRequestV1StoredSchema,
  type SkillRevisionJobV1Stored,
  type SkillRevisionRequestV1Stored,
} from "./schemas/job-v1.ts";
export { SkillRevisionJobV2StoredSchema } from "./schemas/job-v2.ts";
export { SkillRevisionJobV3StoredSchema } from "./schemas/job-v3.ts";
export { SkillRevisionJobV4StoredSchema } from "./schemas/job-v4.ts";
export { migrateSkillRevisionDraftV1ToV2 } from "./steps/draft-v1-to-v2.ts";
export { migrateSkillRevisionDraftV2ToV3 } from "./steps/draft-v2-to-v3.ts";
export { migrateSkillRevisionDraftV3ToV4 } from "./steps/draft-v3-to-v4.ts";
export { migrateSkillRevisionDraftV4ToV5 } from "./steps/draft-v4-to-v5.ts";
export { migrateSkillRevisionJobV2ToV3 } from "./steps/job-v2-to-v3.ts";
export { migrateSkillRevisionJobV3ToV4 } from "./steps/job-v3-to-v4.ts";
export { migrateSkillRevisionJobV4ToV5 } from "./steps/job-v4-to-v5.ts";
export {
  SkillRevisionMigrationJournalSchema,
  type SkillRevisionMigrationJournal,
} from "./journal.ts";

export const SKILL_REVISION_STORAGE_MIGRATIONS = Object.freeze({
  draft: Object.freeze([
    Object.freeze({
      from: "pragma.skill-revision-draft/v1" as const,
      to: "pragma.skill-revision-draft/v2" as const,
    }),
    Object.freeze({
      from: "pragma.skill-revision-draft/v2" as const,
      to: "pragma.skill-revision-draft/v3" as const,
    }),
    Object.freeze({
      from: "pragma.skill-revision-draft/v3" as const,
      to: "pragma.skill-revision-draft/v4" as const,
    }),
    Object.freeze({
      from: "pragma.skill-revision-draft/v4" as const,
      to: "pragma.skill-revision-draft/v5" as const,
    }),
  ]),
  job: Object.freeze([
    Object.freeze({
      from: "pragma.skill-revision-job/v2" as const,
      to: "pragma.skill-revision-job/v3" as const,
    }),
    Object.freeze({
      from: "pragma.skill-revision-job/v3" as const,
      to: "pragma.skill-revision-job/v4" as const,
    }),
    Object.freeze({
      from: "pragma.skill-revision-job/v4" as const,
      to: "pragma.skill-revision-job/v5" as const,
    }),
  ]),
});
