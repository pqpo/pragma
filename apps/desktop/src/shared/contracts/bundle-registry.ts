import {
  BundleSourceCategorySchema,
  BundleSourceItemSummarySchema,
  BundleSourceKindSchema,
  BundleSourceManifestSchema,
  BundleSourceRootRefSchema,
  BundleSourceSemverSchema,
  BundleSourceSlugSchema,
  PRAGMA_TEXT_LIMITS,
  PragmaAvatarIdSchema,
} from "@pragma/shared";
import { z } from "zod";
import { PragmaBundleModuleOptionsSchema } from "./bundles.ts";

export const DesktopBundleRegistryRemoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine(
    (value) =>
      /^https:\/\/[^/@\s]+\/[^\s]+$/u.test(value) ||
      /^ssh:\/\/[^\s]+$/u.test(value) ||
      /^[A-Za-z0-9._-]+@[^:\s]+:[^\s]+$/u.test(value),
    "Expected an HTTPS or SSH Git remote without embedded credentials.",
  )
  .refine((value) => {
    if (!value.startsWith("https://") && !value.startsWith("ssh://")) return true;
    try {
      const remote = new URL(value);
      return remote.password === "" && (remote.protocol !== "https:" || remote.username === "");
    } catch {
      return false;
    }
  }, "Git credentials must not be embedded in a Bundle Source URL.");

export const DesktopBundleRegistryBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !/[\s~^:?*[\\]/u.test(value),
    "Expected a valid Git branch name.",
  );

export const DesktopBundleRegistrySourceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    remote: DesktopBundleRegistryRemoteSchema,
    branch: DesktopBundleRegistryBranchSchema.optional(),
    enabled: z.boolean(),
    official: z.boolean(),
    order: z.number().int().nonnegative(),
  })
  .strict();

export const DesktopBundleRegistrySourcesSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-bundle-registry-sources/v2"),
    sources: z.array(DesktopBundleRegistrySourceSchema).max(100),
    dismissedOfficialSourceIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .strict();

export const DesktopBundleRegistrySourceStatusSchema = DesktopBundleRegistrySourceSchema.extend({
  status: z.enum(["ready", "stale", "syncing", "error"]),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  syncedAt: z.string().datetime().optional(),
  itemCount: z.number().int().nonnegative().optional(),
  resolvedBranch: DesktopBundleRegistryBranchSchema.optional(),
  errorCode: z.string().trim().min(1).max(100).optional(),
  errorMessage: z.string().trim().min(1).max(2_000).optional(),
});

export const AddDesktopBundleRegistrySourceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    remote: DesktopBundleRegistryRemoteSchema,
    branch: DesktopBundleRegistryBranchSchema.optional(),
  })
  .strict();

export const UpdateDesktopBundleRegistrySourceSchema = z
  .object({
    sourceId: z.string().uuid(),
    name: z.string().trim().min(1).max(200).optional(),
    remote: DesktopBundleRegistryRemoteSchema.optional(),
    branch: DesktopBundleRegistryBranchSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    order: z.number().int().nonnegative().optional(),
  })
  .strict();

export const DesktopBundleRegistrySourceRefSchema = z
  .object({ sourceId: z.string().uuid() })
  .strict();

