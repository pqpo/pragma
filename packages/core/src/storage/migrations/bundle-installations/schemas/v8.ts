import { z } from "zod";

import { BundleInstallationV7Schema } from "./v7.ts";

export const BundleInstallationV8Schema = z
  .object({
    ...BundleInstallationV7Schema.shape,
    schemaVersion: z.literal("pragma.bundle-installation/v8"),
    bundleVersion: z.enum([
      "pragma.desktop-bundle/v1",
      "pragma.bundle/v1",
      "pragma.bundle/v2",
      "pragma.bundle/v3",
    ]),
    rootKind: z.enum(["Expert", "ExpertTeam", "Flow", "ContextStore", "Capability"]),
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

export const BundleInstallationsCatalogV8Schema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-installations/v8"),
    installations: z.array(BundleInstallationV8Schema),
  })
  .strict();

export type BundleInstallationsCatalogV8 = z.infer<typeof BundleInstallationsCatalogV8Schema>;
