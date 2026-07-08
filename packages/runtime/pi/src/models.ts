import type {
  AuthStorage,
  CreateAgentSessionOptions,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { ModelRegistry as PiModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ExpertAgent, IExpertAgentModelProviderConfig } from "@pragma/core";

const DEFAULT_PI_MODEL_API = "openai-completions";
const DEFAULT_PI_MODEL_CONTEXT_WINDOW = 128000;
const DEFAULT_PI_MODEL_MAX_TOKENS = 16384;

export function createPiModelRegistry(
  authStorage: AuthStorage,
  providers: readonly IExpertAgentModelProviderConfig[],
): ModelRegistry {
  const modelRegistry = PiModelRegistry.inMemory(authStorage);
  const normalizedProviders = providers
    .map(normalizeModelProviderConfig)
    .filter((provider): provider is IExpertAgentModelProviderConfig => provider !== undefined);

  for (const provider of normalizedProviders) {
    modelRegistry.registerProvider(provider.provider, {
      baseUrl: provider.baseApi,
      api: provider.api ?? DEFAULT_PI_MODEL_API,
      apiKey: provider.key,
      models: provider.modelNames.map((modelName) => ({
        id: modelName,
        name: modelName,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: DEFAULT_PI_MODEL_CONTEXT_WINDOW,
        maxTokens: DEFAULT_PI_MODEL_MAX_TOKENS,
      })),
    });
  }

  return modelRegistry;
}

export function resolveRuntimeModel(
  modelName: string | undefined,
  modelRegistry: ModelRegistry,
): CreateAgentSessionOptions["model"] | undefined {
  if (modelName === undefined) {
    return undefined;
  }

  return modelRegistry.getAll().find((candidate) => matchesRuntimeModel(candidate, modelName));
}

export function resolveRequiredRuntimeModel(
  modelName: string | undefined,
  modelRegistry: ModelRegistry,
  source: string,
): CreateAgentSessionOptions["model"] | undefined {
  const model = resolveRuntimeModel(modelName, modelRegistry);

  if (modelName !== undefined && model === undefined) {
    throw new Error(`Unknown ${source} model: ${modelName}`);
  }

  return model;
}

export function getRuntimeModelName(
  agent: ExpertAgent,
  modelName: string | undefined,
): string | undefined {
  return modelName ?? agent.models?.defaultModelName;
}

export function collectRuntimeModelProviders(
  agent: ExpertAgent,
  providers: readonly IExpertAgentModelProviderConfig[] | undefined,
): readonly IExpertAgentModelProviderConfig[] {
  return [...(agent.models?.providers ?? []), ...(providers ?? [])];
}

function matchesRuntimeModel(
  candidate: NonNullable<CreateAgentSessionOptions["model"]>,
  modelName: string,
): boolean {
  return (
    candidate.id === modelName ||
    candidate.name === modelName ||
    `${candidate.provider}/${candidate.id}` === modelName ||
    `${candidate.provider}/${candidate.name}` === modelName
  );
}

function normalizeModelProviderConfig(
  provider: IExpertAgentModelProviderConfig,
): IExpertAgentModelProviderConfig | undefined {
  const providerName = provider.provider.trim();
  const baseApi = provider.baseApi.trim();
  const key = provider.key.trim();
  const modelNames = [...new Set(provider.modelNames.map((modelName) => modelName.trim()))].filter(
    (modelName) => modelName.length > 0,
  );

  if (
    providerName.length === 0 ||
    baseApi.length === 0 ||
    key.length === 0 ||
    modelNames.length === 0
  ) {
    return undefined;
  }

  return {
    ...provider,
    provider: providerName,
    baseApi,
    key,
    modelNames,
  };
}
