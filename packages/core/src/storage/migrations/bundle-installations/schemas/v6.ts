import { z } from "zod";

import { BundleInstallationV5Schema } from "./v5.ts";

const ConflictResolutionV6Schema = z.object({
  resourceRef: z.string(),
  action: z.enum(["update", "copy", "keep_local"]),
  expectedTargetRevision: z.number().int().positive().optional(),
  expectedTargetSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const BundleInstallationV6Schema = z.object({
  ...BundleInstallationV5Schema.shape,
  schemaVersion: z.literal("pragma.bundle-installation/v6"),
  conflictResolutions: z.array(ConflictResolutionV6Schema).default([]),
}).superRefine((installation, context) => {
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
