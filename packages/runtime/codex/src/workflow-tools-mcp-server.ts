import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import {
  fromJsonSchema,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  JsonSchemaType,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

import type { ExpertAgent } from "@pragma/core";
import type { ExpertAgentDefaultTool } from "@pragma/core";
import type { ExpertAgentLogger } from "@pragma/core";
import type { McpManagedTool } from "@pragma/core";
import { dispatchExpertAgentHook } from "@pragma/core";
import type { RuntimeEventEmitter } from "@pragma/core";
import type { RuntimeStreamEvent } from "@pragma/core";
import type { ExpertAgentRunContext } from "@pragma/core";
import type { LoopExecutionContext } from "@pragma/core";
import { resolveToolPolicy, type ResolvedTool } from "@pragma/core";
import type {
  ExpertAgentHumanInteractionHandler,
  ExpertAgentManagedTool,
  ExpertAgentToolApproval,
  ExpertAgentToolCallResult,
} from "@pragma/core";
import { resolveExpertAgentToolApprovalRequirement } from "@pragma/core";

export interface CodexWorkflowToolRuntimeState {
  runId?: string | undefined;
  source?: RuntimeStreamEvent["source"] | undefined;
  emitter?: RuntimeEventEmitter | undefined;
}

export interface CodexWorkflowToolsMcpServer {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly dispose: () => Promise<void>;
}

export interface CreateCodexWorkflowToolsMcpServerOptions {
  readonly agent: ExpertAgent;
  readonly getContext: () => ExpertAgentRunContext | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly logger: ExpertAgentLogger;
  readonly mcpTools?: readonly McpManagedTool[] | undefined;
  readonly state: CodexWorkflowToolRuntimeState;
  readonly workflowExecution?: LoopExecutionContext | undefined;
}

type LocalTool = ExpertAgentManagedTool<string, ExpertAgentToolCallResult>;

export async function createCodexWorkflowToolsMcpServer(
  options: CreateCodexWorkflowToolsMcpServerOptions,
): Promise<CodexWorkflowToolsMcpServer> {
  const id = `pragma_tools_${sanitizeMcpConfigId(options.agent.id)}_${randomUUID().replaceAll("-", "_")}`;
  const name = `Pragma tools for ${options.agent.name}`;
  const server = new McpServer(
    {
      name,
      version: options.agent.version,
    },
    {
      instructions:
        "Workflow-scoped Pragma tools. These tools are isolated to the current runtime session.",
    },
  );
  const tools = createCodexWorkflowLocalTools(options);

  for (const resolvedTool of tools) {
    registerLocalTool(server, resolvedTool.tool, options);
  }

  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);

  const httpServer = createServer((request, response) => {
    handleMcpHttpRequest(transport, request, response).catch((error: unknown) => {
      options.logger.error("Codex workflow MCP HTTP request failed", { error });
      if (!response.headersSent) {
        response.writeHead(500);
        response.end();
        return;
      }

      response.destroy(error instanceof Error ? error : undefined);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      httpServer.off("error", onError);
      resolve();
    };

    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(0, "127.0.0.1");
  });

  const address = httpServer.address();

  if (!isAddressInfo(address)) {
    await server.close();
    await closeHttpServer(httpServer);
    throw new Error("Codex workflow MCP server did not bind to a TCP address.");
  }

  return {
    id,
    name,
    url: `http://127.0.0.1:${address.port}/mcp`,
    async dispose() {
      await Promise.allSettled([server.close(), closeHttpServer(httpServer)]);
    },
  };
}

function createCodexWorkflowLocalTools(
  options: CreateCodexWorkflowToolsMcpServerOptions,
): readonly ResolvedTool<LocalTool>[] {
  const defaultTools = options.agent.createDefaultTools({
    getContext: options.getContext,
  });
  const resolved = resolveToolPolicy<LocalTool>({
    context: options.getContext(),
    tools: [
      ...defaultTools.map((tool) => createResolvedLocalTool("default", fromDefaultTool(tool))),
      ...(options.agent.tools ?? []).map((tool) => createResolvedLocalTool("managed", tool)),
      ...createCodexMcpTools(options.mcpTools ?? []).map((tool) =>
        createResolvedLocalTool("mcp", tool),
      ),
    ],
  });

  return resolved.tools;
}

function createCodexMcpTools(
  mcpTools: readonly McpManagedTool[],
): readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] {
  return mcpTools.map((mcpTool) => {
    const toolName = `mcp_${sanitizeToolName(mcpTool.serverId)}_${sanitizeToolName(mcpTool.name)}`;

    return {
      name: toolName,
      description: [
        mcpTool.description ?? `Call MCP tool ${mcpTool.name}.`,
        `Original MCP server: ${mcpTool.serverName}. Original tool: ${mcpTool.name}.`,
      ].join("\n"),
      inputSchema: mcpTool.inputSchema,
      async call(args, signal, context) {
        const result = await mcpTool.call(args, signal, {
          toolCallId: context?.toolCallId,
        });

        return {
          text: formatMcpToolResult(result),
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

function createResolvedLocalTool(
  source: ResolvedTool<LocalTool>["source"],
  tool: LocalTool,
): ResolvedTool<LocalTool> {
  return {
    name: tool.name,
    source,
    tool,
  };
}

function fromDefaultTool(tool: ExpertAgentDefaultTool): LocalTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    approval: tool.approval,
    async call(args, signal, context) {
      return await tool.call(args, signal, {
        toolCallId: context?.toolCallId,
        humanInteraction: context?.humanInteraction,
      });
    },
  };
}

function registerLocalTool(
  server: McpServer,
  tool: LocalTool,
  options: CreateCodexWorkflowToolsMcpServerOptions,
): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: toMcpInputSchema(tool.inputSchema),
    },
    async (input, context) => {
      const toolCallId = String(context.mcpReq.id);

      try {
        const result = await executeWithToolHooks({
          agent: options.agent,
          tool,
          toolCallId,
          args: input,
          signal: context.mcpReq.signal,
          approval: tool.approval,
          humanInteractionHandler: options.humanInteractionHandler,
          runContext: options.getContext(),
          workflowExecution: options.workflowExecution,
          logger: options.logger,
          state: options.state,
        });

        return toCallToolResult(result);
      } catch (error) {
        return toCallToolResult({
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        });
      }
    },
  );
}

async function executeWithToolHooks(options: {
  readonly agent: ExpertAgent;
  readonly tool: LocalTool;
  readonly toolCallId: string | undefined;
  readonly args: unknown;
  readonly signal: AbortSignal | undefined;
  readonly approval: ExpertAgentToolApproval | undefined;
  readonly humanInteractionHandler: ExpertAgentHumanInteractionHandler | undefined;
  readonly runContext: ExpertAgentRunContext | undefined;
  readonly workflowExecution: LoopExecutionContext | undefined;
  readonly logger: ExpertAgentLogger;
  readonly state: CodexWorkflowToolRuntimeState;
}): Promise<ExpertAgentToolCallResult> {
  const startedAt = Date.now();
  const runId = options.state.runId;

  options.logger.info("Tool call started", {
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
    const resolvedArgs = await maybeRequestToolApproval({
      approval: options.approval,
      humanInteractionHandler: options.humanInteractionHandler,
      toolName: options.tool.name,
      toolCallId: options.toolCallId,
      args: options.args,
      state: options.state,
    });

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
    const result = await options.tool.call(executeArgs, options.signal, {
      toolCallId: options.toolCallId,
      humanInteraction: options.humanInteractionHandler,
      runContext: options.runContext,
      workflowExecution: options.workflowExecution,
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
    options.logger.info("Tool call completed", {
      runId,
      toolName: options.tool.name,
      toolCallId: options.toolCallId,
      durationMs,
      isError: result.isError ?? false,
    });

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
    options.logger.error("Tool call failed", {
      runId,
      toolName: options.tool.name,
      toolCallId: options.toolCallId,
      durationMs,
      error,
    });
    throw error;
  }
}

async function maybeRequestToolApproval(options: {
  readonly approval: ExpertAgentToolApproval | undefined;
  readonly humanInteractionHandler: ExpertAgentHumanInteractionHandler | undefined;
  readonly toolName: string;
  readonly toolCallId: string | undefined;
  readonly args: unknown;
  readonly state: CodexWorkflowToolRuntimeState;
}): Promise<
  | { readonly approved: true; readonly updatedInput: unknown | undefined }
  | { readonly approved: false; readonly result: ExpertAgentToolCallResult }
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

  emitApprovalRequested({
    approval,
    toolName: options.toolName,
    toolCallId: options.toolCallId,
    args: options.args,
    state: options.state,
  });

  if (options.humanInteractionHandler === undefined) {
    return {
      approved: false,
      result: {
        text: approval.reason ?? `Tool approval required for ${options.toolName}.`,
        isError: true,
      },
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
      },
    };
  }

  return { approved: true, updatedInput: response.updatedInput };
}

function emitApprovalRequested(options: {
  readonly approval: ExpertAgentToolApproval;
  readonly toolName: string;
  readonly toolCallId: string | undefined;
  readonly args: unknown;
  readonly state: CodexWorkflowToolRuntimeState;
}): void {
  const approvalId = `approval-${randomUUID()}`;
  const runId = options.state.runId ?? approvalId;
  const toolCallId = options.toolCallId ?? approvalId;

  options.state.emitter?.emit({
    runId,
    source: {
      ...(options.state.source ?? {
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
}

function toMcpInputSchema(schema: unknown): StandardSchemaWithJSON | undefined {
  if (schema === undefined) {
    return fromJsonSchema(defaultObjectJsonSchema());
  }

  if (isStandardSchemaWithJson(schema)) {
    return schema;
  }

  if (isRecord(schema)) {
    return fromJsonSchema(schema as JsonSchemaType);
  }

  return fromJsonSchema(defaultObjectJsonSchema());
}

function defaultObjectJsonSchema(): JsonSchemaType {
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as JsonSchemaType;
}

function toCallToolResult(result: ExpertAgentToolCallResult): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: result.text,
      },
    ],
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(isJsonObject(result.details) ? { structuredContent: result.details } : {}),
  };
}

async function handleMcpHttpRequest(
  transport: WebStandardStreamableHTTPServerTransport,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!request.url?.startsWith("/mcp")) {
    response.writeHead(404);
    response.end();
    return;
  }

  const webRequest = createWebRequest(request);
  const webResponse = await transport.handleRequest(webRequest);

  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));

  if (webResponse.body === null) {
    response.end();
    return;
  }

  Readable.fromWeb(webResponse.body).pipe(response);
}

function createWebRequest(request: IncomingMessage): Request {
  const url = `http://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/mcp"}`;
  const init: RequestInit & { duplex?: "half"; body?: unknown } = {
    method: request.method ?? "POST",
    headers: createHeaders(request),
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request;
    init.duplex = "half";
  }

  return new Request(url, init as RequestInit);
}

function createHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  return headers;
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

function sanitizeMcpConfigId(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  return sanitized.length === 0 ? "agent" : sanitized;
}

function sanitizeToolName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  return sanitized.length === 0 ? "tool" : sanitized;
}

function formatMcpToolResult(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const textParts = result.content
      .map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : undefined))
      .filter((entry): entry is string => entry !== undefined);

    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function isAddressInfo(value: ReturnType<ReturnType<typeof createServer>["address"]>): value is AddressInfo {
  return typeof value === "object" && value !== null && "port" in value;
}

function isStandardSchemaWithJson(value: unknown): value is StandardSchemaWithJSON {
  if (!isRecord(value) || !isRecord(value["~standard"])) {
    return false;
  }

  return "jsonSchema" in value["~standard"];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
