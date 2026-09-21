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

const KnowledgeBaseUpdateV7Schema = z
  .object({
    sourceRef: z.string(),
    targetRef: z.string(),
    storeId: z.string().uuid(),
    baseRevision: z.number().int().positive().optional(),
    baseSnapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    importedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    importedName: z.string().trim().min(1).max(200).optional(),
    importedDescription: z.string().trim().max(2_000).optional(),
    phase: z.enum(["prepared", "applied"]),
  })
  .strict()
  .superRefine((update, context) => {
    if ((update.baseRevision === undefined) !== (update.baseSnapshotHash === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseRevision"],
        message: "Knowledge-base update baseline revision and snapshot hash must be paired.",
      });
    }
  });

export const BundleInstallationV7Schema = z.object({
  ...BundleInstallationV6Schema.shape,
  schemaVersion: z.literal("pragma.bundle-installation/v7"),
  assetConflictResolutions: z.array(AssetConflictResolutionV7Schema).default([]),
  knowledgeBaseUpdate: KnowledgeBaseUpdateV7Schema.optional(),
});

export const BundleInstallationsCatalogV7Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installations/v7"),
  installations: z.array(BundleInstallationV7Schema),
});

export type BundleInstallationsCatalogV7 = z.infer<typeof BundleInstallationsCatalogV7Schema>;
