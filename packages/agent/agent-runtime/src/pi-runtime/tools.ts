import type { AuthStorage, ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentLifecycle,
  ExpertAgent,
  ExpertAgentDefaultTool,
  ExpertAgentRunContext,
  SubAgentManagedTool,
} from "@expertmesh/agent-core";
import { createSubAgentTool } from "@expertmesh/agent-core";

import type { McpManagedTool } from "../mcp-tools.ts";
import { launchPiSubAgent } from "./subagents.ts";
import { formatMcpToolResult, normalizeInputSchema, sanitizeToolName } from "./tool-schema.ts";
import type { RuntimeStreamBridge } from "./types.ts";

export function createCustomTools(options: {
  readonly agent: ExpertAgent;
  readonly authStorage: AuthStorage;
  readonly cwd: string;
  readonly mcpTools: readonly McpManagedTool[];
  readonly modelRegistry: ModelRegistry;
  readonly parentSystemPrompt: string;
  readonly streamBridge: RuntimeStreamBridge;
  readonly lifecycle: AgentLifecycle<ExpertAgentRunContext>;
}): ToolDefinition[] {
  const subAgentTool = createSubAgentTool({
    agent: options.agent,
    parentSystemPrompt: options.parentSystemPrompt,
    launch: (request) =>
      launchPiSubAgent(request, {
        authStorage: options.authStorage,
        cwd: options.cwd,
        modelRegistry: options.modelRegistry,
        streamBridge: options.streamBridge,
      }),
  });
  const documentTools = options.agent.createDefaultTools({
    getContext: () => options.lifecycle.currentContext,
  });

  return [
    ...createPiDefaultTools(documentTools),
    ...(subAgentTool === undefined ? [] : [createPiSubAgentTool(subAgentTool)]),
    ...createPiMcpTools(options.mcpTools),
  ];
}

function createPiDefaultTools(tools: readonly ExpertAgentDefaultTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: `${tool.name}: ${tool.description}`,
    parameters: normalizeInputSchema(tool.inputSchema),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
      const result = await tool.call(params, signal);

      return {
        content: [
          {
            type: "text",
            text: result.text,
          },
        ],
        isError: result.isError ?? false,
        details: result.details,
      };
    },
  }));
}

function createPiSubAgentTool(subAgentTool: SubAgentManagedTool): ToolDefinition {
  return {
    name: subAgentTool.name,
    label: "Launch subAgent",
    description: subAgentTool.description,
    promptSnippet: "launch_subagent: delegate a focused task to a specialized subAgent",
    promptGuidelines: [
      "Use launch_subagent only when the subAgent's whenToUse matches the delegated task.",
      "Pass a self-contained task. Include the concrete files, constraints, and expected output.",
    ],
    parameters: normalizeInputSchema(subAgentTool.inputSchema),
    executionMode: "parallel",
    async execute(toolCallId, params, signal) {
      const result = await subAgentTool.call(params, signal, { toolCallId });

      return {
        content: [
          {
            type: "text",
            text: result.text,
          },
        ],
        isError: result.isError ?? false,
        details: result.details,
      };
    },
  };
}

function createPiMcpTools(mcpTools: readonly McpManagedTool[]): ToolDefinition[] {
  return mcpTools.map((mcpTool) => {
    const toolName = `mcp_${sanitizeToolName(mcpTool.serverId)}_${sanitizeToolName(mcpTool.name)}`;

    return {
      name: toolName,
      label: `MCP ${mcpTool.serverName}:${mcpTool.name}`,
      description: [
        mcpTool.description ?? `Call MCP tool ${mcpTool.name}.`,
        `Original MCP server: ${mcpTool.serverName}. Original tool: ${mcpTool.name}.`,
      ].join("\n"),
      promptSnippet: `${toolName}: call ${mcpTool.name} from MCP server ${mcpTool.serverName}`,
      parameters: normalizeInputSchema(mcpTool.inputSchema),
      executionMode: "parallel",
      async execute(_toolCallId, params) {
        const result = await mcpTool.call(params, undefined);

        return {
          content: [
            {
              type: "text",
              text: formatMcpToolResult(result),
            },
          ],
          details: {
            server: mcpTool.serverName,
            tool: mcpTool.name,
            result,
          },
        };
      },
    };
  });
}
