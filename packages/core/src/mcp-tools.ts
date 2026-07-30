import {
  Client,
  SSEClientTransport,
  StdioClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { AuthProvider, Transport } from "@modelcontextprotocol/client";
import type { IExpertAgentMcpConfig, IExpertAgentMcpServer } from "./agent/expert-agent.ts";
import type { ExpertAgentManagedTool } from "./tools/managed-tool.ts";

import { mcpServerConnectionCacheKey } from "./mcp-tool-registry-cache-key.ts";

export interface McpToolRegistry {
  readonly tools: readonly McpManagedTool[];
}

export interface McpToolRegistryLeaseStats {
  readonly openedConnections: number;
  readonly reusedConnections: number;
  readonly coalescedConnections: number;
}

export interface McpToolRegistryLease {
  readonly registry: McpToolRegistry;
  readonly stats: McpToolRegistryLeaseStats;
  readonly release: () => Promise<void>;
}

export interface McpToolRegistryPool {
  readonly acquire: (config: IExpertAgentMcpConfig | undefined) => Promise<McpToolRegistryLease>;
  /**
   * Hard-stops every pooled connection, including connections referenced by active leases.
   * Hosts must call this only during final shutdown, after stopping normal execution dispatch.
   * Releasing a lease after close is safe and has no effect.
   */
  readonly close: () => Promise<void>;
}

export interface McpManagedTool extends ExpertAgentManagedTool<string, unknown> {
  readonly serverId: string;
  readonly serverName: string;
}

interface McpToolInfo {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

interface McpClient {
  readonly listTools: () => Promise<readonly McpToolInfo[]>;
  readonly callTool: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
  readonly dispose: () => Promise<void>;
}

interface McpConnection {
  readonly client: McpClient;
  readonly tools: readonly McpToolInfo[];
}

export function createMcpToolRegistryPool(
  options: {
    readonly idleTtlMs?: number | undefined;
    readonly maxIdleEntries?: number | undefined;
  } = {},
): McpToolRegistryPool {
  const idleTtlMs = options.idleTtlMs ?? 5 * 60_000;
  const maxIdleEntries = options.maxIdleEntries ?? 32;
  const entries = new Map<
    string | object,
    {
      readonly opening: Promise<McpConnection>;
      references: number;
      ready: boolean;
      releasedAt?: number | undefined;
      timer?: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  let closed = false;

  const disposeEntry = async (key: string | object): Promise<void> => {
    const entry = entries.get(key);
    if (entry === undefined || entry.references > 0) return;
    entries.delete(key);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const connection = await entry.opening.catch(() => undefined);
    await connection?.client.dispose();
  };

  const trimIdle = async (): Promise<void> => {
    const idle = [...entries.entries()]
      .filter(([, entry]) => entry.references === 0)
      .toSorted(([, left], [, right]) => (left.releasedAt ?? 0) - (right.releasedAt ?? 0));
    const excess = Math.max(0, idle.length - maxIdleEntries);
    await Promise.all(idle.slice(0, excess).map(async ([key]) => await disposeEntry(key)));
  };

  const releaseConnection = async (key: string | object): Promise<void> => {
    const current = entries.get(key);
    if (current === undefined) return;
    current.references = Math.max(0, current.references - 1);
    if (current.references > 0) return;
    current.releasedAt = Date.now();
    if (idleTtlMs === 0) {
      await disposeEntry(key);
      return;
    }
    current.timer = setTimeout(() => {
      void disposeEntry(key).catch(() => undefined);
    }, idleTtlMs);
    current.timer.unref();
    await trimIdle();
  };

  const acquireConnection = async (
    server: IExpertAgentMcpServer,
  ): Promise<{
    readonly connection: McpConnection;
    readonly disposition: "opened" | "reused" | "coalesced";
    readonly release: () => Promise<void>;
  }> => {
    const key = mcpServerConnectionCacheKey(server);
    let entry = entries.get(key);
    let disposition: "opened" | "reused" | "coalesced";
    if (entry === undefined) {
      const opening = openMcpConnection(server);
      entry = { opening, references: 0, ready: false };
      entries.set(key, entry);
      disposition = "opened";
      void opening.then(
        () => {
          const current = entries.get(key);
          if (current?.opening === opening) current.ready = true;
        },
        () => {
          if (entries.get(key)?.opening === opening) entries.delete(key);
        },
      );
    } else {
      disposition = entry.ready ? "reused" : "coalesced";
    }
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.releasedAt = undefined;
    entry.references += 1;
    let released = false;
    try {
      const connection = await entry.opening;
      return {
        connection,
        disposition,
        async release() {
          if (released) return;
          released = true;
          await releaseConnection(key);
        },
      };
    } catch (error) {
      released = true;
      await releaseConnection(key);
      throw error;
    }
  };

  return {
    async acquire(config) {
      if (closed) throw new Error("MCP Tool Registry pool is closed.");
      if (config === undefined || Object.keys(config.mcpServers).length === 0) {
        return emptyMcpToolRegistryLease();
      }
      const servers = Object.entries(config.mcpServers);
      const acquisitions = await Promise.allSettled(
        servers.map(async ([serverId, server]) => ({
          serverId,
          server,
          acquired: await acquireConnection(server),
        })),
      );
      const acquired = acquisitions.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const errors = acquisitions.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length > 0) {
        await Promise.allSettled(acquired.map(async (item) => await item.acquired.release()));
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors, "Multiple MCP Server connections failed.");
      }

      const tools = acquired.flatMap(({ serverId, server, acquired: current }) =>
        filterMcpTools(current.connection.tools, server).map((tool) =>
          createManagedMcpTool(serverId, server, current.connection.client, tool),
        ),
      );
      let released = false;
      return {
        registry: { tools },
        stats: {
          openedConnections: acquired.filter((item) => item.acquired.disposition === "opened")
            .length,
          reusedConnections: acquired.filter((item) => item.acquired.disposition === "reused")
            .length,
          coalescedConnections: acquired.filter((item) => item.acquired.disposition === "coalesced")
            .length,
        },
        async release() {
          if (released) return;
          released = true;
          const results = await Promise.allSettled(
            acquired.map(async (item) => await item.acquired.release()),
          );
          const releaseErrors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason as unknown] : [],
          );
          if (releaseErrors.length === 1) throw releaseErrors[0];
          if (releaseErrors.length > 1) {
            throw new AggregateError(releaseErrors, "MCP Tool Registry lease release failed.");
          }
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      const values = [...entries.values()];
      entries.clear();
      for (const entry of values) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
      }
      const results = await Promise.allSettled(
        values.map(async (entry) => {
          const connection = await entry.opening;
          await connection.client.dispose();
        }),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "MCP Tool Registry pool close failed.");
      }
    },
  };
}

