import {
  ContextStoreContentMetadataSchema,
  ContextStoreIdSchema,
  ContextStoreSnapshotSchema,
} from "./context-stores.ts";
import {
  DesktopBundleRegistryBranchSchema,
  DesktopBundleRegistryRemoteSchema,
} from "./bundle-registry.ts";
import { z } from "zod";
import { AssetGitSourceSchema } from "./asset-git.ts";

export const KnowledgeSyncConfigurationSchema = z
  .object({
    schemaVersion: z.literal("pragma.knowledge-sync-settings/v1"),
    remote: DesktopBundleRegistryRemoteSchema,
    branch: DesktopBundleRegistryBranchSchema.optional(),
    autoPush: z.boolean().default(true),
    pushDeletions: z.boolean().default(false),
  })
  .strict();

export const UpdateKnowledgeSyncConfigurationSchema = KnowledgeSyncConfigurationSchema.omit({
  schemaVersion: true,
}).extend({
  initializationMode: z.enum(["merge_and_publish", "restore_remote"]).default("merge_and_publish"),
});

export const KnowledgeSyncRepositoryManifestV1Schema = z
  .object({ schemaVersion: z.literal("pragma.knowledge-sync/v1") })
  .strict();
export const KnowledgeSyncRepositoryManifestSchema = z
  .object({ schemaVersion: z.literal("pragma.knowledge-sync/v2") })
  .strict();

export const KnowledgeSyncFileMetadataSchema = z
  .object({
    path: ContextStoreSnapshotSchema.shape.files.element.shape.id,
    metadata: ContextStoreContentMetadataSchema,
  })
  .strict();

const KnowledgeSyncStoreManifestBaseSchema = z
  .object({
    id: ContextStoreIdSchema,
    name: z.string().trim().min(1).max(50),
    description: z.string().trim().max(500),
    directories: ContextStoreSnapshotSchema.shape.directories,
    files: z.array(KnowledgeSyncFileMetadataSchema).max(5_000),
  })
  .strict();

function validateStoreManifest(
  manifest: z.infer<typeof KnowledgeSyncStoreManifestBaseSchema>,
  context: z.RefinementCtx,
): void {
  const paths = new Set<string>();
  for (const [index, file] of manifest.files.entries()) {
    if (paths.has(file.path)) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "path"],
        message: `Duplicate knowledge sync file path: ${file.path}`,
      });
    }
    paths.add(file.path);
  }
  const directories = new Set<string>();
  for (const [index, directory] of manifest.directories.entries()) {
    if (directories.has(directory)) {
      context.addIssue({
        code: "custom",
        path: ["directories", index],
        message: `Duplicate knowledge sync directory: ${directory}`,
      });
    }
    directories.add(directory);
  }
}

export const KnowledgeSyncStoreManifestV1Schema = KnowledgeSyncStoreManifestBaseSchema.extend({
  schemaVersion: z.literal("pragma.knowledge-sync-store/v1"),
}).superRefine(validateStoreManifest);

export const KnowledgeSyncStoreManifestSchema = KnowledgeSyncStoreManifestBaseSchema.extend({
  schemaVersion: z.literal("pragma.knowledge-sync-store/v2"),
  assetGit: AssetGitSourceSchema.optional(),
}).superRefine(validateStoreManifest);

export const KnowledgeSyncStoreStatusSchema = z
  .object({
    storeId: ContextStoreIdSchema,
    name: z.string().trim().min(1).max(50),
    status: z.enum(["synced", "pending", "syncing", "conflict", "error", "ignored_remote"]),
    errorCode: z.string().trim().min(1).max(100).optional(),
    errorMessage: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const KnowledgeSyncConflictSchema = z
  .object({
    storeId: ContextStoreIdSchema,
    name: z.string().trim().min(1).max(50),
    remoteRevision: z.string().min(1).max(128),
    localExists: z.boolean(),
    remoteExists: z.boolean(),
    localFiles: z.array(z.string().min(1).max(2_000)),
    remoteFiles: z.array(z.string().min(1).max(2_000)),
  })
  .strict();

export const KnowledgeSyncOverviewSchema = z
  .object({
    configured: z.boolean(),
    configuration: KnowledgeSyncConfigurationSchema.optional(),
    status: z.enum(["unconfigured", "ready", "syncing", "conflict", "error"]),
    resolvedBranch: z.string().min(1).max(300).optional(),
    revision: z.string().min(1).max(128).optional(),
    syncedAt: z.string().datetime().optional(),
    errorCode: z.string().trim().min(1).max(100).optional(),
    errorMessage: z.string().trim().min(1).max(2_000).optional(),
    stores: z.array(KnowledgeSyncStoreStatusSchema),
    conflicts: z.array(KnowledgeSyncConflictSchema),
  })
  .strict();

export const ResolveKnowledgeSyncConflictSchema = z
  .object({ storeId: ContextStoreIdSchema, choice: z.enum(["local", "remote"]) })
  .strict();

export const RestoreIgnoredRemoteKnowledgeBaseSchema = z
  .object({ storeId: ContextStoreIdSchema })
  .strict();

export type KnowledgeSyncConfiguration = z.infer<typeof KnowledgeSyncConfigurationSchema>;
export type UpdateKnowledgeSyncConfiguration = z.infer<
  typeof UpdateKnowledgeSyncConfigurationSchema
>;
export type KnowledgeSyncStoreManifest = z.infer<typeof KnowledgeSyncStoreManifestSchema>;
export type KnowledgeSyncOverview = z.infer<typeof KnowledgeSyncOverviewSchema>;
export type ResolveKnowledgeSyncConflict = z.infer<typeof ResolveKnowledgeSyncConflictSchema>;
export type RestoreIgnoredRemoteKnowledgeBase = z.infer<
  typeof RestoreIgnoredRemoteKnowledgeBaseSchema
>;
