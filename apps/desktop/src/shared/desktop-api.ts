import {
  ContextTriggerSchema,
  HumanInteractionRequestSchema,
  HumanInteractionResponseSchema,
} from "@pragma/shared";
import {
  PragmaDiagnosticSchema,
  PragmaExpertResourceSchema,
  PragmaLockSchema,
  PragmaResourceRefSchema,
  PragmaResourceSchema,
  PragmaToolBindingSchema,
} from "@pragma/interpreter/ast";
import { z } from "zod";

export const DesktopAppInfoSchema = z.object({
  name: z.literal("Pragma Desktop"),
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

export const DesktopRuntimeIdSchema = z.enum(["pi", "codex", "claude-code"]);

export const DesktopRuntimeAvailabilitySchema = z.object({
  id: DesktopRuntimeIdSchema,
  status: z.enum(["available", "unavailable"]),
  executablePath: z.string().optional(),
  version: z.string().optional(),
  reason: z.string().optional(),
  models: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(200),
        displayName: z.string().trim().min(1).max(200),
        default: z.boolean().optional(),
      }),
    )
    .optional(),
  modelDiscoveryError: z.string().optional(),
});

export const DesktopBridgeSnapshotSchema = z.object({
  app: DesktopAppInfoSchema,
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

export const PickWorkspaceResultSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  basename: z.string().optional(),
  reason: z.enum(["cancelled", "no_window", "not_directory", "not_accessible", "error"]).optional(),
  error: z.string().optional(),
});

export const ValidateWorkspacePathSchema = z.string().min(1);

export const ValidateWorkspaceResultSchema = z.object({
  ok: z.boolean(),
  reason: z
    .enum(["not_absolute", "not_found", "not_directory", "not_readable", "not_writable", "error"])
    .optional(),
  error: z.string().optional(),
});

export const ModelProviderIdSchema = z.string().uuid();

export const ModelIdSchema = z.string().trim().min(1).max(200);

export const ModelProviderSchema = z.object({
  id: ModelProviderIdSchema,
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url(),
  models: z.array(ModelIdSchema).min(1),
  hasApiKey: z.boolean(),
});

export const CreateModelProviderSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().trim().min(1).max(10_000),
  models: z.array(ModelIdSchema).min(1).max(100),
});

export const UpdateModelProviderSchema = z.object({
  id: ModelProviderIdSchema,
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().trim().min(1).max(10_000).optional(),
  models: z.array(ModelIdSchema).min(1).max(100),
});

export const DeleteModelProviderSchema = z.object({
  id: ModelProviderIdSchema,
});

export const ModelConnectionTestRequestSchema = z.object({
  providerId: ModelProviderIdSchema,
  modelId: ModelIdSchema,
});

export const ModelConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  code: z.enum([
    "success",
    "not_configured",
    "authentication",
    "model_unavailable",
    "timeout",
    "network",
    "invalid_response",
    "request_failed",
  ]),
  message: z.string(),
  latencyMs: z.number().int().nonnegative().optional(),
  status: z.number().int().optional(),
});

export const EXPERT_NAME_MAX_LENGTH = 20;
export const EXPERT_ID_MAX_LENGTH = 20;
export const EXPERT_DESCRIPTION_MAX_LENGTH = 200;
export const EXPERT_TAG_MAX_LENGTH = 20;

export const ExpertIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "Use only letters, numbers, underscores, and hyphens.");

export const CreateExpertIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(EXPERT_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_]+$/, "Use only letters, numbers, and underscores.");

export const ExpertScopeSchema = z.string().trim().min(1).max(4_000);

export const ExpertModelConfigSchema = z.discriminatedUnion("runtimeId", [
  z.object({
    runtimeId: z.literal("pi"),
    providerId: ModelProviderIdSchema,
    modelName: ModelIdSchema,
  }),
  z.object({
    runtimeId: z.literal("codex"),
    modelName: ModelIdSchema,
  }),
  z.object({
    runtimeId: z.literal("claude-code"),
    modelName: ModelIdSchema,
  }),
]);

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