export const DesktopSquareItemSchema = BundleSourceItemSummarySchema.extend({
  sourceId: z.string().uuid(),
  sourceName: z.string().trim().min(1).max(200),
  sourceOfficial: z.boolean(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
});

export const DesktopSquareCategorySchema = BundleSourceCategorySchema.extend({
  kind: BundleSourceKindSchema,
});

export const DesktopSquareCatalogSchema = z
  .object({
    items: z.array(DesktopSquareItemSchema),
    categories: z.array(DesktopSquareCategorySchema),
    sources: z.array(DesktopBundleRegistrySourceStatusSchema),
  })
  .strict();

export const GetDesktopSquareItemSchema = z
  .object({
    sourceId: z.string().uuid(),
    kind: BundleSourceKindSchema,
    itemId: BundleSourceSlugSchema,
  })
  .strict();

export const DesktopSquareItemDetailSchema = z
  .object({
    sourceId: z.string().uuid(),
    sourceName: z.string().trim().min(1).max(200),
    sourceOfficial: z.boolean(),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    item: BundleSourceItemSummarySchema,
  })
  .strict();

export const DownloadDesktopSquareBundleSchema = z
  .object({
    sourceId: z.string().uuid(),
    kind: BundleSourceKindSchema,
    itemId: BundleSourceSlugSchema,
    version: BundleSourceSemverSchema,
  })
  .strict();

export const DesktopSquareBundleDownloadSchema = z
  .object({
    path: z.string().trim().min(1).max(2_000),
    rootRef: BundleSourceRootRefSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    cached: z.boolean(),
  })
  .strict();

export const DesktopBundleRegistrySnapshotSchema = z.union([
  z
    .object({
      schemaVersion: z.literal("pragma.desktop-bundle-source-snapshot/v3"),
      commit: z.string().regex(/^[a-f0-9]{40,64}$/),
      syncedAt: z.string().datetime(),
      manifest: BundleSourceManifestSchema,
      items: z.array(BundleSourceItemSummarySchema),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("pragma.desktop-bundle-source-snapshot/v3"),
      empty: z.literal(true),
      syncedAt: z.string().datetime(),
      items: z.array(BundleSourceItemSummarySchema).max(0),
    })
    .strict(),
]);

export const PrepareBundleSourcePublicationSchema = z
  .object({
    rootRef: BundleSourceRootRefSchema,
    projectRevision: z.number().int().positive(),
  })
  .strict();

const BundleSourcePublicationMetadataShape = {
  itemId: BundleSourceSlugSchema,
  name: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(8_000),
  authorName: z.string().trim().min(1).max(200),
  authorUrl: z.string().url().max(2_000).optional(),
  license: z.string().trim().min(1).max(100),
  homepage: z.string().url().max(2_000).optional(),
  avatarId: PragmaAvatarIdSchema.optional(),
} as const;

export const BundleSourcePublicationMetadataSchema = z
  .object({
    ...BundleSourcePublicationMetadataShape,
    tags: z.array(BundleSourceSlugSchema).max(30),
  })
  .strict();

export const BundleSourcePublicationDraftMetadataSchema = z
  .object({
    ...BundleSourcePublicationMetadataShape,
    tags: z
      .array(z.string().trim().min(1).max(PRAGMA_TEXT_LIMITS.defaultMetadata.tag))
      .max(PRAGMA_TEXT_LIMITS.defaultMetadata.tags),
  })
  .strict();

export const BundleSourcePublicationTargetSchema = z
  .object({
    sourceId: z.string().uuid(),
    categoryId: BundleSourceSlugSchema,
    version: BundleSourceSemverSchema,
  })
  .strict();

export const BundleSourcePublicationSourceSchema = z
  .object({
    source: DesktopBundleRegistrySourceStatusSchema,
    selectable: z.boolean(),
    unavailableReason: z.string().trim().min(1).max(2_000).optional(),
    categories: z.array(BundleSourceCategorySchema),
    existingItem: BundleSourceItemSummarySchema.optional(),
  })
  .strict();

export const BundleSourcePublicationPreparationSchema = z
  .object({
    root: z
      .object({
        ref: BundleSourceRootRefSchema,
        kind: BundleSourceKindSchema,
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(8_000),
      })
      .strict(),
    projectRevision: z.number().int().positive(),
    modules: PragmaBundleModuleOptionsSchema,
    moduleCounts: z
      .object({
        capabilities: z.number().int().nonnegative(),
        plugins: z.number().int().nonnegative(),
        knowledgeBases: z.number().int().nonnegative(),
        flowLayouts: z.number().int().nonnegative(),
      })
      .strict(),
    metadata: BundleSourcePublicationDraftMetadataSchema,
    sources: z.array(BundleSourcePublicationSourceSchema),
  })
  .strict();

export const PublishBundleSourceSchema = PrepareBundleSourcePublicationSchema.extend({
  modules: PragmaBundleModuleOptionsSchema,
  metadata: BundleSourcePublicationMetadataSchema,
  targets: z.array(BundleSourcePublicationTargetSchema).min(1).max(100),
})
  .strict()
  .superRefine((value, context) => {
    const sourceIds = new Set<string>();
    const version = value.targets[0]?.version;
    for (const [index, target] of value.targets.entries()) {
      if (sourceIds.has(target.sourceId)) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "sourceId"],
          message: "A Bundle Source can only appear once in a publication.",
        });
      }
      sourceIds.add(target.sourceId);
      if (target.version !== version) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "version"],
          message: "All publication targets must use the same version.",
        });
      }
    }
  });

export function bundleSourcePublicationSummary(description: string): string {
  const paragraph = description
    .split(/\n\s*\n/gu)
    .map((part) => part.trim())
    .find((part) => part !== "");
  const normalized = (paragraph ?? description.trim()).replace(/\s+/gu, " ");
  const truncated = normalized.slice(0, 500);
  return /[\uD800-\uDBFF]$/u.test(truncated) ? truncated.slice(0, -1) : truncated;
}

export function normalizeBundleSourcePublicationTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function prepareBundleSourcePublicationTags(values: readonly string[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    const normalized = normalizeBundleSourcePublicationTag(value);
    const prepared = BundleSourceSlugSchema.safeParse(normalized).success
      ? normalized
      : value.trim();
    if (!tags.includes(prepared)) tags.push(prepared);
  }
  return tags;
}

export const BundleSourcePublicationTargetResultSchema = z
  .object({
    sourceId: z.string().uuid(),
    sourceName: z.string().trim().min(1).max(200),
    status: z.enum(["published", "already_published", "failed"]),
    version: BundleSourceSemverSchema,
    commit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    errorCode: z.string().trim().min(1).max(100).optional(),
    errorMessage: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const BundleSourcePublicationResultSchema = z
  .object({
    bundleFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    results: z.array(BundleSourcePublicationTargetResultSchema).min(1),
  })
  .strict();
