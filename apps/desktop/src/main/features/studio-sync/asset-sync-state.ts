import { z } from "zod";
import { CoreAssetSyncItemSchema } from "../../../shared/contracts/index.ts";
export const StateSchema = z
  .object({
    schemaVersion: z.literal("pragma.asset-sync-state/v2"),
    source: z.string(),
    repositoryInitialized: z.boolean(),
    bases: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
    remoteItems: z
      .record(
        z.string(),
        CoreAssetSyncItemSchema.pick({ kind: true, name: true, fingerprint: true }),
      )
      .default({}),
    unavailableItems: z
      .record(
        z.string(),
        CoreAssetSyncItemSchema.pick({ kind: true, name: true, fingerprint: true }),
      )
      .default({}),
    conflicts: z.array(z.string()),
    conflictMessages: z.record(z.string(), z.string().max(2_000)).default({}),
    restoreConflicts: z.array(z.string()).default([]),
    syncedAt: z.string().datetime().optional(),
  })
  .strict();
const ChangeSchema = z
  .object({
    key: z.string(),
    expectedRevision: z.number().int().positive().optional(),
    local: CoreAssetSyncItemSchema.optional(),
    remote: CoreAssetSyncItemSchema.optional(),
  })
  .strict();
export const JournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.asset-sync-journal/v3"),
    source: z.string(),
    changes: z.array(ChangeSchema),
    expected: z.record(z.string(), z.string().nullable()),
    incomingState: StateSchema,
  })
  .strict();
export type SyncState = z.infer<typeof StateSchema>;
