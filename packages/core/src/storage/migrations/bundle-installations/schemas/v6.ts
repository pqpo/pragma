import { z } from "zod";

import { BundleInstallationV5BaseSchema } from "./v5.ts";

export const BundleInstallationV6Schema = BundleInstallationV5BaseSchema.omit({
  schemaVersion: true,
  knowledgeBaseUpdate: true,
})
  .extend({
    schemaVersion: z.literal("pragma.bundle-installation/v6"),
    knowledgeBaseUpdate: z
      .object({
        sourceRef: z.string(),
        targetRef: z.string(),
        storeId: z.string().uuid(),
        baseSnapshotHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        importedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
        phase: z.enum(["prepared", "applied"]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((installation, context) => {
    const update = installation.knowledgeBaseUpdate;
    if (update === undefined) return;
    if (
      installation.rootKind !== "ContextStore" ||
      update.sourceRef !== installation.sourceRootRef ||
      update.targetRef !== installation.rootRef
    ) {
      context.addIssue({
        code: "custom",
        path: ["knowledgeBaseUpdate"],
        message: "Knowledge-base update journal must describe the installation root.",
      });
    }
  });

export const BundleInstallationsCatalogV6Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installations/v6"),
  installations: z.array(BundleInstallationV6Schema),
});

export type BundleInstallationsCatalogV6 = z.infer<typeof BundleInstallationsCatalogV6Schema>;
