import { z } from "zod";
import { PRAGMA_TEXT_LIMITS, pragmaUnicodeLength } from "../pragma-text-limits.ts";
import { SemanticResourceIdSchema } from "../integration/primitives.schema.ts";
import {
  PragmaHttpParameterSchema,
  PragmaHttpToolSchema,
  PragmaJsonSchemaSchema,
  PragmaObjectJsonSchemaSchema,
  type PragmaJsonSchema,
} from "./tool-capability.schema.ts";
export function capabilityNameSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .refine((value) => pragmaUnicodeLength(value) <= PRAGMA_TEXT_LIMITS.capability.name, {
      message: `Must contain at most ${PRAGMA_TEXT_LIMITS.capability.name} characters.`,
    });
}

export function capabilityDescriptionSchema(required = false) {
  const schema = z.string().trim();
  return (required ? schema.min(1) : schema).refine(
    (value) => pragmaUnicodeLength(value) <= PRAGMA_TEXT_LIMITS.capability.description,
    { message: `Must contain at most ${PRAGMA_TEXT_LIMITS.capability.description} characters.` },
  );
}

const CapabilityEnvironmentSchema = z
  .record(z.string().max(200), z.string().max(2_000))
  .superRefine((environment, context) => {
    for (const key of Object.keys(environment)) {
      if (/(key|token|secret|password|credential)/i.test(key)) {
        context.addIssue({
          code: "custom",
          message: `Use secretRefs instead of env.${key} for secrets.`,
          path: [key],
        });
      }
    }
  });

export const CapabilityIdSchema = z.union([SemanticResourceIdSchema, z.string().uuid()]);
export const CapabilityRuntimeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, "Use lowercase letters, numbers, and underscores.");
export const CapabilityToolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, "Use letters, numbers, underscores, and hyphens.");

export const CapabilityToolSnapshotSchema = z.object({
  name: CapabilityToolNameSchema,
  description: z.string().trim().max(2_000).optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const SkillFilePathSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path
        .split("/")
        .every(
          (segment) =>
            segment.length > 0 &&
            segment !== "." &&
            segment !== ".." &&
            segment.toLowerCase() !== ".git",
        ),
    "Skill file paths must be safe relative paths.",
  );

export const SkillCapabilityDefinitionSchema = z.object({
  kind: z.literal("skill"),
  name: capabilityNameSchema(),
  description: capabilityDescriptionSchema(true),
  entryPath: z.literal("SKILL.md"),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  // Git supplies this metadata even when the host filesystem cannot represent executable bits.
  executablePaths: z.array(SkillFilePathSchema).max(1_000).optional(),
});

export const McpConnectionSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string().trim().min(1).max(1_000),
    args: z.array(z.string().max(2_000)).max(100).default([]),
    env: CapabilityEnvironmentSchema.default({}),
    secretEnv: z.record(z.string().max(200), z.string().trim().min(1).max(200)).default({}),
  }),
  z.object({
    transport: z.enum(["streamable-http", "sse"]),
    url: z.string().trim().url(),
    tokenCredentialRef: z.string().trim().min(1).max(200).optional(),
  }),
]);

export const McpServerCapabilityDefinitionSchema = z
  .object({
    kind: z.literal("mcp_server"),
    name: capabilityNameSchema(),
    description: capabilityDescriptionSchema(),
    connection: McpConnectionSchema,
    timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    tools: z.array(CapabilityToolSnapshotSchema).max(500),
  })
  .superRefine((definition, context) => addDuplicateToolIssues(definition.tools, context));

export const HttpServiceParameterSchema = PragmaHttpParameterSchema;
export const HttpServiceToolSchema = PragmaHttpToolSchema;

export const HttpServiceAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), credentialRef: z.string().trim().min(1).max(200) }),
  z.object({
    type: z.literal("api_key_header"),
    headerName: z.string().trim().min(1).max(100),
    credentialRef: z.string().trim().min(1).max(200),
  }),
]);

export const HttpServiceCapabilityDefinitionSchema = z
  .object({
    kind: z.literal("http_service"),
    name: capabilityNameSchema(),
    description: capabilityDescriptionSchema(),
    baseUrl: z.string().trim().url(),
    auth: HttpServiceAuthSchema,
    timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    tools: z.array(HttpServiceToolSchema).min(1).max(200),
  })
  .superRefine((definition, context) => addDuplicateToolIssues(definition.tools, context));

export type CodeServiceJsonSchema = PragmaJsonSchema;
export const CodeServiceJsonSchemaSchema = PragmaJsonSchemaSchema;
export const CodeServiceObjectJsonSchemaSchema = PragmaObjectJsonSchemaSchema;

export const CodeServiceCapabilityDefinitionSchema = z.object({
  kind: z.literal("code_service"),
  name: capabilityNameSchema(),
  description: capabilityDescriptionSchema(),
  language: z.literal("javascript"),
  timeoutMs: z.number().int().min(100).max(10_000).default(2_000),
  tool: z.object({
    name: CapabilityToolNameSchema,
    description: z.string().trim().min(1).max(2_000),
    inputSchema: CodeServiceObjectJsonSchemaSchema,
    outputSchema: CodeServiceObjectJsonSchemaSchema,
    source: z
      .string()
      .min(1)
      .max(100 * 1024),
  }),
});

function addDuplicateToolIssues(
  tools: readonly { readonly name: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  tools.forEach((tool, index) => {
    if (seen.has(tool.name)) {
      context.addIssue({
        code: "custom",
        message: `Tool name ${tool.name} must be unique.`,
        path: ["tools", index, "name"],
      });
    }
    seen.add(tool.name);
  });
}

export const CapabilityDefinitionSchema = z.discriminatedUnion("kind", [
  SkillCapabilityDefinitionSchema,
  McpServerCapabilityDefinitionSchema,
  HttpServiceCapabilityDefinitionSchema,
  CodeServiceCapabilityDefinitionSchema,
]);

export const CapabilityManifestSchema = z.object({
  schemaVersion: z.literal("pragma.capability/v4"),
  id: CapabilityIdSchema,
  runtimeKey: CapabilityRuntimeKeySchema,
  name: capabilityNameSchema(),
  kind: z.enum(["skill", "mcp_server", "http_service", "code_service"]),
  latestRevision: z.number().int().positive(),
  activeRevision: z.number().int().positive().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CapabilityHealthSchema = z.object({
  revision: z.number().int().positive(),
  status: z.enum(["ready", "needs_attention"]),
  checkedAt: z.string().datetime(),
  diagnostic: z
    .object({
      code: z.string().min(1).max(100),
      message: z.string().min(1).max(2_000),
      retryable: z.boolean(),
    })
    .optional(),
});

export const CapabilitySchema = z.object({
  manifest: CapabilityManifestSchema,
  health: CapabilityHealthSchema,
  definition: CapabilityDefinitionSchema,
  managedBy: z.enum(["user", "system"]).optional(),
});

export const ExpertCapabilityReferenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skill"),
    capabilityId: CapabilityIdSchema,
  }),
  z.object({
    kind: z.literal("tools"),
    capabilityId: CapabilityIdSchema,
    toolNames: z.array(CapabilityToolNameSchema).min(1).max(500),
  }),
]);

export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
export type CapabilityHealth = z.infer<typeof CapabilityHealthSchema>;
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;
export type ExpertCapabilityReference = z.infer<typeof ExpertCapabilityReferenceSchema>;
