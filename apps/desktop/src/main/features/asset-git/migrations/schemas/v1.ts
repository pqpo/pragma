import { z } from "zod";
import {
  AssetGitTargetSchema,
  AssetGitSourceSchema,
} from "../../../../../shared/contracts/index.ts";

const CommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const AssetGitRecordV1Schema = z.object({
  schemaVersion: z.literal("pragma.asset-git/v1"),
  target: AssetGitTargetSchema,
  source: AssetGitSourceSchema,
  baseRevision: z.number().int().positive().optional(),
  remoteCommit: CommitSchema.optional(),
  syncedAt: z.string().datetime().optional(),
  conflictPaths: z.array(z.string()).optional(),
  error: z.string().optional(),
});
export const AssetGitJournalV1Schema = z.object({
  schemaVersion: z.literal("pragma.asset-git-journal/v1"),
  target: AssetGitTargetSchema,
  source: AssetGitSourceSchema,
  baseRevision: z.number().int().positive(),
  remoteCommit: CommitSchema.optional(),
  phase: z.enum(["prepared", "pushed", "local_published"]),
  publishedRevision: z.number().int().positive().optional(),
});
