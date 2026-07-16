import { randomBytes, randomUUID } from "node:crypto";
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

import type { Expert } from "./agent/expert-agent.ts";
import type { ExpertAgentDefaultTool } from "./context-system/context-tools.ts";
import type { ExpertAgentLogger } from "./logging/logger.ts";
import type { McpManagedTool } from "./mcp-tools.ts";
import { dispatchExpertAgentHook } from "./plugins/expert-agent-plugin.ts";
import type { RuntimeEventEmitter } from "./runtime/runtime-event-emitter.ts";
import type { RuntimeStreamEvent } from "./runtime/stream-events.ts";
import type { ExpertAgentRunContext } from "./runtime/run-context.ts";
import { resolveToolPolicy, type ResolvedTool } from "./tools/tool-resolver.ts";
import type {
  ExpertAgentHumanInteractionHandler,
  ExpertAgentManagedTool,
  ExpertAgentToolApproval,
  ExpertAgentToolCallResult,
  ExpertToolExecutionContext,
} from "./tools/managed-tool.ts";
import { resolveExpertAgentToolApprovalRequirement } from "./tools/managed-tool.ts";

export interface ExpertToolRuntimeState {
  runId?: string | undefined;
  source?: RuntimeStreamEvent["source"] | undefined;
  emitter?: RuntimeEventEmitter | undefined;
}

export interface ExpertToolsMcpSessionRegistration {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly dispose: () => Promise<void>;
}

export interface RegisterExpertToolsMcpSessionOptions {
  readonly agent: Expert;
  /** Stable native runtime-session identity used to preserve the MCP config key across restores. */
  readonly instanceId?: string | undefined;
  readonly getContext: () => ExpertAgentRunContext | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly logger: ExpertAgentLogger;
  readonly mcpTools?: readonly McpManagedTool[] | undefined;
  readonly state: ExpertToolRuntimeState;
  readonly executionContext?: ExpertToolExecutionContext | undefined;
}

type LocalTool = ExpertAgentManagedTool<string, ExpertAgentToolCallResult>;
const RUNTIME_PERMISSION_APPROVAL_REASON = "Runtime requested tool approval.";
const SESSION_MCP_PATH_PATTERN = /^\/sessions\/([A-Za-z0-9_-]{43})\/mcp$/;

interface ExpertToolsMcpGatewayEntry {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly logger: ExpertAgentLogger;
}

class ExpertToolsMcpGateway {
  private readonly entries = new Map<string, ExpertToolsMcpGatewayEntry>();
  private httpServer: ReturnType<typeof createServer> | undefined;
  private origin: string | undefined;
  private lifecycle: Promise<void> = Promise.resolve();

  async register(
    options: RegisterExpertToolsMcpSessionOptions,
  ): Promise<ExpertToolsMcpSessionRegistration> {
    const instanceId = options.instanceId ?? randomUUID();
    const id = `pragma_tools_${sanitizeMcpConfigId(options.agent.id)}_${sanitizeMcpConfigId(instanceId)}`;
    const name = `Pragma tools for ${options.agent.name}`;
    const server = createSessionMcpServer(name, options);
    const transport = new WebStandardStreamableHTTPServerTransport();

    try {
      await server.connect(transport);
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }

    const entry: ExpertToolsMcpGatewayEntry = { server, transport, logger: options.logger };
    let token: string;
    let url: string;

    try {
      ({ token, url } = await this.serialize(async () => {
        await this.ensureListening();
        const origin = this.origin;
        if (origin === undefined) {
          throw new Error("Execution MCP Gateway is not listening.");
        }
        const registeredToken = this.createUniqueToken();
        this.entries.set(registeredToken, entry);
        return {
          token: registeredToken,
          url: `${origin}/sessions/${registeredToken}/mcp`,
        };
      }));
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }

    let disposePromise: Promise<void> | undefined;

    return {
      id,
      name,
      url,
      dispose: () => {
        disposePromise ??= this.unregister(token, entry);
        return disposePromise;
      },
    };
  }

