import { z } from "zod";

const DependencyStatusSchema = z.enum(["ready", "missing", "invalid", "action_required"]);
const DependencyActionSchema = z.enum([
  "none",
  "choose_runtime",
  "choose_capability",
  "configure_capability",
  "choose_knowledge_base",
  "install_plugin",
  "enter_secret",
  "restore_or_replace",
]);

const ReadinessV4Schema = z.object({
  id: z.string(),
  kind: z.enum(["runtime", "capability", "context-store", "plugin", "secret"]),
  resourceRef: z.string(),
  name: z.string(),
  status: DependencyStatusSchema,
  code: z.string(),
  action: DependencyActionSchema,
  message: z.string(),
  capabilityKind: z.enum(["skill", "mcp_server", "http_service", "code_service"]).optional(),
  targetId: z.string().optional(),
});

const PendingDependencyV4Schema = z.object({
  id: z.string(),
  kind: z.enum(["runtime", "capability", "context-store", "plugin", "secret"]),
  resourceRef: z.string(),
  name: z.string(),
  message: z.string(),
  capabilityKind: z.enum(["skill", "mcp_server", "http_service", "code_service"]).optional(),
  status: DependencyStatusSchema.optional(),
  code: z.string().optional(),
  action: DependencyActionSchema.optional(),
  targetId: z.string().optional(),
});

const ConflictResolutionV4Schema = z.object({
  resourceRef: z.string(),
  action: z.enum(["update", "copy"]),
});

const ResourceMappingV4Schema = z.object({
  sourceRef: z.string(),
  targetRef: z.string(),
});

export const BundleInstallationV4Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installation/v4"),
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
  conflictResolutions: z.array(ConflictResolutionV4Schema).default([]),
  resourceMappings: z.array(ResourceMappingV4Schema).default([]),
  status: z.enum(["installing", "needs_setup", "ready", "failed"]),
  pending: z.array(PendingDependencyV4Schema),
  readiness: z.array(ReadinessV4Schema).default([]),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const BundleInstallationsCatalogV4Schema = z.object({
  schemaVersion: z.literal("pragma.bundle-installations/v4"),
  installations: z.array(BundleInstallationV4Schema),
});

export type BundleInstallationsCatalogV4 = z.infer<typeof BundleInstallationsCatalogV4Schema>;
