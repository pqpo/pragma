import {
  ContextTriggerSchema,
  HumanInteractionRequestSchema,
  HumanInteractionResponseSchema,
  ModelApiSchema as SharedModelApiSchema,
  ModelCompatibilityProfileIdSchema,
  ModelThinkingLevelSchema,
  ProviderModelDefinitionSchema,
  ToolPermissionModeSchema,
} from "@pragma/shared";
import {
  canonicalPragmaResourceRef,
  PragmaBindingRefSchema,
  PragmaDiagnosticSchema,
  PragmaExpertResourceSchema,
  PragmaInvocableResourceRefSchema,
  PragmaLockSchema,
  PragmaResourceRefSchema,
  PragmaSemanticResourceRefSchema,
  PragmaResourceSchema,
  PragmaToolBindingSchema,
  PragmaHttpParameterSchema,
  PragmaHttpToolSchema,
  PRAGMA_EXPERT_INSTRUCTIONS_MAX_LENGTH,
  PRAGMA_EXPERT_SCOPE_MAX_LENGTH,
  PragmaExpertInstructionsSchema,
  PragmaExpertScopeSchema,
  PragmaSemanticResourceIdSchema,
  PragmaJsonSchemaSchema,
  PragmaObjectJsonSchemaSchema,
  type PragmaJsonSchema,
  type PragmaInvocableResource,
  type PragmaResource,
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

export const DesktopLocalePreferenceSchema = z.enum(["system", "en", "zh-Hans", "zh-Hant"]);

export const DesktopResolvedLocaleSchema = z.enum(["en", "zh-Hans", "zh-Hant"]);

export const DesktopToolPermissionModeSchema = ToolPermissionModeSchema;

export const DesktopSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  localePreference: DesktopLocalePreferenceSchema,
  toolPermissionMode: DesktopToolPermissionModeSchema.default("request-approval"),
  defaultWorkspace: z.string().trim().min(1).max(2_000).optional(),
});

export const DesktopSettingsSnapshotSchema = DesktopSettingsSchema.omit({
  defaultWorkspace: true,
}).extend({
  defaultWorkspace: z.string().trim().min(1).max(2_000),
  usesBuiltInDefaultWorkspace: z.boolean(),
  resolvedLocale: DesktopResolvedLocaleSchema,
});

export const UpdateDesktopSettingsSchema = z
  .object({
    localePreference: DesktopLocalePreferenceSchema.optional(),
    toolPermissionMode: DesktopToolPermissionModeSchema.optional(),
    defaultWorkspace: z.string().trim().min(1).max(2_000).nullable().optional(),
  })
  .refine(
    (input) =>
      input.localePreference !== undefined ||
      input.toolPermissionMode !== undefined ||
      input.defaultWorkspace !== undefined,
    "At least one Desktop setting must be provided.",
  );

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
export const ModelProviderPresetIdSchema = z.string().trim().min(1).max(80);
export const ModelProviderProtocolSchema = SharedModelApiSchema;

export const ModelCompatibilityProfileDescriptorSchema = z.object({
  id: ModelCompatibilityProfileIdSchema,
  displayName: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000),
  api: z.enum(["openai-completions", "openai-responses"]),
});

export const ModelProviderModelSchema = ProviderModelDefinitionSchema.extend({
  capabilitiesSource: z.enum(["preset", "provider", "manual"]),
});

export const ModelProviderVerificationSchema = z.object({
  status: z.enum(["unverified", "verified", "failed"]),
  checkedAt: z.string().datetime().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  code: z.string().trim().min(1).max(100).optional(),
  message: z.string().max(2_000).optional(),
  revision: z.number().int().positive().optional(),
});

export const ModelProviderSchema = z.object({
  id: ModelProviderIdSchema,
  presetId: ModelProviderPresetIdSchema,
  name: z.string().trim().min(1).max(100),
  protocol: ModelProviderProtocolSchema,
  baseUrl: z.string().url(),
  compatibilityProfileId: ModelCompatibilityProfileIdSchema.optional(),
  models: z.array(ModelProviderModelSchema).min(1),
  hasApiKey: z.boolean(),
  requiresApiKey: z.boolean(),
  verification: ModelProviderVerificationSchema,
  revision: z.number().int().positive(),
});

export const CreateModelProviderSchema = z.object({
  presetId: ModelProviderPresetIdSchema,
  name: z.string().trim().min(1).max(100),
  protocol: ModelProviderProtocolSchema,
  baseUrl: z.string().trim().url(),
  compatibilityProfileId: ModelCompatibilityProfileIdSchema.optional(),
  apiKey: z.string().trim().max(10_000),
  requiresApiKey: z.boolean(),
  models: z.array(ModelProviderModelSchema).min(1).max(100),
});

