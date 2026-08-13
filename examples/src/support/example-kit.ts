import "dotenv/config";

import {
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  type DefineExpertOptions,
  type Expert,
  type IExpertAgentModelsConfig,
  type ModelProviderDefinition,
} from "@pragma/core";
import { createPiRuntime } from "@pragma/runtime-pi";
import { createRuntimeTestContextSystem } from "../runtimes/shared/console-runtime-chat.ts";

export async function createExampleExpert(
  id: string,
  instructions: string,
  options: Pick<DefineExpertOptions, "mcp" | "plugins" | "skills" | "tools"> &
    Partial<Pick<DefineExpertOptions, "description" | "name">> = {},
): Promise<Expert> {
  const contextSystem = createRuntimeTestContextSystem();
  const { name = id, description = `${id} example Expert`, ...capabilities } = options;

  return await defineExpert({
    id,
    name,
    description,
    instructions,
    tags: ["example"],
    scope: "example",
    workspace: process.cwd(),
    contextSystem,
    ...capabilities,
    models: createExampleModelsConfig(process.env),
  });
}

export function createExampleModelsConfig(env: NodeJS.ProcessEnv): IExpertAgentModelsConfig {
  const provider = requiredEnv(env, "PRAGMA_MODEL_PROVIDER");
  const modelName = requiredEnv(env, "PRAGMA_MODEL_NAME");
  return {
    default: { model: { providerId: provider, modelId: modelName } },
  };
}

export function createExampleApp(pragmaHome?: string) {
  const runtime = createExamplePiRuntime(process.env);
  return createPragma({
    ...(pragmaHome === undefined ? {} : { pragmaHome }),
    runtimes: createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: runtime.descriptor.id,
    }),
  });
}

export function createExamplePiRuntime(env: NodeJS.ProcessEnv = process.env) {
  const providerId = requiredEnv(env, "PRAGMA_MODEL_PROVIDER");
  const modelId = requiredEnv(env, "PRAGMA_MODEL_NAME");
  const api = parseModelApi(env["PRAGMA_MODEL_API"]) ?? "openai-completions";
  const provider: ModelProviderDefinition = {
    id: providerId,
    catalogId: providerId,
    displayName: providerId,
    models: [
      {
        id: modelId,
        name: modelId,
        api,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
    baseUrl: requiredEnv(env, "PRAGMA_MODEL_BASE_API"),
    api,
  };
  return createPiRuntime({
    modelProviders: {
      listProviders: async () => [provider],
      resolveProvider: async (id) => {
        if (id !== providerId) throw new Error(`Unknown example model provider: ${id}`);
        return {
          ...provider,
          apiKey: requiredEnv(env, "PRAGMA_MODEL_API_KEY"),
          credentialFingerprint: `example:${providerId}`,
        };
      },
    },
  });
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(
      `Missing ${name}. Copy examples/.env.example to examples/.env and configure the model.`,
    );
  }
  return value;
}

function parseModelApi(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return undefined;
  const supported = [
    "anthropic-messages",
    "google-generative-ai",
    "openai-completions",
    "openai-responses",
  ] as const;
  if (supported.some((api) => api === normalized)) {
    return normalized;
  }
  throw new Error(`Unsupported PRAGMA_MODEL_API: ${normalized}`);
}
