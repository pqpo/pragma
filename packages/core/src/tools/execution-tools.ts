import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ToolContentSchema, type ToolContent } from "@pragma/shared";

import type { Expert } from "../agent/expert-agent.ts";
import type { ExpertAgentDefaultTool } from "../context-system/context-tools.ts";
import type { PragmaLogger } from "../logging/logger.ts";
import type { McpManagedTool } from "../mcp-tools.ts";
import { dispatchExpertAgentHook } from "../plugins/expert-agent-plugin.ts";
import type { RuntimeEventEmitter } from "../runtime/runtime-event-emitter.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import type { RuntimeStreamEvent } from "../runtime/stream-events.ts";
import type {
  ExpertAgentHumanInteractionHandler,
  ExpertAgentManagedTool,
  ExpertAgentToolApproval,
  ExpertAgentToolCallResult,
  ExpertToolExecutionContext,
} from "./managed-tool.ts";
import { createTextToolResult, resolveExpertAgentToolApprovalRequirement } from "./managed-tool.ts";
import { resolveToolPolicy, type ResolvedTool, type ResolvedToolSet } from "./tool-resolver.ts";

export interface ExecutionToolRuntimeState {
  runId?: string | undefined;
  source?: RuntimeStreamEvent["source"] | undefined;
  emitter?: RuntimeEventEmitter | undefined;
}

export interface ExecutionTool extends ExpertAgentManagedTool<string, ExpertAgentToolCallResult> {
  readonly label: string;
  readonly preflight?: ExpertAgentDefaultTool["preflight"];
}
export type ResolvedExecutionTool = ResolvedTool<ExecutionTool>;
export type ResolvedExecutionToolSet = ResolvedToolSet<ExecutionTool>;