export const CapabilityIdSchema = z.string().uuid();
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
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const SkillCapabilityDefinitionSchema = z.object({
  kind: z.literal("skill"),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000),
  entryPath: z.literal("SKILL.md"),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
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
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000),
    connection: McpConnectionSchema,
    timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    tools: z.array(CapabilityToolSnapshotSchema).max(500),
  })
  .superRefine((definition, context) => addDuplicateToolIssues(definition.tools, context));

export const HttpServiceParameterSchema = z.object({
  name: z.string().trim().min(1).max(100),
  location: z.enum(["path", "query"]),
  required: z.boolean(),
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string().trim().max(500).optional(),
});

export const HttpServiceToolSchema = z
  .object({
    name: CapabilityToolNameSchema,
    description: z.string().trim().min(1).max(2_000),
    method: z.enum(["GET", "POST"]),
    path: z.string().trim().min(1).max(1_000).regex(/^\//, "Path must start with /"),
    parameters: z.array(HttpServiceParameterSchema).max(100).default([]),
    bodySchema: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((tool, context) => {
    if (tool.method === "GET" && tool.bodySchema !== undefined) {
      context.addIssue({
        code: "custom",
        message: "GET tools cannot declare a body.",
        path: ["bodySchema"],
      });
    }
    const declaredPathParameters = new Set(
      tool.parameters
        .filter((parameter) => parameter.location === "path")
        .map((parameter) => parameter.name),
    );
    for (const match of tool.path.matchAll(/\{([^}]+)\}/g)) {
      if (!declaredPathParameters.has(match[1] ?? "")) {
        context.addIssue({
          code: "custom",
          message: `Path parameter ${match[1]} must be declared.`,
          path: ["path"],
        });
      }
    }
  });

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
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000),
    baseUrl: z.string().trim().url(),
    auth: HttpServiceAuthSchema,
    timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    tools: z.array(HttpServiceToolSchema).min(1).max(200),
  })
  .superRefine((definition, context) => addDuplicateToolIssues(definition.tools, context));

export type CodeServiceJsonSchema =
  | { readonly type: "string"; readonly description?: string | undefined }
  | { readonly type: "number"; readonly description?: string | undefined }
  | { readonly type: "integer"; readonly description?: string | undefined }
  | { readonly type: "boolean"; readonly description?: string | undefined }
  | {
      readonly type: "object";
      readonly description?: string | undefined;
      readonly properties: Readonly<Record<string, CodeServiceJsonSchema>>;
      readonly required?: readonly string[] | undefined;
      readonly additionalProperties: false;
    }
  | {
      readonly type: "array";
      readonly description?: string | undefined;
      readonly items: CodeServiceJsonSchema;
    };

const CodeServiceFieldNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use a JavaScript-style field name.");
const CodeServiceDescriptionSchema = z.string().trim().max(500).optional();

export const CodeServiceJsonSchemaSchema: z.ZodType<CodeServiceJsonSchema> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("string"), description: CodeServiceDescriptionSchema }).strict(),
    z.object({ type: z.literal("number"), description: CodeServiceDescriptionSchema }).strict(),
    z.object({ type: z.literal("integer"), description: CodeServiceDescriptionSchema }).strict(),
    z.object({ type: z.literal("boolean"), description: CodeServiceDescriptionSchema }).strict(),
    z
      .object({
        type: z.literal("object"),
        description: CodeServiceDescriptionSchema,
        properties: z.record(CodeServiceFieldNameSchema, CodeServiceJsonSchemaSchema),
        required: z.array(CodeServiceFieldNameSchema).max(200).optional(),
        additionalProperties: z.literal(false),
      })
      .strict()
      .superRefine((schema, context) => {
        const properties = new Set(Object.keys(schema.properties));
        const required = schema.required ?? [];
        required.forEach((name, index) => {
          if (!properties.has(name)) {
            context.addIssue({
              code: "custom",
              message: `Required field ${name} must exist in properties.`,
              path: ["required", index],
            });
          }
          if (required.indexOf(name) !== index) {
            context.addIssue({
              code: "custom",
              message: `Required field ${name} must be unique.`,
              path: ["required", index],
            });
          }
        });
      }),
    z
      .object({
        type: z.literal("array"),
        description: CodeServiceDescriptionSchema,
        items: CodeServiceJsonSchemaSchema,
      })
      .strict(),
  ]),
);

