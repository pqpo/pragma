import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

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
import { isHumanInteractionCheckpointError } from "./execution/expert-runner.ts";
import type { PragmaLogger } from "./logging/logger.ts";
import type { McpManagedTool } from "./mcp-tools.ts";
import type { ExpertAgentRunContext } from "./runtime/run-context.ts";
import type {
  ExpertAgentHumanInteractionHandler,
  ExpertAgentToolCallResult,
  ExpertToolExecutionContext,
} from "./tools/managed-tool.ts";
import {
  emitExecutionToolApprovalRequested,
  executeExecutionTool,
  resolveExecutionTools,
  sanitizeExecutionToolName,
  type ExecutionTool,
  type ExecutionToolRuntimeState,
  type ResolvedExecutionTool,
} from "./tools/execution-tools.ts";

export type ExpertToolRuntimeState = ExecutionToolRuntimeState;

export interface ExpertToolsMcpSessionRegistration {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly dispose: () => Promise<void>;
}

export interface RegisterExpertToolsMcpSessionOptions {
  readonly agent: Expert;
  readonly getContext: () => ExpertAgentRunContext | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly logger: PragmaLogger;
  readonly mcpTools?: readonly McpManagedTool[] | undefined;
  readonly state: ExpertToolRuntimeState;
  readonly executionContext?: ExpertToolExecutionContext | undefined;
}

type LocalTool = ExecutionTool;
const RUNTIME_PERMISSION_APPROVAL_REASON = "Runtime requested tool approval.";
const SESSION_MCP_PATH_PATTERN = /^\/sessions\/([A-Za-z0-9_-]{43})\/mcp$/;
const MCP_CONFIG_ID = "pragma";
const MCP_QUALIFIED_TOOL_NAME_LIMIT = 64;
const MCP_QUALIFIED_TOOL_PREFIX = `mcp__${MCP_CONFIG_ID}__`;
const MCP_LOCAL_TOOL_NAME_LIMIT = MCP_QUALIFIED_TOOL_NAME_LIMIT - MCP_QUALIFIED_TOOL_PREFIX.length;

interface ExpertToolsMcpGatewayEntry {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly logger: PragmaLogger;
}

class ExpertToolsMcpGateway {
  private readonly entries = new Map<string, ExpertToolsMcpGatewayEntry>();
  private httpServer: ReturnType<typeof createServer> | undefined;
  private origin: string | undefined;
  private lifecycle: Promise<void> = Promise.resolve();

  async register(
    options: RegisterExpertToolsMcpSessionOptions,
  ): Promise<ExpertToolsMcpSessionRegistration> {
    const id = MCP_CONFIG_ID;
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
      entry.logger.error("tool.mcp_request_failed", "Execution MCP Session request failed", error);
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
      version: "0.0.0",
    },
    {
      instructions:
        "Execution-scoped Pragma tools. These tools are isolated to the current runtime session.",
    },
  );
  const tools = createExecutionLocalTools(options);
  const runtimeNames = new Set<string>();

  for (const resolvedTool of tools) {
    const runtimeName = createRuntimeToolName(resolvedTool.name);
    if (runtimeNames.has(runtimeName)) {
      throw new Error(`Execution MCP tool name collision: ${runtimeName}.`);
    }
    runtimeNames.add(runtimeName);
    registerLocalTool(server, runtimeName, resolvedTool.tool, options);
  }

  return server;
}

function createExecutionLocalTools(
  options: RegisterExpertToolsMcpSessionOptions,
): readonly ResolvedExecutionTool[] {
  const resolved = resolveExecutionTools({
    agent: options.agent,
    getContext: options.getContext,
    mcpTools: options.mcpTools,
  });
  const permissionTool = createPermissionPromptTool(
    options,
    new Set(resolved.tools.flatMap((tool) => [tool.name, createRuntimeToolName(tool.name)])),
  );

  return [
    { name: permissionTool.name, source: "default", tool: permissionTool },
    ...resolved.tools,
  ];
}