/** The sole model-facing projection; Host hooks and callers retain the original details. */
export function toModelToolResult(result: ExpertAgentToolCallResult): {
  content: ToolContent[];
  isError?: boolean;
} {
  return {
    content: [...result.content],
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

export function resolveExecutionTools(options: {
  readonly agent: Expert;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly getContext: () => ExpertAgentRunContext | undefined;
  readonly mcpTools?: readonly McpManagedTool[] | undefined;
}): ResolvedExecutionToolSet {
  const defaultTools = options.agent.createDefaultTools({ getContext: options.getContext });
  return resolveToolPolicy({
    context: options.context ?? options.getContext(),
    policy: options.agent.toolPolicy,
    tools: [
      ...defaultTools.map((tool) => resolvedTool("default", fromDefaultTool(tool))),
      ...(options.agent.tools ?? []).map((tool) => resolvedTool("managed", fromManagedTool(tool))),
      ...createExecutionMcpTools(options.mcpTools ?? []).map((tool) => resolvedTool("mcp", tool)),
    ],
  });
}

export async function executeExecutionTool(options: {
  readonly agent: Expert;
  readonly tool: ExecutionTool;
  readonly toolCallId: string | undefined;
  readonly args: unknown;
  readonly signal: AbortSignal | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly runContext?: ExpertAgentRunContext | undefined;
  readonly executionContext?: ExpertToolExecutionContext | undefined;
  readonly logger: PragmaLogger;
  readonly state: ExecutionToolRuntimeState;
}): Promise<ExpertAgentToolCallResult> {
  const startedAt = Date.now();
  const runId = options.state.runId;
  await options.executionContext?.assertOwnership?.();

  options.logger.info("tool.call_started", "Tool call started", {
    runId,
    toolName: options.tool.name,
    toolCallId: options.toolCallId,
  });
  await dispatchExpertAgentHook(options.agent.hooks, "beforeToolCall", {
    agent: options.agent,
    toolName: options.tool.name,
    toolCallId: options.toolCallId,
    args: options.args,
    runId,
    logger: options.logger,
  });

  try {
    const preflight = options.tool.preflight?.(options.args);
    const resolvedArgs =
      preflight === undefined
        ? await maybeRequestToolApproval({
            approval: options.tool.approval,
            humanInteractionHandler: options.humanInteractionHandler,
            toolName: options.tool.name,
            toolCallId: options.toolCallId,
            args: options.args,
            state: options.state,
          })
        : { approved: false as const, result: preflight };
    if (!resolvedArgs.approved) {
      const durationMs = Date.now() - startedAt;
      await dispatchExpertAgentHook(options.agent.hooks, "afterToolCall", {
        agent: options.agent,
        toolName: options.tool.name,
        toolCallId: options.toolCallId,
        args: options.args,
        runId,
        durationMs,
        result: resolvedArgs.result,
        logger: options.logger,
      });
      return resolvedArgs.result;
    }

    const executeArgs = resolvedArgs.updatedInput ?? options.args;
    await options.executionContext?.assertOwnership?.();
    const result = await options.tool.call(executeArgs, options.signal, {
      toolCallId: options.toolCallId,
      humanInteraction: options.humanInteractionHandler,
      runContext: options.runContext,
      execution: options.executionContext,
    });
    const durationMs = Date.now() - startedAt;
    await dispatchExpertAgentHook(options.agent.hooks, "afterToolCall", {
      agent: options.agent,
      toolName: options.tool.name,
      toolCallId: options.toolCallId,
      args: executeArgs,
      runId,
      durationMs,
      result,
      logger: options.logger,
    });
    options.logger.info("tool.call_completed", "Tool call completed", {
      runId,
      toolName: options.tool.name,
      toolCallId: options.toolCallId,
      durationMs,
      isError: result.isError ?? false,
    });
    try {
      const hint = await options.agent.contextSystem.afterToolResult({
        toolName: options.tool.name,
        toolCallId: options.toolCallId,
        args: executeArgs,
        result,
        context: options.runContext,
      });
      if (hint !== undefined)
        return { ...result, content: [...result.content, { type: "text", text: hint }] };
    } catch {
      options.logger.warn(
        "tool.host_result_hint_failed",
        "Host tool result observation is unavailable.",
      );
    }
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await dispatchExpertAgentHook(options.agent.hooks, "afterToolCall", {
      agent: options.agent,
      toolName: options.tool.name,
      toolCallId: options.toolCallId,
      args: options.args,
      runId,
      durationMs,
      error,
      logger: options.logger,
    });
    options.logger.error("tool.call_failed", "Tool call failed", error, {
      runId,
      toolName: options.tool.name,
      toolCallId: options.toolCallId,
      durationMs,
    });
    throw error;
  }
}

function resolvedTool(
  source: ResolvedExecutionTool["source"],
  tool: ExecutionTool,
): ResolvedExecutionTool {
  return { name: tool.name, source, tool };
}

function fromDefaultTool(tool: ExpertAgentDefaultTool): ExecutionTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    inputSchema: tool.inputSchema,
    approval: tool.approval,
    preflight: tool.preflight,
    async call(args, signal, context) {
      return await tool.call(args, signal, {
        toolCallId: context?.toolCallId,
        humanInteraction: context?.humanInteraction,
        runContext: context?.runContext,
        execution: context?.execution,
      });
    },
  };
}

function fromManagedTool(
  tool: ExpertAgentManagedTool<string, ExpertAgentToolCallResult>,
): ExecutionTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    approval: tool.approval,
    async call(args, signal, context) {
      return await tool.call(args, signal, context);
    },
  };
}

function createExecutionMcpTools(mcpTools: readonly McpManagedTool[]): ExecutionTool[] {
  return mcpTools.map((mcpTool) => ({
    name: `mcp_${sanitizeExecutionToolName(mcpTool.serverId)}_${sanitizeExecutionToolName(mcpTool.name)}`,
    label: `MCP ${mcpTool.serverName}:${mcpTool.name}`,
    description: [
      mcpTool.description ?? `Call MCP tool ${mcpTool.name}.`,
      `Original MCP server: ${mcpTool.serverName}. Original tool: ${mcpTool.name}.`,
    ].join("\n"),
    inputSchema: mcpTool.inputSchema,
    ...(mcpTool.outputSchema === undefined ? {} : { outputSchema: mcpTool.outputSchema }),
    approval: mcpTool.approval,
    async call(args, signal, context) {
      const result = await mcpTool.call(args, signal, { toolCallId: context?.toolCallId });
      return {
        content: normalizeMcpToolContent(result),
        ...(isRecord(result) && result["isError"] === true ? { isError: true } : {}),
        details: isRecord(result)
          ? result["structuredContent"] !== undefined
            ? result["structuredContent"]
            : (result["details"] ?? result)
          : result,
      };
    },
  }));
}