export const UpdateModelProviderSchema = z.object({
  id: ModelProviderIdSchema,
  presetId: ModelProviderPresetIdSchema,
  name: z.string().trim().min(1).max(100),
  protocol: ModelProviderProtocolSchema,
  baseUrl: z.string().trim().url(),
  compatibilityProfileId: ModelCompatibilityProfileIdSchema.optional(),
  apiKey: z.string().trim().max(10_000).optional(),
  requiresApiKey: z.boolean(),
  models: z.array(ModelProviderModelSchema).min(1).max(100),
});

export const DeleteModelProviderSchema = z.object({
  id: ModelProviderIdSchema,
});

export const ModelConnectionTestRequestSchema = z.object({
  providerId: ModelProviderIdSchema,
  modelId: ModelIdSchema.optional(),
  thinkingLevel: ModelThinkingLevelSchema.optional(),
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
    "unsupported_protocol",
    "request_failed",
  ]),
  message: z.string(),
  latencyMs: z.number().int().nonnegative().optional(),
  status: z.number().int().optional(),
});

export const DiscoverProviderModelsSchema = z.object({
  presetId: ModelProviderPresetIdSchema,
  protocol: ModelProviderProtocolSchema,
  baseUrl: z.string().trim().url(),
  apiKey: z.string().trim().max(10_000).optional(),
  providerId: ModelProviderIdSchema.optional(),
});

export const ModelDiscoveryResultSchema = z.object({
  ok: z.boolean(),
  models: z.array(ModelProviderModelSchema),
  message: z.string().max(2_000),
  source: z.enum(["provider", "preset", "manual"]),
});

export const ModelProviderSettingsSnapshotSchema = z.object({
  status: z.enum(["ready", "reset_required"]),
  providers: z.array(ModelProviderSchema),
  legacyConfigPath: z.string().optional(),
  message: z.string().optional(),
});

export const ResetModelProvidersResultSchema = ModelProviderSettingsSnapshotSchema.extend({
  backupPath: z.string().optional(),
});

export const EXPERT_NAME_MAX_LENGTH = 20;
export const EXPERT_ID_MAX_LENGTH = 20;
export const EXPERT_DESCRIPTION_MAX_LENGTH = 200;
export const EXPERT_TAG_MAX_LENGTH = 20;
export const EXPERT_SCOPE_MAX_LENGTH = PRAGMA_EXPERT_SCOPE_MAX_LENGTH;
export const EXPERT_INSTRUCTIONS_MAX_LENGTH = PRAGMA_EXPERT_INSTRUCTIONS_MAX_LENGTH;

export const ExpertIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(EXPERT_ID_MAX_LENGTH)
  .pipe(PragmaSemanticResourceIdSchema);

export const CreateExpertIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(EXPERT_ID_MAX_LENGTH)
  .pipe(PragmaSemanticResourceIdSchema);

export const ExpertScopeSchema = PragmaExpertScopeSchema;
export const ExpertInstructionsSchema = PragmaExpertInstructionsSchema;
export const ExpertAdditionalInstructionsSchema = z
  .string()
  .max(EXPERT_INSTRUCTIONS_MAX_LENGTH)
  .default("");

export const ExpertModelConfigSchema = z.object({
  runtimeId: DesktopRuntimeIdSchema,
  providerId: z.string().trim().min(1).max(200),
  modelId: ModelIdSchema,
  thinkingLevel: z.string().trim().min(1).max(100).optional(),
});

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
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000),
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
export const CapabilityDeleteResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.literal("capability_referenced"),
  }),
]);
export const GetSkillDocumentSchema = z.object({
  id: CapabilityIdSchema,
  revision: z.number().int().positive().optional(),
});
export const SkillDocumentSchema = z.object({
  capabilityId: CapabilityIdSchema,
  revision: z.number().int().positive(),
  entryPath: z.literal("SKILL.md"),
  content: z.string(),
});
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
  output: z.unknown().optional(),
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

export const DeleteContextStoreSchema = z.object({
  storeId: ContextStoreIdSchema,
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

export const ExpertExecutionProfileSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("pinned"), model: ExpertModelConfigSchema }),
  z.object({ mode: z.literal("system-default") }),
]);

