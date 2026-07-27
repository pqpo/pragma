import { createHash } from "node:crypto";

import {
  createMcpToolRegistry,
  verifyCodeServiceDefinition,
  type IExpertAgentMcpServer,
} from "@pragma/core";

import {
  CapabilityDefinitionSchema,
  CapabilityToolSnapshotSchema,
  type CapabilityDefinition,
} from "../../../shared/contracts/index.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { CapabilityVerifier } from "./capability-verification.ts";

export function createCapabilityVerifier(
  credentials: CapabilityCredentialStore,
): CapabilityVerifier {
  return async (definition, capabilityId) => {
    const checkedAt = new Date().toISOString();
    if (definition.kind === "code_service") {
      const result = await verifyCodeServiceDefinition({
        name: definition.name,
        timeoutMs: definition.timeoutMs,
        tool: definition.tool,
      });
      return result.ok
        ? { definition, health: { status: "ready", checkedAt } }
        : {
            definition,
            health: {
              status: "needs_attention",
              checkedAt,
              diagnostic: { code: result.code, message: result.message, retryable: true },
            },
          };
    }
    if (definition.kind !== "mcp_server") {
      return { definition, health: { status: "ready", checkedAt } };
    }

    try {
      const server = await toCoreMcpServer(definition, capabilityId, credentials);
      const registry = await createMcpToolRegistry({ mcpServers: { capability: server } });
      try {
        const tools = registry.tools.map((tool) =>
          CapabilityToolSnapshotSchema.parse({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            schemaHash: hashSchema(tool.inputSchema),
          }),
        );
        return {
          definition: CapabilityDefinitionSchema.parse({ ...definition, tools }),
          health: { status: "ready", checkedAt },
        };
      } finally {
        await registry.dispose();
      }
    } catch (error) {
      return {
        definition,
        health: {
          status: "needs_attention",
          checkedAt,
          diagnostic: classifyMcpError(error),
        },
      };
    }
  };
}

export async function toCoreMcpServer(
  definition: Extract<CapabilityDefinition, { readonly kind: "mcp_server" }>,
  capabilityId: string,
  credentials: CapabilityCredentialStore,
  allowTools?: readonly string[],
): Promise<IExpertAgentMcpServer> {
  const base = {
    name: definition.name,
    timeout: definition.timeoutMs,
    ...(allowTools === undefined ? {} : { allowTools }),
  };
  if (definition.connection.transport === "stdio") {
    const secretEntries = await Promise.all(
      Object.entries(definition.connection.secretEnv).map(async ([key, reference]) => {
        const value = await credentials.get(capabilityId, reference);
        if (value === undefined) throw new Error(`Credential ${reference} is not configured.`);
        return [key, value] as const;
      }),
    );
    return {
      ...base,
      transport: "stdio",
      command: definition.connection.command,
      args: definition.connection.args,
      env: { ...definition.connection.env, ...Object.fromEntries(secretEntries) },
    };
  }

  const token =
    definition.connection.tokenCredentialRef === undefined
      ? undefined
      : await credentials.get(capabilityId, definition.connection.tokenCredentialRef);
  if (definition.connection.tokenCredentialRef !== undefined && token === undefined) {
    throw new Error(`Credential ${definition.connection.tokenCredentialRef} is not configured.`);
  }
  return {
    ...base,
    transport: definition.connection.transport,
    url: definition.connection.url,
    ...(token === undefined ? {} : { token }),
  };
}

export function hashSchema(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function classifyMcpError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  const message = error instanceof Error ? error.message : "The MCP server could not be verified.";
  const errorCodes = collectErrorCodes(error);
  const lower = `${message} ${errorCodes.join(" ")}`.toLowerCase();
  const code =
    lower.includes("timed out") || errorCodes.some(isTimeoutErrorCode)
      ? "timeout"
      : lower.includes("401") || lower.includes("unauthorized") || lower.includes("credential")
        ? "authentication"
        : lower.includes("spawn") || lower.includes("exited") || lower.includes("enoent")
          ? "process_exit"
          : lower.includes("network") ||
              lower.includes("fetch") ||
              lower.includes("connect") ||
              errorCodes.some(isNetworkErrorCode)
            ? "network"
            : "protocol";
  return {
    code,
    message: sanitizeDiagnostic(
      errorCodes.length === 0 ? message : `${message} (${errorCodes.join(", ")})`,
    ),
    retryable: code !== "authentication",
  };
}

function collectErrorCodes(error: unknown): string[] {
  const codes = new Set<string>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const record = current as { readonly code?: unknown; readonly cause?: unknown };
    if (typeof record.code === "string" && /^[A-Z0-9_]+$/i.test(record.code)) {
      codes.add(record.code.toUpperCase());
    }
    current = record.cause;
  }
  return [...codes];
}

function isTimeoutErrorCode(code: string): boolean {
  return code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT";
}

function isNetworkErrorCode(code: string): boolean {
  return [
    "ECONNREFUSED",
    "ECONNRESET",
    "EAI_AGAIN",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTDOWN",
    "EHOSTUNREACH",
    "UND_ERR_SOCKET",
  ].includes(code);
}

function sanitizeDiagnostic(message: string): string {
  return message
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(token|key|secret|password)=([^\s&]+)/gi, "$1=[redacted]")
    .slice(0, 2_000);
}