export const CodeServiceObjectJsonSchemaSchema = CodeServiceJsonSchemaSchema.refine(
  (schema): schema is Extract<CodeServiceJsonSchema, { readonly type: "object" }> =>
    schema.type === "object",
  "The root schema must be an object.",
).superRefine((schema, context) => {
  const limits = codeSchemaLimits(schema);
  if (limits.depth > 5) {
    context.addIssue({ code: "custom", message: "Schema nesting cannot exceed 5 levels." });
  }
  if (limits.fields > 200) {
    context.addIssue({ code: "custom", message: "Schema cannot contain more than 200 fields." });
  }
});

export const CodeServiceCapabilityDefinitionSchema = z.object({
  kind: z.literal("code_service"),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
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

function codeSchemaLimits(schema: CodeServiceJsonSchema): {
  readonly depth: number;
  readonly fields: number;
} {
  if (schema.type === "array") {
    const child = codeSchemaLimits(schema.items);
    return { depth: child.depth + 1, fields: child.fields };
  }
  if (schema.type !== "object") return { depth: 1, fields: 0 };
  const children = Object.values(schema.properties).map(codeSchemaLimits);
  return {
    depth: 1 + Math.max(0, ...children.map((child) => child.depth)),
    fields:
      Object.keys(schema.properties).length +
      children.reduce((sum, child) => sum + child.fields, 0),
  };
}

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
  schemaVersion: z.literal("pragma.capability/v1"),
  id: CapabilityIdSchema,
  runtimeKey: CapabilityRuntimeKeySchema,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["skill", "mcp_server", "http_service", "code_service"]),
  latestRevision: z.number().int().positive(),
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
});

export const ExpertCapabilityReferenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skill"),
    capabilityId: CapabilityIdSchema,
    revision: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("tools"),
    capabilityId: CapabilityIdSchema,
    revision: z.number().int().positive(),
    toolNames: z.array(CapabilityToolNameSchema).min(1).max(500),
  }),
]);

export const ImportSkillCapabilitySchema = z.object({
  sourcePath: z.string().trim().min(1).max(2_000),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(2_000).optional(),
});

export const CreateCapabilitySchema = z
  .object({
    definition: z.union([
      McpServerCapabilityDefinitionSchema,
      HttpServiceCapabilityDefinitionSchema,
      CodeServiceCapabilityDefinitionSchema,
    ]),
    credentials: z.record(z.string().max(200), z.string().min(1).max(10_000)).default({}),
  })
  .superRefine(addCodeCredentialIssue);

export const UpdateCapabilitySchema = z
  .object({
    id: CapabilityIdSchema,
    definition: z.union([
      McpServerCapabilityDefinitionSchema,
      HttpServiceCapabilityDefinitionSchema,
      CodeServiceCapabilityDefinitionSchema,
    ]),
    credentials: z.record(z.string().max(200), z.string().min(1).max(10_000)).default({}),
  })
  .superRefine(addCodeCredentialIssue);

function addCodeCredentialIssue(
  input: {
    readonly definition: { readonly kind: string };
    readonly credentials: Readonly<Record<string, string>>;
  },
  context: z.RefinementCtx,
): void {
  if (input.definition.kind === "code_service" && Object.keys(input.credentials).length > 0) {
    context.addIssue({
      code: "custom",
      message: "Code services cannot receive credentials.",
      path: ["credentials"],
    });
  }
}

