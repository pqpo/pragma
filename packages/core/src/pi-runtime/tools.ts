import type { AuthStorage, ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentLifecycle,
  ExpertAgent,
  ExpertAgentDefaultTool,
  ExpertAgentHumanInteractionHandler,
  ExpertAgentManagedTool,
  ExpertAgentToolApproval,
  ExpertAgentToolCallResult,
  ExpertAgentRunContext,
  ResolvedTool,
  ResolvedToolSet,
  SubAgentManagedTool,
} from "@expertmesh/core";
import {
  createSubAgentTool,
  dispatchExpertAgentHook,
  resolveToolPolicy,
} from "@expertmesh/core";
import { randomUUID } from "node:crypto";

import type { McpManagedTool } from "../mcp-tools.ts";
import { launchPiSubAgent } from "./subagents.ts";
import { formatMcpToolResult, normalizeInputSchema, sanitizeToolName } from "./tool-schema.ts";
import type { PiRuntimeStreamState } from "./types.ts";

export function createResolvedPiTools(options: {
  readonly agent: ExpertAgent;
  readonly authStorage: AuthStorage;
  readonly cwd: string;
  readonly mcpTools: readonly McpManagedTool[];
  readonly modelRegistry: ModelRegistry;
  readonly parentSystemPrompt: string;
  readonly streamState: PiRuntimeStreamState;
  readonly lifecycle: AgentLifecycle<ExpertAgentRunContext>;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
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
        streamState: options.streamState,
      }),
  });
  const contextTools = options.agent.createDefaultTools({
    getContext: () => options.lifecycle.currentContext,
  });
  const humanInteractionHandler = options.humanInteractionHandler;

  const parentResolvedTools = resolveToolPolicy({
    context: options.context,
    tools: [
      ...createPiDefaultTools(
        options.agent,
        contextTools,
        options.streamState,
        humanInteractionHandler,
      ).map((tool) => createResolvedTool("default", tool)),
      ...createPiManagedTools(
        options.agent,
        options.agent.tools ?? [],
        options.streamState,
        humanInteractionHandler,
      ).map((tool) => createResolvedTool("managed", tool)),
      ...(subAgentTool === undefined
        ? []
        : [
            createResolvedTool(
              "subagent",
              createPiSubAgentTool(options.agent, subAgentTool, options.streamState),
            ),
          ]),
      ...createPiMcpTools(options.agent, options.mcpTools, options.streamState).map((tool) =>
        createResolvedTool("mcp", tool),
      ),
    ],
  });

  return parentResolvedTools;
}

