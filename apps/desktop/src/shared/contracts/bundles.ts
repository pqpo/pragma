import { PragmaInvocableResourceRefSchema, PragmaResourceRefSchema } from "@pragma/interpreter/ast";
import { z } from "zod";

export const PragmaBundleModuleOptionsSchema = z
  .object({
    capabilities: z.boolean().default(true),
    plugins: z.boolean().default(true),
    knowledgeBases: z.boolean().default(false),
    flowLayouts: z.boolean().default(true),
  })
  .strict();

export const PreparePragmaBundleExportSchema = z
  .object({
    rootRef: PragmaInvocableResourceRefSchema,
    projectRevision: z.number().int().positive(),
  })
  .strict();

export const PragmaBundleExportPreviewSchema = z
  .object({
    root: z
      .object({
        ref: PragmaInvocableResourceRefSchema,
        kind: z.enum(["Expert", "ExpertTeam", "Flow"]),
        name: z.string().trim().min(1).max(200),
      })
      .strict(),
    projectRevision: z.number().int().positive(),
    resourceCount: z.number().int().positive(),
    capabilityCount: z.number().int().nonnegative(),
    pluginCount: z.number().int().nonnegative(),
    knowledgeBaseCount: z.number().int().nonnegative(),
    hasFlowLayouts: z.boolean(),
    defaults: PragmaBundleModuleOptionsSchema,
  })
  .strict();

export const ExportPragmaBundleSchema = PreparePragmaBundleExportSchema.extend({
  modules: PragmaBundleModuleOptionsSchema,
}).strict();

