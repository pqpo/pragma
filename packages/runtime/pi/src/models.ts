import type { CreateAgentSessionOptions, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ModelRegistry as PiModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  ModelProviderDefinition,
  RuntimeModel,
  RuntimeModelProviderConverter,
} from "@pragma/core";
import type { ModelApi, ProviderModelDefinition } from "@pragma/shared";

import type { PiModelProviderConfig, PiProviderModelConfig } from "./types.ts";

const THINKING_LEVEL_LABELS = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
} as const;

const SUPPORTED_APIS = new Set<ModelApi>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
]);

export function normalizePiRuntimeModels(models: readonly RuntimeModel[]): readonly RuntimeModel[] {
  return models.map((model) => {
    if (model.thinking === undefined) return model;
    const supportedLevels = model.thinking.supportedLevels.filter((level) =>
      Object.hasOwn(THINKING_LEVEL_LABELS, level.value),
    );
    if (supportedLevels.length === 0) {
      return {
        id: model.id,
        displayName: model.displayName,
        provider: model.provider,
        ...(model.default === undefined ? {} : { default: model.default }),
      };
    }
    const defaultLevel = model.thinking.defaultLevel;
    return {
      ...model,
      thinking: {
        supportedLevels,
        ...(defaultLevel !== undefined && Object.hasOwn(THINKING_LEVEL_LABELS, defaultLevel)
          ? { defaultLevel }
          : {}),
      },
    };
  });
}

export async function createPiModelRuntime(
  providers: readonly PiModelProviderConfig[],
): Promise<{ readonly modelRegistry: ModelRegistry; readonly modelRuntime: ModelRuntime }> {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const modelRegistry = new PiModelRegistry(modelRuntime);
  for (const provider of providers.map(normalizeProvider).filter(isDefined)) {
    modelRuntime.registerProvider(provider.id, {
      baseUrl: provider.baseUrl,
      api: provider.api,
      apiKey: provider.apiKey,
      ...(provider.headers === undefined ? {} : { headers: { ...provider.headers } }),
      ...(provider.authHeader === undefined ? {} : { authHeader: provider.authHeader }),
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        ...(model.api === undefined ? {} : { api: model.api }),
        ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
        ...(model.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
        input: [...model.input],
        cost: { ...model.cost },
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(model.headers === undefined ? {} : { headers: { ...model.headers } }),
        ...(model.compat === undefined ? {} : { compat: model.compat }),
      })),
    });
  }
  return { modelRegistry, modelRuntime };
}

export async function createPiModelRegistry(
  providers: readonly PiModelProviderConfig[],
): Promise<ModelRegistry> {
  return (await createPiModelRuntime(providers)).modelRegistry;
}

export function resolveRequiredRuntimeModel(
  modelRef: { readonly providerId: string; readonly modelId: string } | undefined,
  modelRegistry: ModelRegistry,
  source: string,
): CreateAgentSessionOptions["model"] | undefined {
  if (modelRef === undefined) return undefined;
  const model = modelRegistry
    .getAll()
    .find(
      (candidate) =>
        candidate.provider === modelRef.providerId && candidate.id === modelRef.modelId,
    );
  if (model === undefined) {
    throw new Error(`Unknown ${source} model: ${modelRef.providerId}/${modelRef.modelId}`);
  }
  return model;
}

export function resolvePiThinkingLevel(
  thinkingLevel: string | undefined,
): CreateAgentSessionOptions["thinkingLevel"] | undefined {
  switch (thinkingLevel) {
    case undefined:
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return thinkingLevel;
    default:
      throw new Error(`Unsupported PI thinking level: ${thinkingLevel}`);
  }
}

export function createPiModelProviderConverter(): RuntimeModelProviderConverter<PiModelProviderConfig> {
  return {
    supports: (api) => SUPPORTED_APIS.has(api),
    toRuntimeModels(provider) {
      return provider.models.flatMap((model) => {
        const api = model.api ?? provider.api;
        if (!SUPPORTED_APIS.has(api)) return [];
        const piModel = toPiModel(provider, model);
        const levels = getSupportedThinkingLevels(piModel);
        return [
          {
            id: model.id,
            displayName: model.name,
            provider: {
              kind: "registered" as const,
              id: provider.id,
              displayName: provider.displayName,
            },
            ...(levels.length === 0
              ? {}
              : {
                  thinking: {
                    supportedLevels: levels.map((value) => ({
                      value,
                      label: THINKING_LEVEL_LABELS[value],
                    })),
                  },
                }),
          },
        ];
      });
    },
    convertProvider(provider) {
      const models = provider.models
        .filter((model) => SUPPORTED_APIS.has(model.api ?? provider.api))
        .map(toPiProviderModel);
      if (models.length === 0) {
        throw new Error(
          `PI does not support any configured models for provider "${provider.displayName}".`,
        );
      }
      if (!SUPPORTED_APIS.has(provider.api) && models.every((model) => model.api === undefined)) {
        throw new Error(`PI does not support provider API protocol "${provider.api}".`);
      }
      return {
        id: provider.id,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        api: provider.api as Api,
        models,
      };
    },
  };
}

function toPiModel(provider: ModelProviderDefinition, model: ProviderModelDefinition): Model<Api> {
  return {
    ...toPiProviderModel(model),
    api: (model.api ?? provider.api) as Api,
    provider: provider.id,
    baseUrl: model.baseUrl ?? provider.baseUrl,
    input: [...model.input],
  } as Model<Api>;
}

function toPiProviderModel(model: ProviderModelDefinition): PiProviderModelConfig {
  return {
    id: model.id,
    name: model.name,
    ...(model.api === undefined ? {} : { api: model.api as Api }),
    ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap === undefined
      ? {}
      : {
          thinkingLevelMap: Object.fromEntries(
            Object.entries(model.thinkingLevelMap).filter((entry) => entry[1] !== undefined),
          ),
        }),
    input: [...model.input],
    cost: toPiModelCost(model.cost),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function toPiModelCost(cost: ProviderModelDefinition["cost"]): Model<Api>["cost"] {
  const rates = {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
  };
  return cost.tiers === undefined
    ? rates
    : { ...rates, tiers: cost.tiers.map((tier) => ({ ...tier })) };
}

function normalizeProvider(provider: PiModelProviderConfig): PiModelProviderConfig | undefined {
  const id = provider.id.trim();
  const baseUrl = provider.baseUrl.trim();
  const apiKey = provider.apiKey.trim();
  const models = provider.models
    .map((model) => ({ ...model, id: model.id.trim(), name: model.name.trim() }))
    .filter((model) => model.id !== "" && model.name !== "");
  if (id === "" || baseUrl === "" || models.length === 0) return undefined;
  return { ...provider, id, baseUrl, apiKey, models };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
