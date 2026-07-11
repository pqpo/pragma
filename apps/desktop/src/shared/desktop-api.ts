import { ContextTriggerSchema } from "@pragma/shared";
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

export const ExpertIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens.");

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
]);

export const CapabilityManifestSchema = z.object({
  schemaVersion: z.literal("pragma.capability/v1"),
  id: CapabilityIdSchema,
  runtimeKey: CapabilityRuntimeKeySchema,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["skill", "mcp_server", "http_service"]),
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

export const CreateCapabilitySchema = z.object({
  definition: z.union([McpServerCapabilityDefinitionSchema, HttpServiceCapabilityDefinitionSchema]),
  credentials: z.record(z.string().max(200), z.string().min(1).max(10_000)).default({}),
});

export const UpdateCapabilitySchema = z.object({
  id: CapabilityIdSchema,
  definition: z.union([McpServerCapabilityDefinitionSchema, HttpServiceCapabilityDefinitionSchema]),
  credentials: z.record(z.string().max(200), z.string().min(1).max(10_000)).default({}),
});

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

export const ExpertContextStoreMountSchema = z.object({
  storeId: ContextStoreIdSchema,
  enabled: z.boolean(),
  priority: z.number().int().nonnegative(),
});

export const ExpertDefinitionSchema = z.object({
  schemaVersion: z.literal("pragma.expert/v2"),
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
  instructions: z.string().max(100_000).optional(),
  model: ExpertModelConfigSchema.nullable().optional(),
  capabilities: z.array(ExpertCapabilityReferenceSchema).max(500).optional(),
  toolApprovals: z.record(z.string().max(200), ExpertToolApprovalModeSchema).optional(),
  plugins: z.array(ExpertPluginReferenceSchema).max(100).optional(),
  contextStoreMounts: z.array(ExpertContextStoreMountSchema).max(200).optional(),
});

export const UpdateExpertDefinitionSchema = CreateExpertDefinitionSchema.omit({ id: true });

export const DeleteExpertDefinitionSchema = z.object({ id: ExpertIdSchema });

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
export type ExpertContextStoreMount = z.infer<typeof ExpertContextStoreMountSchema>;
export type ExpertDefinition = z.infer<typeof ExpertDefinitionSchema>;
export type ExpertSummary = z.infer<typeof ExpertSummarySchema>;
export type CreateExpertDefinition = z.infer<typeof CreateExpertDefinitionSchema>;
export type UpdateExpertDefinition = z.infer<typeof UpdateExpertDefinitionSchema>;
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
  pickContextStoreFolder: () => Promise<PickWorkspaceResult>;
  listExperts: () => Promise<ExpertSummary[]>;
  getExpert: (id: string) => Promise<ExpertDefinition>;
  createExpert: (input: CreateExpertDefinition) => Promise<ExpertDefinition>;
  updateExpert: (id: string, input: UpdateExpertDefinition) => Promise<ExpertDefinition>;
  deleteExpert: (id: string) => Promise<void>;
  listCapabilities: () => Promise<Capability[]>;
  getCapability: (id: string, revision?: number) => Promise<Capability>;
  importSkillCapability: (input: ImportSkillCapability) => Promise<Capability>;
  createCapability: (input: CreateCapability) => Promise<Capability>;
  updateCapability: (input: UpdateCapability) => Promise<Capability>;
  retryCapability: (id: string) => Promise<Capability>;
  testCapability: (input: CapabilityTestRequest) => Promise<CapabilityTestResult>;
  deleteCapability: (id: string) => Promise<void>;
  pickSkillSource: () => Promise<PickWorkspaceResult>;
  getRuntimeAvailability: () => Promise<DesktopRuntimeAvailability[]>;
}
