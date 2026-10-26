import { z } from "zod";
import { CoreAssetSyncItemSchema } from "../../../../../shared/contracts/index.ts";
import { AssetSyncStateV2Schema } from "./v2.ts";
const ChangeSchema = z
  .object({
    key: z.string(),
    expectedRevision: z.number().int().positive().optional(),
    local: CoreAssetSyncItemSchema.optional(),
    remote: CoreAssetSyncItemSchema.optional(),
  })
  .strict();
export const AssetSyncJournalV3Schema = z
  .object({
    schemaVersion: z.literal("pragma.asset-sync-journal/v3"),
    source: z.string(),
    changes: z.array(ChangeSchema),
    expected: z.record(z.string(), z.string().nullable()),
    incomingState: AssetSyncStateV2Schema,
  })
  .strict();
