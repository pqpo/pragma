import { z } from "zod";

import { BundleInstallationV4Schema } from "./v4.ts";

export const BundleInstallationV5Schema = BundleInstallationV4Schema.extend({
  schemaVersion: z.literal("pragma.bundle-installation/v5"),
  bundleVersion: z.enum(["pragma.desktop-bundle/v1", "pragma.bundle/v1", "pragma.bundle/v2"]),
  rootKind: z.enum(["Expert", "ExpertTeam", "Flow", "ContextStore"]),
  knowledgeBaseUpdate: z
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
    })
    .optional(),
}).superRefine((installation, context) => {
  const update = installation.knowledgeBaseUpdate;
  if (update === undefined) return;
  if (
    installation.rootKind !== "ContextStore" ||
    update.sourceRef !== installation.sourceRootRef ||
    update.targetRef !== installation.rootRef
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["knowledgeBaseUpdate"],
      message: "Knowledge-base update journal must describe the installation root.",
    });
  }
});

export const BundleInstallationsCatalogV5Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installations/v5"),
  installations: z.array(BundleInstallationV5Schema),
});

export type BundleInstallationsCatalogV5 = z.infer<typeof BundleInstallationsCatalogV5Schema>;
