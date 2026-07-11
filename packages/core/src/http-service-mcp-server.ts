import type {
  IExpertAgentInProcessMcpServer,
  IExpertAgentMcpToolInfo,
} from "./agent/expert-agent.ts";

export type HttpServiceAuth =
  | { readonly type: "none" }
  | { readonly type: "bearer"; readonly token: string }
  | { readonly type: "api_key_header"; readonly headerName: string; readonly value: string };

export interface HttpServiceParameter {
  readonly name: string;
  readonly location: "path" | "query";
  readonly required: boolean;
  readonly type: "string" | "number" | "integer" | "boolean";
  readonly description?: string | undefined;
}

export interface HttpServiceToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly parameters: readonly HttpServiceParameter[];
  readonly bodySchema?: Record<string, unknown> | undefined;
}

export interface HttpServiceDefinition {
  readonly name: string;
  readonly baseUrl: string;
  readonly auth: HttpServiceAuth;
  readonly tools: readonly HttpServiceToolDefinition[];
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
}

export type HttpServiceToolErrorCode =
  | "invalid_input"
  | "authentication"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream_4xx"
  | "upstream_5xx"
  | "timeout"
  | "network"
  | "invalid_response"
  | "response_too_large"
  | "aborted";

export interface HttpServiceToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean | undefined;
  readonly details?:
    | {
        readonly code: HttpServiceToolErrorCode;
        readonly service: string;
        readonly tool: string;
        readonly status?: number | undefined;
        readonly requestId?: string | undefined;
      }
    | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_SUMMARY_BYTES = 4096;

export function createHttpServiceMcpServer(
  definition: HttpServiceDefinition,
): IExpertAgentInProcessMcpServer {
  const tools = new Map(definition.tools.map((tool) => [tool.name, tool]));

  return {
    async listTools(): Promise<readonly IExpertAgentMcpToolInfo[]> {
      return definition.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: createToolInputSchema(tool),
      }));
    },
    async callTool(name, args, signal): Promise<HttpServiceToolResult> {
      const tool = tools.get(name);
      if (tool === undefined) {
        return errorResult(definition, name, "invalid_input", `Unknown HTTP tool: ${name}.`);
      }

      const input = asRecord(args);
      if (input === undefined) {
        return errorResult(definition, name, "invalid_input", "Tool input must be an object.");
      }

      try {
        const request = createRequest(definition, tool, input);
        signal?.throwIfAborted();
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(
          () => timeoutController.abort(new Error("HTTP service request timed out.")),
          definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );

        try {
          const requestSignal =
            signal === undefined
              ? timeoutController.signal
              : AbortSignal.any([signal, timeoutController.signal]);
          const response = await fetch(request.url, {
            method: tool.method,
            headers: request.headers,
            ...(request.body === undefined ? {} : { body: request.body }),
            signal: requestSignal,
            redirect: "error",
          });
          return await readResponse(definition, tool, response);
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        if (error instanceof HttpServiceInputError) {
          return errorResult(definition, name, "invalid_input", error.message);
        }
        if (signal?.aborted === true) {
          return errorResult(
            definition,
            name,
            "aborted",
            "The HTTP service request was cancelled.",
          );
        }
        if (isAbortError(error)) {
          return errorResult(definition, name, "timeout", "The HTTP service request timed out.");
        }
        return errorResult(definition, name, "network", "The HTTP service could not be reached.");
      }
    },
  };
}

class HttpServiceInputError extends Error {}

function createToolInputSchema(tool: HttpServiceToolDefinition): Record<string, unknown> {
  const pathProperties = parameterProperties(tool.parameters, "path");
  const queryProperties = parameterProperties(tool.parameters, "query");
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  if (Object.keys(pathProperties.properties).length > 0) {
    properties["path"] = objectSchema(pathProperties.properties, pathProperties.required);
    if (pathProperties.required.length > 0) required.push("path");
  }
  if (Object.keys(queryProperties.properties).length > 0) {
    properties["query"] = objectSchema(queryProperties.properties, queryProperties.required);
    if (queryProperties.required.length > 0) required.push("query");
  }
  if (tool.bodySchema !== undefined) {
    properties["body"] = tool.bodySchema;
  }

  return objectSchema(properties, required);
}

function parameterProperties(
  parameters: readonly HttpServiceParameter[],
  location: HttpServiceParameter["location"],
): { readonly properties: Record<string, unknown>; readonly required: readonly string[] } {
  const selected = parameters.filter((parameter) => parameter.location === location);
  return {
    properties: Object.fromEntries(
      selected.map((parameter) => [
        parameter.name,
        {
          type: parameter.type,
          ...(parameter.description === undefined ? {} : { description: parameter.description }),
        },
      ]),
    ),
    required: selected.filter((parameter) => parameter.required).map((parameter) => parameter.name),
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
  };
}

