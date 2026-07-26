import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentLifecycle,
  Expert,
  ExpertAgentDefaultTool,
  ExpertAgentHumanInteractionHandler,
  ExpertAgentManagedTool,
  ExpertAgentToolApproval,
  ExpertAgentToolCallResult,
  ExpertAgentRunContext,
  ExpertToolExecutionContext,
  ResolvedTool,
  ResolvedToolSet,
} from "@pragma/core";
import {
  dispatchExpertAgentHook,
  resolveExpertAgentToolApprovalRequirement,
  resolveToolPolicy,
} from "@pragma/core";
import { randomUUID } from "node:crypto";

import type { McpManagedTool } from "@pragma/core";
import { formatMcpToolResult, normalizeInputSchema, sanitizeToolName } from "./tool-schema.ts";
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
        options.lifecycle.currentContext,
        options.executionContext,
      ).map((tool) => createResolvedTool("managed", tool)),
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
  agent: Expert,
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
  agent: Expert,
  tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[],
  streamState: PiRuntimeStreamState,
  humanInteractionHandler: ExpertAgentHumanInteractionHandler | undefined,
  runContext: ExpertAgentRunContext | undefined,
  executionContext: ExpertToolExecutionContext | undefined,
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
            runContext,
            execution: executionContext,
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

function createPiMcpTools(
  agent: Expert,
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
          async (resolvedParams) => {
            const rawResult = await mcpTool.call(resolvedParams, undefined, { toolCallId });
            return {
              text: formatMcpToolResult(rawResult),
              ...(isRecord(rawResult) && rawResult["isError"] === true ? { isError: true } : {}),
              details: rawResult,
            };
          },
        );

        return {
          content: [
            {
              type: "text",
              text: result.text,
            },
          ],
          isError: result.isError ?? false,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function executeWithToolHooks<
  TResult extends { text: string; isError?: boolean; details?: unknown },
>(
  agent: Expert,
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

  logger.info("tool.call_started", "Tool call started", {
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
      logger.warn("tool.call_rejected", "Tool call rejected by approval policy", {
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
    logger.info("tool.call_completed", "Tool call completed", {
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
    logger.error("tool.call_failed", "Tool call failed", error, {
      runId: streamState.runId,
      toolName,
      toolCallId,
      durationMs,
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
      readonly kind: "tool";
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
  const approval = options.approval;

  if (approval === undefined) {
    return { approved: true, updatedInput: undefined };
  }

  const approvalRequest = {
    kind: "tool_approval" as const,
    toolName: options.toolName,
    toolCallId: options.toolCallId,
    reason: approval.reason,
    input: options.args,
  };
  const requirement = await resolveExpertAgentToolApprovalRequirement(approval, approvalRequest);

  if (requirement === "none") {
    return { approved: true, updatedInput: undefined };
  }

  if (requirement === "ask" && options.humanInteractionHandler === undefined) {
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
      ...(approval.reason === undefined ? {} : { reason: approval.reason }),
      inputPreview: options.args,
    },
  });

  if (options.humanInteractionHandler === undefined) {
    return {
      approved: false,
      result: {
        text: approval.reason ?? `Tool approval required for ${options.toolName}.`,
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