export const ExpertDefinitionSchema = z.object({
  schemaVersion: z.literal("pragma.desktop-expert-view/v1"),
  ref: PragmaSemanticResourceRefSchema.refine((value) => value.startsWith("expert:")),
  id: ExpertIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000),
  tags: z.array(z.string().trim().min(1).max(100)).max(30),
  version: z.string().trim().min(1).max(100),
  scope: ExpertScopeSchema,
  instructions: ExpertInstructionsSchema,
  additionalInstructions: ExpertAdditionalInstructionsSchema,
  origin: z.enum(["project", "built-in"]),
  readOnly: z.boolean(),
  customized: z.boolean(),
  executionProfile: ExpertExecutionProfileSchema,
  capabilities: z.array(ExpertCapabilityReferenceSchema).max(500),
  toolApprovals: z.record(z.string().max(200), ExpertToolApprovalModeSchema),
  plugins: z.array(ExpertPluginReferenceSchema).max(100),
  contextStoreMounts: z.array(ExpertContextStoreMountSchema).max(200),
  resourceTools: z.array(PragmaToolBindingSchema).max(200).default([]),
  resourceRuntime: PragmaExpertResourceSchema.shape.spec.shape.runtime.optional(),
  opaqueCapabilities: PragmaExpertResourceSchema.shape.spec.shape.capabilities.optional(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ExpertSummarySchema = ExpertDefinitionSchema.pick({
  schemaVersion: true,
  ref: true,
  id: true,
  name: true,
  description: true,
  tags: true,
  version: true,
  scope: true,
  origin: true,
  readOnly: true,
  customized: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateExpertDefinitionSchema = ExpertDefinitionSchema.omit({
  schemaVersion: true,
  ref: true,
  resourceRuntime: true,
  origin: true,
  readOnly: true,
  customized: true,
  additionalInstructions: true,
  executionProfile: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  id: CreateExpertIdSchema,
  name: z.string().trim().min(1).max(EXPERT_NAME_MAX_LENGTH),
  description: z.string().trim().min(1).max(EXPERT_DESCRIPTION_MAX_LENGTH),
  tags: z.array(z.string().trim().min(1).max(EXPERT_TAG_MAX_LENGTH)).max(30),
  instructions: ExpertInstructionsSchema,
  model: ExpertModelConfigSchema,
  capabilities: z.array(ExpertCapabilityReferenceSchema).max(500).optional(),
  toolApprovals: z.record(z.string().max(200), ExpertToolApprovalModeSchema).optional(),
  plugins: z.array(ExpertPluginReferenceSchema).max(100).optional(),
  contextStoreMounts: z.array(ExpertContextStoreMountSchema).max(200).optional(),
  resourceTools: z.array(PragmaToolBindingSchema).max(200).optional(),
  opaqueCapabilities: PragmaExpertResourceSchema.shape.spec.shape.capabilities.optional(),
});

export const UpdateExpertDefinitionSchema = CreateExpertDefinitionSchema.omit({ id: true });

export const UpdateBuiltInExpertDefinitionSchema = CreateExpertDefinitionSchema.pick({
  name: true,
  description: true,
  tags: true,
  model: true,
  capabilities: true,
  toolApprovals: true,
  plugins: true,
  contextStoreMounts: true,
})
  .extend({
    additionalInstructions: ExpertAdditionalInstructionsSchema,
    model: ExpertModelConfigSchema.optional(),
    capabilities: ExpertDefinitionSchema.shape.capabilities,
    toolApprovals: ExpertDefinitionSchema.shape.toolApprovals,
    plugins: ExpertDefinitionSchema.shape.plugins,
    contextStoreMounts: ExpertDefinitionSchema.shape.contextStoreMounts,
  })
  .strict();

export const ExpertRefSchema = PragmaSemanticResourceRefSchema.refine((value) =>
  value.startsWith("expert:"),
);
export const DeleteExpertDefinitionSchema = z.object({ ref: ExpertRefSchema });
export const ResetBuiltInExpertDefinitionSchema = z.object({ ref: ExpertRefSchema });

export const PragmaProjectSnapshotSchema = z.object({
  schemaVersion: z.literal("pragma.project-snapshot/v2"),
  projectId: z.string().trim().min(1).max(120),
  revision: z.number().int().nonnegative(),
  resources: z.array(PragmaResourceSchema),
  diagnostics: z.array(PragmaDiagnosticSchema),
  lock: PragmaLockSchema.optional(),
  projectFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
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
  ref: PragmaInvocableResourceRefSchema,
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(100),
});

export const MissionExecutorSchema = z.discriminatedUnion("kind", [
  MissionExecutorBaseSchema.extend({ kind: z.literal("expert") }),
  MissionExecutorBaseSchema.extend({ kind: z.literal("team") }),
  MissionExecutorBaseSchema.extend({ kind: z.literal("flow") }),
]);

const MissionExecutorOptionBaseSchema = MissionExecutorBaseSchema.extend({
  description: z.string().trim().max(2_000),
  origin: z.enum(["project", "built-in"]),
  readOnly: z.boolean(),
  customized: z.boolean(),
});

export const MissionExecutorOptionSchema = z.discriminatedUnion("kind", [
  MissionExecutorOptionBaseSchema.extend({ kind: z.literal("expert") }),
  MissionExecutorOptionBaseSchema.extend({ kind: z.literal("team") }),
  MissionExecutorOptionBaseSchema.extend({ kind: z.literal("flow") }),
]);

export const MissionCreationDefaultsSchema = z.object({
  workspace: MissionWorkspaceSchema,
  recentWorkspaces: z.array(MissionWorkspaceSchema).max(5),
  executorRef: ExpertRefSchema,
  toolPermissionMode: DesktopToolPermissionModeSchema,
});

export const MissionModelOverrideSchema = ExpertModelConfigSchema.omit({
  runtimeId: true,
}).strict();

export const MissionModelOptionsRequestSchema = z.object({
  executorRef: PragmaInvocableResourceRefSchema,
  missionId: MissionIdSchema.optional(),
});

export const MissionModelOptionsSchema = z.object({
  status: z.enum(["ready", "reset_required"]),
  runtime: z.object({
    id: DesktopRuntimeIdSchema,
    displayName: z.string().trim().min(1).max(200),
  }),
  models: z.array(DesktopRuntimeModelSchema),
  defaultSelection: MissionModelOverrideSchema.optional(),
});

export const MissionLifecycleStatusSchema = z.enum(["active", "completed"]);

export const MissionUserMessageSchema = z.object({
  id: z.string().uuid(),
  content: z.string().min(1).max(100_000),
  createdAt: z.string().datetime(),
});

export const MissionTimelineRecordSchema = z.discriminatedUnion("kind", [
  MissionUserMessageSchema.extend({
    schemaVersion: z.literal("pragma.mission-message/v1"),
    sequence: z.number().int().positive(),
    kind: z.literal("user"),
  }),
  z.object({
    schemaVersion: z.literal("pragma.mission-message/v1"),
    sequence: z.number().int().positive(),
    kind: z.literal("execution"),
    inputMessageId: z.string().uuid(),
    executionId: z.string().uuid(),
    createdAt: z.string().datetime(),
  }),
]);

export const MissionWorkTaskSchema = z.object({
  taskId: z.string().min(1),
  executionId: z.string().min(1),
  invocationId: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative().optional(),
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
  error: z.string().max(10_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const MissionWorkRecordSchema = z.object({
  recordId: z.string().min(1),
  kind: z.enum(["root", "agent", "runtime-agent", "flow", "task", "human-task"]),
  sessionId: z.string().min(1),
  parentRecordId: z.string().min(1).optional(),
  title: z.string().min(1),
  executorId: z.string().min(1).optional(),
  origin: z.enum(["core", "runtime"]),
  status: MissionWorkTaskSchema.shape.status,
  tasks: z.array(MissionWorkTaskSchema),
  summary: z.string().max(1_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const MissionWorkSnapshotSchema = z.object({
  missionId: MissionIdSchema,
  revision: z.number().int().nonnegative(),
  records: z.array(MissionWorkRecordSchema),
});

const MissionExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);

export const MissionSchema = z.object({
  schemaVersion: z.literal("pragma.mission/v3"),
  id: MissionIdSchema,
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(100_000),
  initialMessageId: z.string().uuid(),
  toolPermissionMode: DesktopToolPermissionModeSchema.default("request-approval"),
  workspace: MissionWorkspaceSchema,
  project: z.object({
    id: z.string().trim().min(1),
    revision: z.number().int().positive(),
  }),
  executor: MissionExecutorSchema,
  modelOverride: MissionModelOverrideSchema.optional(),
  execution: z
    .object({
      id: z.string().uuid(),
      inputMessageId: z.string().uuid(),
      sessionId: z.string().uuid().optional(),
      status: MissionExecutionStatusSchema,
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

export const MissionSummarySchema = z.object({
  id: MissionIdSchema,
  title: z.string().trim().min(1).max(120),
  workspace: z.object({ basename: z.string().trim().min(1).max(255) }),
  executor: z.object({
    kind: z.enum(["expert", "team", "flow"]),
    name: z.string().trim().min(1).max(120),
  }),
  execution: z.object({ status: MissionExecutionStatusSchema }).optional(),
  lifecycleStatus: MissionLifecycleStatusSchema,
  updatedAt: z.string().datetime(),
});

export const CreateMissionSchema = z.object({
  workspace: z.string().trim().min(1).max(2_000),
  executor: z.object({
    ref: PragmaInvocableResourceRefSchema,
  }),
  goal: z.string().trim().min(1).max(100_000),
  toolPermissionMode: DesktopToolPermissionModeSchema.optional(),
  modelOverride: MissionModelOverrideSchema.optional(),
});

export const UpdateMissionOptionsSchema = z.object({
  id: MissionIdSchema,
  toolPermissionMode: DesktopToolPermissionModeSchema,
  modelOverride: MissionModelOverrideSchema.nullable(),
});

export function isMissionExecutorResource(
  resource: PragmaResource,
): resource is PragmaInvocableResource {
  return resource.kind === "Expert" || resource.kind === "ExpertTeam" || resource.kind === "Flow";
}

export function missionExecutorKind(resource: PragmaInvocableResource): "expert" | "team" | "flow" {
  switch (resource.kind) {
    case "Expert":
      return "expert";
    case "ExpertTeam":
      return "team";
    case "Flow":
      return "flow";
  }
}

export function missionExecutorRef(resource: PragmaInvocableResource): string {
  return canonicalPragmaResourceRef(resource);
}

export function missionExecutorSnapshot(resource: PragmaInvocableResource): MissionExecutor {
  return MissionExecutorSchema.parse({
    kind: missionExecutorKind(resource),
    ref: missionExecutorRef(resource),
    name: resource.metadata.name,
    version: resource.metadata.version,
  });
}

export const MissionActionSchema = z.object({ id: MissionIdSchema });
export const GetMissionChatSchema = z.object({
  id: MissionIdSchema,
  beforeSequence: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const GetMissionWorkOutputSchema = z.object({
  id: MissionIdSchema,
  recordId: z.string().min(1),
  beforeCursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export const SendMissionMessageSchema = z.object({
  id: MissionIdSchema,
  content: z.string().trim().min(1).max(100_000),
  requestId: z.string().uuid(),
});
export const MissionHumanInteractionSchema = z.object({
  interactionId: z.string().min(1),
  request: HumanInteractionRequestSchema,
});

const MissionChatEntryBaseSchema = z.object({
  id: z.string().min(1),
  timelineSequence: z.number().int().positive().optional(),
  executionId: z.string().min(1).optional(),
  invocationId: z.string().min(1).optional(),
  executorId: z.string().min(1).optional(),
  executorName: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
});

export const MissionChatEntrySchema = z.discriminatedUnion("kind", [
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("user"),
    content: z.string().max(200_000),
  }),
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("assistant"),
    content: z.string().max(200_000),
    streaming: z.boolean().default(false),
  }),
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("thinking"),
    content: z.string().max(200_000),
    streaming: z.boolean().default(false),
  }),
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("tool"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    status: z.enum(["running", "approval_required", "succeeded", "failed"]),
    inputPreview: z.string().max(801).optional(),
    outputPreview: z.string().max(801).optional(),
    error: z.string().max(10_000).optional(),
  }),
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("agent_activity"),
    commandId: z.string().min(1),
    action: z.enum(["spawn", "wait", "list", "send", "resume", "interrupt", "run"]),
    phase: z.enum(["started", "completed", "failed"]),
    senderSessionId: z.string().min(1).optional(),
    targetSessionIds: z.array(z.string().min(1)).default([]),
    label: z.string().max(500).optional(),
    error: z.string().max(10_000).optional(),
  }),
]);

export const MissionWorkOutputSnapshotSchema = z.object({
  missionId: MissionIdSchema,
  recordId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  entries: z.array(MissionChatEntrySchema),
  nextBeforeCursor: z.string().min(1).optional(),
});

export const MissionWorkUpdateSchema = z.object({
  missionId: MissionIdSchema,
  revision: z.number().int().positive(),
});

export const MissionChatExecutionSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]),
  interruptible: z.boolean(),
  error: z.string().max(10_000).optional(),
});

export const MissionChatSnapshotSchema = z.object({
  missionId: MissionIdSchema,
  revision: z.number().int().nonnegative(),
  entries: z.array(MissionChatEntrySchema),
  page: z.object({
    oldestSequence: z.number().int().positive().optional(),
    newestSequence: z.number().int().positive().optional(),
    nextBeforeSequence: z.number().int().positive().optional(),
  }),
  pendingInteractions: z.array(MissionHumanInteractionSchema),
  execution: MissionChatExecutionSchema.optional(),
});

export const MissionChatPatchSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("entry.upsert"),
    entry: MissionChatEntrySchema,
  }),
  z.object({
    type: z.literal("entry.append"),
    entryId: z.string().min(1),
    field: z.enum(["content", "outputPreview"]),
    delta: z.string().max(200_000),
  }),
  z.object({
    type: z.literal("entry.streaming"),
    entryId: z.string().min(1),
    streaming: z.boolean(),
  }),
]);