function emptyMcpToolRegistryLease(): McpToolRegistryLease {
  return {
    registry: { tools: [] },
    stats: {
      openedConnections: 0,
      reusedConnections: 0,
      coalescedConnections: 0,
    },
    async release() {
      return undefined;
    },
  };
}

async function openMcpConnection(server: IExpertAgentMcpServer): Promise<McpConnection> {
  const client = await createOfficialMcpClient(server);
  try {
    return { client, tools: await client.listTools() };
  } catch (error) {
    await client.dispose().catch(() => undefined);
    throw error;
  }
}

function createManagedMcpTool(
  serverId: string,
  server: IExpertAgentMcpServer,
  client: McpClient,
  mcpTool: McpToolInfo,
): McpManagedTool {
  const managedTool: McpManagedTool = {
    serverId,
    serverName: server.name,
    name: mcpTool.name,
    description: `Call MCP tool ${mcpTool.name}.`,
    inputSchema: {},
    ...(mcpTool.outputSchema === undefined ? {} : { outputSchema: mcpTool.outputSchema }),
    ...(server.toolApprovals?.[mcpTool.name] === undefined
      ? {}
      : { approval: server.toolApprovals[mcpTool.name] }),
    call: (args, signal) => client.callTool(mcpTool.name, args, signal),
  };

  if (mcpTool.description !== undefined) {
    return {
      ...managedTool,
      description: mcpTool.description,
      ...(mcpTool.inputSchema === undefined ? {} : { inputSchema: mcpTool.inputSchema }),
    };
  }

  if (mcpTool.inputSchema !== undefined) {
    return {
      ...managedTool,
      inputSchema: mcpTool.inputSchema,
    };
  }

  return managedTool;
}

