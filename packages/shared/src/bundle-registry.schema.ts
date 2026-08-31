import { z } from "zod";

export const BundleRegistrySlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(1)
  .max(80);

export const BundleRegistryCategoryIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/)
  .min(1)
  .max(120);

export const BundleRegistrySemverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )
  .max(100);

export const BundleRegistryRelativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Expected a normalized repository-relative path.",
  );

export const BundleRegistryLocalizedTextSchema = z
  .object({
    default: z.string().trim().min(1).max(4_000),
    translations: z
      .object({
        en: z.string().trim().min(1).max(4_000),
        "zh-Hans": z.string().trim().min(1).max(4_000),
        "zh-Hant": z.string().trim().min(1).max(4_000),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export const BundleRegistryCategorySchema = z
  .object({
    id: BundleRegistryCategoryIdSchema,
    name: BundleRegistryLocalizedTextSchema,
    description: BundleRegistryLocalizedTextSchema.optional(),
    order: z.number().int().nonnegative().default(0),
  })
  .strict();

export const BundleRegistryManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-registry/v1"),
    id: BundleRegistrySlugSchema,
    name: BundleRegistryLocalizedTextSchema,
    description: BundleRegistryLocalizedTextSchema.optional(),
    maxBundleBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024)
      .default(100 * 1024 * 1024),
    categories: z.array(BundleRegistryCategorySchema).min(1).max(500),
    catalog: z.literal("catalog/index.json").default("catalog/index.json"),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const category of manifest.categories) {
      if (ids.has(category.id)) {
        context.addIssue({ code: "custom", message: `Duplicate category: ${category.id}` });
      }
      ids.add(category.id);
      const parent = category.id.includes("/")
        ? category.id.slice(0, category.id.indexOf("/"))
        : undefined;
      if (
        parent !== undefined &&
        !manifest.categories.some((candidate) => candidate.id === parent)
      ) {
        context.addIssue({ code: "custom", message: `Missing parent category: ${parent}` });
      }
    }
  });

export const BundleRegistryRequirementSummarySchema = z
  .object({
    kind: z.enum(["binding", "runtime", "plugin", "secret", "external-artifact"]),
    name: z.string().trim().min(1).max(200),
    required: z.boolean(),
  })
  .strict();

export const BundleRegistryVersionSchema = z
  .object({
    version: BundleRegistrySemverSchema,
    releasedAt: z.string().datetime(),
    changelog: BundleRegistryRelativePathSchema.optional(),
    bundle: z
      .object({
        path: BundleRegistryRelativePathSchema,
        size: z
          .number()
          .int()
          .positive()
          .max(512 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bundleFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        projectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        bundleSchemaVersion: z.literal("pragma.bundle/v1"),
        compilerVersion: z.string().trim().min(1).max(100),
        root: z
          .object({
            ref: z.string().trim().min(1).max(200),
            kind: z.enum(["Expert", "ExpertTeam", "Flow"]),
            name: z.string().trim().min(1).max(200),
          })
          .strict(),
        requirements: z.array(BundleRegistryRequirementSummarySchema).max(500).default([]),
      })
      .strict(),
  })
  .strict();

export const BundleRegistryPackageSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-registry-package/v1"),
    id: BundleRegistrySlugSchema,
    name: BundleRegistryLocalizedTextSchema,
    summary: BundleRegistryLocalizedTextSchema,
    publisher: z
      .object({
        name: z.string().trim().min(1).max(200),
        url: z.string().url().max(2_000).optional(),
      })
      .strict(),
    license: z.string().trim().min(1).max(100),
    homepage: z.string().url().max(2_000).optional(),
    primaryCategory: BundleRegistryCategoryIdSchema,
    categories: z.array(BundleRegistryCategoryIdSchema).min(1).max(10),
    tags: z.array(BundleRegistrySlugSchema).max(30).default([]),
    readme: BundleRegistryRelativePathSchema.default("README.md"),
    localizedReadmes: z
      .object({
        en: BundleRegistryRelativePathSchema,
        "zh-Hans": BundleRegistryRelativePathSchema,
        "zh-Hant": BundleRegistryRelativePathSchema,
      })
      .partial()
      .strict()
      .optional(),
    media: z
      .object({
        icon: BundleRegistryRelativePathSchema.optional(),
        screenshots: z.array(BundleRegistryRelativePathSchema).max(8).default([]),
      })
      .strict()
      .default({ screenshots: [] }),
    channels: z
      .object({
        stable: BundleRegistrySemverSchema,
        preview: BundleRegistrySemverSchema.optional(),
      })
      .strict(),
    versions: z.array(BundleRegistryVersionSchema).min(1).max(200),
  })
  .strict()
  .superRefine((item, context) => {
    if (!item.categories.includes(item.primaryCategory)) {
      context.addIssue({
        code: "custom",
        message: "primaryCategory must be included in categories.",
      });
    }
    const versions = new Set(item.versions.map((version) => version.version));
    if (versions.size !== item.versions.length) {
      context.addIssue({ code: "custom", message: "Package versions must be unique." });
    }
    if (!versions.has(item.channels.stable)) {
      context.addIssue({
        code: "custom",
        message: "The stable channel must reference a package version.",
      });
    }
    if (item.channels.preview !== undefined && !versions.has(item.channels.preview)) {
      context.addIssue({
        code: "custom",
        message: "The preview channel must reference a package version.",
      });
    }
  });