export const CapabilityActionSchema = z.object({ id: CapabilityIdSchema });
export const CapabilityTestRequestSchema = z.object({
  id: CapabilityIdSchema,
  toolName: CapabilityToolNameSchema.optional(),
  input: z.unknown().optional(),
});
export const CapabilityTestResultSchema = z.object({
  ok: z.boolean(),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(2_000),
  capability: CapabilitySchema,
  output: z.record(z.string(), z.unknown()).optional(),
});

export const PreviewCodeServiceRequestSchema = z.object({
  definition: CodeServiceCapabilityDefinitionSchema,
  input: z.unknown(),
});

export const PreviewCodeServiceResultSchema = z.object({
  ok: z.boolean(),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(2_000),
  output: z.record(z.string(), z.unknown()).optional(),
});

export const ExpertToolApprovalModeSchema = z.enum(["none", "ask", "required"]);

export const ExpertPluginReferenceSchema = z.object({
  source: z.string().trim().min(1).max(2_000),
  config: z.unknown().optional(),
});

export const ContextStoreIdSchema = z.string().uuid();

export const ContextNoteEntrySchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens."),
  description: z.string().trim().min(1).max(2_000),
  content: z.string().trim().min(1).max(100_000),
  trigger: ContextTriggerSchema,
});

const ContextStoreBaseSchema = z.object({
  schemaVersion: z.literal("pragma.context-store/v1"),
  id: ContextStoreIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const FileContextStoreSchema = ContextStoreBaseSchema.extend({
  type: z.literal("file"),
  status: z.enum(["configured", "device_offline", "needs_attention"]),
  source: z.object({
    path: z.string().trim().min(1).max(2_000),
    updateBehavior: z.enum(["watch", "manual"]),
  }),
});

export const NoteContextStoreSchema = ContextStoreBaseSchema.extend({
  type: z.literal("note"),
  status: z.literal("ready"),
  entries: z.array(ContextNoteEntrySchema).max(200).default([]),
});

export const ContextStoreSchema = z.discriminatedUnion("type", [
  FileContextStoreSchema,
  NoteContextStoreSchema,
]);

const CreateContextStoreBaseShape = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
};

export const CreateContextStoreSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("file"),
    ...CreateContextStoreBaseShape,
    source: z.object({
      path: z.string().trim().min(1).max(2_000),
      updateBehavior: z.enum(["watch", "manual"]),
    }),
  }),
  z.object({
    type: z.literal("note"),
    ...CreateContextStoreBaseShape,
  }),
]);

export const AddContextNoteEntrySchema = z.object({
  storeId: ContextStoreIdSchema,
  entry: ContextNoteEntrySchema,
});

export const ContextStoreContentMetadataSchema = z.object({
  description: z.string().max(2_000).optional(),
  trigger: ContextTriggerSchema,
  trustLevel: z.enum(["system", "workspace", "user", "external"]).optional(),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
  priority: z.enum(["critical", "high", "normal", "low"]),
});

