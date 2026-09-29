import { z } from "zod";
import { AssetGitTargetSchema, AssetGitSourceSchema } from "../../../shared/contracts/index.ts";

const CommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const RecordSchema = z.object({
  schemaVersion: z.literal("pragma.asset-git/v2"),
  knowledgeMetadataVersion: z.union([z.literal(0), z.literal(1)]),
  target: AssetGitTargetSchema,
  source: AssetGitSourceSchema,
  baseRevision: z.number().int().positive().optional(),
  remoteCommit: CommitSchema.optional(),
  syncedAt: z.string().datetime().optional(),
  conflictPaths: z.array(z.string()).optional(),
  error: z.string().optional(),
  errorPath: z.string().optional(),
});
export const JournalSchema = z.object({
  schemaVersion: z.literal("pragma.asset-git-journal/v2"),
  knowledgeMetadataVersion: z.union([z.literal(0), z.literal(1)]),
  target: AssetGitTargetSchema,
  source: AssetGitSourceSchema,
  baseRevision: z.number().int().positive(),
  remoteCommit: CommitSchema.optional(),
  phase: z.enum(["prepared", "pushed", "local_published"]),
  publishedRevision: z.number().int().positive().optional(),
});
export type AssetGitRecord = z.infer<typeof RecordSchema>;
export type AssetGitJournal = z.infer<typeof JournalSchema>;
