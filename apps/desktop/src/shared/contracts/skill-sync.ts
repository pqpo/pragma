import { z } from "zod";

import {
  DesktopBundleRegistryBranchSchema,
  DesktopBundleRegistryRemoteSchema,
} from "./bundle-registry.ts";
import { CapabilityIdSchema } from "./capabilities.ts";

export const SkillSyncConfigurationSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-sync-settings/v1"),
    remote: DesktopBundleRegistryRemoteSchema,
    branch: DesktopBundleRegistryBranchSchema.optional(),
    autoPush: z.boolean().default(true),
    pushDeletions: z.boolean().default(false),
  })
  .strict();

export const UpdateSkillSyncConfigurationSchema = SkillSyncConfigurationSchema.omit({
  schemaVersion: true,
});

export const SkillSyncRepositoryManifestSchema = z
  .object({ schemaVersion: z.literal("pragma.skill-sync/v1") })
  .strict();

export const SkillSyncIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("capability"), id: CapabilityIdSchema }).strict(),
  z.object({ kind: z.literal("pragma-bundle"), logicalId: CapabilityIdSchema }).strict(),
]);

export const SkillSyncFileMetadataSchema = z
  .object({
    path: z.string().min(1).max(2_000),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    executable: z.boolean(),
  })
  .strict();

export const SkillSyncSkillManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-sync-skill/v1"),
    identity: SkillSyncIdentitySchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    files: z.array(SkillSyncFileMetadataSchema).min(1).max(1_000),
  })
  .strict();

export const SkillSyncItemStatusSchema = z
  .object({
    syncKey: z.string().min(1).max(200),
    capabilityId: CapabilityIdSchema.optional(),
    name: z.string().trim().min(1).max(120),
    status: z.enum(["synced", "pending", "syncing", "conflict", "error", "ignored_remote"]),
    errorCode: z.string().trim().min(1).max(100).optional(),
    errorMessage: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const SkillSyncConflictSchema = z
  .object({
    syncKey: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(120),
    remoteRevision: z.string().min(1).max(128),
    localExists: z.boolean(),
    remoteExists: z.boolean(),
    localFiles: z.array(z.string().min(1).max(2_000)),
    remoteFiles: z.array(z.string().min(1).max(2_000)),
  })
  .strict();

export const SkillSyncOverviewSchema = z
  .object({
    configured: z.boolean(),
    configuration: SkillSyncConfigurationSchema.optional(),
    status: z.enum(["unconfigured", "ready", "syncing", "conflict", "error"]),
    resolvedBranch: z.string().min(1).max(300).optional(),
    revision: z.string().min(1).max(128).optional(),
    syncedAt: z.string().datetime().optional(),
    errorCode: z.string().trim().min(1).max(100).optional(),
    errorMessage: z.string().trim().min(1).max(2_000).optional(),
    skills: z.array(SkillSyncItemStatusSchema),
    conflicts: z.array(SkillSyncConflictSchema),
  })
  .strict();

export const ResolveSkillSyncConflictSchema = z
  .object({ syncKey: z.string().min(1).max(200), choice: z.enum(["local", "remote"]) })
  .strict();

export const RestoreIgnoredRemoteSkillSchema = z
  .object({ syncKey: z.string().min(1).max(200) })
  .strict();

export type SkillSyncConfiguration = z.infer<typeof SkillSyncConfigurationSchema>;
export type UpdateSkillSyncConfiguration = z.infer<typeof UpdateSkillSyncConfigurationSchema>;
export type SkillSyncIdentity = z.infer<typeof SkillSyncIdentitySchema>;
export type SkillSyncSkillManifest = z.infer<typeof SkillSyncSkillManifestSchema>;
export type SkillSyncOverview = z.infer<typeof SkillSyncOverviewSchema>;
export type ResolveSkillSyncConflict = z.infer<typeof ResolveSkillSyncConflictSchema>;
export type RestoreIgnoredRemoteSkill = z.infer<typeof RestoreIgnoredRemoteSkillSchema>;
