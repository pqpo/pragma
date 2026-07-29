import type { CreateAgentSessionOptions, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ModelRegistry as PiModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { RuntimeModel, RuntimeModelProviderConverter } from "@pragma/core";
import type {
  ModelApi,
  ModelThinkingCapability,
  ModelThinkingLevel,
  ProviderModelDefinition,
} from "@pragma/shared";

import { findPiBuiltinModel } from "./catalog.ts";
import {
  defaultPiCompatibilityProfileId,
  resolvePiCompatibilityProfile,
  type PiCompatibilityProfile,
} from "./profiles.ts";
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
  for (const provider of providers) registerPiModelProvider(modelRuntime, provider);
  return { modelRegistry, modelRuntime };
}

export function registerPiModelProvider(
  modelRuntime: ModelRuntime,
  input: PiModelProviderConfig,
): void {
  const provider = normalizeProvider(input);
  if (provider === undefined) return;
  modelRuntime.registerProvider(provider.id, {
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: provider.apiKey,
    ...(provider.headers === undefined ? {} : { headers: { ...provider.headers } }),
    ...(provider.authHeader === undefined ? {} : { authHeader: provider.authHeader }),
    models: provider.models.map((model) => toRegisteredPiModel(provider, model)),
  });
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
      throw new Error(`Unsupported thinking level: ${thinkingLevel}`);
  }
}

export function createPiModelProviderConverter(): RuntimeModelProviderConverter<PiModelProviderConfig> {
  return {
    supports: (api) => SUPPORTED_APIS.has(api),
    toRuntimeModels(provider) {
      return provider.models.flatMap((model) => {
        const api = model.api ?? provider.api;
        if (!SUPPORTED_APIS.has(api)) return [];
        const piModel = resolvePiModel(provider, toPiProviderModel(model));
        const levels = supportedDeclaredThinkingLevels(piModel, model.thinking);
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
                    ...(model.thinking?.defaultLevel !== undefined &&
                    levels.includes(model.thinking.defaultLevel)
                      ? { defaultLevel: model.thinking.defaultLevel }
                      : {}),
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
          `No configured models are supported for provider "${provider.displayName}".`,
        );
      }
      if (!SUPPORTED_APIS.has(provider.api) && models.every((model) => model.api === undefined)) {
        throw new Error(`Provider API protocol "${provider.api}" is not supported.`);
      }
      return {
        id: provider.id,
        catalogId: provider.catalogId,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        api: provider.api as Api,
        ...(provider.compatibilityProfileId === undefined
          ? {}
          : { compatibilityProfileId: provider.compatibilityProfileId }),
        models,
      };
    },
  };
}

