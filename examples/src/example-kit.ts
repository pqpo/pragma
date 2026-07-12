import "dotenv/config";

import {
  createPragma,
  createRuntimeRegistry,
  defineExpert,
  type DefineExpertOptions,
  type Expert,
  type ExpertAgentModelApi,
  type IExpertAgentModelsConfig,
} from "@pragma/core";
import { createPiRuntime } from "@pragma/runtime-pi";

export async function createExampleExpert(
  id: string,
  instructions: string,
  options: Pick<DefineExpertOptions, "tools"> = {},
): Promise<Expert> {
  return await defineExpert({
    id,
    name: id,
    description: `${id} example Expert`,
    instructions,
    tags: ["example"],
    version: "1.0.0",
    scope: "example",
    workspace: process.cwd(),
    ...options,
    models: createExampleModelsConfig(process.env),
  });
}

export function createExampleModelsConfig(env: NodeJS.ProcessEnv): IExpertAgentModelsConfig {
  const provider = requiredEnv(env, "PRAGMA_MODEL_PROVIDER");
  const modelName = requiredEnv(env, "PRAGMA_MODEL_NAME");
  const baseApi = requiredEnv(env, "PRAGMA_MODEL_BASE_API");
  const key = requiredEnv(env, "PRAGMA_MODEL_API_KEY");
  const api = parseModelApi(env["PRAGMA_MODEL_API"]);

  return {
    defaultModelName: `${provider}/${modelName}`,
    providers: [
      {
        provider,
        modelNames: [modelName],
        baseApi,
        key,
        ...(api === undefined ? {} : { api }),
      },
    ],
  };
}

export function createExampleApp(pragmaHome?: string) {
  const runtime = createPiRuntime();
  return createPragma({
    ...(pragmaHome === undefined ? {} : { pragmaHome }),
    runtimes: createRuntimeRegistry({
      runtimes: [runtime],
      defaultRuntime: runtime.descriptor.id,
    }),
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

function parseModelApi(value: string | undefined): ExpertAgentModelApi | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return undefined;
  const supported = [
    "anthropic-messages",
    "google-generative-ai",
    "openai-completions",
    "openai-responses",
  ] as const satisfies readonly ExpertAgentModelApi[];
  if (supported.some((api) => api === normalized)) {
    return normalized as ExpertAgentModelApi;
  }
  throw new Error(`Unsupported PRAGMA_MODEL_API: ${normalized}`);
}