  private unregister(token: string, entry: ExpertToolsMcpGatewayEntry): Promise<void> {
    return this.serialize(async () => {
      if (this.entries.get(token) !== entry) return;

      this.entries.delete(token);
      const closeResults = await Promise.allSettled([
        entry.server.close(),
        ...(this.entries.size === 0 && this.httpServer !== undefined ? [this.stopListening()] : []),
      ]);
      const errors = closeResults.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );

      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Execution MCP Session cleanup failed.");
      }
    });
  }

  private async ensureListening(): Promise<void> {
    if (this.httpServer !== undefined) return;

    const httpServer = createServer((request, response) => {
      void this.routeRequest(request, response);
    });

    try {
      await listenOnLoopback(httpServer);
      const address = httpServer.address();
      if (!isAddressInfo(address)) {
        throw new Error("Execution MCP Gateway did not bind to a TCP address.");
      }

      this.httpServer = httpServer;
      this.origin = `http://127.0.0.1:${address.port}`;
    } catch (error) {
      await closeHttpServer(httpServer).catch(() => undefined);
      throw error;
    }
  }

  private async stopListening(): Promise<void> {
    const httpServer = this.httpServer;
    this.httpServer = undefined;
    this.origin = undefined;
    if (httpServer !== undefined) await closeHttpServer(httpServer);
  }

  private async routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = readSessionToken(request.url);
    const entry = token === undefined ? undefined : this.entries.get(token);
    if (entry === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }

    try {
      await handleMcpHttpRequest(entry.transport, request, response);
    } catch (error) {
      entry.logger.error("Execution MCP Session request failed", { error });
      if (!response.headersSent) {
        response.writeHead(500);
        response.end();
        return;
      }

      response.destroy(error instanceof Error ? error : undefined);
    }
  }

  private createUniqueToken(): string {
    let token: string;
    do {
      token = randomBytes(32).toString("base64url");
    } while (this.entries.has(token));
    return token;
  }

  private serialize<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const expertToolsMcpGateway = new ExpertToolsMcpGateway();

export async function registerExpertToolsMcpSession(
  options: RegisterExpertToolsMcpSessionOptions,
): Promise<ExpertToolsMcpSessionRegistration> {
  return await expertToolsMcpGateway.register(options);
}

function createSessionMcpServer(
  name: string,
  options: RegisterExpertToolsMcpSessionOptions,
): McpServer {
  const server = new McpServer(
    {
      name,
      version: options.agent.version,
    },
    {
      instructions:
        "Execution-scoped Pragma tools. These tools are isolated to the current runtime session.",
    },
  );
  const tools = createExecutionLocalTools(options);

  for (const resolvedTool of tools) {
    registerLocalTool(server, resolvedTool.tool, options);
  }

  return server;
}

function createExecutionLocalTools(
  options: RegisterExpertToolsMcpSessionOptions,
): readonly ResolvedTool<LocalTool>[] {
  const defaultTools = options.agent.createDefaultTools({
    getContext: options.getContext,
  });
  const resolved = resolveToolPolicy<LocalTool>({
    context: options.getContext(),
    tools: [
      ...defaultTools.map((tool) => createResolvedLocalTool("default", fromDefaultTool(tool))),
      ...(options.agent.tools ?? []).map((tool) => createResolvedLocalTool("managed", tool)),
      ...createExecutionMcpTools(options.mcpTools ?? []).map((tool) =>
        createResolvedLocalTool("mcp", tool),
      ),
    ],
  });
  const permissionTool = createPermissionPromptTool(
    options,
    new Set(resolved.tools.map((tool) => tool.name)),
  );

  return [createResolvedLocalTool("default", permissionTool), ...resolved.tools];
}

function createPermissionPromptTool(
  options: RegisterExpertToolsMcpSessionOptions,
  runtimeManagedToolNames: ReadonlySet<string>,
): LocalTool {
  return {
    name: "request_tool_approval",
    description:
      "Ask the Pragma host whether a runtime tool call should be allowed. Use only for runtime permission prompts.",
    inputSchema: {
      type: "object",
      properties: {
        toolName: { type: "string" },
        tool_name: { type: "string" },
        toolCallId: { type: "string" },
        tool_call_id: { type: "string" },
        input: {},
        toolInput: {},
      },
      additionalProperties: true,
    },
    approval: {
      mode: "none",
    },
    async call(args) {
      const request = normalizePermissionPromptInput(args);
      const handler = options.humanInteractionHandler;

      if (isRuntimeManagedExecutionTool(request.toolName, runtimeManagedToolNames)) {
        const details = {
          behavior: "allow",
          updatedInput: request.input,
        };

        return {
          text: JSON.stringify(details),
          details,
        };
      }

      emitApprovalRequested({
        approval: {
          mode: "required",
          reason: RUNTIME_PERMISSION_APPROVAL_REASON,
        },
        toolName: request.toolName,
        toolCallId: request.toolCallId,
        args: request.input,
        state: options.state,
      });

      if (handler === undefined) {
        return {
          text: JSON.stringify({
            behavior: "deny",
            message: "No approval handler is configured.",
          }),
          isError: true,
          details: {
            behavior: "deny",
            message: "No approval handler is configured.",
          },
        };
      }

      const response = await handler({
        kind: "tool_approval",
        toolName: request.toolName,
        toolCallId: request.toolCallId,
        reason: RUNTIME_PERMISSION_APPROVAL_REASON,
        input: request.input,
      });

      if (response.kind !== "tool_approval" || !response.approved) {
        const message =
          response.kind === "tool_approval" && response.reason !== undefined
            ? response.reason
            : `User declined ${request.toolName}.`;

        return {
          text: JSON.stringify({
            behavior: "deny",
            message,
          }),
          isError: true,
          details: {
            behavior: "deny",
            message,
          },
        };
      }

      const details = {
        behavior: "allow",
        updatedInput: response.updatedInput ?? request.input,
      };

      return {
        text: JSON.stringify(details),
        details,
      };
    },
  };
}