function createRequest(
  definition: HttpServiceDefinition,
  tool: HttpServiceToolDefinition,
  input: Record<string, unknown>,
): { readonly url: string; readonly headers: Record<string, string>; readonly body?: string } {
  const pathInput = asRecord(input["path"]) ?? {};
  const queryInput = asRecord(input["query"]) ?? {};
  let resolvedPath = tool.path;

  for (const parameter of tool.parameters.filter((item) => item.location === "path")) {
    const value = validateParameter(parameter, pathInput[parameter.name]);
    if (value !== undefined) {
      resolvedPath = resolvedPath.replaceAll(
        `{${parameter.name}}`,
        encodeURIComponent(String(value)),
      );
    }
  }
  if (/\{[^}]+\}/.test(resolvedPath)) {
    throw new HttpServiceInputError("A required path parameter is missing.");
  }

  const baseUrl = new URL(
    definition.baseUrl.endsWith("/") ? definition.baseUrl : `${definition.baseUrl}/`,
  );
  const url = new URL(resolvedPath.replace(/^\/+/, ""), baseUrl);
  for (const parameter of tool.parameters.filter((item) => item.location === "query")) {
    const value = validateParameter(parameter, queryInput[parameter.name]);
    if (value !== undefined) url.searchParams.set(parameter.name, String(value));
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (definition.auth.type === "bearer") {
    headers["authorization"] = `Bearer ${definition.auth.token}`;
  } else if (definition.auth.type === "api_key_header") {
    headers[definition.auth.headerName] = definition.auth.value;
  }

  if (tool.method === "POST") {
    headers["content-type"] = "application/json";
    const body = input["body"];
    if (tool.bodySchema !== undefined && asRecord(body) === undefined) {
      throw new HttpServiceInputError("A JSON object body is required.");
    }
    return { url: url.toString(), headers, body: JSON.stringify(body ?? {}) };
  }

  return { url: url.toString(), headers };
}

function validateParameter(
  parameter: HttpServiceParameter,
  value: unknown,
): string | number | boolean | undefined {
  if (value === undefined) {
    if (parameter.required) {
      throw new HttpServiceInputError(
        `Missing required ${parameter.location} parameter: ${parameter.name}.`,
      );
    }
    return undefined;
  }
  const valid =
    parameter.type === "string"
      ? typeof value === "string"
      : parameter.type === "boolean"
        ? typeof value === "boolean"
        : typeof value === "number" &&
          Number.isFinite(value) &&
          (parameter.type !== "integer" || Number.isInteger(value));
  if (!valid) {
    throw new HttpServiceInputError(
      `${parameter.location} parameter ${parameter.name} must be ${parameter.type}.`,
    );
  }
  return value as string | number | boolean;
}

async function readResponse(
  definition: HttpServiceDefinition,
  tool: HttpServiceToolDefinition,
  response: Response,
): Promise<HttpServiceToolResult> {
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > (definition.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) {
    return errorResult(
      definition,
      tool.name,
      "response_too_large",
      "The HTTP service response exceeded the configured size limit.",
      response,
    );
  }
  const text = new TextDecoder().decode(body);
  if (!response.ok) {
    return errorResult(
      definition,
      tool.name,
      statusErrorCode(response.status),
      sanitizeErrorSummary(text).slice(0, MAX_ERROR_SUMMARY_BYTES) || `HTTP ${response.status}.`,
      response,
    );
  }
  if (response.status === 204 || text.trim() === "") {
    return { content: [{ type: "text", text: "" }] };
  }
  try {
    return { content: [{ type: "text", text: JSON.stringify(JSON.parse(text)) }] };
  } catch {
    return errorResult(
      definition,
      tool.name,
      "invalid_response",
      "The HTTP service returned a non-JSON response.",
      response,
    );
  }
}

function errorResult(
  definition: HttpServiceDefinition,
  tool: string,
  code: HttpServiceToolErrorCode,
  message: string,
  response?: Response,
): HttpServiceToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: {
      code,
      service: definition.name,
      tool,
      ...(response === undefined ? {} : { status: response.status }),
      ...(response?.headers.get("x-request-id") === null || response === undefined
        ? {}
        : { requestId: response.headers.get("x-request-id") as string }),
    },
  };
}

function statusErrorCode(status: number): HttpServiceToolErrorCode {
  if (status === 401) return "authentication";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "upstream_5xx" : "upstream_4xx";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.message.includes("timed out"))
  );
}

function sanitizeErrorSummary(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(
      /("?(?:token|api[_-]?key|secret|password)"?\s*[:=]\s*)"?[^",\s}]+"?/gi,
      "$1[redacted]",
    );
}