function createPermissionPromptTool(
  options: RegisterExpertToolsMcpSessionOptions,
  runtimeManagedToolNames: ReadonlySet<string>,
): LocalTool {
  return {
    name: "request_tool_approval",
    label: "Request tool approval",
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

      emitExecutionToolApprovalRequested({
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

function registerLocalTool(
  server: McpServer,
  runtimeName: string,
  tool: LocalTool,
  options: RegisterExpertToolsMcpSessionOptions,
): void {
  const outputSchema =
    tool.outputSchema === undefined ? undefined : toMcpInputSchema(tool.outputSchema);
  server.registerTool(
    runtimeName,
    {
      description: tool.description,
      inputSchema: toMcpInputSchema(tool.inputSchema),
      ...(outputSchema === undefined ? {} : { outputSchema }),
    },
    async (input, context) => {
      const toolCallId = String(context.mcpReq.id);

      try {
        const result = await executeExecutionTool({
          agent: options.agent,
          tool,
          toolCallId,
          args: input,
          signal: context.mcpReq.signal,
          humanInteractionHandler: options.humanInteractionHandler,
          runContext: options.getContext(),
          executionContext: options.executionContext,
          logger: options.logger,
          state: options.state,
        });

        return toCallToolResult(result);
      } catch (error) {
        // A human checkpoint is a control signal for the owning Runtime turn,
        // not a tool result that the model may recover from. The controller
        // also stops the active submission out of band; rethrowing here keeps
        // the HTTP MCP boundary from manufacturing tool_execution_failed and
        // giving an external Runtime a chance to continue the turn.
        if (isHumanInteractionCheckpointError(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const payload = {
          ok: false as const,
          committed: false as const,
          error: { code: "tool_execution_failed", message },
        };
        return toCallToolResult({
          text: JSON.stringify(payload),
          isError: true,
          details: payload,
        });
      }
    },
  );
}

function toMcpInputSchema(schema: unknown): StandardSchemaWithJSON | undefined {
  if (schema === undefined) {
    return fromJsonSchema(defaultObjectJsonSchema());
  }

  // Zod decorates materialized z.toJSONSchema() results with Standard Schema metadata.
  // Normalize those JSON documents instead of treating them as executable validators.
  if (isStandardSchemaWithJson(schema) && !isJsonSchemaRecord(schema)) {
    return schema;
  }

  if (isRecord(schema)) {
    return fromJsonSchema(normalizeMcpJsonSchema(schema) as JsonSchemaType);
  }

  return fromJsonSchema(defaultObjectJsonSchema());
}

function isJsonSchemaRecord(schema: unknown): boolean {
  if (!isRecord(schema)) return false;

  return [
    "$schema",
    "$ref",
    "$defs",
    "definitions",
    "type",
    "properties",
    "items",
    "allOf",
    "anyOf",
    "oneOf",
    "additionalProperties",
  ].some((keyword) => Object.hasOwn(schema, keyword));
}

function normalizeMcpJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const root = schema;

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(visit);
    }
    if (!isRecord(value)) {
      return value;
    }

    const reference = value["$ref"];
    if (typeof reference === "string") {
      const target = resolveLocalJsonSchemaReference(root, reference);
      const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
      if (
        target !== undefined &&
        Object.keys(siblings).length > 0 &&
        isDeepStrictEqual(siblings, target)
      ) {
        return { $ref: reference };
      }
    }

    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
  };

  return visit(schema) as Record<string, unknown>;
}

function resolveLocalJsonSchemaReference(
  root: Record<string, unknown>,
  reference: string,
): unknown {
  if (!reference.startsWith("#/")) return undefined;

  let current: unknown = root;
  for (const encodedSegment of reference.slice(2).split("/")) {
    if (!isRecord(current)) return undefined;
    const segment = decodeURIComponent(encodedSegment).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
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

function createRuntimeToolName(value: string): string {
  const sanitized = sanitizeExecutionToolName(value);
  if (sanitized === value && sanitized.length <= MCP_LOCAL_TOOL_NAME_LIMIT) return sanitized;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 10);
  const prefixLength = MCP_LOCAL_TOOL_NAME_LIMIT - digest.length - 1;
  return `${sanitized.slice(0, prefixLength)}_${digest}`;
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
