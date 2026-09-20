import { z } from "zod";

const BaseSkillRevisionMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.skill-revision-migration/v1"),
  recordId: z.string().uuid(),
  recordPath: z.string().min(1),
  backupPath: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const SkillRevisionMigrationJournalSchema = z.discriminatedUnion("sourceVersion", [
  BaseSkillRevisionMigrationJournalSchema.extend({
    kind: z.literal("job"),
    sourceVersion: z.literal("pragma.skill-revision-job/v2"),
    targetVersion: z.literal("pragma.skill-revision-job/v3"),
  }).strict(),
  BaseSkillRevisionMigrationJournalSchema.extend({
    kind: z.literal("job"),
    sourceVersion: z.literal("pragma.skill-revision-job/v3"),
    targetVersion: z.literal("pragma.skill-revision-job/v4"),
  }).strict(),
  BaseSkillRevisionMigrationJournalSchema.extend({
    kind: z.literal("draft"),
    sourceVersion: z.literal("pragma.skill-revision-draft/v1"),
    targetVersion: z.literal("pragma.skill-revision-draft/v2"),
  }).strict(),
  BaseSkillRevisionMigrationJournalSchema.extend({
    kind: z.literal("draft"),
    sourceVersion: z.literal("pragma.skill-revision-draft/v2"),
    targetVersion: z.literal("pragma.skill-revision-draft/v3"),
  }).strict(),
  BaseSkillRevisionMigrationJournalSchema.extend({
    kind: z.literal("draft"),
    sourceVersion: z.literal("pragma.skill-revision-draft/v3"),
    targetVersion: z.literal("pragma.skill-revision-draft/v4"),
    workspacePath: z.string().min(1).max(4_000),
    sourceWorktreePath: z.string().min(1).max(4_000),
    targetWorktreePath: z.string().min(1).max(4_000),
  }).strict(),
]);

export type SkillRevisionMigrationJournal = z.infer<typeof SkillRevisionMigrationJournalSchema>;
