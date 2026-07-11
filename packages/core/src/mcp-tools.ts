import {
  Client,
  SSEClientTransport,
  StdioClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { AuthProvider, Transport } from "@modelcontextprotocol/client";
import type {
  ExpertAgentManagedTool,
  IExpertAgentMcpConfig,
  IExpertAgentMcpServer,
} from "@pragma/core";

export interface McpToolRegistry {
  readonly tools: readonly McpManagedTool[];
  readonly dispose: () => Promise<void>;
}

export interface McpManagedTool extends ExpertAgentManagedTool<string, unknown> {
  readonly serverId: string;
  readonly serverName: string;
}

interface McpToolInfo {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
}

interface McpClient {
  readonly listTools: () => Promise<readonly McpToolInfo[]>;
  readonly callTool: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
  readonly dispose: () => Promise<void>;
}

export async function createMcpToolRegistry(
  config: IExpertAgentMcpConfig | undefined,
): Promise<McpToolRegistry> {
  if (config === undefined) {
    return emptyMcpToolRegistry();
  }

  const clients: McpClient[] = [];
  const tools: McpManagedTool[] = [];

  try {
    for (const [serverId, server] of Object.entries(config.mcpServers)) {
      const client = await createOfficialMcpClient(server);
      clients.push(client);

      const mcpTools = filterMcpTools(await client.listTools(), server);

      for (const mcpTool of mcpTools) {
        tools.push(createManagedMcpTool(serverId, server, client, mcpTool));
      }
    }
  } catch (error) {
    await disposeMcpClients(clients);
    throw error;
  }

  return {
    tools,
    dispose: () => disposeMcpClients(clients),
  };
}

function emptyMcpToolRegistry(): McpToolRegistry {
  return {
    tools: [],
    async dispose() {
      return undefined;
    },
  };
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
  };
}

async function disposeMcpClients(clients: readonly McpClient[]): Promise<void> {
  await Promise.allSettled(clients.map((client) => client.dispose()));
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
