import type { CreateAgentSessionOptions, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ExpertAgent, IExpertAgentModelProviderConfig } from "@expertmesh/core";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PI_MODEL_CONFIG_DIR = ".expertmesh/runtime-sessions/pi/models";
const DEFAULT_PI_MODEL_API = "openai-completions";

interface PiModelsJson {
  readonly providers: Record<
    string,
    {
      readonly baseUrl: string;
      readonly api: string;
      readonly apiKey: string;
      readonly models: readonly { readonly id: string }[];
    }
  >;
}

export async function writePiModelConfig(
  cwd: string,
  agentId: string,
  providers: readonly IExpertAgentModelProviderConfig[],
): Promise<string | undefined> {
  const normalizedProviders = providers
    .map(normalizeModelProviderConfig)
    .filter((provider): provider is IExpertAgentModelProviderConfig => provider !== undefined);

  if (normalizedProviders.length === 0) {
    return undefined;
  }

  const config: PiModelsJson = {
    providers: Object.fromEntries(
      normalizedProviders.map((provider) => [
        provider.provider,
        {
          baseUrl: provider.baseApi,
          api: provider.api ?? DEFAULT_PI_MODEL_API,
          apiKey: provider.key,
          models: provider.modelNames.map((modelName) => ({ id: modelName })),
        },
      ]),
    ),
  };
  const configDir = join(cwd, PI_MODEL_CONFIG_DIR);
  const configPath = join(configDir, `${encodeURIComponent(agentId)}.models.json`);

  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await chmod(configPath, 0o600);

  return configPath;
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
