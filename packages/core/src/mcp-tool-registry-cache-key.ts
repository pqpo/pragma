import { createHash } from "node:crypto";

import type { IExpertAgentMcpServer } from "./agent/expert-agent.ts";

export function mcpServerConnectionCacheKey(server: IExpertAgentMcpServer): string | object {
  if (server.transport === "in-process") return server.inProcess;
  return createHash("sha256")
    .update(stableStringify(normalizeExternalMcpServer(server)))
    .digest("hex");
}

function normalizeExternalMcpServer(server: IExpertAgentMcpServer): unknown {
  if (server.transport === "in-process") {
    throw new Error("In-process MCP Servers use object-identity cache keys.");
  }
  const connection = Object.fromEntries(
    Object.entries(server).filter(
      ([key]) => key !== "allowTools" && key !== "disallowTools" && key !== "toolApprovals",
    ),
  );
  return {
    ...connection,
    ...(server.transport === "stdio"
      ? {
          env: Object.entries(server.env ?? {})
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => [key, createHash("sha256").update(value).digest("hex")]),
        }
      : server.token === undefined
        ? {}
        : {
            token: createHash("sha256").update(server.token).digest("hex"),
          }),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
