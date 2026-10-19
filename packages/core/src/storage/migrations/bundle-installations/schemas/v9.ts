import { z } from "zod";
import { BundleInstallationV8Schema } from "./v8.ts";
import { BundleInstallationTransactionSchema } from "@pragma/shared";
export { BundleInstallationTransactionSchema } from "@pragma/shared";
export const BundleInstallationV9Schema = z
  .object({
    ...BundleInstallationV8Schema.shape,
    schemaVersion: z.literal("pragma.bundle-installation/v9"),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,199}$/)
      .optional(),
    transaction: BundleInstallationTransactionSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const update = record.knowledgeBaseUpdate;
    if (
      update !== undefined &&
      (record.rootKind !== "ContextStore" ||
        update.sourceRef !== record.sourceRootRef ||
        update.targetRef !== record.rootRef)
    )
      context.addIssue({
        code: "custom",
        path: ["knowledgeBaseUpdate"],
        message: "Knowledge-base update journal must describe the installation root.",
      });
  });
export const BundleInstallationsCatalogV9Schema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-installations/v9"),
    installations: z.array(BundleInstallationV9Schema),
  })
  .strict();
export type BundleInstallationsCatalogV9 = z.infer<typeof BundleInstallationsCatalogV9Schema>;