export const PragmaBundleExportResultSchema = z
  .object({
    cancelled: z.boolean(),
    path: z.string().trim().min(1).max(2_000).optional(),
    bundleFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const InspectPragmaBundleSchema = z
  .object({
    sourcePath: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const PragmaBundlePickResultSchema = z
  .object({
    cancelled: z.boolean(),
    path: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const PragmaBundleConflictMatchSchema = z
  .object({
    kind: z.enum(["identity", "name"]),
    localRef: PragmaResourceRefSchema,
    localName: z.string().trim().min(1).max(200),
  })
  .strict();

export const PragmaBundleConflictSchema = z
  .object({
    ref: PragmaResourceRefSchema,
    resourceKind: z.enum([
      "Expert",
      "ExpertTeam",
      "Flow",
      "Automation",
      "Capability",
      "ContextStore",
      "RuntimeProfile",
    ]),
    importedName: z.string().trim().min(1).max(200),
    matches: z.array(PragmaBundleConflictMatchSchema).min(1).max(2),
    updateAllowed: z.boolean(),
    updateBlockedReason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const PragmaBundleDependencySummarySchema = z
  .object({
    kind: z.enum(["runtime", "capability", "context-store", "plugin", "secret"]),
    ref: z.string().trim().min(1).max(500),
    name: z.string().trim().min(1).max(200),
    included: z.boolean(),
  })
  .strict();

export const PragmaBundleImportInspectionSchema = z
  .object({
    sourcePath: z.string().trim().min(1).max(2_000),
    sourceName: z.string().trim().min(1).max(500),
    bundleFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    projectRevision: z.number().int().nonnegative(),
    root: z
      .object({
        ref: PragmaInvocableResourceRefSchema,
        kind: z.enum(["Expert", "ExpertTeam", "Flow"]),
        name: z.string().trim().min(1).max(200),
      })
      .strict(),
    createdAt: z.string().datetime(),
    archiveBytes: z.number().int().positive(),
    unpackedBytes: z.number().int().positive(),
    fileCount: z.number().int().positive(),
    resources: z.number().int().positive(),
    dependencies: z.array(PragmaBundleDependencySummarySchema),
    conflicts: z.array(PragmaBundleConflictSchema),
    requirements: z.array(
      z
        .object({
          id: z.string().trim().min(1).max(500),
          kind: z.enum(["runtime", "capability", "context-store", "plugin", "secret"]),
          resourceRef: z.string().trim().min(1).max(500),
          name: z.string().trim().min(1).max(200),
          message: z.string().trim().min(1).max(4_000),
          required: z.boolean(),
          capabilityKind: z
            .enum(["skill", "mcp_server", "http_service", "code_service"])
            .optional(),
          runtimeRequest: z
            .object({
              runtimeId: z.string().trim().min(1).max(200).optional(),
              providerId: z.string().trim().min(1).max(200).optional(),
              modelId: z.string().trim().min(1).max(200).optional(),
              thinkingLevel: z.string().trim().min(1).max(100).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    alreadyInstalledId: z.string().uuid().optional(),
  })
  .strict();

export const PragmaBundleConflictResolutionSchema = z
  .object({
    resourceRef: PragmaResourceRefSchema,
    action: z.enum(["update", "copy"]),
  })
  .strict();

export const BundleRuntimeResolutionSchema = z
  .object({
    resourceRef: PragmaResourceRefSchema,
    runtimeId: z.string().trim().min(1).max(200),
    providerId: z.string().trim().min(1).max(200),
    modelId: z.string().trim().min(1).max(200),
    thinkingLevel: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const BundleCapabilityResolutionSchema = z
  .object({
    resourceRef: PragmaResourceRefSchema,
    capabilityId: z.string().uuid(),
    revision: z.number().int().positive(),
  })
  .strict();

export const BundleContextStoreResolutionSchema = z
  .object({
    resourceRef: PragmaResourceRefSchema,
    storeId: z.string().uuid(),
  })
  .strict();

export const StartPragmaBundleImportSchema = z
  .object({
    sourcePath: z.string().trim().min(1).max(2_000),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    expectedProjectRevision: z.number().int().nonnegative(),
    conflicts: z.array(PragmaBundleConflictResolutionSchema).default([]),
    runtimes: z.array(BundleRuntimeResolutionSchema).default([]),
    capabilities: z.array(BundleCapabilityResolutionSchema).default([]),
    contextStores: z.array(BundleContextStoreResolutionSchema).default([]),
    secrets: z.record(z.string(), z.string().min(1).max(10_000)).default({}),
  })
  .strict();

export const PragmaBundlePendingDependencySchema = z
  .object({
    id: z.string().trim().min(1).max(500),
    kind: z.enum(["runtime", "capability", "context-store", "plugin", "secret"]),
    resourceRef: z.string().trim().min(1).max(500),
    name: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(4_000),
    capabilityKind: z.enum(["skill", "mcp_server", "http_service", "code_service"]).optional(),
  })
  .strict();

export const PragmaBundleInstallationSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-installation/v2"),
    id: z.string().uuid(),
    bundleFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    projectId: z.string().trim().min(1).max(120),
    projectRevision: z.number().int().nonnegative(),
    sourceRootRef: PragmaInvocableResourceRefSchema,
    rootRef: PragmaInvocableResourceRefSchema,
    rootName: z.string().trim().min(1).max(200),
    rootKind: z.enum(["Expert", "ExpertTeam", "Flow"]),
    resourceRefs: z.array(PragmaResourceRefSchema),
    createdResourceRefs: z.array(PragmaResourceRefSchema),
    createdCapabilityIds: z.array(z.string().uuid()).default([]),
    createdContextStoreIds: z.array(z.string().uuid()).default([]),
    createdPluginRefs: z.array(z.string().trim().min(1).max(500)).default([]),
    conflictResolutions: z.array(PragmaBundleConflictResolutionSchema).default([]),
    resourceMappings: z
      .array(
        z
          .object({
            sourceRef: PragmaResourceRefSchema,
            targetRef: PragmaResourceRefSchema,
          })
          .strict(),
      )
      .default([]),
    status: z.enum(["installing", "needs_setup", "ready", "failed"]),
    pending: z.array(PragmaBundlePendingDependencySchema),
    error: z.string().max(10_000).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const ResolvePragmaBundleInstallationSchema = z
  .object({
    installationId: z.string().uuid(),
    baseRevision: z.number().int().nonnegative(),
    runtimes: z.array(BundleRuntimeResolutionSchema).default([]),
    capabilities: z.array(BundleCapabilityResolutionSchema).default([]),
    contextStores: z.array(BundleContextStoreResolutionSchema).default([]),
    secrets: z.record(z.string(), z.string().min(1).max(10_000)).default({}),
  })
  .strict();

export const PragmaBundleInstallationActionSchema = z
  .object({
    installationId: z.string().uuid(),
  })
  .strict();
