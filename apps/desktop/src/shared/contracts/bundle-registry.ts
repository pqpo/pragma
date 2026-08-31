import {
  BundleRegistryCatalogIndexSchema,
  BundleRegistryManifestSchema,
  BundleRegistryPackageSchema,
  BundleRegistryPackageSummarySchema,
} from "@pragma/shared";
import { z } from "zod";

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
  }, "Git credentials must not be embedded in a Registry URL.");

export const DesktopBundleRegistryRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !value.startsWith("-"), "A Git ref cannot start with a dash.");

export const DesktopBundleRegistrySourceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    remote: DesktopBundleRegistryRemoteSchema,
    ref: DesktopBundleRegistryRefSchema.optional(),
    enabled: z.boolean(),
    official: z.boolean(),
    order: z.number().int().nonnegative(),
  })
  .strict();

export const DesktopBundleRegistrySourcesSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-bundle-registry-sources/v1"),
    sources: z.array(DesktopBundleRegistrySourceSchema).max(100),
  })
  .strict();

export const DesktopBundleRegistrySourceStatusSchema = DesktopBundleRegistrySourceSchema.extend({
  status: z.enum(["ready", "stale", "syncing", "error"]),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  syncedAt: z.string().datetime().optional(),
  packageCount: z.number().int().nonnegative().optional(),
  errorCode: z.string().trim().min(1).max(100).optional(),
  errorMessage: z.string().trim().min(1).max(2_000).optional(),
});

export const AddDesktopBundleRegistrySourceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    remote: DesktopBundleRegistryRemoteSchema,
    ref: DesktopBundleRegistryRefSchema.optional(),
  })
  .strict();

export const UpdateDesktopBundleRegistrySourceSchema = z
  .object({
    sourceId: z.string().uuid(),
    name: z.string().trim().min(1).max(200).optional(),
    ref: DesktopBundleRegistryRefSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    order: z.number().int().nonnegative().optional(),
  })
  .strict();

export const DesktopBundleRegistrySourceRefSchema = z
  .object({ sourceId: z.string().uuid() })
  .strict();

export const DesktopSquarePackageSchema = BundleRegistryPackageSummarySchema.extend({
  sourceId: z.string().uuid(),
  sourceName: z.string().trim().min(1).max(200),
  sourceOfficial: z.boolean(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
});

export const DesktopSquareCatalogSchema = z
  .object({
    packages: z.array(DesktopSquarePackageSchema),
    sources: z.array(DesktopBundleRegistrySourceStatusSchema),
  })
  .strict();

export const GetDesktopSquarePackageSchema = z
  .object({
    sourceId: z.string().uuid(),
    packageId: z.string().trim().min(1).max(80),
  })
  .strict();

export const DesktopSquarePackageDetailSchema = z
  .object({
    sourceId: z.string().uuid(),
    sourceName: z.string().trim().min(1).max(200),
    sourceOfficial: z.boolean(),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    package: BundleRegistryPackageSchema,
    readme: z.string().max(512 * 1024),
  })
  .strict();

export const DownloadDesktopSquareBundleSchema = z
  .object({
    sourceId: z.string().uuid(),
    packageId: z.string().trim().min(1).max(80),
    version: z.string().trim().min(1).max(100),
  })
  .strict();

export const DesktopSquareBundleDownloadSchema = z
  .object({
    path: z.string().trim().min(1).max(2_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    cached: z.boolean(),
  })
  .strict();

export const DesktopBundleRegistrySnapshotSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-bundle-registry-snapshot/v1"),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    syncedAt: z.string().datetime(),
    manifest: BundleRegistryManifestSchema,
    catalog: BundleRegistryCatalogIndexSchema,
    packages: z.array(BundleRegistryPackageSummarySchema),
  })
  .strict();