export const ContextStoreContentSummarySchema = z.object({
  id: z.string().trim().min(1).max(2_000),
  metadata: ContextStoreContentMetadataSchema,
  revision: z.string().max(500).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const ContextStoreContentSchema = ContextStoreContentSummarySchema.extend({
  content: z.string().max(1_000_000),
  truncated: z.boolean(),
});

export const ListContextStoreContentsSchema = z.object({
  storeId: ContextStoreIdSchema,
});

export const GetContextStoreContentSchema = ListContextStoreContentsSchema.extend({
  contentId: z.string().trim().min(1).max(2_000),
});

export const ExpertContextStoreMountSchema = z.object({
  storeId: ContextStoreIdSchema,
  enabled: z.boolean(),
  priority: z.number().int().nonnegative(),
});

export const ExpertDefinitionSchema = z.object({
  schemaVersion: z.literal("pragma.desktop-expert-view/v1"),
  id: ExpertIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000),
  tags: z.array(z.string().trim().min(1).max(100)).max(30),
  version: z.string().trim().min(1).max(100),
  scope: ExpertScopeSchema,
  instructions: z.string().max(100_000).optional(),
  model: ExpertModelConfigSchema.nullable(),
  capabilities: z.array(ExpertCapabilityReferenceSchema).max(500),
  toolApprovals: z.record(z.string().max(200), ExpertToolApprovalModeSchema),
  plugins: z.array(ExpertPluginReferenceSchema).max(100),
  contextStoreMounts: z.array(ExpertContextStoreMountSchema).max(200),
  resourceTools: z.array(PragmaToolBindingSchema).max(200).default([]),
  resourceRuntime: PragmaExpertResourceSchema.shape.spec.shape.runtime,
  opaqueCapabilities: PragmaExpertResourceSchema.shape.spec.shape.capabilities.optional(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ExpertSummarySchema = ExpertDefinitionSchema.pick({
  schemaVersion: true,
  id: true,
  name: true,
  description: true,
  tags: true,
  version: true,
  scope: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateExpertDefinitionSchema = ExpertDefinitionSchema.omit({
  schemaVersion: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  id: CreateExpertIdSchema,
  name: z.string().trim().min(1).max(EXPERT_NAME_MAX_LENGTH),
  description: z.string().trim().min(1).max(EXPERT_DESCRIPTION_MAX_LENGTH),
  tags: z.array(z.string().trim().min(1).max(EXPERT_TAG_MAX_LENGTH)).max(30),
  instructions: z.string().max(100_000).optional(),
  model: ExpertModelConfigSchema.nullable().optional(),
  capabilities: z.array(ExpertCapabilityReferenceSchema).max(500).optional(),
  toolApprovals: z.record(z.string().max(200), ExpertToolApprovalModeSchema).optional(),
  plugins: z.array(ExpertPluginReferenceSchema).max(100).optional(),
  contextStoreMounts: z.array(ExpertContextStoreMountSchema).max(200).optional(),
  resourceTools: z.array(PragmaToolBindingSchema).max(200).optional(),
  resourceRuntime: PragmaExpertResourceSchema.shape.spec.shape.runtime,
  opaqueCapabilities: PragmaExpertResourceSchema.shape.spec.shape.capabilities.optional(),
});

export const UpdateExpertDefinitionSchema = CreateExpertDefinitionSchema.omit({ id: true });

export const DeleteExpertDefinitionSchema = z.object({ id: ExpertIdSchema });

export const PragmaProjectSnapshotSchema = z.object({
  schemaVersion: z.literal("pragma.desktop-project/v1"),
  projectId: z.string().trim().min(1).max(120),
  revision: z.number().int().nonnegative(),
  resources: z.array(PragmaResourceSchema),
  diagnostics: z.array(PragmaDiagnosticSchema),
  lock: PragmaLockSchema.optional(),
  updatedAt: z.string().datetime().optional(),
});

export const PublishPragmaProjectSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  resources: z.array(PragmaResourceSchema),
});

export const UpsertPragmaResourceSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  resource: PragmaResourceSchema,
});

export const DeletePragmaResourceSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  ref: PragmaResourceRefSchema,
});

export const ValidatePragmaYamlSchema = z.object({ source: z.string().max(2_000_000) });

export const ValidatePragmaResourceSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  resource: PragmaResourceSchema,
});

export const PragmaYamlValidationResultSchema = z.object({
  resource: PragmaResourceSchema.optional(),
  diagnostics: z.array(PragmaDiagnosticSchema),
});

const WorkflowLayoutIdentitySchema = z.object({
  projectId: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9_-]+$/),
  flowId: z.string().trim().min(1).max(120),
});

export const WorkflowLayoutSchema = WorkflowLayoutIdentitySchema.extend({
  schemaVersion: z.literal("pragma.desktop-flow-layout/v1"),
  flowVersion: z.string().trim().min(1).max(100),
  nodes: z.record(
    z.string().trim().min(1),
    z.object({ x: z.number().finite(), y: z.number().finite() }),
  ),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().positive().max(4),
  }),
  updatedAt: z.string().datetime(),
});

