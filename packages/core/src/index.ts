import type { ExpertAgentCreateOptions } from "./agent/expert-agent.ts";
import { ExpertAgent } from "./agent/expert-agent.ts";

export { AgentMessageSchema, type AgentMessage, type AgentMessageUsage } from "@pragma/shared";
export {
  HumanInteractionRecordSchema,
  type HumanInteractionRecord,
  type HumanInteractionResponse,
} from "@pragma/shared";
export * from "./agent/context-manager.ts";
export * from "./agent/agent-launcher.ts";
export * from "./agent/expert-agent.ts";
export * from "./context-system/context-system.ts";
export * from "./context-system/context-tools.ts";
export * from "./context-system/file-system-context-store.ts";
export * from "./context-system/in-memory-context-store.ts";
export * from "./human-interaction/durable-human-interaction.ts";
export * from "./logging/logger.ts";
export * from "./directive/index.ts";
export * from "./mcp-tools.ts";
export * from "./http-service-mcp-server.ts";
export * from "./plugins/expert-agent-plugin.ts";
export * from "./plugins/plugin-loader.ts";
export * from "./runtime/agent-lifecycle.ts";
export * from "./runtime/async-push-queue.ts";
export * from "./runtime/driver.ts";
export * from "./runtime/output.ts";
export * from "./runtime/process-probe.ts";
export * from "./runtime/run-context.ts";
export * from "./runtime/runtime-adapter.ts";
export * from "./runtime/runtime-event-emitter.ts";
export * from "./runtime/session-persistence.ts";
export * from "./runtime/session-record.ts";
export * from "./runtime/stream-events.ts";
export * from "./runtime/stream-controller.ts";
export * from "./runtime/usage.ts";
export * from "./runtime-registry.ts";
export * from "./sdk-mcp-server.ts";
export * from "./tools/managed-tool.ts";
export * from "./tools/tool-resolver.ts";
export * from "./storage/pragma-paths.ts";
export * from "./workflow-tools-mcp-server.ts";

export async function defineAgent(options: ExpertAgentCreateOptions): Promise<ExpertAgent> {
  return await ExpertAgent.create(options);
}

export const agent = defineAgent;