function isRuntimeManagedExecutionTool(
  toolName: string,
  runtimeManagedToolNames: ReadonlySet<string>,
): boolean {
  return runtimeManagedToolNames.has(normalizeRuntimeManagedToolName(toolName));
}

function normalizeRuntimeManagedToolName(toolName: string): string {
  if (!toolName.startsWith("mcp__")) {
    return toolName;
  }

  const secondDelimiterIndex = toolName.indexOf("__", 5);

  return secondDelimiterIndex < 0 ? toolName : toolName.slice(secondDelimiterIndex + 2);
}

function normalizePermissionPromptInput(args: unknown): {
  readonly toolName: string;
  readonly toolCallId: string | undefined;
  readonly input: unknown;
} {
  const record = isRecord(args) ? args : {};
  const toolName =
    readString(record["toolName"]) ??
    readString(record["tool_name"]) ??
    readString(record["name"]) ??
    "runtime_tool";
  const toolCallId =
    readString(record["toolCallId"]) ??
    readString(record["tool_call_id"]) ??
    readString(record["id"]);
  const input =
    record["input"] ??
    record["toolInput"] ??
    record["tool_input"] ??
    record["arguments"] ??
    record["params"] ??
    args;

  return { toolName, toolCallId, input };
}

function createExecutionMcpTools(
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
      ...(mcpTool.outputSchema === undefined ? {} : { outputSchema: mcpTool.outputSchema }),
      async call(args, signal, context) {
        const result = await mcpTool.call(args, signal, {
          toolCallId: context?.toolCallId,
        });

        return {
          text: formatMcpToolResult(result),
          ...(isRecord(result) && result["isError"] === true ? { isError: true } : {}),
          details:
            isRecord(result) && isJsonObject(result["structuredContent"])
              ? result["structuredContent"]
              : {
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
  options: RegisterExpertToolsMcpSessionOptions,
): void {
  const outputSchema =
    tool.outputSchema === undefined ? undefined : toMcpInputSchema(tool.outputSchema);
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: toMcpInputSchema(tool.inputSchema),
      ...(outputSchema === undefined ? {} : { outputSchema }),
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
          executionContext: options.executionContext,
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
  readonly agent: Expert;
  readonly tool: LocalTool;
  readonly toolCallId: string | undefined;
  readonly args: unknown;
  readonly signal: AbortSignal | undefined;
  readonly approval: ExpertAgentToolApproval | undefined;
  readonly humanInteractionHandler: ExpertAgentHumanInteractionHandler | undefined;
  readonly runContext: ExpertAgentRunContext | undefined;
  readonly executionContext: ExpertToolExecutionContext | undefined;
  readonly logger: ExpertAgentLogger;
  readonly state: ExpertToolRuntimeState;
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
  readonly state: ExpertToolRuntimeState;
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
  readonly state: ExpertToolRuntimeState;
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
    ...(result.isError === true || !isJsonObject(result.details)
      ? {}
      : { structuredContent: result.details }),
  };
}

async function handleMcpHttpRequest(
  transport: WebStandardStreamableHTTPServerTransport,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const webRequest = createWebRequest(request);
  const webResponse = await transport.handleRequest(webRequest);

  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));

  if (webResponse.body === null) {
    response.end();
    return;
  }

  Readable.fromWeb(webResponse.body).pipe(response);
}

function readSessionToken(requestUrl: string | undefined): string | undefined {
  if (requestUrl === undefined) return undefined;

  try {
    return SESSION_MCP_PATH_PATTERN.exec(new URL(requestUrl, "http://127.0.0.1").pathname)?.[1];
  } catch {
    return undefined;
  }
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

function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
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

function isAddressInfo(
  value: ReturnType<ReturnType<typeof createServer>["address"]>,
): value is AddressInfo {
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
