import { z } from "zod";
import { MAX_SKILL_PACKAGE_BYTES } from "@pragma/shared";

import { CapabilityIdSchema } from "./capabilities.ts";
import { ContextStoreIdSchema } from "./context-stores.ts";
import {
  DesktopBundleRegistryBranchSchema,
  DesktopBundleRegistryRemoteSchema,
} from "./bundle-registry.ts";

export const AssetGitKindSchema = z.enum(["knowledge", "skill"]);
export const AssetGitTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("knowledge"), id: ContextStoreIdSchema }).strict(),
  z.object({ kind: z.literal("skill"), id: CapabilityIdSchema }).strict(),
]);
export const AssetGitSourceSchema = z
  .object({
    remote: DesktopBundleRegistryRemoteSchema,
    branch: DesktopBundleRegistryBranchSchema.optional(),
  })
  .strict();
export const AssetGitBindSchema = z
  .object({ target: AssetGitTargetSchema, source: AssetGitSourceSchema })
  .strict();
export const AssetGitImportSchema = z
  .object({ kind: AssetGitKindSchema, source: AssetGitSourceSchema })
  .strict();
export const AssetGitStatusSchema = z
  .object({
    target: AssetGitTargetSchema,
    source: AssetGitSourceSchema.optional(),
    status: z.enum(["unbound", "pending", "syncing", "synced", "conflict", "error"]),
    syncedAt: z.string().datetime().optional(),
    conflictPaths: z.array(z.string()).optional(),
    error: z.string().optional(),
    backupFailed: z.boolean().optional(),
    errorPath: z.string().optional(),
  })
  .strict();

export type AssetGitTarget = z.infer<typeof AssetGitTargetSchema>;
export type AssetGitSource = z.infer<typeof AssetGitSourceSchema>;
export type AssetGitStatus = z.infer<typeof AssetGitStatusSchema>;

const AssetGitConflictPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.includes("\\") &&
      !path.includes("\0") &&
      path
        .split("/")
        .every(
          (segment) =>
            segment !== "" &&
            segment !== "." &&
            segment !== ".." &&
            segment.toLowerCase() !== ".git",
        ),
    "Expected a managed relative file path.",
  );
export const AssetGitConflictFileSchema = z
  .object({
    path: AssetGitConflictPathSchema,
    kind: z.enum(["text", "binary"]),
    mergeLocal: z.string().nullable(),
    mergeRemote: z.string().nullable(),
    base: z.string().nullable(),
    local: z.string().nullable(),
    remote: z.string().nullable(),
    localDeleted: z.boolean(),
    remoteDeleted: z.boolean(),
    modeConflict: z.boolean(),
    localExecutable: z.boolean().optional(),
    remoteExecutable: z.boolean().optional(),
  })
  .strict();
export const AssetGitConflictsSchema = z
  .object({
    target: AssetGitTargetSchema,
    snapshot: z.string().regex(/^[a-f0-9]{64}$/u),
    files: z.array(AssetGitConflictFileSchema),
  })
  .strict();
export const AssetGitResolutionSchema = z.discriminatedUnion("choice", [
  z
    .object({ path: AssetGitConflictPathSchema, choice: z.enum(["local", "remote", "delete"]) })
    .strict(),
  z
    .object({
      path: AssetGitConflictPathSchema,
      choice: z.literal("manual"),
      content: z.string().max(MAX_SKILL_PACKAGE_BYTES),
      executable: z.boolean().optional(),
    })
    .strict(),
]);
export const ResolveAssetGitConflictsSchema = z
  .object({
    target: AssetGitTargetSchema,
    snapshot: AssetGitConflictsSchema.shape.snapshot,
    resolutions: z.array(AssetGitResolutionSchema).min(1),
  })
  .strict();
export type AssetGitConflicts = z.infer<typeof AssetGitConflictsSchema>;
export type AssetGitResolution = z.infer<typeof AssetGitResolutionSchema>;
export type ResolveAssetGitConflicts = z.infer<typeof ResolveAssetGitConflictsSchema>;
