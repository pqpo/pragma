import { z } from "zod";

import { BundleInstallationV6Schema } from "./v6.ts";

const AssetConflictResolutionV7Schema = z.object({
  resourceRef: z.string(),
  assetKind: z.enum(["skill", "knowledge_base"]),
  action: z.enum(["update", "copy", "keep_local"]),
  targetAssetId: z.string().optional(),
  expectedTarget: z
    .object({
      revision: z.number().int().positive(),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});

export const BundleInstallationV7Schema = z.object({
  ...BundleInstallationV6Schema.shape,
  schemaVersion: z.literal("pragma.bundle-installation/v7"),
  assetConflictResolutions: z.array(AssetConflictResolutionV7Schema).default([]),
});

export const BundleInstallationsCatalogV7Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installations/v7"),
  installations: z.array(BundleInstallationV7Schema),
});

export type BundleInstallationsCatalogV7 = z.infer<typeof BundleInstallationsCatalogV7Schema>;
