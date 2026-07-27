import {
  ModelApiSchema as SharedModelApiSchema,
  ModelCompatibilityProfileIdSchema,
  ModelThinkingLevelSchema,
  ProviderModelDefinitionSchema,
} from "@pragma/shared";
import { z } from "zod";

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
