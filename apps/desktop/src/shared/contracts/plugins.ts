import { PragmaBindingRefSchema } from "@pragma/interpreter/ast";
import { z } from "zod";

export const ExpertToolApprovalModeSchema = z.enum(["none", "ask", "required"]);

export const DesktopPluginRefSchema = z
  .string()
  .trim()
  .regex(
    /^plugin:[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.+_-]*$/,
    "Expected an exact plugin reference such as plugin:memory@1.0.0.",
  );

export const DesktopPluginConfigurationPropertySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(["string", "number", "boolean", "object", "array"]),
    description: z.string().trim().min(1).max(4_000),
    required: z.boolean(),
    secret: z.boolean(),
    default: z.unknown().optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

export const DesktopPluginManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.plugin/v2"),
    id: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(4_000),
    version: z.string().trim().min(1).max(100),
    tags: z.array(z.string().trim().min(1).max(100)),
    runtime: z
      .object({
        type: z.literal("expert-agent-plugin"),
        entry: z.string().trim().min(1).max(2_000),
        trust: z.literal("trusted-host"),
      })
      .strict(),
    capabilities: z
      .array(
        z
          .object({
            type: z.string().trim().min(1),
            name: z.string().trim().min(1),
            description: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .max(500),
    configuration: z.record(z.string(), z.unknown()),
    permissions: z
      .object({
        filesystem: z.array(z.string().trim().min(1)),
        shell: z.array(z.string().trim().min(1)),
        network: z.array(z.string().trim().min(1)),
        environment: z.array(z.string().trim().min(1)),
      })
      .strict(),
  })
  .strict();

export const DesktopPluginSchema = z
  .object({
    ref: DesktopPluginRefSchema,
    origin: z.enum(["built_in", "user"]),
    manifest: DesktopPluginManifestSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["ready", "needs_attention"]),
    diagnostic: z.string().max(4_000).optional(),
    defaultConfig: z.record(z.string(), z.unknown()),
    configuredSecrets: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const InspectPluginZipSchema = z.object({ sourcePath: z.string().trim().min(1).max(2_000) });
export const PluginZipInspectionSchema = z
  .object({
    sourcePath: z.string().trim().min(1).max(2_000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    manifest: DesktopPluginManifestSchema,
    fileCount: z.number().int().positive(),
    unpackedBytes: z.number().int().positive(),
  })
  .strict();
export const ImportPluginZipSchema = z.object({
  sourcePath: z.string().trim().min(1).max(2_000),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const UpdatePluginDefaultsSchema = z.object({
  ref: DesktopPluginRefSchema,
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.string().nullable()),
});
export const SetPluginSecretsSchema = z.object({
  secrets: z.record(PragmaBindingRefSchema, z.string().nullable()),
});
export const PluginActionSchema = z.object({ ref: DesktopPluginRefSchema });

export const ExpertPluginReferenceSchema = z
  .object({
    ref: DesktopPluginRefSchema,
    config: z.record(z.string(), z.unknown()).optional(),
    secretBindings: z.record(z.string(), PragmaBindingRefSchema).optional(),
  })
  .strict();
