import { setDefaultRuntimeRegistryFactory } from "./agent/expert-agent.ts";
import type { ExpertAgentCreateOptions } from "./agent/expert-agent.ts";
import { ExpertAgent } from "./agent/expert-agent.ts";
import { createRuntimeRegistry } from "./runtime-registry.ts";

setDefaultRuntimeRegistryFactory(createRuntimeRegistry);

export * from "./agent/context-manager.ts";
export * from "./agent/expert-agent.ts";
export * from "./context-system/context-system.ts";
export * from "./context-system/context-tools.ts";
export * from "./context-system/file-system-context-store.ts";
export * from "./context-system/in-memory-context-store.ts";
export * from "./logging/logger.ts";
export * from "./memory-system/index.ts";
export * from "./loop/index.ts";
export * from "./plugins/expert-agent-plugin.ts";
export * from "./plugins/plugin-loader.ts";
export * from "./runtime/agent-lifecycle.ts";
export * from "./runtime/async-push-queue.ts";
export * from "./runtime/run-context.ts";
export * from "./runtime/runtime-adapter.ts";
export * from "./runtime/runtime-event-emitter.ts";
export * from "./runtime/stream-events.ts";
export * from "./pi-runtime/index.ts";
export * from "./runtime-registry.ts";
export * from "./sdk-mcp-server.ts";
export * from "./subagents/sub-agent.ts";
export * from "./subagents/subagent-tool.ts";
export * from "./tools/managed-tool.ts";
export * from "./tools/tool-resolver.ts";

export async function defineAgent(options: ExpertAgentCreateOptions): Promise<ExpertAgent> {
  return await ExpertAgent.create(options);
}

export const agent = defineAgent;
