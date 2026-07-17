import type {
  AuthStorage,
  CreateAgentSessionOptions,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { ModelRegistry as PiModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RuntimeModel } from "@pragma/core";

import type { PiModelProviderConfig } from "./types.ts";

const DEFAULT_PI_MODEL_CONTEXT_WINDOW = 128000;
const DEFAULT_PI_MODEL_MAX_TOKENS = 16384;
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function normalizePiRuntimeModels(models: readonly RuntimeModel[]): readonly RuntimeModel[] {
  return models.map((model) => {
    if (model.thinking === undefined) return model;
    const supportedLevels = model.thinking.supportedLevels.filter((level) =>
      PI_THINKING_LEVELS.has(level.value),
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
        ...(defaultLevel !== undefined && PI_THINKING_LEVELS.has(defaultLevel)
          ? { defaultLevel }
          : {}),
      },
    };
  });
}

export function createPiModelRegistry(
  authStorage: AuthStorage,
  providers: readonly PiModelProviderConfig[],
): ModelRegistry {
  const modelRegistry = PiModelRegistry.inMemory(authStorage);
  for (const provider of providers.map(normalizeProvider).filter(isDefined)) {
    modelRegistry.registerProvider(provider.id, {
      baseUrl: provider.baseUrl,
      api: provider.api,
      apiKey: provider.apiKey,
      models: provider.modelIds.map((modelId) => ({
        id: modelId,
        name: modelId,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: DEFAULT_PI_MODEL_CONTEXT_WINDOW,
        maxTokens: DEFAULT_PI_MODEL_MAX_TOKENS,
      })),
    });
  }
  return modelRegistry;
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
      return thinkingLevel;
    default:
      throw new Error(`Unsupported PI thinking level: ${thinkingLevel}`);
  }
}

function normalizeProvider(provider: PiModelProviderConfig): PiModelProviderConfig | undefined {
  const id = provider.id.trim();
  const baseUrl = provider.baseUrl.trim();
  const apiKey = provider.apiKey.trim();
  const modelIds = [...new Set(provider.modelIds.map((modelId) => modelId.trim()))].filter(Boolean);
  if (id === "" || baseUrl === "" || apiKey === "" || modelIds.length === 0) return undefined;
  return { ...provider, id, baseUrl, apiKey, modelIds };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
