import {
  HOST_CONTEXT_NAMESPACE,
  createExpertAgentPluginConfigEnvName,
} from "@pragma/core";
import type { ExpertAgentPluginSetupContext } from "@pragma/core";

import { PLUGIN_ID } from "./constants.ts";
import { MemoryPluginConfigSchema } from "./schema.ts";
import type { MemoryPluginConfig } from "./schema.ts";
import { describeConfigInput } from "./config-utils.ts";

export async function resolveConfig(
  context: ExpertAgentPluginSetupContext,
): Promise<MemoryPluginConfig> {
  const hostConfig = await readHostConfig(context);
  const envConfig = readEnvConfig(context.env);
  const explicitConfig =
    context.config === undefined ? undefined : readConfigObject(context.config);

  return MemoryPluginConfigSchema.parse({
    ...envConfig,
    ...(hostConfig ?? {}),
    ...(explicitConfig ?? {}),
  });
}

function readConfigObject(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  throw new Error(
    `Expert Memory plugin config must be an object, received ${describeConfigInput(input)}.`,
  );
}

async function readHostConfig(
  context: ExpertAgentPluginSetupContext,
): Promise<Record<string, unknown> | undefined> {
  const result = await context.contextSystem.read({
    namespace: HOST_CONTEXT_NAMESPACE,
    id: "memory-config.json",
  });

  if (!result.ok) {
    return undefined;
  }

  return JSON.parse(result.value.content) as Record<string, unknown>;
}

function readEnvConfig(env: NodeJS.ProcessEnv): Partial<MemoryPluginConfig> {
  return {
    ...readBooleanEnv(env, createPluginEnvName("enabled"), "enabled"),
    ...readBooleanEnv(env, createPluginEnvName("useMemories"), "useMemories"),
    ...readBooleanEnv(env, createPluginEnvName("generateMemories"), "generateMemories"),
    ...readStringEnv(env, createPluginEnvName("memoryRoot"), "memoryRoot"),
    ...readStringEnv(env, createPluginEnvName("taskSummaryModel"), "taskSummaryModel"),
    ...readStringEnv(env, createPluginEnvName("sessionSummaryModel"), "sessionSummaryModel"),
    ...readStringEnv(env, createPluginEnvName("skillMergeModel"), "skillMergeModel"),
    ...readStringEnv(env, createPluginEnvName("summaryModel"), "summaryModel"),
  };
}

function createPluginEnvName(name: string): string {
  return createExpertAgentPluginConfigEnvName({
    pluginId: PLUGIN_ID,
    name,
  });
}

function readBooleanEnv<TKey extends keyof MemoryPluginConfig>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: TKey,
): Partial<MemoryPluginConfig> {
  const value = env[name];

  if (value === undefined) {
    return {};
  }

  return {
    [key]: value === "1" || value.toLowerCase() === "true",
  } as Partial<MemoryPluginConfig>;
}

function readStringEnv<TKey extends keyof MemoryPluginConfig>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: TKey,
): Partial<MemoryPluginConfig> {
  const value = env[name];

  return value === undefined ? {} : ({ [key]: value } as Partial<MemoryPluginConfig>);
}
