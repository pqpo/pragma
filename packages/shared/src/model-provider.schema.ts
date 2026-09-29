import { z } from "zod";

export const KNOWN_MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-embeddings",
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

export const ModelThinkingCapabilitySchema = z
  .object({
    supportedLevels: z.array(ModelThinkingLevelSchema).min(1),
    defaultLevel: ModelThinkingLevelSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.supportedLevels).size !== value.supportedLevels.length) {
      context.addIssue({
        code: "custom",
        path: ["supportedLevels"],
        message: "Thinking levels must be unique.",
      });
    }
    if (value.defaultLevel !== undefined && !value.supportedLevels.includes(value.defaultLevel)) {
      context.addIssue({
        code: "custom",
        path: ["defaultLevel"],
        message: "The default thinking level must be supported by the model.",
      });
    }
  });

export const ModelCompatibilityProfileIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9.-]*@v[1-9][0-9]*$/u)
  .max(120);

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

export const ModelCapabilityValueSourceSchema = z.enum([
  "provider",
  "catalog",
  "manual",
  "default",
  "legacy",
]);

export const GenerationModelDefinitionSchema = z
  .object({
    kind: z.literal("generation"),
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    api: ModelApiSchema.optional(),
    baseUrl: z.string().url().optional(),
    reasoning: z.boolean(),
    thinking: ModelThinkingCapabilitySchema.optional(),
    compatibilityProfileId: ModelCompatibilityProfileIdSchema.optional(),
    input: z.array(z.enum(["text", "image"])).min(1),
    cost: ModelCostSchema,
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    contextWindowSource: ModelCapabilityValueSourceSchema.optional(),
    maxTokensSource: ModelCapabilityValueSourceSchema.optional(),
  })
  .superRefine((value, context) => {
    if (!value.reasoning && value.thinking !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["thinking"],
        message: "Only reasoning models can declare adjustable thinking levels.",
      });
    }
  });

export type ModelApi = z.infer<typeof ModelApiSchema>;
export type ModelThinkingLevel = z.infer<typeof ModelThinkingLevelSchema>;
export type ModelThinkingCapability = z.infer<typeof ModelThinkingCapabilitySchema>;
export type ModelCompatibilityProfileId = z.infer<typeof ModelCompatibilityProfileIdSchema>;
export type ModelCost = z.infer<typeof ModelCostSchema>;
export type ModelCapabilityValueSource = z.infer<typeof ModelCapabilityValueSourceSchema>;
export type ProviderModelDefinition = z.infer<typeof ProviderModelDefinitionSchema>;

export const EmbeddingModelDefinitionSchema = z
  .object({
    kind: z.literal("embedding"),
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    api: z.literal("openai-embeddings"),
    baseUrl: z.string().url().optional(),
    maxInputTokens: z.number().int().positive().optional(),
    maxInputTokensSource: ModelCapabilityValueSourceSchema.optional(),
    maxBatchInputs: z.number().int().positive().max(2048).default(32),
    maxBatchTokens: z.number().int().positive().optional(),
    cost: z.object({ input: z.number().nonnegative() }),
  })
  .strict();
export const ProviderModelDefinitionSchema = z.discriminatedUnion("kind", [
  GenerationModelDefinitionSchema,
  EmbeddingModelDefinitionSchema,
]);
const ConfiguredModelFields = {
  capabilitiesSource: z.enum(["preset", "provider", "manual"]),
};
export const ConfiguredProviderModelSchema = z.discriminatedUnion("kind", [
  GenerationModelDefinitionSchema.extend({
    ...ConfiguredModelFields,
    inputOverride: z
      .array(z.enum(["text", "image"]))
      .min(1)
      .optional(),
  }).superRefine((model, context) => {
    if (model.inputOverride !== undefined && !model.inputOverride.includes("text"))
      context.addIssue({
        code: "custom",
        path: ["inputOverride"],
        message: "Input overrides must retain text.",
      });
  }),
  EmbeddingModelDefinitionSchema.extend(ConfiguredModelFields),
]);
export type GenerationModelDefinition = z.infer<typeof GenerationModelDefinitionSchema>;
export type EmbeddingModelDefinition = z.infer<typeof EmbeddingModelDefinitionSchema>;
export type ConfiguredProviderModel = z.infer<typeof ConfiguredProviderModelSchema>;
