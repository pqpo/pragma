import { z } from "zod";
export const DesktopPluginRefSchema = z
  .string()
  .trim()
  .regex(
    /^plugin:[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.+_-]*$/,
    "Expected an exact plugin reference such as plugin:example@1.0.0.",
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

export type DesktopPluginManifest = z.infer<typeof DesktopPluginManifestSchema>;
export type DesktopPlugin = z.infer<typeof DesktopPluginSchema>;
