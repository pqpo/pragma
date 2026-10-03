import { toCoreMcpServer, hashSchema, classifyMcpError } from "@pragma/local-host/resources";
export { toCoreMcpServer, hashSchema, classifyMcpError } from "@pragma/local-host/resources";
import {
  createMcpToolRegistryPool,
  verifyCodeServiceDefinition,
  type McpToolRegistryPool,
} from "@pragma/core";
import {
  CapabilityDefinitionSchema,
  CapabilityToolSnapshotSchema,
} from "../../../shared/contracts/index.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { CapabilityVerifier } from "./capability-verification.ts";
export function createCapabilityVerifier(
  credentials: CapabilityCredentialStore,
  mcpToolRegistryPool?: McpToolRegistryPool,
): CapabilityVerifier {
  return async (definition, capabilityId, credentialOverride) => {
    const credentialReader = credentialOverride ?? credentials;
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
      const server = await toCoreMcpServer(definition, capabilityId, credentialReader);
      const ownsPool = mcpToolRegistryPool === undefined;
      const pool =
        mcpToolRegistryPool ??
        createMcpToolRegistryPool({
          idleTtlMs: 0,
          maxIdleEntries: 0,
        });
      try {
        const lease = await pool.acquire({ mcpServers: { capability: server } });
        try {
          const tools = lease.registry.tools.map((tool) =>
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
          await lease.release();
        }
      } finally {
        if (ownsPool) await pool.close();
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
