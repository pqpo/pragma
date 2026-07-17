import {
  definePluginEntry,
  readExpertAgentPluginManifest,
  type ExpertAgentPluginContributions,
  type ExpertAgentPluginEntry,
} from "@pragma/core";

import { MemorySystem } from "./memory-system/index.ts";
import {
  createExperienceMemoryContributions,
  experienceMemoryCapabilities,
  type ExperienceMemoryPluginConfig,
} from "./experience-memory/index.ts";
import {
  createFactMemoryContributions,
  factMemoryCapabilities,
  type FactMemoryPluginConfig,
} from "./fact-memory/index.ts";
import { createDefaultMemoryDistillationPipeline } from "./memory-system/index.ts";
import {
  createSkillMemoryContributions,
  skillMemoryCapabilities,
  type SkillMemoryConfigInput,
} from "./skill-memory/index.ts";
import {
  createTaskMemoryContributions,
  taskMemoryCapabilities,
  type TaskMemoryPluginConfig,
} from "./task-memory/index.ts";
import type { MemorySummaryConfig } from "./memory-system/index.ts";

export {
  createExperienceMemoryContributions,
  experienceMemoryCapabilities,
  createFactMemoryContributions,
  factMemoryCapabilities,
  createSkillMemoryContributions,
  skillMemoryCapabilities,
  createTaskMemoryContributions,
  taskMemoryCapabilities,
};
export * from "./memory-system/index.ts";
export * from "./experience-memory/index.ts";
export * from "./fact-memory/index.ts";
export * from "./skill-memory/index.ts";
export * from "./task-memory/index.ts";

export interface MemoryPluginConfig {
  readonly task?: TaskMemoryPluginConfig | undefined;
  readonly experience?: ExperienceMemoryPluginConfig | undefined;
  readonly fact?: FactMemoryPluginConfig | undefined;
  readonly skill?: SkillMemoryConfigInput | undefined;
  readonly summary?: Partial<MemorySummaryConfig> | undefined;
}

export interface CreateMemoryPluginEntryOptions {
  readonly memorySystem?: MemorySystem | undefined;
}

export function createMemoryPluginEntry(
  options: CreateMemoryPluginEntryOptions = {},
): ExpertAgentPluginEntry {
  return definePluginEntry({
    manifest: readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url)),
    setup: (context) => {
      const memorySystem =
        options.memorySystem ??
        new MemorySystem({
          distillation: createDefaultMemoryDistillationPipeline(),
          summaryConfig: readMemorySummaryConfig(context.userConfig),
        });

      return mergeContributions([
        createTaskMemoryContributions({
          ...context,
          memorySystem,
        }),
        createExperienceMemoryContributions({
          ...context,
          memorySystem,
        }),
        createFactMemoryContributions({
          ...context,
          memorySystem,
        }),
        createSkillMemoryContributions({
          ...context,
          memorySystem,
          userConfig: readSkillMemoryConfig(context.userConfig) ?? {},
        }),
      ]);
    },
  });
}

function readMemorySummaryConfig(input: unknown): Partial<MemorySummaryConfig> | undefined {
  if (input === undefined || input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const summary = (input as { summary?: unknown }).summary;

  if (summary === undefined || summary === null) {
    return undefined;
  }

  if (typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("Memory plugin summary config must be an object.");
  }

  return summary as Partial<MemorySummaryConfig>;
}

export default createMemoryPluginEntry();

export const memoryPluginCapabilities = [
  ...taskMemoryCapabilities,
  ...experienceMemoryCapabilities,
  ...factMemoryCapabilities,
  ...skillMemoryCapabilities,
] as const;

function readSkillMemoryConfig(input: unknown): SkillMemoryConfigInput | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Memory plugin config must be an object.");
  }

  if (!("skill" in input)) {
    return input as SkillMemoryConfigInput;
  }

  const skill = (input as { skill?: unknown }).skill;

  if (skill === undefined) {
    return undefined;
  }

  if (skill !== null && typeof skill === "object" && !Array.isArray(skill)) {
    return skill as SkillMemoryConfigInput;
  }

  throw new Error("Memory plugin skill config must be an object.");
}

function mergeContributions(
  contributions: readonly ExpertAgentPluginContributions[],
): ExpertAgentPluginContributions {
  return {
    tools: contributions.flatMap((contribution) => contribution.tools ?? []),
    hooks: mergeHooks(contributions),
  };
}

function mergeHooks(
  contributions: readonly ExpertAgentPluginContributions[],
): ExpertAgentPluginContributions["hooks"] {
  const hooks = contributions
    .map((contribution) => contribution.hooks)
    .filter((hook): hook is NonNullable<typeof hook> => hook !== undefined);

  if (hooks.length === 0) {
    return undefined;
  }

  return {
    beforeSessionCreate: chainHooks(hooks.map((hook) => hook.beforeSessionCreate)),
    afterSessionCreate: chainHooks(hooks.map((hook) => hook.afterSessionCreate)),
    beforeTaskSubmit: chainHooks(hooks.map((hook) => hook.beforeTaskSubmit)),
    afterTaskSubmit: chainHooks(hooks.map((hook) => hook.afterTaskSubmit)),
    beforeSessionDestroy: chainHooks(hooks.map((hook) => hook.beforeSessionDestroy)),
    afterSessionDestroy: chainHooks(hooks.map((hook) => hook.afterSessionDestroy)),
    beforeToolCall: chainHooks(hooks.map((hook) => hook.beforeToolCall)),
    afterToolCall: chainHooks(hooks.map((hook) => hook.afterToolCall)),
    onStreamEvent: chainHooks(hooks.map((hook) => hook.onStreamEvent)),
  };
}

function chainHooks<TArgs>(
  hooks: readonly (((context: TArgs) => void | Promise<void>) | undefined)[],
): ((context: TArgs) => Promise<void>) | undefined {
  const activeHooks = hooks.filter((hook): hook is NonNullable<typeof hook> => hook !== undefined);

  if (activeHooks.length === 0) {
    return undefined;
  }

  return async (context) => {
    for (const hook of activeHooks) {
      await hook(context);
    }
  };
}
