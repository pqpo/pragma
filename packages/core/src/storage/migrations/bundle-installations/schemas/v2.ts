import { z } from "zod";

const PendingDependencyV2Schema = z.object({
  id: z.string(),
  kind: z.enum(["runtime", "capability", "context-store", "plugin", "secret"]),
  resourceRef: z.string(),
  name: z.string(),
  message: z.string(),
  capabilityKind: z.enum(["skill", "mcp_server", "http_service", "code_service"]).optional(),
});

const ConflictResolutionV2Schema = z.object({
  resourceRef: z.string(),
  action: z.enum(["update", "copy"]),
});

const ResourceMappingV2Schema = z.object({
  sourceRef: z.string(),
  targetRef: z.string(),
});

export const BundleInstallationV2Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installation/v2"),
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
  conflictResolutions: z.array(ConflictResolutionV2Schema).default([]),
  resourceMappings: z.array(ResourceMappingV2Schema).default([]),
  status: z.enum(["installing", "needs_setup", "ready", "failed"]),
  pending: z.array(PendingDependencyV2Schema),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const BundleInstallationsCatalogV2Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installations/v2"),
  installations: z.array(BundleInstallationV2Schema),
});

export type BundleInstallationsCatalogV2 = z.infer<typeof BundleInstallationsCatalogV2Schema>;
