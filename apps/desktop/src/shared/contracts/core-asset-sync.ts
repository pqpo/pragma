import { z } from "zod";

import { AssetGitSourceSchema } from "./asset-git.ts";

export const CoreAssetSyncKindSchema = z.enum([
  "expert",
  "team",
  "flow",
  "runtime-profile",
  "knowledge",
  "skill",
  "capability",
  "flow-layout",
]);
export const CoreAssetLogicalKindSchema = z.enum([
  "expert",
  "team",
  "flow",
  "runtime-profile",
  "knowledge",
  "context",
  "skill",
  "capability",
]);
export const CoreAssetSyncKeySchema = z.string().min(1).max(300);
export const CoreAssetSyncConfigurationSchema = AssetGitSourceSchema.extend({
  schemaVersion: z.literal("pragma.asset-sync-settings/v1"),
  autoPush: z.boolean().default(true),
  pushDeletions: z.boolean().default(false),
}).strict();
export const UpdateCoreAssetSyncConfigurationSchema = CoreAssetSyncConfigurationSchema.omit({
  schemaVersion: true,
});
export const CoreAssetSyncItemSchema = z
  .object({
    key: CoreAssetSyncKeySchema,
    kind: CoreAssetSyncKindSchema,
    name: z.string().max(300),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    data: z.unknown(),
  })
  .strict();
export const CoreAssetSyncItemStatusSchema = CoreAssetSyncItemSchema.pick({
  key: true,
  kind: true,
  name: true,
}).extend({
  assetKey: CoreAssetSyncKeySchema,
  assetKind: CoreAssetLogicalKindSchema,
  assetName: z.string().max(300),
  status: z.enum(["synced", "pending", "conflict", "ignored_remote", "needs_attention", "error"]),
  message: z.string().max(2_000).optional(),
});
export const CoreAssetSyncOverviewSchema = z
  .object({
    configuration: CoreAssetSyncConfigurationSchema.optional(),
    status: z.enum(["unconfigured", "ready", "syncing", "conflict", "error"]),
    syncedAt: z.string().datetime().optional(),
    error: z.string().max(2_000).optional(),
    items: z.array(CoreAssetSyncItemStatusSchema),
  })
  .strict();
export const ResolveCoreAssetSyncConflictSchema = z
  .object({
    key: CoreAssetSyncKeySchema,
    choice: z.enum(["local", "remote"]),
  })
  .strict();

export type CoreAssetSyncConfiguration = z.infer<typeof CoreAssetSyncConfigurationSchema>;
export type UpdateCoreAssetSyncConfiguration = z.infer<
  typeof UpdateCoreAssetSyncConfigurationSchema
>;
export type CoreAssetSyncItem = z.infer<typeof CoreAssetSyncItemSchema>;
export type CoreAssetLogicalKind = z.infer<typeof CoreAssetLogicalKindSchema>;
export type CoreAssetSyncItemStatus = z.infer<typeof CoreAssetSyncItemStatusSchema>;
export type CoreAssetSyncOverview = z.infer<typeof CoreAssetSyncOverviewSchema>;
export type ResolveCoreAssetSyncConflict = z.infer<typeof ResolveCoreAssetSyncConflictSchema>;
