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
export const CoreAssetSyncKeySchema = z.string().min(1).max(300);
export const CoreAssetSyncConfigurationSchema = AssetGitSourceSchema.extend({
  schemaVersion: z.literal("pragma.core-asset-sync-settings/v1"),
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
export const CoreAssetSyncRepositorySchema = z
  .object({
    schemaVersion: z.literal("pragma.core-asset-sync/v1"),
    items: z.array(CoreAssetSyncItemSchema).max(5_000),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    for (const [index, item] of value.items.entries()) {
      if (keys.has(item.key))
        context.addIssue({
          code: "custom",
          path: ["items", index, "key"],
          message: "Duplicate asset key.",
        });
      keys.add(item.key);
    }
  });
export const CoreAssetSyncItemStatusSchema = CoreAssetSyncItemSchema.pick({
  key: true,
  kind: true,
  name: true,
}).extend({
  status: z.enum(["synced", "pending", "conflict", "ignored_remote", "needs_attention", "error"]),
  message: z.string().max(2_000).optional(),
});
export const CoreAssetSyncOverviewSchema = z
  .object({
    configuration: CoreAssetSyncConfigurationSchema.optional(),
    legacySyncStopped: z.boolean().optional(),
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
export type CoreAssetSyncOverview = z.infer<typeof CoreAssetSyncOverviewSchema>;
export type ResolveCoreAssetSyncConflict = z.infer<typeof ResolveCoreAssetSyncConflictSchema>;
