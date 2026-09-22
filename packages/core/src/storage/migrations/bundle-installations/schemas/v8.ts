import { z } from "zod";

import { BundleInstallationV7Schema } from "./v7.ts";

export const BundleInstallationV8Schema = z.object({
  ...BundleInstallationV7Schema.shape,
  schemaVersion: z.literal("pragma.bundle-installation/v8"),
  bundleVersion: z.enum([
    "pragma.desktop-bundle/v1",
    "pragma.bundle/v1",
    "pragma.bundle/v2",
    "pragma.bundle/v3",
  ]),
  rootKind: z.enum(["Expert", "ExpertTeam", "Flow", "ContextStore", "Capability"]),
});

export const BundleInstallationsCatalogV8Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installations/v8"),
  installations: z.array(BundleInstallationV8Schema),
});

export type BundleInstallationsCatalogV8 = z.infer<typeof BundleInstallationsCatalogV8Schema>;