export const BundleRegistryPackageDraftSchema = z
  .object({
    ...BundleRegistryPackageSchema.shape,
    channels: z
      .object({
        stable: BundleRegistrySemverSchema.optional(),
        preview: BundleRegistrySemverSchema.optional(),
      })
      .strict()
      .default({}),
    versions: z.array(BundleRegistryVersionSchema).max(200).default([]),
  })
  .strict();

export const BundleRegistryPackageSummarySchema = z
  .object({
    id: BundleRegistryPackageSchema.shape.id,
    name: BundleRegistryPackageSchema.shape.name,
    summary: BundleRegistryPackageSchema.shape.summary,
    publisher: BundleRegistryPackageSchema.shape.publisher,
    license: BundleRegistryPackageSchema.shape.license,
    primaryCategory: BundleRegistryPackageSchema.shape.primaryCategory,
    categories: BundleRegistryPackageSchema.shape.categories,
    tags: BundleRegistryPackageSchema.shape.tags,
    media: BundleRegistryPackageSchema.shape.media,
    channels: BundleRegistryPackageSchema.shape.channels,
    packagePath: BundleRegistryRelativePathSchema,
    stable: BundleRegistryVersionSchema,
    preview: BundleRegistryVersionSchema.optional(),
  })
  .strict();

export const BundleRegistryPackageShardSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-registry-package-shard/v1"),
    packages: z.array(BundleRegistryPackageSummarySchema).max(5_000),
  })
  .strict();

export const BundleRegistryCategoryCatalogSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-registry-category/v1"),
    categoryId: BundleRegistryCategoryIdSchema,
    packageIds: z.array(BundleRegistrySlugSchema).max(100_000),
  })
  .strict();

export const BundleRegistryCatalogIndexSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-registry-catalog/v1"),
    registryId: BundleRegistrySlugSchema,
    packageCount: z.number().int().nonnegative(),
    packageShards: z.array(
      z
        .object({
          prefix: z.string().regex(/^[0-9a-z]$/),
          path: BundleRegistryRelativePathSchema,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    categoryIndexes: z.array(
      z
        .object({
          categoryId: BundleRegistryCategoryIdSchema,
          path: BundleRegistryRelativePathSchema,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((catalog, context) => {
    const shardPrefixes = new Set<string>();
    const paths = new Set<string>();
    for (const shard of catalog.packageShards) {
      if (shardPrefixes.has(shard.prefix)) {
        context.addIssue({ code: "custom", message: `Duplicate package shard: ${shard.prefix}` });
      }
      if (paths.has(shard.path)) {
        context.addIssue({ code: "custom", message: `Duplicate catalog path: ${shard.path}` });
      }
      shardPrefixes.add(shard.prefix);
      paths.add(shard.path);
    }
    const categoryIds = new Set<string>();
    for (const category of catalog.categoryIndexes) {
      if (categoryIds.has(category.categoryId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate category index: ${category.categoryId}`,
        });
      }
      if (paths.has(category.path)) {
        context.addIssue({ code: "custom", message: `Duplicate catalog path: ${category.path}` });
      }
      categoryIds.add(category.categoryId);
      paths.add(category.path);
    }
    const declaredPackages = catalog.packageShards.reduce((sum, shard) => sum + shard.count, 0);
    if (declaredPackages !== catalog.packageCount) {
      context.addIssue({
        code: "custom",
        message: "Package shard counts do not match packageCount.",
      });
    }
  });

export type BundleRegistryManifest = z.infer<typeof BundleRegistryManifestSchema>;
export type BundleRegistryPackage = z.infer<typeof BundleRegistryPackageSchema>;
export type BundleRegistryPackageSummary = z.infer<typeof BundleRegistryPackageSummarySchema>;
export type BundleRegistryCatalogIndex = z.infer<typeof BundleRegistryCatalogIndexSchema>;