export function createCustomTools(
  options: Parameters<typeof createResolvedPiTools>[0],
): ToolDefinition[] {
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
  streamState: PiRuntimeStreamState,
  humanInteractionHandler: ExpertAgentHumanInteractionHandler | undefined,
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
        tool.approval,
        humanInteractionHandler,
        streamState,
        async (resolvedParams) =>
          await tool.call(resolvedParams, signal, {
            toolCallId,
            humanInteraction: humanInteractionHandler,
          }),
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
  streamState: PiRuntimeStreamState,
  humanInteractionHandler: ExpertAgentHumanInteractionHandler | undefined,
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
        tool.approval,
        humanInteractionHandler,
        streamState,
        async (resolvedParams) =>
          await tool.call(resolvedParams, signal, {
            toolCallId,
            humanInteraction: humanInteractionHandler,
          }),
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

function createPiSubAgentTool(
  agent: ExpertAgent,
  subAgentTool: SubAgentManagedTool,
  streamState: PiRuntimeStreamState,
): ToolDefinition {
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
        undefined,
        undefined,
        streamState,
        async (resolvedParams) => await subAgentTool.call(resolvedParams, signal, { toolCallId }),
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

function createPiMcpTools(
  agent: ExpertAgent,
  mcpTools: readonly McpManagedTool[],
  streamState: PiRuntimeStreamState,
): ToolDefinition[] {
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
          undefined,
          undefined,
          streamState,
          async (resolvedParams) => ({
            text: formatMcpToolResult(
              await mcpTool.call(resolvedParams, undefined, { toolCallId }),
            ),
          }),
        );

        return {
          content: [
            {
              type: "text",
              text: result.text,
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

async function executeWithToolHooks<
  TResult extends { text: string; isError?: boolean; details?: unknown },
>(
  agent: ExpertAgent,
  toolName: string,
  toolCallId: string | undefined,
  args: unknown,
  approval: ExpertAgentToolApproval | undefined,
  humanInteractionHandler: ExpertAgentHumanInteractionHandler | undefined,
  streamState: PiRuntimeStreamState,
  execute: (args: unknown) => Promise<TResult>,
): Promise<TResult> {
  const startedAt = Date.now();
  const logger = streamState.logger ?? agent.logger;

  logger.info("Tool call started", {
    runId: streamState.runId,
    toolName,
    toolCallId,
  });
  await dispatchExpertAgentHook(agent.hooks, "beforeToolCall", {
    agent,
    toolName,
    toolCallId,
    args,
    runId: streamState.runId,
    logger,
  });

  try {
    const resolvedArgs = await maybeRequestToolApproval<TResult>({
      approval,
      humanInteractionHandler,
      toolName,
      toolCallId,
      runId: streamState.runId,
      source: streamState.source,
      args,
      emitApprovalRequested: (request) => {
        streamState.emitter?.emit(request);
      },
    });
    if (resolvedArgs.approved === false) {
      const durationMs = Date.now() - startedAt;
      await dispatchExpertAgentHook(agent.hooks, "afterToolCall", {
        agent,
        toolName,
        toolCallId,
        args,
        runId: streamState.runId,
        durationMs,
        result: resolvedArgs.result,
        logger,
      });
      logger.warn("Tool call rejected by approval policy", {
        runId: streamState.runId,
        toolName,
        toolCallId,
        durationMs,
      });
      return resolvedArgs.result;
    }

    const executeArgs = resolvedArgs.updatedInput ?? args;
    const result = await execute(executeArgs);
    const durationMs = Date.now() - startedAt;

    await dispatchExpertAgentHook(agent.hooks, "afterToolCall", {
      agent,
      toolName,
      toolCallId,
      args: executeArgs,
      runId: streamState.runId,
      durationMs,
      result,
      logger,
    });
    logger.info("Tool call completed", {
      runId: streamState.runId,
      toolName,
      toolCallId,
      durationMs,
      isError: result.isError ?? false,
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await dispatchExpertAgentHook(agent.hooks, "afterToolCall", {
      agent,
      toolName,
      toolCallId,
      args,
      runId: streamState.runId,
      durationMs,
      error,
      logger,
    });
    logger.error("Tool call failed", {
      runId: streamState.runId,
      toolName,
      toolCallId,
      durationMs,
      error,
    });
    throw error;
  }
}

async function maybeRequestToolApproval<
  TResult extends { text: string; isError?: boolean; details?: unknown },
>(options: {
  readonly approval: ExpertAgentToolApproval | undefined;
  readonly humanInteractionHandler: ExpertAgentHumanInteractionHandler | undefined;
  readonly toolName: string;
  readonly toolCallId: string | undefined;
  readonly runId: string | undefined;
  readonly source: PiRuntimeStreamState["source"];
  readonly args: unknown;
  readonly emitApprovalRequested: (event: {
    readonly runId: string;
    readonly source: NonNullable<PiRuntimeStreamState["source"]>;
    readonly type: "tool.approval_requested";
    readonly payload: {
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly kind: "tool" | "subagent";
      readonly reason?: string | undefined;
      readonly inputPreview?: unknown;
    };
  }) => void;
}): Promise<
  | { readonly approved: true; readonly updatedInput: unknown | undefined }
  | {
      readonly approved: false;
      readonly result: TResult;
    }
> {
  if (options.approval === undefined || options.approval.mode === "none") {
    return { approved: true, updatedInput: undefined };
  }

  const approvalRequest = {
    kind: "tool_approval" as const,
    toolName: options.toolName,
    toolCallId: options.toolCallId,
    reason: options.approval.reason,
    input: options.args,
  };

  if (options.approval.when !== undefined && !(await options.approval.when(approvalRequest))) {
    return { approved: true, updatedInput: undefined };
  }

  const approvalId = `approval-${randomUUID()}`;
  const runId = options.runId ?? approvalId;
  const toolCallId = options.toolCallId ?? approvalId;
  options.emitApprovalRequested({
    runId,
    source: {
      ...(options.source ?? {
        kind: "tool",
        runId,
        path: [],
      }),
      kind: "tool",
      runId,
      toolCallId,
    },
    type: "tool.approval_requested",
    payload: {
      approvalId,
      toolCallId,
      toolName: options.toolName,
      kind: "tool",
      ...(options.approval.reason === undefined ? {} : { reason: options.approval.reason }),
      inputPreview: options.args,
    },
  });

  if (options.humanInteractionHandler === undefined) {
    return {
      approved: false,
      result: {
        text: options.approval.reason ?? `Tool approval required for ${options.toolName}.`,
        isError: true,
      } as TResult,
    };
  }

  const response = await options.humanInteractionHandler(approvalRequest);

  if (response.kind !== "tool_approval" || !response.approved) {
    return {
      approved: false,
      result: {
        text:
          response.kind === "tool_approval" && response.reason !== undefined
            ? response.reason
            : `User declined ${options.toolName}.`,
        isError: true,
      } as TResult,
    };
  }

  return { approved: true, updatedInput: response.updatedInput };
}
