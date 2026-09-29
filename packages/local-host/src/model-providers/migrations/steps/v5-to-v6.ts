import { ModelProvidersV5Schema, type ModelProvidersV5 } from "../schemas/v5.ts";

const QWEN_MAX_LIMITS = new Map([
  ["qwen3.7-max", { contextWindow: 1_000_000, maxTokens: 131_072 }],
  ["qwen3.8-max", { contextWindow: 1_000_000, maxTokens: 131_072 }],
]);

export const modelProvidersV5ToV6Step = {
  fromVersion: 5,
  toVersion: 6,
  inputSchema: ModelProvidersV5Schema,
  migrate(value: ModelProvidersV5) {
    return {
      ...value,
      schemaVersion: 6 as const,
      providers: value.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => {
          const corrected =
            provider.presetId === "qwen" &&
            model.contextWindow === 128_000 &&
            model.maxTokens === 16_384
              ? QWEN_MAX_LIMITS.get(model.id)
              : undefined;
          return {
            ...model,
            ...(corrected ?? {}),
            contextWindowSource:
              corrected === undefined ? ("legacy" as const) : ("catalog" as const),
            maxTokensSource: corrected === undefined ? ("legacy" as const) : ("catalog" as const),
          };
        }),
      })),
    };
  },
} as const;
