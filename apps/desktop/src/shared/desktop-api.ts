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

export const ExpertScopeSchema = z.enum(["personal", "organization"]);

export const ExpertModelConfigSchema = z.object({
  providerId: ModelProviderIdSchema.optional(),
  modelName: ModelIdSchema,
});

export const ExpertSkillReferenceSchema = z.object({
  type: z.enum(["builtin", "registry", "local"]),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000),
  path: z.string().trim().min(1).max(1_000).optional(),
  baseDir: z.enum(["workspace", "user"]).optional(),
  version: z.string().trim().min(1).max(100).nullable().optional(),
});

const ExpertMcpEnvironmentSchema = z
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

export const ExpertMcpServerSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    transport: z.enum(["stdio", "http"]),
    command: z.string().trim().min(1).max(1_000).optional(),
    args: z.array(z.string().max(2_000)).max(100).optional(),
    url: z.string().url().optional(),
    env: ExpertMcpEnvironmentSchema.optional(),
    secretRefs: z.record(z.string().max(200), z.string().trim().min(1).max(200)).optional(),
    allowTools: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
    disallowTools: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
    timeout: z.number().int().positive().max(120_000).optional(),
  })
  .superRefine((server, context) => {
    if (server.transport === "stdio" && server.command === undefined) {
      context.addIssue({
        code: "custom",
        message: "A stdio MCP server requires a command.",
        path: ["command"],
      });
    }
    if (server.transport === "http" && server.url === undefined) {
      context.addIssue({
        code: "custom",
        message: "An HTTP MCP server requires a URL.",
        path: ["url"],
      });
    }
    if (server.transport === "stdio" && server.url !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A stdio MCP server cannot declare a URL.",
        path: ["url"],
      });
    }
    if (
      server.transport === "http" &&
      (server.command !== undefined || server.args !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "An HTTP MCP server cannot declare a command or arguments.",
        path: [server.command === undefined ? "args" : "command"],
      });
    }
  });

export const ExpertToolApprovalModeSchema = z.enum(["none", "ask", "required"]);

export const ExpertPluginReferenceSchema = z.object({
  source: z.string().trim().min(1).max(2_000),
  config: z.unknown().optional(),
});

export const ExpertDefinitionSchema = z.object({
  schemaVersion: z.literal("pragma.expert/v1"),
  id: ExpertIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000),
  tags: z.array(z.string().trim().min(1).max(100)).max(30),
  version: z.string().trim().min(1).max(100),
  scope: ExpertScopeSchema,
  instructions: z.string().max(100_000).optional(),
  model: ExpertModelConfigSchema.nullable(),
  skills: z.array(ExpertSkillReferenceSchema).max(200),
  mcpServers: z.array(ExpertMcpServerSchema).max(100),
  toolIds: z.array(z.string().trim().min(1).max(200)).max(500),
  toolApprovals: z.record(z.string().max(200), ExpertToolApprovalModeSchema),
  plugins: z.array(ExpertPluginReferenceSchema).max(100),
  contextSources: z.array(z.string().trim().min(1).max(1_000)).max(200),
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
  skills: z.array(ExpertSkillReferenceSchema).max(200).optional(),
  mcpServers: z.array(ExpertMcpServerSchema).max(100).optional(),
  toolIds: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
  toolApprovals: z.record(z.string().max(200), ExpertToolApprovalModeSchema).optional(),
  plugins: z.array(ExpertPluginReferenceSchema).max(100).optional(),
  contextSources: z.array(z.string().trim().min(1).max(1_000)).max(200).optional(),
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
export type ExpertDefinition = z.infer<typeof ExpertDefinitionSchema>;
export type ExpertSummary = z.infer<typeof ExpertSummarySchema>;
export type CreateExpertDefinition = z.infer<typeof CreateExpertDefinitionSchema>;
export type UpdateExpertDefinition = z.infer<typeof UpdateExpertDefinitionSchema>;

export interface PragmaDesktopAPI {
  getBridgeSnapshot: () => Promise<DesktopBridgeSnapshot>;
  pickWorkspace: () => Promise<PickWorkspaceResult>;
  validateWorkspace: (path: string) => Promise<ValidateWorkspaceResult>;
  listModelProviders: () => Promise<ModelProvider[]>;
  createModelProvider: (input: CreateModelProvider) => Promise<ModelProvider>;
  updateModelProvider: (input: UpdateModelProvider) => Promise<ModelProvider>;
  deleteModelProvider: (input: DeleteModelProvider) => Promise<void>;
  testModelConnection: (input: ModelConnectionTestRequest) => Promise<ModelConnectionTestResult>;
  listExperts: () => Promise<ExpertSummary[]>;
  getExpert: (id: string) => Promise<ExpertDefinition>;
  createExpert: (input: CreateExpertDefinition) => Promise<ExpertDefinition>;
  updateExpert: (id: string, input: UpdateExpertDefinition) => Promise<ExpertDefinition>;
  deleteExpert: (id: string) => Promise<void>;
  getRuntimeAvailability: () => Promise<DesktopRuntimeAvailability[]>;
}
