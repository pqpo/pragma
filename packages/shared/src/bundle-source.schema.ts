import { z } from "zod";

import { PragmaAvatarIdSchema } from "./avatar.ts";

export const BundleSourceSlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .min(1)
  .max(80);

export const BundleSourceSemverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  )
  .max(100);

export const BundleSourceKindSchema = z.enum(["expert", "expert-team", "flow"]);

export const BUNDLE_SOURCE_KIND_DIRECTORIES = {
  expert: "experts",
  "expert-team": "expert-teams",
  flow: "flows",
} as const satisfies Readonly<Record<z.infer<typeof BundleSourceKindSchema>, string>>;

export const BundleSourceLocalizedTextSchema = z
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

export const BundleSourceLocalizedDescriptionSchema = z
  .object({
    default: z.string().trim().min(1).max(20_000),
    translations: z
      .object({
        en: z.string().trim().min(1).max(20_000),
        "zh-Hans": z.string().trim().min(1).max(20_000),
        "zh-Hant": z.string().trim().min(1).max(20_000),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export const BundleSourceCategorySchema = z
  .object({
    id: BundleSourceSlugSchema,
    name: BundleSourceLocalizedTextSchema,
    description: BundleSourceLocalizedTextSchema.optional(),
    order: z.number().int().nonnegative().default(0),
  })
  .strict();

const BundleSourceSectionSchema = z
  .object({ categories: z.array(BundleSourceCategorySchema).min(1).max(200) })
  .strict()
  .superRefine((section, context) => {
    const ids = new Set<string>();
    for (const [index, category] of section.categories.entries()) {
      if (ids.has(category.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate Bundle Source category: ${category.id}`,
          path: ["categories", index, "id"],
        });
      }
      ids.add(category.id);
    }
  });

export const BundleSourceManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-source/v1"),
    id: BundleSourceSlugSchema,
    name: BundleSourceLocalizedTextSchema,
    description: BundleSourceLocalizedDescriptionSchema.optional(),
    maxBundleBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024)
      .default(100 * 1024 * 1024),
    sections: z
      .object({
        expert: BundleSourceSectionSchema,
        "expert-team": BundleSourceSectionSchema,
        flow: BundleSourceSectionSchema,
      })
      .strict(),
  })
  .strict();

export const BundleSourceRootRefSchema = z
  .string()
  .regex(/^(expert|team|flow):[0-9a-hjkmnp-tv-z]{16}$/u)
  .max(100);

export const BundleSourceItemSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-source-item/v1"),
    id: BundleSourceSlugSchema,
    rootRef: BundleSourceRootRefSchema,
    name: BundleSourceLocalizedTextSchema,
    summary: BundleSourceLocalizedTextSchema,
    description: BundleSourceLocalizedDescriptionSchema,
    author: z
      .object({
        name: z.string().trim().min(1).max(200),
        url: z.string().url().max(2_000).optional(),
      })
      .strict(),
    license: z.string().trim().min(1).max(100),
    homepage: z.string().url().max(2_000).optional(),
    tags: z.array(BundleSourceSlugSchema).max(30).default([]),
    avatarId: PragmaAvatarIdSchema.optional(),
    latestVersion: BundleSourceSemverSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((item, context) => {
    if (Date.parse(item.updatedAt) < Date.parse(item.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "updatedAt cannot be earlier than createdAt.",
        path: ["updatedAt"],
      });
    }
  });

export const BundleSourceItemSummarySchema = BundleSourceItemSchema.extend({
  kind: BundleSourceKindSchema,
  categoryId: BundleSourceSlugSchema,
  versions: z.array(BundleSourceSemverSchema).min(1).max(200),
  configPath: z.string().trim().min(1).max(500),
}).strict();

export type BundleSourceKind = z.infer<typeof BundleSourceKindSchema>;
export type BundleSourceManifest = z.infer<typeof BundleSourceManifestSchema>;
export type BundleSourceCategory = z.infer<typeof BundleSourceCategorySchema>;
export type BundleSourceItem = z.infer<typeof BundleSourceItemSchema>;
export type BundleSourceItemSummary = z.infer<typeof BundleSourceItemSummarySchema>;

export function bundleSourceRootPrefix(kind: BundleSourceKind): "expert" | "team" | "flow" {
  return kind === "expert-team" ? "team" : kind;
}

export function bundleSourceItemDirectory(input: {
  readonly kind: BundleSourceKind;
  readonly categoryId: string;
  readonly itemId: string;
}): string {
  const categoryId = BundleSourceSlugSchema.parse(input.categoryId);
  const itemId = BundleSourceSlugSchema.parse(input.itemId);
  return `${BUNDLE_SOURCE_KIND_DIRECTORIES[input.kind]}/${categoryId}/${itemId}`;
}

export type BundleSourceRepositoryEntry =
  | {
      readonly kind: "config";
      readonly sourceKind: BundleSourceKind;
      readonly categoryId: string;
      readonly itemId: string;
    }
  | {
      readonly kind: "bundle";
      readonly sourceKind: BundleSourceKind;
      readonly categoryId: string;
      readonly itemId: string;
      readonly version: string;
    };

export function parseBundleSourceRepositoryEntry(
  path: string,
): BundleSourceRepositoryEntry | undefined {
  const parts = path.split("/");
  const sourceKind = sourceKindForDirectory(parts[0]);
  if (sourceKind === undefined || parts.length < 4) return undefined;
  const category = BundleSourceSlugSchema.safeParse(parts[1]);
  const item = BundleSourceSlugSchema.safeParse(parts[2]);
  if (!category.success || !item.success) return undefined;
  if (parts.length === 4 && parts[3] === "config.yaml") {
    return {
      kind: "config",
      sourceKind,
      categoryId: category.data,
      itemId: item.data,
    };
  }
  if (parts.length === 6 && parts[3] === "versions" && parts[5] === "bundle.pragma") {
    const version = BundleSourceSemverSchema.safeParse(parts[4]);
    if (!version.success) return undefined;
    return {
      kind: "bundle",
      sourceKind,
      categoryId: category.data,
      itemId: item.data,
      version: version.data,
    };
  }
  return undefined;
}

function sourceKindForDirectory(directory: string | undefined): BundleSourceKind | undefined {
  for (const [kind, value] of Object.entries(BUNDLE_SOURCE_KIND_DIRECTORIES)) {
    if (directory === value) return BundleSourceKindSchema.parse(kind);
  }
  return undefined;
}
