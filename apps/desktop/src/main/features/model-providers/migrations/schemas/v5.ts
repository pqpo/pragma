import { z } from "zod";

/** Historical on-disk shape; keep this independent from current protocol schemas. */
const ModelApiV5Schema = z.string().trim().min(1).max(100);
const ModelCompatibilityProfileIdV5Schema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9.-]*@v[1-9][0-9]*$/u)
  .max(120);
const ModelThinkingLevelV5Schema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const SecretOwnerV5Schema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("model-provider"), providerId: z.string().min(1) })
    .passthrough(),
  z
    .object({
      kind: z.literal("capability"),
      capabilityId: z.string().min(1),
      name: z.string().min(1),
    })
    .passthrough(),
  z
    .object({ kind: z.literal("plugin-binding"), bindingRef: z.string().min(1) })
    .passthrough(),
]);

const SecretRefV5Schema = z
  .object({
    schemaVersion: z.literal("pragma.secret-ref/v1"),
    secretId: z.string().uuid(),
    owner: SecretOwnerV5Schema,
    revision: z.string().uuid(),
  })
  .passthrough();

const ModelThinkingCapabilityV5Schema = z
  .object({
    supportedLevels: z.array(ModelThinkingLevelV5Schema).min(1),
    defaultLevel: ModelThinkingLevelV5Schema.optional(),
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

const ModelCostRatesV5Schema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
  })
  .passthrough();

const ModelCostV5Schema = ModelCostRatesV5Schema.extend({
  tiers: z
    .array(
      ModelCostRatesV5Schema.extend({
        inputTokensAbove: z.number().int().nonnegative(),
      }).passthrough(),
    )
    .optional(),
}).passthrough();

const ModelProviderModelV5Schema = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    api: ModelApiV5Schema.optional(),
    baseUrl: z.string().url().optional(),
    reasoning: z.boolean(),
    thinking: ModelThinkingCapabilityV5Schema.optional(),
    compatibilityProfileId: ModelCompatibilityProfileIdV5Schema.optional(),
    input: z.array(z.enum(["text", "image"])).min(1),
    cost: ModelCostV5Schema,
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
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

const ModelProviderVerificationV5Schema = z
  .object({
    status: z.enum(["unverified", "verified", "failed"]),
    checkedAt: z.string().datetime().optional(),
    latencyMs: z.number().int().nonnegative().optional(),
    code: z.string().trim().min(1).max(100).optional(),
    message: z.string().max(2_000).optional(),
    revision: z.number().int().positive().optional(),
  })
  .passthrough();

export const ModelProvidersV5Schema = z
  .object({
    schemaVersion: z.literal(5),
    providers: z.array(
      z
        .object({
          id: z.string().uuid(),
          presetId: z.string().trim().min(1),
          name: z.string().trim().min(1),
          protocol: ModelApiV5Schema,
          baseUrl: z.string().url(),
          compatibilityProfileId: ModelCompatibilityProfileIdV5Schema.optional(),
          models: z.array(ModelProviderModelV5Schema).min(1),
          apiKeySecretRef: SecretRefV5Schema.optional(),
          requiresApiKey: z.boolean(),
          verification: ModelProviderVerificationV5Schema,
          revision: z.number().int().positive(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type ModelProvidersV5 = z.infer<typeof ModelProvidersV5Schema>;
