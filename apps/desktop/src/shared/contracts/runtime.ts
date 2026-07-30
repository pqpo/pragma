import { z } from "zod";

export const DesktopAppInfoSchema = z.object({
  name: z.literal("Pragma"),
  version: z.string(),
  os: z.enum(["macos", "windows", "linux", "unknown"]),
});

export const RuntimeGatewayConfigSchema = z.object({
  schemaVersion: z.literal(1),
  endpoint: z.string(),
  transport: z.literal("websocket"),
});

export const LocalRuntimeCapabilitySchema = z.object({
  id: z.enum(["codex", "claude-code", "self-hosted-agent"]),
  label: z.string(),
  status: z.enum(["available", "not_configured"]),
});

export const DesktopRuntimeIdSchema = z.string().trim().min(1).max(200);

export const RuntimeEnvironmentDefinitionSchema = z.object({
  schemaVersion: z.literal("pragma.runtime-environment/v1"),
  id: DesktopRuntimeIdSchema,
  adapter: z.object({
    id: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(100),
  }),
  displayName: z.string().trim().min(1).max(200),
  origin: z.enum(["built-in", "registered"]),
  config: z.record(z.string(), z.unknown()),
});

export const RuntimeEnvironmentRevisionSchema = z.object({
  schemaVersion: z.literal("pragma.runtime-environment-revision/v1"),
  runtimeId: DesktopRuntimeIdSchema,
  revision: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  definition: RuntimeEnvironmentDefinitionSchema,
  status: z.enum(["active", "deleted"]),
  createdAt: z.string().datetime(),
});

export const RuntimeEnvironmentCatalogEntrySchema = z.object({
  runtimeId: DesktopRuntimeIdSchema,
  latestRevision: z.number().int().positive(),
});

export const RuntimeEnvironmentCatalogSchema = z.object({
  schemaVersion: z.literal("pragma.runtime-environment-catalog/v1"),
  defaultRuntimeId: DesktopRuntimeIdSchema,
  entries: z.array(z.unknown()),
});

export const RuntimeThinkingLevelSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).optional(),
});

export const RuntimeModelThinkingSchema = z
  .object({
    supportedLevels: z.array(RuntimeThinkingLevelSchema).min(1),
    defaultLevel: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.defaultLevel !== undefined &&
      !value.supportedLevels.some((level) => level.value === value.defaultLevel)
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultLevel"],
        message: "The default thinking level must be supported by the model.",
      });
    }
  });

export const DesktopRuntimeModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  provider: z.object({
    kind: z.enum(["runtime-managed", "registered"]),
    id: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200),
  }),
  default: z.boolean().optional(),
  thinking: RuntimeModelThinkingSchema.optional(),
});

export const DesktopRuntimeAvailabilitySchema = z.object({
  id: DesktopRuntimeIdSchema,
  revision: z.number().int().positive().optional(),
  origin: z.enum(["built-in", "registered"]).optional(),
  adapter: z.object({ id: z.string().trim().min(1), version: z.string().trim().min(1) }).optional(),
  isDefault: z.boolean(),
  kind: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  status: z.enum(["available", "unavailable"]),
  executablePath: z.string().optional(),
  version: z.string().optional(),
  reason: z.string().optional(),
  models: z.array(DesktopRuntimeModelSchema).optional(),
  modelDiscoveryError: z.string().optional(),
});

export const SetDefaultRuntimeSchema = z.object({
  runtimeId: DesktopRuntimeIdSchema,
});

export const DesktopBridgeSnapshotSchema = z.object({
  app: DesktopAppInfoSchema,
  interpreter: z
    .object({
      writeVersion: z.string().min(1),
      directReadVersions: z.array(z.string().min(1)).min(1),
      upgradeFromVersions: z.array(z.string().min(1)),
    })
    .strict()
    .optional(),
  gateway: RuntimeGatewayConfigSchema,
  device: z.object({
    status: z.literal("offline"),
    label: z.string(),
  }),
  workspace: z.object({
    path: z.string().nullable(),
    status: z.enum(["unset", "ready"]),
  }),
  capabilities: z.array(LocalRuntimeCapabilitySchema),
});