export const GetWorkflowLayoutSchema = WorkflowLayoutIdentitySchema;
export const DeleteWorkflowLayoutSchema = WorkflowLayoutIdentitySchema;

export const MissionIdSchema = z.string().uuid();

export const MissionWorkspaceSchema = z.object({
  path: z.string().trim().min(1).max(2_000),
  basename: z.string().trim().min(1).max(255),
});

const MissionExecutorBaseSchema = z.object({
  ref: PragmaResourceRefSchema,
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(100),
});

export const MissionExecutorSchema = z.discriminatedUnion("kind", [
  MissionExecutorBaseSchema.extend({ kind: z.literal("expert") }),
  MissionExecutorBaseSchema.extend({ kind: z.literal("team") }),
  MissionExecutorBaseSchema.extend({ kind: z.literal("flow") }),
]);

export const MissionLifecycleStatusSchema = z.enum(["active", "completed"]);

export const MissionMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(200_000),
  createdAt: z.string().datetime(),
  executionId: z.string().uuid().optional(),
});

export const MissionWorkItemSchema = z.object({
  invocationId: z.string().min(1),
  parentInvocationId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  executorId: z.string().min(1).optional(),
  kind: z.enum(["flow", "task", "human-task", "expert", "expert-team"]),
  status: z.enum([
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  inputSummary: z.string().max(500),
  outputSummary: z.string().max(1_000).optional(),
});

export const MissionSchema = z.object({
  schemaVersion: z.literal("pragma.mission/v2"),
  id: MissionIdSchema,
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(100_000),
  workspace: MissionWorkspaceSchema,
  project: z.object({
    id: z.string().trim().min(1),
    revision: z.number().int().positive(),
  }),
  executor: MissionExecutorSchema,
  messages: z.array(MissionMessageSchema).default([]),
  execution: z
    .object({
      id: z.string().uuid(),
      sessionId: z.string().uuid().optional(),
      status: z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]),
      startedAt: z.string().datetime(),
      finishedAt: z.string().datetime().optional(),
      error: z.string().max(10_000).optional(),
    })
    .optional(),
  lifecycleStatus: MissionLifecycleStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export const CreateMissionSchema = z.object({
  workspace: z.string().trim().min(1).max(2_000),
  executor: z.object({
    ref: PragmaResourceRefSchema,
  }),
  goal: z.string().trim().min(1).max(100_000),
});

export const MissionActionSchema = z.object({ id: MissionIdSchema });
export const SendMissionMessageSchema = z.object({
  id: MissionIdSchema,
  content: z.string().trim().min(1).max(100_000),
  requestId: z.string().uuid(),
});
export const MissionHumanInteractionSchema = z.object({
  interactionId: z.string().min(1),
  request: HumanInteractionRequestSchema,
});
export const RespondMissionHumanInteractionSchema = z.object({
  missionId: MissionIdSchema,
  interactionId: z.string().min(1),
  requestId: z.string().uuid(),
  response: HumanInteractionResponseSchema,
});

export type DesktopAppInfo = z.infer<typeof DesktopAppInfoSchema>;
export type RuntimeGatewayConfig = z.infer<typeof RuntimeGatewayConfigSchema>;
export type LocalRuntimeCapability = z.infer<typeof LocalRuntimeCapabilitySchema>;
export type DesktopRuntimeAvailability = z.infer<typeof DesktopRuntimeAvailabilitySchema>;
export type DesktopBridgeSnapshot = z.infer<typeof DesktopBridgeSnapshotSchema>;
export type PickWorkspaceResult = z.infer<typeof PickWorkspaceResultSchema>;
export type ValidateWorkspaceResult = z.infer<typeof ValidateWorkspaceResultSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export type CreateModelProvider = z.infer<typeof CreateModelProviderSchema>;
export type UpdateModelProvider = z.infer<typeof UpdateModelProviderSchema>;
export type DeleteModelProvider = z.infer<typeof DeleteModelProviderSchema>;
export type ModelConnectionTestRequest = z.infer<typeof ModelConnectionTestRequestSchema>;
export type ModelConnectionTestResult = z.infer<typeof ModelConnectionTestResultSchema>;
export type ContextStore = z.infer<typeof ContextStoreSchema>;
export type CreateContextStore = z.infer<typeof CreateContextStoreSchema>;
export type ContextNoteEntry = z.infer<typeof ContextNoteEntrySchema>;
export type AddContextNoteEntry = z.infer<typeof AddContextNoteEntrySchema>;
export type ContextStoreContentMetadata = z.infer<typeof ContextStoreContentMetadataSchema>;
export type ContextStoreContentSummary = z.infer<typeof ContextStoreContentSummarySchema>;
export type ContextStoreContent = z.infer<typeof ContextStoreContentSchema>;
export type ListContextStoreContents = z.infer<typeof ListContextStoreContentsSchema>;
export type GetContextStoreContent = z.infer<typeof GetContextStoreContentSchema>;
export type ExpertContextStoreMount = z.infer<typeof ExpertContextStoreMountSchema>;
export type ExpertDefinition = z.infer<typeof ExpertDefinitionSchema>;
export type ExpertSummary = z.infer<typeof ExpertSummarySchema>;
export type CreateExpertDefinition = z.infer<typeof CreateExpertDefinitionSchema>;
export type UpdateExpertDefinition = z.infer<typeof UpdateExpertDefinitionSchema>;
export type PragmaProjectSnapshot = z.infer<typeof PragmaProjectSnapshotSchema>;
export type PublishPragmaProject = z.infer<typeof PublishPragmaProjectSchema>;
export type UpsertPragmaResource = z.infer<typeof UpsertPragmaResourceSchema>;
export type DeletePragmaResource = z.infer<typeof DeletePragmaResourceSchema>;
export type PragmaYamlValidationResult = z.infer<typeof PragmaYamlValidationResultSchema>;
export type ValidatePragmaResource = z.infer<typeof ValidatePragmaResourceSchema>;
export type WorkflowLayout = z.infer<typeof WorkflowLayoutSchema>;
export type GetWorkflowLayout = z.infer<typeof GetWorkflowLayoutSchema>;
export type DeleteWorkflowLayout = z.infer<typeof DeleteWorkflowLayoutSchema>;
export type Mission = z.infer<typeof MissionSchema>;
export type MissionExecutor = z.infer<typeof MissionExecutorSchema>;
export type MissionLifecycleStatus = z.infer<typeof MissionLifecycleStatusSchema>;
export type CreateMission = z.infer<typeof CreateMissionSchema>;
export type MissionMessage = z.infer<typeof MissionMessageSchema>;
export type MissionWorkItem = z.infer<typeof MissionWorkItemSchema>;
export type SendMissionMessage = z.infer<typeof SendMissionMessageSchema>;
export type MissionHumanInteraction = z.infer<typeof MissionHumanInteractionSchema>;
export type RespondMissionHumanInteraction = z.infer<typeof RespondMissionHumanInteractionSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
export type CapabilityHealth = z.infer<typeof CapabilityHealthSchema>;
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;
export type ExpertCapabilityReference = z.infer<typeof ExpertCapabilityReferenceSchema>;
export type ImportSkillCapability = z.infer<typeof ImportSkillCapabilitySchema>;
export type CreateCapability = z.infer<typeof CreateCapabilitySchema>;
export type UpdateCapability = z.infer<typeof UpdateCapabilitySchema>;
export type CapabilityTestRequest = z.infer<typeof CapabilityTestRequestSchema>;
export type CapabilityTestResult = z.infer<typeof CapabilityTestResultSchema>;
export type PreviewCodeServiceRequest = z.infer<typeof PreviewCodeServiceRequestSchema>;
export type PreviewCodeServiceResult = z.infer<typeof PreviewCodeServiceResultSchema>;

export interface PragmaDesktopAPI {
  getBridgeSnapshot: () => Promise<DesktopBridgeSnapshot>;
  pickWorkspace: () => Promise<PickWorkspaceResult>;
  validateWorkspace: (path: string) => Promise<ValidateWorkspaceResult>;
  listModelProviders: () => Promise<ModelProvider[]>;
  createModelProvider: (input: CreateModelProvider) => Promise<ModelProvider>;
  updateModelProvider: (input: UpdateModelProvider) => Promise<ModelProvider>;
  deleteModelProvider: (input: DeleteModelProvider) => Promise<void>;
  testModelConnection: (input: ModelConnectionTestRequest) => Promise<ModelConnectionTestResult>;
  listContextStores: () => Promise<ContextStore[]>;
  createContextStore: (input: CreateContextStore) => Promise<ContextStore>;
  addContextNoteEntry: (input: AddContextNoteEntry) => Promise<ContextStore>;
  listContextStoreContents: (
    input: ListContextStoreContents,
  ) => Promise<ContextStoreContentSummary[]>;
  getContextStoreContent: (input: GetContextStoreContent) => Promise<ContextStoreContent>;
  pickContextStoreFolder: () => Promise<PickWorkspaceResult>;
  listExperts: () => Promise<ExpertSummary[]>;
  getExpert: (id: string) => Promise<ExpertDefinition>;
  createExpert: (input: CreateExpertDefinition) => Promise<ExpertDefinition>;
  updateExpert: (id: string, input: UpdateExpertDefinition) => Promise<ExpertDefinition>;
  deleteExpert: (id: string) => Promise<void>;
  getPragmaProject: () => Promise<PragmaProjectSnapshot>;
  publishPragmaProject: (input: PublishPragmaProject) => Promise<PragmaProjectSnapshot>;
  upsertPragmaResource: (input: UpsertPragmaResource) => Promise<PragmaProjectSnapshot>;
  deletePragmaResource: (input: DeletePragmaResource) => Promise<PragmaProjectSnapshot>;
  validatePragmaYaml: (source: string) => Promise<PragmaYamlValidationResult>;
  validatePragmaResource: (input: ValidatePragmaResource) => Promise<PragmaYamlValidationResult>;
  getWorkflowLayout: (input: GetWorkflowLayout) => Promise<WorkflowLayout | null>;
  saveWorkflowLayout: (layout: WorkflowLayout) => Promise<WorkflowLayout>;
  deleteWorkflowLayout: (input: DeleteWorkflowLayout) => Promise<void>;
  listMissions: () => Promise<Mission[]>;
  getMission: (id: string) => Promise<Mission>;
  createMission: (input: CreateMission) => Promise<Mission>;
  runMission: (id: string) => Promise<Mission>;
  sendMissionMessage: (input: SendMissionMessage) => Promise<Mission>;
  listMissionWorkItems: (id: string) => Promise<MissionWorkItem[]>;
  deleteMission: (id: string) => Promise<void>;
  listMissionHumanInteractions: (id: string) => Promise<MissionHumanInteraction[]>;
  respondToMissionHumanInteraction: (input: RespondMissionHumanInteraction) => Promise<void>;
  markMissionComplete: (id: string) => Promise<Mission>;
  reopenMission: (id: string) => Promise<Mission>;
  listCapabilities: () => Promise<Capability[]>;
  getCapability: (id: string, revision?: number) => Promise<Capability>;
  importSkillCapability: (input: ImportSkillCapability) => Promise<Capability>;
  createCapability: (input: CreateCapability) => Promise<Capability>;
  updateCapability: (input: UpdateCapability) => Promise<Capability>;
  retryCapability: (id: string) => Promise<Capability>;
  testCapability: (input: CapabilityTestRequest) => Promise<CapabilityTestResult>;
  previewCodeService: (input: PreviewCodeServiceRequest) => Promise<PreviewCodeServiceResult>;
  deleteCapability: (id: string) => Promise<void>;
  pickSkillSource: () => Promise<PickWorkspaceResult>;
  getRuntimeAvailability: () => Promise<DesktopRuntimeAvailability[]>;
}
