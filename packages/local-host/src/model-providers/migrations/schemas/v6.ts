import { z } from "zod";

/** Historical on-disk shape; keep this independent from current protocol schemas. */
const ModelApiV6Schema = z.string().trim().min(1).max(100);
const ModelCompatibilityProfileIdV6Schema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9.-]*@v[1-9][0-9]*$/u)
  .max(120);
const ModelThinkingLevelV6Schema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const SecretOwnerV6Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model-provider"), providerId: z.string().min(1) }).passthrough(),
  z
    .object({
      kind: z.literal("capability"),
      capabilityId: z.string().min(1),
      name: z.string().min(1),
    })
    .passthrough(),
  z.object({ kind: z.literal("plugin-binding"), bindingRef: z.string().min(1) }).passthrough(),
]);

const SecretRefV6Schema = z
  .object({
    schemaVersion: z.literal("pragma.secret-ref/v1"),
    secretId: z.string().uuid(),
    owner: SecretOwnerV6Schema,
    revision: z.string().uuid(),
  })
  .passthrough();

const ModelThinkingCapabilityV6Schema = z
  .object({
    supportedLevels: z.array(ModelThinkingLevelV6Schema).min(1),
    defaultLevel: ModelThinkingLevelV6Schema.optional(),
  })
  .passthrough()
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

const ModelCostRatesV6Schema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
  })
  .passthrough();

const ModelCostV6Schema = ModelCostRatesV6Schema.extend({
  tiers: z
    .array(
      ModelCostRatesV6Schema.extend({
        inputTokensAbove: z.number().int().nonnegative(),
      }).passthrough(),
    )
    .optional(),
}).passthrough();

const ModelProviderModelV6Schema = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    api: ModelApiV6Schema.optional(),
    baseUrl: z.string().url().optional(),
    reasoning: z.boolean(),
    thinking: ModelThinkingCapabilityV6Schema.optional(),
    compatibilityProfileId: ModelCompatibilityProfileIdV6Schema.optional(),
    input: z.array(z.enum(["text", "image"])).min(1),
    cost: ModelCostV6Schema,
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    contextWindowSource: z.enum(["provider", "catalog", "manual", "default", "legacy"]).optional(),
    maxTokensSource: z.enum(["provider", "catalog", "manual", "default", "legacy"]).optional(),
    capabilitiesSource: z.enum(["preset", "provider", "manual"]),
    inputOverride: z
      .array(z.enum(["text", "image"]))
      .min(1)
      .optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (!value.reasoning && value.thinking !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["thinking"],
        message: "Only reasoning models can declare adjustable thinking levels.",
      });
    }
    if (value.inputOverride !== undefined && !value.inputOverride.includes("text")) {
      context.addIssue({
        code: "custom",
        path: ["inputOverride"],
        message: "Model input overrides must retain text input.",
      });
    }
  });

const ModelProviderVerificationV6Schema = z
  .object({
    status: z.enum(["unverified", "verified", "failed"]),
    checkedAt: z.string().datetime().optional(),
    latencyMs: z.number().int().nonnegative().optional(),
    code: z.string().trim().min(1).max(100).optional(),
    message: z.string().max(2_000).optional(),
    revision: z.number().int().positive().optional(),
  })
  .passthrough();

export const ModelProvidersV6Schema = z
  .object({
    schemaVersion: z.literal(6),
    providers: z.array(
      z
        .object({
          id: z.string().uuid(),
          presetId: z.string().trim().min(1),
          name: z.string().trim().min(1),
          protocol: ModelApiV6Schema,
          baseUrl: z.string().url(),
          compatibilityProfileId: ModelCompatibilityProfileIdV6Schema.optional(),
          models: z.array(ModelProviderModelV6Schema).min(1),
          apiKeySecretRef: SecretRefV6Schema.optional(),
          requiresApiKey: z.boolean(),
          verification: ModelProviderVerificationV6Schema,
          revision: z.number().int().positive(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type ModelProvidersV6 = z.infer<typeof ModelProvidersV6Schema>;
