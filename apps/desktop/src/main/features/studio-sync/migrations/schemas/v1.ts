import { z } from "zod";
import {
  AssetGitSourceSchema,
  CoreAssetSyncItemSchema,
} from "../../../../../shared/contracts/index.ts";
export const AssetSyncSettingsV1Schema = AssetGitSourceSchema.extend({
  schemaVersion: z.literal("pragma.asset-sync-settings/v1"),
  autoPush: z.boolean().default(true),
  pushDeletions: z.boolean().default(false),
}).strict();
export const AssetSyncStateV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.asset-sync-state/v1"),
    source: z.string(),
    repositoryInitialized: z.boolean(),
    bases: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
    remoteItems: z
      .record(
        z.string(),
        CoreAssetSyncItemSchema.pick({ kind: true, name: true, fingerprint: true }),
      )
      .default({}),
    ignoredRemote: z.array(z.string()),
    conflicts: z.array(z.string()),
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
export const AssetSyncJournalV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.asset-sync-journal/v1"),
    source: z.string(),
    changes: z.array(ChangeSchema),
    expected: z.record(z.string(), z.string().nullable()),
    incomingState: AssetSyncStateV1Schema,
  })
  .strict();
