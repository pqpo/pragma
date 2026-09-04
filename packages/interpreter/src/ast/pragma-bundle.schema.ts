import { z } from "zod";

import {
  PragmaContextStoreRefSchema,
  PragmaInvocableResourceRefSchema,
  PragmaSemanticResourceRefSchema,
} from "./pragma-dsl.schema.ts";

export const PRAGMA_BUNDLE_WRITE_VERSION = "pragma.bundle/v2" as const;
export const PRAGMA_BUNDLE_DIRECT_READ_VERSIONS = [PRAGMA_BUNDLE_WRITE_VERSION] as const;
export const PRAGMA_BUNDLE_UPGRADE_FROM_VERSIONS = ["pragma.bundle/v1"] as const;

export const PragmaBundleRootRefSchema = z.union([
  PragmaInvocableResourceRefSchema,
  PragmaContextStoreRefSchema,
]);

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BundlePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "Bundle paths must be normalized relative POSIX paths.",
  );

export const PragmaBundleFileSchema = z
  .object({
    path: BundlePathSchema,
    size: z.number().int().nonnegative(),
    sha256: Sha256Schema,
  })
  .strict();

export const PragmaBundlePayloadSchema = z
  .object({
    codec: z.string().trim().min(1),
    root: BundlePathSchema,
    fingerprint: Sha256Schema,
  })
  .strict();

export const PragmaBundleRequirementKindSchema = z.enum([
  "binding",
  "runtime",
  "plugin",
  "secret",
  "external-artifact",
]);

export const PragmaBundleRequirementSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    kind: PragmaBundleRequirementKindSchema,
    ownerRef: PragmaSemanticResourceRefSchema,
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).min(1),
    contract: z.string().trim().min(1),
    required: z.boolean().default(true),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000).optional(),
    hints: z.record(z.string(), z.unknown()).default({}),
    payload: PragmaBundlePayloadSchema.optional(),
  })
  .strict();

export const PragmaBundleExtensionSchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.string().trim().min(1),
    required: z.boolean().default(false),
    root: BundlePathSchema,
    fingerprint: Sha256Schema,
  })
  .strict();

const PragmaBundleManifestShape = {
  createdAt: z.string().datetime({ offset: true }),
  bundleFingerprint: Sha256Schema,
  project: z
    .object({
      entry: BundlePathSchema,
      compilerVersion: z.string().trim().min(1),
      projectFingerprint: Sha256Schema,
    })
    .strict(),
  requirements: z.array(PragmaBundleRequirementSchema).default([]),
  extensions: z.array(PragmaBundleExtensionSchema).default([]),
  files: z.array(PragmaBundleFileSchema),
} as const;

export const PragmaBundleV1ManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle/v1"),
    ...PragmaBundleManifestShape,
    roots: z.array(PragmaInvocableResourceRefSchema).min(1),
  })
  .strict()
  .superRefine(refineBundleManifest);

export const PragmaBundleManifestSchema = z
  .object({
    schemaVersion: z.literal(PRAGMA_BUNDLE_WRITE_VERSION),
    ...PragmaBundleManifestShape,
    roots: z.array(PragmaBundleRootRefSchema).min(1),
  })
  .strict()
  .superRefine(refineBundleManifest);

export type PragmaBundleRootRef = z.infer<typeof PragmaBundleRootRefSchema>;
export type PragmaBundleV1Manifest = z.infer<typeof PragmaBundleV1ManifestSchema>;

function refineBundleManifest(
  manifest: {
    readonly roots: readonly string[];
    readonly requirements: readonly { readonly id: string }[];
    readonly extensions: readonly {
      readonly id: string;
      readonly version: string;
      readonly root: string;
    }[];
    readonly files: readonly { readonly path: string }[];
    readonly project: { readonly entry: string };
  },
  context: z.RefinementCtx,
): void {
  reportDuplicates(manifest.roots, "roots", "bundle root", context);
  reportDuplicates(
    manifest.requirements.map((requirement) => requirement.id),
    "requirements",
    "requirement id",
    context,
  );
  reportDuplicates(
    manifest.extensions.map((extension) => `${extension.id}@${extension.version}`),
    "extensions",
    "extension id and version",
    context,
  );
  const files = new Set<string>();
  for (const [index, file] of manifest.files.entries()) {
    if (files.has(file.path)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate bundle file: ${file.path}`,
        path: ["files", index, "path"],
      });
    }
    files.add(file.path);
  }
  if (!files.has(manifest.project.entry)) {
    context.addIssue({
      code: "custom",
      message: "Project entry is not declared in the bundle file index.",
      path: ["project", "entry"],
    });
  }
  for (const [index, extension] of manifest.extensions.entries()) {
    if (
      ![...files].some((path) => path === extension.root || path.startsWith(`${extension.root}/`))
    ) {
      context.addIssue({
        code: "custom",
        message: `Extension root has no files: ${extension.root}`,
        path: ["extensions", index, "root"],
      });
    }
  }
}

function reportDuplicates(
  values: readonly string[],
  path: string,
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate ${label}: ${value}`,
        path: [path, index],
      });
    }
    seen.add(value);
  }
}

export type PragmaBundleManifest = z.infer<typeof PragmaBundleManifestSchema>;
export type PragmaBundleRequirement = z.infer<typeof PragmaBundleRequirementSchema>;
export type PragmaBundleExtension = z.infer<typeof PragmaBundleExtensionSchema>;
export type PragmaBundlePayload = z.infer<typeof PragmaBundlePayloadSchema>;
