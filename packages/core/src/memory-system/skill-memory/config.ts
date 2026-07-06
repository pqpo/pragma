import { HOST_CONTEXT_NAMESPACE } from "../../context-system/context-system.ts";
import {
  createExpertAgentPluginConfigEnvName,
  type ExpertAgentPluginSetupContext,
} from "../../plugins/expert-agent-plugin.ts";

import { SKILL_MEMORY_CONFIG_CONTEXT_ID, SKILL_MEMORY_ID } from "./constants.ts";
import { SkillMemoryConfigSchema } from "./schema.ts";
import type { SkillMemoryConfig } from "./schema.ts";
import { describeConfigInput } from "./config-utils.ts";

export async function resolveConfig(
  context: ExpertAgentPluginSetupContext,
): Promise<SkillMemoryConfig> {
  const hostConfig = await readHostConfig(context);
  const envConfig = readEnvConfig(context.env);
  const explicitConfig =
    context.config === undefined ? undefined : readConfigObject(context.config);

  return SkillMemoryConfigSchema.parse({
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
    `Skill memory config must be an object, received ${describeConfigInput(input)}.`,
  );
}

async function readHostConfig(
  context: ExpertAgentPluginSetupContext,
): Promise<Record<string, unknown> | undefined> {
  const result = await context.contextSystem.read({
    namespace: HOST_CONTEXT_NAMESPACE,
    id: SKILL_MEMORY_CONFIG_CONTEXT_ID,
  });

  if (!result.ok) {
    return undefined;
  }

  return JSON.parse(result.value.content) as Record<string, unknown>;
}

function readEnvConfig(env: NodeJS.ProcessEnv): Partial<SkillMemoryConfig> {
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
    pluginId: SKILL_MEMORY_ID,
    name,
  });
}

function readBooleanEnv<TKey extends keyof SkillMemoryConfig>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: TKey,
): Partial<SkillMemoryConfig> {
  const value = env[name];

  if (value === undefined) {
    return {};
  }

  return {
    [key]: value === "1" || value.toLowerCase() === "true",
  } as Partial<SkillMemoryConfig>;
}

function readStringEnv<TKey extends keyof SkillMemoryConfig>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: TKey,
): Partial<SkillMemoryConfig> {
  const value = env[name];

  return value === undefined ? {} : ({ [key]: value } as Partial<SkillMemoryConfig>);
}
