import type { AuthStorage, ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentLifecycle,
  ExpertAgent,
  ExpertAgentDefaultTool,
  ExpertAgentManagedTool,
  ExpertAgentToolCallResult,
  ExpertAgentRunContext,
  ResolvedTool,
  ResolvedToolSet,
  SubAgentManagedTool,
} from "@expertmesh/agent-core";
import {
  createSubAgentTool,
  dispatchExpertAgentHook,
  resolveToolPolicy,
} from "@expertmesh/agent-core";

import type { McpManagedTool } from "../mcp-tools.ts";
import { launchPiSubAgent } from "./subagents.ts";
import { formatMcpToolResult, normalizeInputSchema, sanitizeToolName } from "./tool-schema.ts";
import type { RuntimeStreamBridge } from "./types.ts";

export function createResolvedPiTools(options: {
  readonly agent: ExpertAgent;
  readonly authStorage: AuthStorage;
  readonly cwd: string;
  readonly mcpTools: readonly McpManagedTool[];
  readonly modelRegistry: ModelRegistry;
  readonly parentSystemPrompt: string;
  readonly streamBridge: RuntimeStreamBridge;
  readonly lifecycle: AgentLifecycle<ExpertAgentRunContext>;
  readonly context?: ExpertAgentRunContext | undefined;
}): ResolvedToolSet<ToolDefinition> {
  const subAgentTool = createSubAgentTool({
    agent: options.agent,
    parentSystemPrompt: options.parentSystemPrompt,
    launch: (request) =>
      launchPiSubAgent(request, {
        authStorage: options.authStorage,
        cwd: options.cwd,
        modelRegistry: options.modelRegistry,
        resolvedTools: parentResolvedTools,
        streamBridge: options.streamBridge,
      }),
  });
  const documentTools = options.agent.createDefaultTools({
    getContext: () => options.lifecycle.currentContext,
  });

  const parentResolvedTools = resolveToolPolicy({
    context: options.context,
    tools: [
      ...createPiDefaultTools(options.agent, documentTools).map((tool) =>
        createResolvedTool("default", tool),
      ),
      ...createPiManagedTools(options.agent, options.agent.tools ?? []).map((tool) =>
        createResolvedTool("managed", tool),
      ),
      ...(subAgentTool === undefined
        ? []
        : [createResolvedTool("subagent", createPiSubAgentTool(options.agent, subAgentTool))]),
      ...createPiMcpTools(options.agent, options.mcpTools).map((tool) =>
        createResolvedTool("mcp", tool),
      ),
    ],
  });

  return parentResolvedTools;
}

export function createCustomTools(options: Parameters<typeof createResolvedPiTools>[0]): ToolDefinition[] {
  return createResolvedPiTools(options).tools.map((resolvedTool) => resolvedTool.tool);
}

function createResolvedTool(
  source: ResolvedTool<ToolDefinition>["source"],
  tool: ToolDefinition,
): ResolvedTool<ToolDefinition> {
  return {
    name: tool.name,
    source,
    tool,
  };
}

function createPiDefaultTools(
  agent: ExpertAgent,
  tools: readonly ExpertAgentDefaultTool[],
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: `${tool.name}: ${tool.description}`,
    parameters: normalizeInputSchema(tool.inputSchema),
    executionMode: "parallel",
    async execute(toolCallId, params, signal) {
      const result = await executeWithToolHooks(
        agent,
        tool.name,
        toolCallId,
        params,
        async () => await tool.call(params, signal),
      );

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

function createPiManagedTools(
  agent: ExpertAgent,
  tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[],
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    promptSnippet: `${tool.name}: ${tool.description}`,
    parameters: normalizeInputSchema(tool.inputSchema),
    executionMode: "parallel",
    async execute(toolCallId, params, signal) {
      const result = await executeWithToolHooks(
        agent,
        tool.name,
        toolCallId,
        params,
        async () => await tool.call(params, signal, { toolCallId }),
      );

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

function createPiSubAgentTool(agent: ExpertAgent, subAgentTool: SubAgentManagedTool): ToolDefinition {
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
      const result = await executeWithToolHooks(
        agent,
        subAgentTool.name,
        toolCallId,
        params,
        async () => await subAgentTool.call(params, signal, { toolCallId }),
      );

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

function createPiMcpTools(agent: ExpertAgent, mcpTools: readonly McpManagedTool[]): ToolDefinition[] {
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
    async execute(toolCallId, params) {
      const result = await executeWithToolHooks(
        agent,
        toolName,
        toolCallId,
        params,
        async () => await mcpTool.call(params, undefined, { toolCallId }),
      );

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

async function executeWithToolHooks<TResult>(
  agent: ExpertAgent,
  toolName: string,
  toolCallId: string | undefined,
  args: unknown,
  execute: () => Promise<TResult>,
): Promise<TResult> {
  const startedAt = Date.now();

  await dispatchExpertAgentHook(agent.hooks, "beforeToolCall", {
    agent,
    toolName,
    toolCallId,
    args,
  });

  try {
    const result = await execute();

    await dispatchExpertAgentHook(agent.hooks, "afterToolCall", {
      agent,
      toolName,
      toolCallId,
      args,
      durationMs: Date.now() - startedAt,
      result,
    });

    return result;
  } catch (error) {
    await dispatchExpertAgentHook(agent.hooks, "afterToolCall", {
      agent,
      toolName,
      toolCallId,
      args,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}