function toPiProviderModel(model: ProviderModelDefinition): PiProviderModelConfig {
  return {
    id: model.id,
    name: model.name,
    ...(model.api === undefined ? {} : { api: model.api as Api }),
    ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
    reasoning: model.reasoning,
    ...(model.thinking === undefined ? {} : { thinking: cloneThinking(model.thinking) }),
    ...(model.compatibilityProfileId === undefined
      ? {}
      : { compatibilityProfileId: model.compatibilityProfileId }),
    input: [...model.input],
    cost: toPiModelCost(model.cost),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function toRegisteredPiModel(
  provider: PiModelProviderConfig,
  model: PiProviderModelConfig,
): Omit<Model<Api>, "provider"> {
  const resolved = resolvePiModel(provider, model);
  return {
    id: resolved.id,
    name: resolved.name,
    api: resolved.api,
    baseUrl: resolved.baseUrl,
    reasoning: resolved.reasoning,
    ...(resolved.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: { ...resolved.thinkingLevelMap } }),
    input: [...resolved.input],
    cost: clonePiModelCost(resolved.cost),
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
    ...(resolved.headers === undefined ? {} : { headers: { ...resolved.headers } }),
    ...(resolved.compat === undefined ? {} : { compat: resolved.compat }),
  };
}

function resolvePiModel(
  provider: Pick<
    PiModelProviderConfig,
    "id" | "catalogId" | "api" | "baseUrl" | "compatibilityProfileId"
  >,
  model: PiProviderModelConfig,
): Model<Api> {
  const api = model.api ?? provider.api;
  const builtinCandidate = findPiBuiltinModel(provider.catalogId, model.id);
  const builtin = builtinCandidate?.api === api ? builtinCandidate : undefined;
  const automaticProfile =
    builtin === undefined
      ? resolvePiCompatibilityProfile(defaultPiCompatibilityProfileId(provider.catalogId, api), api)
      : undefined;
  const providerProfile = resolvePiCompatibilityProfile(provider.compatibilityProfileId, api);
  const modelProfile = resolvePiCompatibilityProfile(model.compatibilityProfileId, api);
  const effectiveProfile = modelProfile ?? providerProfile ?? automaticProfile;
  const profileOverrides = [automaticProfile, providerProfile, modelProfile].filter(
    (entry): entry is PiCompatibilityProfile => entry !== undefined,
  );
  const compat = profileOverrides.reduce<NonNullable<Model<Api>["compat"]> | undefined>(
    (current, profile) => ({ ...(current ?? {}), ...profile.compat }),
    builtin?.compat,
  );
  const profileThinkingMap =
    effectiveProfile === undefined ? undefined : createProfileThinkingMap(effectiveProfile);
  const baseThinkingMap =
    modelProfile !== undefined || providerProfile !== undefined || automaticProfile !== undefined
      ? profileThinkingMap
      : builtin?.thinkingLevelMap;
  const preliminary = {
    id: model.id,
    name: model.name,
    api,
    provider: provider.id,
    baseUrl: model.baseUrl ?? provider.baseUrl,
    reasoning: model.reasoning,
    ...(baseThinkingMap === undefined ? {} : { thinkingLevelMap: { ...baseThinkingMap } }),
    input: [...model.input],
    cost: clonePiModelCost(model.cost),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(builtin?.headers === undefined ? {} : { headers: { ...builtin.headers } }),
    ...(compat === undefined ? {} : { compat }),
  } satisfies Model<Api>;
  const thinkingLevelMap = applyDeclaredThinkingLevels(preliminary, model.thinking);
  return {
    ...preliminary,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(model.headers === undefined
      ? {}
      : { headers: { ...preliminary.headers, ...model.headers } }),
    ...(model.compat === undefined
      ? {}
      : { compat: { ...(preliminary.compat ?? {}), ...model.compat } }),
  };
}

function createProfileThinkingMap(
  profile: PiCompatibilityProfile,
): NonNullable<Model<Api>["thinkingLevelMap"]> {
  const supported = new Set(profile.supportedThinkingLevels);
  return Object.fromEntries(
    (Object.keys(THINKING_LEVEL_LABELS) as ModelThinkingLevel[]).map((level) => [
      level,
      supported.has(level) ? (profile.thinkingLevelMap?.[level] ?? level) : null,
    ]),
  );
}

function applyDeclaredThinkingLevels(
  model: Model<Api>,
  declared: ModelThinkingCapability | undefined,
): Model<Api>["thinkingLevelMap"] | undefined {
  if (declared === undefined) return model.thinkingLevelMap;
  const supported = new Set(getSupportedThinkingLevels(model));
  const allowed = new Set(declared.supportedLevels.filter((level) => supported.has(level)));
  return Object.fromEntries(
    (Object.keys(THINKING_LEVEL_LABELS) as ModelThinkingLevel[]).map((level) => [
      level,
      allowed.has(level) ? (model.thinkingLevelMap?.[level] ?? level) : null,
    ]),
  );
}

function supportedDeclaredThinkingLevels(
  model: Model<Api>,
  declared: ModelThinkingCapability | undefined,
): readonly ModelThinkingLevel[] {
  if (declared === undefined) return [];
  const supported = new Set(getSupportedThinkingLevels(model));
  return declared.supportedLevels.filter((level) => supported.has(level));
}

function cloneThinking(value: ModelThinkingCapability): ModelThinkingCapability {
  return {
    supportedLevels: [...value.supportedLevels],
    ...(value.defaultLevel === undefined ? {} : { defaultLevel: value.defaultLevel }),
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

function clonePiModelCost(cost: Model<Api>["cost"]): Model<Api>["cost"] {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    ...(cost.tiers === undefined ? {} : { tiers: cost.tiers.map((tier) => ({ ...tier })) }),
  };
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
