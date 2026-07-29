import { createHash } from "node:crypto";

import type { IExpertAgentMcpConfig, IExpertAgentMcpServer } from "./agent/expert-agent.ts";

export function mcpToolRegistryCacheKey(
  config: IExpertAgentMcpConfig | undefined,
): string | IExpertAgentMcpConfig {
  if (config === undefined) return "empty";
  if (Object.values(config.mcpServers).some((server) => server.transport === "in-process")) {
    return config;
  }
  const normalized = Object.entries(config.mcpServers)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([id, server]) => [id, normalizeExternalMcpServer(server)]);
  return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

function normalizeExternalMcpServer(server: IExpertAgentMcpServer): unknown {
  if (server.transport === "in-process") {
    throw new Error("In-process MCP Servers use object-identity cache keys.");
  }
  return {
    ...server,
    ...(server.transport === "stdio"
      ? {
          env: Object.entries(server.env ?? {}).toSorted(([left], [right]) =>
            left.localeCompare(right),
          ),
        }
      : server.token === undefined
        ? {}
        : {
            token: createHash("sha256").update(server.token).digest("hex"),
          }),
    allowTools: [...(server.allowTools ?? [])].toSorted(),
    disallowTools: [...(server.disallowTools ?? [])].toSorted(),
    toolApprovals: Object.entries(server.toolApprovals ?? {}).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
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
