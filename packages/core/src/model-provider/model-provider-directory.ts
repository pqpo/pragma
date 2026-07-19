import type { ProviderModelDefinition } from "@pragma/shared";

import type { ModelProviderDirectory } from "./model-provider.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

const MODELS = {
  openai: [
    model("o4-mini-deep-research", "openai-responses", true, 200_000, 100_000, ["text", "image"], {
      cost: rates(2, 8, 0.5),
    }),
  ],
  anthropic: [
    model("claude-sonnet-5", "anthropic-messages", true, 1_000_000, 128_000, ["text", "image"], {
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      cost: rates(2, 10, 0.2, 2.5),
    }),
  ],
  google: [
    model("gemma-4-31b-it", "google-generative-ai", true, 262_144, 32_768, ["text", "image"], {
      thinkingLevelMap: {
        off: null,
        minimal: "MINIMAL",
        low: null,
        medium: null,
        high: "HIGH",
      },
    }),
  ],
  mistral: [
    model(
      "pixtral-large-latest",
      "mistral-conversations",
      false,
      128_000,
      128_000,
      ["text", "image"],
      { cost: rates(2, 6, 0.2) },
    ),
  ],
  deepseek: [
    model("deepseek-v4-pro", "openai-completions", true, 1_000_000, 384_000, ["text"], {
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        max: "max",
      },
      cost: rates(0.435, 0.87, 0.003625),
    }),
  ],
  xai: [
    model("grok-build-0.1", "openai-completions", true, 256_000, 256_000, ["text", "image"], {
      cost: rates(1, 2, 0.2),
    }),
  ],
  groq: [
    model("qwen/qwen3-32b", "openai-completions", true, 131_072, 40_960, ["text"], {
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: "default" },
      cost: rates(0.29, 0.59),
    }),
  ],
  cerebras: [
    model("zai-glm-4.7", "openai-completions", true, 131_072, 40_960, ["text"], {
      cost: rates(2.25, 2.75, 2.25),
    }),
  ],
  together: [
    model("zai-org/GLM-5.2", "openai-completions", true, 262_144, 164_000, ["text"], {
      cost: rates(1.4, 4.4, 0.26),
    }),
  ],
  fireworks: [
    model(
      "accounts/fireworks/routers/kimi-k2p7-code-fast",
      "anthropic-messages",
      true,
      262_000,
      262_000,
      ["text", "image"],
      { cost: rates(1.9, 8, 0.38) },
    ),
  ],
  zai: [model("glm-5v-turbo", "openai-completions", true, 200_000, 131_072, ["text", "image"])],
  minimax: [
    model("MiniMax-M3", "anthropic-messages", true, 1_000_000, 128_000, ["text", "image"], {
      cost: rates(0.3, 1.2, 0.06),
    }),
  ],
  moonshotai: [
    model("kimi-k3", "openai-completions", true, 1_048_576, 131_072, ["text", "image"], {
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: "max",
      },
      cost: rates(3, 15, 0.3),
    }),
  ],
} as const satisfies Readonly<Record<string, readonly ProviderModelDefinition[]>>;

export function createBuiltInModelProviderDirectory(): ModelProviderDirectory {
  return {
    listModels(catalogId) {
      return MODELS[catalogId as keyof typeof MODELS]?.map(cloneModel) ?? [];
    },
  };
}

function model(
  id: string,
  api: string,
  reasoning: boolean,
  contextWindow: number,
  maxTokens: number,
  input: readonly ("text" | "image")[],
  metadata: {
    readonly thinkingLevelMap?: ProviderModelDefinition["thinkingLevelMap"] | undefined;
    readonly cost?: ProviderModelDefinition["cost"] | undefined;
  } = {},
): ProviderModelDefinition {
  return {
    id,
    name: id,
    api,
    reasoning,
    ...(metadata.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: metadata.thinkingLevelMap }),
    input: [...input],
    cost: metadata.cost ?? ZERO_COST,
    contextWindow,
    maxTokens,
  };
}

function rates(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): ProviderModelDefinition["cost"] {
  return { input, output, cacheRead, cacheWrite };
}

function cloneModel(model: ProviderModelDefinition): ProviderModelDefinition {
  return {
    ...model,
    ...(model.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    input: [...model.input],
    cost: {
      ...model.cost,
      ...(model.cost.tiers === undefined
        ? {}
        : { tiers: model.cost.tiers.map((tier) => ({ ...tier })) }),
    },
  };
}
