import { z } from "zod";

const MAX_STORE_FILES = 5_000;
const MAX_ERROR_MESSAGE_LENGTH = 2_000;

const StoredKnowledgeSummaryV1Schema = z
  .object({
    fingerprint: z.string().min(1).max(128),
    exists: z.boolean(),
    name: z.string().trim().min(1).max(50).optional(),
    files: z.array(z.string().min(1).max(2_000)).max(MAX_STORE_FILES),
  })
  .strict();

export const KnowledgeSyncStateV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.knowledge-sync-state/v1"),
    revision: z.string().optional(),
    resolvedBranch: z.string().optional(),
    syncedAt: z.string().datetime().optional(),
    bases: z.record(z.string(), z.string()),
    ignoredRemote: z.array(
      z.object({ storeId: z.string().uuid(), name: z.string().trim().min(1).max(50) }).strict(),
    ),
    conflicts: z.record(
      z.string(),
      z
        .object({
          remoteRevision: z.string().min(1).max(128),
          local: StoredKnowledgeSummaryV1Schema,
          remote: StoredKnowledgeSummaryV1Schema,
        })
        .strict(),
    ),
    errorCode: z.string().trim().min(1).max(100).optional(),
    errorMessage: z.string().trim().min(1).max(MAX_ERROR_MESSAGE_LENGTH).optional(),
  })
  .strict();

export type KnowledgeSyncStateV1 = z.infer<typeof KnowledgeSyncStateV1Schema>;
