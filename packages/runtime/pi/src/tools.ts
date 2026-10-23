import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  executeExecutionTool,
  resolveExecutionTools,
  toModelToolResult,
  type AgentLifecycle,
  type Expert,
  type ExpertAgentHumanInteractionHandler,
  type ExpertAgentRunContext,
  type ExpertToolExecutionContext,
  type McpManagedTool,
  type ResolvedToolSet,
} from "@pragma/core";

import { normalizeInputSchema } from "./tool-schema.ts";
import type { PiRuntimeStreamState } from "./types.ts";

export function createResolvedPiTools(options: {
  readonly agent: Expert;
  readonly cwd: string;
  readonly mcpTools: readonly McpManagedTool[];
  readonly parentSystemPrompt: string;
  readonly streamState: PiRuntimeStreamState;
  readonly lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined>;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly executionContext?: ExpertToolExecutionContext | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
}): ResolvedToolSet<ToolDefinition> {
  const resolved = resolveExecutionTools({
    agent: options.agent,
    context: options.context,
    getContext: () => options.lifecycle.currentContext,
    mcpTools: options.mcpTools,
  });
  return {
    policy: resolved.policy,
    tools: resolved.tools.map((item) => ({
      name: item.name,
      source: item.source,
      tool: toPiTool(item.tool, options),
    })),
  };
}

export function createCustomTools(
  options: Parameters<typeof createResolvedPiTools>[0],
): ToolDefinition[] {
  return createResolvedPiTools(options).tools.map((resolvedTool) => resolvedTool.tool);
}

function toPiTool(
  tool: ReturnType<typeof resolveExecutionTools>["tools"][number]["tool"],
  options: Parameters<typeof createResolvedPiTools>[0],
): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: `${tool.name}: ${tool.description}`,
    parameters: normalizeInputSchema(tool.inputSchema),
    executionMode: "parallel",
    async execute(toolCallId, params, signal) {
      const result = await executeExecutionTool({
        agent: options.agent,
        tool,
        toolCallId,
        args: params,
        signal,
        humanInteractionHandler: options.humanInteractionHandler,
        runContext: options.lifecycle.currentContext,
        executionContext: options.executionContext,
        logger: options.streamState.logger ?? options.agent.logger,
        state: options.streamState,
      });
      const modelResult = toModelToolResult(result);
      return {
        ...modelResult,
        content: modelResult.content.map((item) => {
          if (item.type === "text")
            return {
              type: "text" as const,
              text: item.text,
              ...(item.textSignature === undefined ? {} : { textSignature: item.textSignature }),
            };
          if (item.type === "image")
            return { type: "image" as const, data: item.data, mimeType: item.mimeType };
          (options.streamState.logger ?? options.agent.logger).warn(
            "runtime.tool_content_degraded",
            "Pi rendered an unsupported tool content block as text.",
            { toolName: tool.name, contentType: item.type },
          );
          return {
            type: "text" as const,
            text: `[Tool content rendered as text: ${item.type}]\n${JSON.stringify(item)}`,
          };
        }),
        isError: result.isError ?? false,
        // Pi retains these for the Host/UI; provider serializers consume only content.
        details: result.details,
      };
    },
  };
}