export function sanitizeExecutionToolName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  return sanitized.length === 0 ? "tool" : sanitized;
}

function normalizeMcpToolContent(result: unknown): ToolContent[] {
  if (
    isRecord(result) &&
    (Array.isArray(result["content"]) || result["structuredContent"] !== undefined)
  ) {
    const content = ToolContentSchema.array().parse(result["content"] ?? []);
    const structured = result["structuredContent"];
    // Some servers provide only a summary in content. Preserve their business output once,
    // but do not repeat structured JSON already supplied as text or an embedded resource.
    if (
      structured !== undefined &&
      !content.some((entry) => mirrorsStructuredResult(entry, structured))
    ) {
      content.push({ type: "text", text: JSON.stringify(structured) });
    }
    return content;
  }
  return [
    ...createTextToolResult(
      typeof result === "string" ? result : (JSON.stringify(result) ?? String(result)),
    ).content,
  ];
}

function mirrorsStructuredResult(entry: unknown, structured: unknown): boolean {
  if (!isRecord(entry)) return false;
  const text =
    entry["type"] === "text"
      ? entry["text"]
      : isRecord(entry["resource"])
        ? entry["resource"]["text"]
        : undefined;
  if (typeof text !== "string") return false;
  try {
    return isDeepStrictEqual(JSON.parse(text), structured);
  } catch {
    return false;
  }
}

async function maybeRequestToolApproval(options: {
  readonly approval: ExpertAgentToolApproval | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly toolName: string;
  readonly toolCallId: string | undefined;
  readonly args: unknown;
  readonly state: ExecutionToolRuntimeState;
}): Promise<
  | { readonly approved: true; readonly updatedInput: unknown | undefined }
  | { readonly approved: false; readonly result: ExpertAgentToolCallResult }
> {
  const approval = options.approval;
  if (approval === undefined) return { approved: true, updatedInput: undefined };
  const request = {
    kind: "tool_approval" as const,
    toolName: options.toolName,
    toolCallId: options.toolCallId,
    reason: approval.reason,
    input: options.args,
  };
  const requirement = await resolveExpertAgentToolApprovalRequirement(approval, request);
  if (requirement === "none") return { approved: true, updatedInput: undefined };
  if (requirement === "ask" && options.humanInteractionHandler === undefined) {
    return { approved: true, updatedInput: undefined };
  }
  emitExecutionToolApprovalRequested({ ...options, approval });
  if (options.humanInteractionHandler === undefined) {
    return {
      approved: false,
      result: createTextToolResult(
        approval.reason ?? `Tool approval required for ${options.toolName}.`,
        { isError: true },
      ),
    };
  }
  const response = await options.humanInteractionHandler(request);
  if (response.kind !== "tool_approval" || !response.approved) {
    return {
      approved: false,
      result: createTextToolResult(
        response.kind === "tool_approval" && response.reason !== undefined
          ? response.reason
          : `User declined ${options.toolName}.`,
        { isError: true },
      ),
    };
  }
  return { approved: true, updatedInput: response.updatedInput };
}

export function emitExecutionToolApprovalRequested(options: {
  readonly approval: ExpertAgentToolApproval;
  readonly toolName: string;
  readonly toolCallId: string | undefined;
  readonly args: unknown;
  readonly state: ExecutionToolRuntimeState;
}): void {
  const approvalId = `approval-${randomUUID()}`;
  const runId = options.state.runId ?? approvalId;
  const toolCallId = options.toolCallId ?? approvalId;
  options.state.emitter?.emit({
    runId,
    source: {
      ...(options.state.source ?? { kind: "tool", runId, path: [] }),
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