const MissionChatUpdateBaseSchema = z.object({
  missionId: MissionIdSchema,
  revision: z.number().int().positive(),
});

export const MissionChatUpdateSchema = z.discriminatedUnion("kind", [
  MissionChatUpdateBaseSchema.extend({
    kind: z.literal("patch"),
    patches: z.array(MissionChatPatchSchema).min(1),
  }),
  MissionChatUpdateBaseSchema.extend({
    kind: z.literal("invalidate"),
  }),
]);

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
export type SetDefaultRuntime = z.infer<typeof SetDefaultRuntimeSchema>;
export type DesktopRuntimeModel = z.infer<typeof DesktopRuntimeModelSchema>;
export type RuntimeEnvironmentDefinition = z.infer<typeof RuntimeEnvironmentDefinitionSchema>;
export type RuntimeEnvironmentRevision = z.infer<typeof RuntimeEnvironmentRevisionSchema>;
export type RuntimeEnvironmentCatalogEntry = z.infer<typeof RuntimeEnvironmentCatalogEntrySchema>;
export type DesktopBridgeSnapshot = z.infer<typeof DesktopBridgeSnapshotSchema>;
export type DesktopLocalePreference = z.infer<typeof DesktopLocalePreferenceSchema>;
export type DesktopResolvedLocale = z.infer<typeof DesktopResolvedLocaleSchema>;
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;
export type DesktopSettingsSnapshot = z.infer<typeof DesktopSettingsSnapshotSchema>;
export type UpdateDesktopSettings = z.infer<typeof UpdateDesktopSettingsSchema>;
export type DesktopToolPermissionMode = z.infer<typeof DesktopToolPermissionModeSchema>;
export type PickWorkspaceResult = z.infer<typeof PickWorkspaceResultSchema>;
export type ValidateWorkspaceResult = z.infer<typeof ValidateWorkspaceResultSchema>;
export type ModelProviderModel = z.infer<typeof ModelProviderModelSchema>;
export type ModelCompatibilityProfileDescriptor = z.infer<
  typeof ModelCompatibilityProfileDescriptorSchema
