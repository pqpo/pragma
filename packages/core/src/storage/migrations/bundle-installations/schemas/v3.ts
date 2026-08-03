import { z } from "zod";

const PendingDependencyV3Schema = z.object({
  id: z.string(),
  kind: z.enum(["runtime", "capability", "context-store", "plugin", "secret"]),
  resourceRef: z.string(),
  name: z.string(),
  message: z.string(),
  capabilityKind: z.enum(["skill", "mcp_server", "http_service", "code_service"]).optional(),
});

const ConflictResolutionV3Schema = z.object({
  resourceRef: z.string(),
  action: z.enum(["update", "copy"]),
});

const ResourceMappingV3Schema = z.object({
  sourceRef: z.string(),
  targetRef: z.string(),
});

export const BundleInstallationV3Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installation/v3"),
  bundleVersion: z.enum(["pragma.desktop-bundle/v1", "pragma.bundle/v1"]),
  sourceProjectFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
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
  conflictResolutions: z.array(ConflictResolutionV3Schema).default([]),
  resourceMappings: z.array(ResourceMappingV3Schema).default([]),
  status: z.enum(["installing", "needs_setup", "ready", "failed"]),
  pending: z.array(PendingDependencyV3Schema),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const BundleInstallationsCatalogV3Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installations/v3"),
  installations: z.array(BundleInstallationV3Schema),
});

export type BundleInstallationsCatalogV3 = z.infer<typeof BundleInstallationsCatalogV3Schema>;