async function createOfficialMcpClient(server: IExpertAgentMcpServer): Promise<McpClient> {
  if (server.transport === "in-process") {
    return createInProcessMcpClient(server);
  }

  const sdkClient = new Client(
    {
      name: "pragma-mcp-client",
      version: "0.0.0",
    },
    {
      capabilities: {},
    },
  );
  const transport = await createOfficialMcpTransport(server);
  await withTimeout(
    sdkClient.connect(transport),
    server.timeout,
    `connect MCP server "${server.name}"`,
  );

  return {
    async listTools() {
      const result = await withTimeout(
        sdkClient.listTools(),
        server.timeout,
        `list MCP tools from "${server.name}"`,
      );

      if (isRecord(result) && Array.isArray(result.tools)) {
        return result.tools.filter(isMcpToolInfo).map(normalizeMcpToolInfo);
      }

      return [];
    },
    async callTool(name, args, signal) {
      signal?.throwIfAborted();
      return withTimeout(
        sdkClient.callTool({
          name,
          arguments: isRecord(args) ? args : {},
        }),
        server.timeout,
        `call MCP tool "${server.name}.${name}"`,
      );
    },
    async dispose() {
      await sdkClient.close();
    },
  };
}

function createInProcessMcpClient(server: IExpertAgentMcpServer): McpClient {
  if (server.transport !== "in-process") {
    throw new Error(`MCP server "${server.name}" is not an in-process server.`);
  }
  const inProcessServer = server.inProcess;

  return {
    listTools: () =>
      withTimeout(
        inProcessServer.listTools(),
        server.timeout,
        `list MCP tools from "${server.name}"`,
      ),
    callTool: (name, args, signal) =>
      withTimeout(
        inProcessServer.callTool(name, args, signal),
        server.timeout,
        `call MCP tool "${server.name}.${name}"`,
      ),
    async dispose() {
      await inProcessServer.dispose?.();
    },
  };
}

async function createOfficialMcpTransport(server: IExpertAgentMcpServer): Promise<Transport> {
  if (server.transport === "stdio") {
    return new StdioClientTransport({
      command: server.command,
      args: [...(server.args ?? [])],
      ...(server.env === undefined ? {} : { env: server.env }),
    });
  }

  if (server.transport === "streamable-http") {
    const authProvider = createBearerTokenAuthProvider(server.token);

    return new StreamableHTTPClientTransport(new URL(server.url), {
      ...(authProvider === undefined ? {} : { authProvider }),
    });
  }

  if (server.transport === "sse") {
    const authProvider = createBearerTokenAuthProvider(server.token);

    return new SSEClientTransport(new URL(server.url), {
      ...(authProvider === undefined ? {} : { authProvider }),
    });
  }

  throw new Error(`MCP server "${server.name}" cannot use an in-process transport here.`);
}

function createBearerTokenAuthProvider(token: string | undefined): AuthProvider | undefined {
  if (token === undefined) {
    return undefined;
  }

  return {
    token: async () => token,
  };
}

function filterMcpTools(
  tools: readonly McpToolInfo[],
  server: IExpertAgentMcpServer,
): readonly McpToolInfo[] {
  return tools.filter((tool) => {
    if (server.allowTools !== undefined && !server.allowTools.includes(tool.name)) {
      return false;
    }

    if (server.disallowTools?.includes(tool.name) === true) {
      return false;
    }

    return true;
  });
}

function normalizeMcpToolInfo(tool: McpToolInfo): McpToolInfo {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  };
}

async function withTimeout<TResult>(
  promise: Promise<TResult>,
  timeout: number | undefined,
  operation: string,
): Promise<TResult> {
  if (timeout === undefined) {
    return promise;
  }

  let timeoutId: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out while trying to ${operation}.`));
        }, timeout);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMcpToolInfo(value: unknown): value is McpToolInfo {
  return isRecord(value) && typeof value.name === "string";
}