>;
export type ModelProviderVerification = z.infer<typeof ModelProviderVerificationSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export type CreateModelProvider = z.infer<typeof CreateModelProviderSchema>;
export type UpdateModelProvider = z.infer<typeof UpdateModelProviderSchema>;
export type DeleteModelProvider = z.infer<typeof DeleteModelProviderSchema>;
export type ModelConnectionTestRequest = z.infer<typeof ModelConnectionTestRequestSchema>;
export type ModelConnectionTestResult = z.infer<typeof ModelConnectionTestResultSchema>;
export type DiscoverProviderModels = z.infer<typeof DiscoverProviderModelsSchema>;
export type ModelDiscoveryResult = z.infer<typeof ModelDiscoveryResultSchema>;
export type ModelProviderSettingsSnapshot = z.infer<typeof ModelProviderSettingsSnapshotSchema>;
export type ResetModelProvidersResult = z.infer<typeof ResetModelProvidersResultSchema>;
export type ContextStore = z.infer<typeof ContextStoreSchema>;
export type CreateContextStore = z.infer<typeof CreateContextStoreSchema>;
export type DeleteContextStore = z.infer<typeof DeleteContextStoreSchema>;
export type ContextNoteEntry = z.infer<typeof ContextNoteEntrySchema>;
export type AddContextNoteEntry = z.infer<typeof AddContextNoteEntrySchema>;
export type ContextStoreContentMetadata = z.infer<typeof ContextStoreContentMetadataSchema>;
export type ContextStoreContentSummary = z.infer<typeof ContextStoreContentSummarySchema>;
export type ContextStoreContent = z.infer<typeof ContextStoreContentSchema>;
export type ListContextStoreContents = z.infer<typeof ListContextStoreContentsSchema>;
export type GetContextStoreContent = z.infer<typeof GetContextStoreContentSchema>;
export type ExpertContextStoreMount = z.infer<typeof ExpertContextStoreMountSchema>;
export type DesktopPluginManifest = z.infer<typeof DesktopPluginManifestSchema>;
export type DesktopPlugin = z.infer<typeof DesktopPluginSchema>;
export type PluginZipInspection = z.infer<typeof PluginZipInspectionSchema>;
export type ImportPluginZip = z.infer<typeof ImportPluginZipSchema>;
export type UpdatePluginDefaults = z.infer<typeof UpdatePluginDefaultsSchema>;
export type ExpertPluginReference = z.infer<typeof ExpertPluginReferenceSchema>;
export type ExpertDefinition = z.infer<typeof ExpertDefinitionSchema>;
export type ExpertExecutionProfile = z.infer<typeof ExpertExecutionProfileSchema>;
export type ExpertModelConfig = z.infer<typeof ExpertModelConfigSchema>;
export type ExpertSummary = z.infer<typeof ExpertSummarySchema>;
export type CreateExpertDefinition = z.infer<typeof CreateExpertDefinitionSchema>;
export type UpdateExpertDefinition = z.infer<typeof UpdateExpertDefinitionSchema>;
export type UpdateBuiltInExpertDefinition = z.infer<typeof UpdateBuiltInExpertDefinitionSchema>;
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
export type MissionSummary = z.infer<typeof MissionSummarySchema>;
export type MissionExecutor = z.infer<typeof MissionExecutorSchema>;
export type MissionExecutorOption = z.infer<typeof MissionExecutorOptionSchema>;
export type MissionCreationDefaults = z.infer<typeof MissionCreationDefaultsSchema>;
export type MissionModelOverride = z.infer<typeof MissionModelOverrideSchema>;
export type MissionModelOptions = z.infer<typeof MissionModelOptionsSchema>;
export type MissionLifecycleStatus = z.infer<typeof MissionLifecycleStatusSchema>;
export type CreateMission = z.infer<typeof CreateMissionSchema>;
export type UpdateMissionOptions = z.infer<typeof UpdateMissionOptionsSchema>;
export type MissionUserMessage = z.infer<typeof MissionUserMessageSchema>;
export type MissionTimelineRecord = z.infer<typeof MissionTimelineRecordSchema>;
export type MissionWorkTask = z.infer<typeof MissionWorkTaskSchema>;
export type MissionWorkRecord = z.infer<typeof MissionWorkRecordSchema>;
export type MissionWorkSnapshot = z.infer<typeof MissionWorkSnapshotSchema>;
export type GetMissionWorkOutput = z.infer<typeof GetMissionWorkOutputSchema>;
export type MissionWorkOutputSnapshot = z.infer<typeof MissionWorkOutputSnapshotSchema>;
export type MissionWorkUpdate = z.infer<typeof MissionWorkUpdateSchema>;
export type GetMissionChat = z.input<typeof GetMissionChatSchema>;
export type MissionChatQuery = z.output<typeof GetMissionChatSchema>;
export type SendMissionMessage = z.infer<typeof SendMissionMessageSchema>;
export type MissionHumanInteraction = z.infer<typeof MissionHumanInteractionSchema>;
export type MissionChatEntry = z.infer<typeof MissionChatEntrySchema>;
export type MissionChatSnapshot = z.infer<typeof MissionChatSnapshotSchema>;
export type MissionChatPatch = z.infer<typeof MissionChatPatchSchema>;
export type MissionChatUpdate = z.infer<typeof MissionChatUpdateSchema>;
export type RespondMissionHumanInteraction = z.infer<typeof RespondMissionHumanInteractionSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
export type CapabilityHealth = z.infer<typeof CapabilityHealthSchema>;
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;
export type ExpertCapabilityReference = z.infer<typeof ExpertCapabilityReferenceSchema>;
export type ImportSkillCapability = z.infer<typeof ImportSkillCapabilitySchema>;
export type CreateCapability = z.infer<typeof CreateCapabilitySchema>;
export type UpdateCapability = z.infer<typeof UpdateCapabilitySchema>;
export type CapabilityDeleteResult = z.infer<typeof CapabilityDeleteResultSchema>;
export type GetSkillDocument = z.infer<typeof GetSkillDocumentSchema>;
export type SkillDocument = z.infer<typeof SkillDocumentSchema>;
export type CapabilityTestRequest = z.infer<typeof CapabilityTestRequestSchema>;
export type CapabilityTestResult = z.infer<typeof CapabilityTestResultSchema>;
export type PreviewCodeServiceRequest = z.infer<typeof PreviewCodeServiceRequestSchema>;
export type PreviewCodeServiceResult = z.infer<typeof PreviewCodeServiceResultSchema>;

