import type { ExpertAgentModelApi, IExpertAgentModelsConfig } from "@expertmesh/agent-core";

const MODEL_API_VALUES = new Set<ExpertAgentModelApi>([
  "anthropic-messages",
  "google-generative-ai",
  "openai-completions",
  "openai-responses",
]);

export interface ExampleModelConfig {
  readonly provider: string;
  readonly modelName: string;
  readonly baseApi: string;
  readonly key: string;
  readonly api: ExpertAgentModelApi;
}

export function readExampleModelConfig(): ExampleModelConfig {
  const provider = process.env.EXPERTMESH_MODEL_PROVIDER ?? "openai";
  const modelName = process.env.EXPERTMESH_MODEL_NAME ?? "gpt-4o-mini";
  const baseApi = process.env.EXPERTMESH_MODEL_BASE_API ?? "https://api.openai.com/v1";
  const key = process.env.EXPERTMESH_MODEL_API_KEY ?? process.env.OPENAI_API_KEY;
  const api = readModelApi(process.env.EXPERTMESH_MODEL_API ?? "openai-responses");

  if (key === undefined || key.trim().length === 0) {
    throw new Error(
      "Missing model key. Set EXPERTMESH_MODEL_API_KEY or OPENAI_API_KEY before running this script.",
    );
  }

  return {
    provider,
    modelName,
    baseApi,
    key,
    api,
  };
}

export function createExpertAgentModelsConfig(
  config: ExampleModelConfig,
): IExpertAgentModelsConfig {
  return {
    defaultModelName: `${config.provider}/${config.modelName}`,
    providers: [
      {
        provider: config.provider,
        modelNames: [config.modelName],
        baseApi: config.baseApi,
        key: config.key,
        api: config.api,
      },
    ],
  };
}

export function formatModelConfig(config: ExampleModelConfig): string {
  return `${config.provider}/${config.modelName}`;
}

function readModelApi(value: string): ExpertAgentModelApi {
  if (MODEL_API_VALUES.has(value as ExpertAgentModelApi)) {
    return value as ExpertAgentModelApi;
  }

  throw new Error(
    `Unsupported EXPERTMESH_MODEL_API "${value}". Expected one of: ${[...MODEL_API_VALUES].join(
      ", ",
    )}.`,
  );
}
