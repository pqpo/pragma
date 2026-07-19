import { z } from "zod";

export const KNOWN_MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
] as const;

export const ModelApiSchema = z.string().trim().min(1).max(100);

export const ModelThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const ModelThinkingLevelMapSchema = z
  .object({
    off: z.string().nullable().optional(),
    minimal: z.string().nullable().optional(),
    low: z.string().nullable().optional(),
    medium: z.string().nullable().optional(),
    high: z.string().nullable().optional(),
    xhigh: z.string().nullable().optional(),
    max: z.string().nullable().optional(),
  })
  .strict();

export const ModelCostRatesSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

export const ModelCostSchema = ModelCostRatesSchema.extend({
  tiers: z
    .array(ModelCostRatesSchema.extend({ inputTokensAbove: z.number().int().nonnegative() }))
    .optional(),
});

export const ProviderModelDefinitionSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  api: ModelApiSchema.optional(),
  baseUrl: z.string().url().optional(),
  reasoning: z.boolean(),
  thinkingLevelMap: ModelThinkingLevelMapSchema.optional(),
  input: z.array(z.enum(["text", "image"])).min(1),
  cost: ModelCostSchema,
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
});

export type ModelApi = z.infer<typeof ModelApiSchema>;
export type ModelThinkingLevel = z.infer<typeof ModelThinkingLevelSchema>;
export type ModelThinkingLevelMap = z.infer<typeof ModelThinkingLevelMapSchema>;
export type ModelCost = z.infer<typeof ModelCostSchema>;
export type ProviderModelDefinition = z.infer<typeof ProviderModelDefinitionSchema>;