export interface PragmaDesktopAPI {
  getBridgeSnapshot: () => Promise<DesktopBridgeSnapshot>;
  getDesktopSettings: () => Promise<DesktopSettingsSnapshot>;
  updateDesktopSettings: (input: UpdateDesktopSettings) => Promise<DesktopSettingsSnapshot>;
  pickWorkspace: () => Promise<PickWorkspaceResult>;
  validateWorkspace: (path: string) => Promise<ValidateWorkspaceResult>;
  getModelProviderSettings: () => Promise<ModelProviderSettingsSnapshot>;
  listModelCompatibilityProfiles: () => Promise<ModelCompatibilityProfileDescriptor[]>;
  listModelProviders: () => Promise<ModelProvider[]>;
  createModelProvider: (input: CreateModelProvider) => Promise<ModelProvider>;
  updateModelProvider: (input: UpdateModelProvider) => Promise<ModelProvider>;
  deleteModelProvider: (input: DeleteModelProvider) => Promise<void>;
  discoverProviderModels: (input: DiscoverProviderModels) => Promise<ModelDiscoveryResult>;
  testModelConnection: (input: ModelConnectionTestRequest) => Promise<ModelConnectionTestResult>;
  resetModelProviders: () => Promise<ResetModelProvidersResult>;
  listContextStores: () => Promise<ContextStore[]>;
  createContextStore: (input: CreateContextStore) => Promise<ContextStore>;
  deleteContextStore: (input: DeleteContextStore) => Promise<void>;
  addContextNoteEntry: (input: AddContextNoteEntry) => Promise<ContextStore>;
  listContextStoreContents: (
    input: ListContextStoreContents,
  ) => Promise<ContextStoreContentSummary[]>;
  getContextStoreContent: (input: GetContextStoreContent) => Promise<ContextStoreContent>;
  pickContextStoreFolder: () => Promise<PickWorkspaceResult>;
  listExperts: () => Promise<ExpertSummary[]>;
  getExpert: (ref: string) => Promise<ExpertDefinition>;
  createExpert: (input: CreateExpertDefinition) => Promise<ExpertDefinition>;
  updateExpert: (ref: string, input: UpdateExpertDefinition) => Promise<ExpertDefinition>;
  updateBuiltInExpert: (
    ref: string,
    input: UpdateBuiltInExpertDefinition,
  ) => Promise<ExpertDefinition>;
  resetBuiltInExpert: (ref: string) => Promise<ExpertDefinition>;
  deleteExpert: (ref: string) => Promise<void>;
  listPlugins: () => Promise<DesktopPlugin[]>;
  getPlugin: (ref: string) => Promise<DesktopPlugin>;
  pickPluginZip: () => Promise<PickWorkspaceResult>;
  inspectPluginZip: (sourcePath: string) => Promise<PluginZipInspection>;
  importPluginZip: (input: ImportPluginZip) => Promise<DesktopPlugin>;
  updatePluginDefaults: (input: UpdatePluginDefaults) => Promise<DesktopPlugin>;
  setPluginSecrets: (secrets: Readonly<Record<string, string | null>>) => Promise<void>;
  deletePlugin: (ref: string) => Promise<void>;
  getPragmaProject: () => Promise<PragmaProjectSnapshot>;
  publishPragmaProject: (input: PublishPragmaProject) => Promise<PragmaProjectSnapshot>;
  upsertPragmaResource: (input: UpsertPragmaResource) => Promise<PragmaProjectSnapshot>;
  deletePragmaResource: (input: DeletePragmaResource) => Promise<PragmaProjectSnapshot>;
  validatePragmaYaml: (source: string) => Promise<PragmaYamlValidationResult>;
  validatePragmaResource: (input: ValidatePragmaResource) => Promise<PragmaYamlValidationResult>;
  getWorkflowLayout: (input: GetWorkflowLayout) => Promise<WorkflowLayout | null>;
  saveWorkflowLayout: (layout: WorkflowLayout) => Promise<WorkflowLayout>;
  deleteWorkflowLayout: (input: DeleteWorkflowLayout) => Promise<void>;
  listMissions: () => Promise<MissionSummary[]>;
  listMissionExecutors: () => Promise<MissionExecutorOption[]>;
  getMissionModelOptions: (
    executorRef: string,
    missionId?: string | undefined,
  ) => Promise<MissionModelOptions>;
  getMissionCreationDefaults: () => Promise<MissionCreationDefaults>;
  getMission: (id: string) => Promise<Mission>;
  createMission: (input: CreateMission) => Promise<Mission>;
  updateMissionOptions: (input: UpdateMissionOptions) => Promise<Mission>;
  runMission: (id: string) => Promise<Mission>;
  sendMissionMessage: (input: SendMissionMessage) => Promise<Mission>;
  getMissionChat: (input: GetMissionChat) => Promise<MissionChatSnapshot>;
  subscribeMissionChat: (id: string, listener: (update: MissionChatUpdate) => void) => () => void;
  subscribeMissionUpdates: (listener: (mission: Mission) => void) => () => void;
  interruptMission: (id: string) => Promise<Mission>;
  getMissionWork: (id: string) => Promise<MissionWorkSnapshot>;
  getMissionWorkOutput: (input: GetMissionWorkOutput) => Promise<MissionWorkOutputSnapshot>;
  subscribeMissionWork: (id: string, listener: (update: MissionWorkUpdate) => void) => () => void;
  deleteMission: (id: string) => Promise<void>;
  listMissionHumanInteractions: (id: string) => Promise<MissionHumanInteraction[]>;
  respondToMissionHumanInteraction: (input: RespondMissionHumanInteraction) => Promise<void>;
  markMissionComplete: (id: string) => Promise<Mission>;
  reopenMission: (id: string) => Promise<Mission>;
  listCapabilities: () => Promise<Capability[]>;
  getCapability: (id: string, revision?: number) => Promise<Capability>;
  getSkillDocument: (input: GetSkillDocument) => Promise<SkillDocument>;
  importSkillCapability: (input: ImportSkillCapability) => Promise<Capability>;
  createCapability: (input: CreateCapability) => Promise<Capability>;
  updateCapability: (input: UpdateCapability) => Promise<Capability>;
  retryCapability: (id: string) => Promise<Capability>;
  testCapability: (input: CapabilityTestRequest) => Promise<CapabilityTestResult>;
  previewCodeService: (input: PreviewCodeServiceRequest) => Promise<PreviewCodeServiceResult>;
  deleteCapability: (id: string) => Promise<CapabilityDeleteResult>;
  pickSkillSource: () => Promise<PickWorkspaceResult>;
  getRuntimeAvailability: () => Promise<DesktopRuntimeAvailability[]>;
  setDefaultRuntime: (input: SetDefaultRuntime) => Promise<DesktopRuntimeAvailability[]>;
}
