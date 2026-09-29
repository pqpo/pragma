import { z } from "zod";
import { MAX_SKILL_PACKAGE_BYTES } from "@pragma/shared";

import { CapabilityIdSchema } from "./capabilities.ts";
import {
  CONTEXT_STORE_FILE_MAX_BYTES,
  ContextStoreIdSchema,
  ContextStoreSnapshotFileSchema,
} from "./context-stores.ts";
import {
  DesktopBundleRegistryBranchSchema,
  DesktopBundleRegistryRemoteSchema,
} from "./bundle-registry.ts";

export const ASSET_GIT_KNOWLEDGE_METADATA_MAX_BYTES = 64 * 1024;

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
    metadata: z.boolean().optional(),
    documentPath: AssetGitConflictPathSchema.optional(),
    documentConflict: z.boolean().optional(),
    mergeLocal: z.string().nullable(),
    mergeRemote: z.string().nullable(),
    base: z.string().nullable(),
    local: z.string().nullable(),
    remote: z.string().nullable(),
    localSizeBytes: z.number().int().nonnegative(),
    remoteSizeBytes: z.number().int().nonnegative(),
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
    nonConflictingSizeBytes: z.number().int().nonnegative(),
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
  .strict()
  .superRefine((request, context) => {
    let manualBytes = 0;
    for (const [index, resolution] of request.resolutions.entries()) {
      if (resolution.choice !== "manual") continue;
      const issue = assetGitManualContentSizeIssue(
        request.target.kind,
        resolution.content,
        resolution.path,
      );
      if (issue)
        context.addIssue({
          code: "custom",
          path: ["resolutions", index, "content"],
          message: `Asset content exceeds the ${request.target.kind} size limit.`,
        });
      manualBytes += new TextEncoder().encode(resolution.content).byteLength;
    }
    if (request.target.kind === "skill" && manualBytes > MAX_SKILL_PACKAGE_BYTES)
      context.addIssue({
        code: "custom",
        path: ["resolutions"],
        message: "The merged Skill exceeds the package size limit.",
      });
  });
export type AssetGitConflicts = z.infer<typeof AssetGitConflictsSchema>;
export type AssetGitResolution = z.infer<typeof AssetGitResolutionSchema>;
export type ResolveAssetGitConflicts = z.infer<typeof ResolveAssetGitConflictsSchema>;

/** Match the domain content schema and its UTF-8 storage budget before publication. */
export function assetGitManualContentSizeIssue(
  kind: AssetGitTarget["kind"],
  content: string,
  path?: string,
): "knowledgeSize" | "skillSize" | "metadataSize" | undefined {
  const bytes = new TextEncoder().encode(content).byteLength;
  if (kind === "knowledge") {
    if (path?.startsWith(".pragma/metadata/"))
      return bytes > ASSET_GIT_KNOWLEDGE_METADATA_MAX_BYTES ? "metadataSize" : undefined;
    if (
      !ContextStoreSnapshotFileSchema.shape.content.safeParse(content).success ||
      bytes > CONTEXT_STORE_FILE_MAX_BYTES
    )
      return "knowledgeSize";
  } else if (bytes > MAX_SKILL_PACKAGE_BYTES) return "skillSize";
  return undefined;
}

/** Include unconflicted files and whole-file/binary choices in the Skill package budget. */
export function assetGitResolutionSizeIssue(
  preview: AssetGitConflicts,
  resolutions: readonly AssetGitResolution[],
): { key: "knowledgeSize" | "skillSize" | "metadataSize"; path?: string } | undefined {
  let total = preview.nonConflictingSizeBytes;
  const files = new Map(preview.files.map((file) => [file.path, file]));
  for (const resolution of resolutions) {
    if (resolution.choice === "manual") {
      const key = assetGitManualContentSizeIssue(
        preview.target.kind,
        resolution.content,
        resolution.path,
      );
      if (key) return { key, path: resolution.path };
      total += new TextEncoder().encode(resolution.content).byteLength;
    } else {
      const file = files.get(resolution.path);
      if (file)
        total +=
          resolution.choice === "local"
            ? file.localSizeBytes
            : resolution.choice === "remote"
              ? file.remoteSizeBytes
              : 0;
    }
  }
  if (preview.target.kind === "skill" && total > MAX_SKILL_PACKAGE_BYTES)
    return { key: "skillSize" };
  return undefined;
}
