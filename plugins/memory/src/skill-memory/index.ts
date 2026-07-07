import type {
  ExpertAgentPluginContributions,
  ExpertAgentPluginSetupContext,
} from "@pragma/core";

import { MemorySystem } from "../memory-system/index.ts";
import { MEMORY_CONTEXT_NAMESPACE, SKILL_MEMORY_ID } from "./constants.ts";
import { resolveConfig } from "./config.ts";
import { createFileSystemMemoryEvidenceStore } from "./evidence-store.ts";
import { regenerateSummary, resolveMemoryRoot } from "./filesystem.ts";
import { SkillMemoryManager } from "./manager.ts";
import {
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
};
export type { SkillMemoryConfig, SkillMemoryConfigInput };

type SkillMemoryPluginSetupContext = ExpertAgentPluginSetupContext & {
  readonly memorySystem: MemorySystem;
};

export function createSkillMemoryContributions(
  context: SkillMemoryPluginSetupContext,
): ExpertAgentPluginContributions {
  const store = createSkillMemoryContextStore(context, context.memorySystem);
  const skillStore = createSkillMemoryStore(context);
  const evidenceStore = createFileSystemMemoryEvidenceStore(context);
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

  const evidenceRegistration = context.memorySystem.registerEvidenceStore({
    store: evidenceStore,
  });

  if (!evidenceRegistration.ok && evidenceRegistration.error.code !== "store_already_registered") {
    throw new Error(evidenceRegistration.error.message);
  }

  context.memorySystem.setSummaryArtifactRegenerator(async () => {
    const config = await resolveConfig(context);

    if (!config.enabled || !config.useMemories) {
      return;
    }

    await regenerateSummary(
      resolveMemoryRoot(context.workspaceRoot, config, context.agent?.id ?? "unknown-agent"),
      context.memorySystem,
      context.agent?.id ?? "unknown-agent",
    );
  });

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
export const skillMemoryCapabilities = [
  {
    type: "context",
    name: MEMORY_CONTEXT_NAMESPACE,
    description: "Exposes unified memory audit files as agent context.",
  },
  {
    type: "memory",
    name: SKILL_MEMORY_ID,
    description: "Registers generated skill cards as typed Skill Memory.",
  },
  {
    type: "hook",
    name: "skill-memory-pipeline",
    description: "Captures evidence and consolidates reusable skill cards.",
  },
] as const;
