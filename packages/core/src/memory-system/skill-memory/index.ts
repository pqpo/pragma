import type {
  ExpertAgentPluginContributions,
  ExpertAgentPluginEntry,
  ExpertAgentPluginRegistration,
  ExpertAgentPluginSetupContext,
} from "../../plugins/expert-agent-plugin.ts";

import { MEMORY_CONTEXT_NAMESPACE, SKILL_MEMORY_ID } from "./constants.ts";
import { SkillMemoryManager } from "./manager.ts";
import {
  parseSkillMemoryConfig,
  SkillMemoryConfigSchema,
  type SkillMemoryConfig,
  type SkillMemoryConfigInput,
  MemoryRunEvidenceSchema as SkillMemoryRunEvidenceSchema,
  MemorySessionEvidenceSchema as SkillMemorySessionEvidenceSchema,
} from "./schema.ts";
import { createSkillMemoryStore } from "./skill-store.ts";
import { createSkillMemoryContextStore } from "./store.ts";

export {
  SkillMemoryConfigSchema,
  SkillMemoryRunEvidenceSchema,
  SkillMemorySessionEvidenceSchema,
  parseSkillMemoryConfig,
};
export type { SkillMemoryConfig, SkillMemoryConfigInput };

const BUILTIN_SKILL_MEMORY_ENTRY: ExpertAgentPluginEntry = {
  id: SKILL_MEMORY_ID,
  name: "Skill Memory",
  description:
    "Distills reusable skill cards from runtime evidence and exposes them through typed Skill Memory plus auditable context views.",
  version: "0.0.0",
  tags: ["memory", "skill", "audit"],
  manifest: {
    schemaVersion: "pragma.plugin/v1",
    id: SKILL_MEMORY_ID,
    name: "Skill Memory",
    description:
      "Distills reusable skill cards from runtime evidence and exposes them through typed Skill Memory plus auditable context views.",
    version: "0.0.0",
    tags: ["memory", "skill", "audit"],
    runtime: {
      type: "expert-agent-plugin",
      entry: "builtin:skill-memory",
    },
    capabilities: [
      {
        type: "context",
        name: MEMORY_CONTEXT_NAMESPACE,
        description: "Exposes skill-memory audit files as agent context.",
      },
      {
        type: "memory",
        name: "skill-memory",
        description: "Registers generated skill cards as typed Skill Memory.",
      },
      {
        type: "hook",
        name: "skill-memory-pipeline",
        description: "Captures evidence and consolidates reusable skill cards.",
      },
    ],
    configuration: {
      properties: [],
    },
    required_config: [],
  },
  setup: (context) => createSkillMemoryContributions(context),
};

export function createSkillMemoryContributions(
  context: ExpertAgentPluginSetupContext,
): ExpertAgentPluginContributions {
  const store = createSkillMemoryContextStore(context);
  const skillStore = createSkillMemoryStore(context);
  const manager = new SkillMemoryManager(context);
  const registration = context.contextSystem.register({
    namespace: MEMORY_CONTEXT_NAMESPACE,
    store,
  });

  if (!registration.ok && registration.error.code !== "context_already_exists") {
    throw new Error(registration.error.message);
  }

  const memoryRegistration = context.memorySystem.registerSkillStore({
    store: skillStore,
  });

  if (!memoryRegistration.ok && memoryRegistration.error.code !== "store_already_registered") {
    throw new Error(memoryRegistration.error.message);
  }

  return {
    hooks: {
      onStreamEvent: async (streamContext) => {
        await manager.recordStreamEvent(streamContext);
      },
      afterTaskSubmit: async (taskContext) => {
        await manager.recordTask(taskContext);
      },
      afterSessionDestroy: async (sessionContext) => {
        await manager.finalizeSession(sessionContext);
      },
    },
  };
}

export function createBuiltInSkillMemoryRegistration(
  config?: SkillMemoryConfigInput | undefined,
): ExpertAgentPluginRegistration {
  return {
    entry: BUILTIN_SKILL_MEMORY_ENTRY,
    ...(config === undefined ? {} : { config }),
  };
}
