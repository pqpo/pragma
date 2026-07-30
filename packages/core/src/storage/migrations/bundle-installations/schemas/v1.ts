import { z } from "zod";

const PendingDependencyV1Schema = z.object({
  id: z.string(),
  kind: z.enum(["runtime", "capability", "context-store", "plugin", "secret"]),
  resourceRef: z.string(),
  name: z.string(),
  message: z.string(),
  capabilityKind: z.enum(["skill", "mcp_server", "http_service", "code_service"]).optional(),
});

export const BundleInstallationV1Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installation/v1"),
  id: z.string().uuid(),
  bundleFingerprint: z.string(),
  projectId: z.string(),
  projectRevision: z.number().int().nonnegative(),
  sourceRootRef: z.string(),
  rootRef: z.string(),
  rootName: z.string(),
  rootKind: z.enum(["Expert", "ExpertTeam", "Flow"]),
  resourceRefs: z.array(z.string()),
  createdResourceRefs: z.array(z.string()),
  createdCapabilityIds: z.array(z.string()).default([]),
  createdContextStoreIds: z.array(z.string()).default([]),
  createdPluginRefs: z.array(z.string()).default([]),
  status: z.enum(["installing", "needs_setup", "ready", "failed"]),
  pending: z.array(PendingDependencyV1Schema),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const BundleInstallationsCatalogV1Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installations/v1"),
  installations: z.array(BundleInstallationV1Schema),
});

export type BundleInstallationsCatalogV1 = z.infer<typeof BundleInstallationsCatalogV1Schema>;
