import { Client } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  JSONRPCMessage,
  StandardSchemaWithJSON,
  Transport,
} from "@modelcontextprotocol/server";
import type { IExpertAgentMcpConfig, IExpertAgentMcpServer } from "@pragma/core";

type MaybePromise<TValue> = TValue | Promise<TValue>;

export interface SdkMcpToolContext {
  readonly signal?: AbortSignal | undefined;
}

export interface SdkMcpToolDefinition<TInput = unknown, TResult = unknown> {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema?: StandardSchemaWithJSON | undefined;
  readonly outputSchema?: StandardSchemaWithJSON | undefined;
  readonly call: (input: TInput, context: SdkMcpToolContext) => MaybePromise<TResult>;
}

export interface CreateSdkMcpServerOptions {
  readonly id: string;
  readonly name: string;
  readonly version?: string | undefined;
  readonly tools: readonly SdkMcpToolDefinition[];
  readonly timeout?: number | undefined;
  readonly allowTools?: readonly string[] | undefined;
  readonly disallowTools?: readonly string[] | undefined;
}

export interface SdkMcpServer {
  readonly id: string;
  readonly server: McpServer;
  readonly mcpServer: IExpertAgentMcpServer;
  readonly mcpConfig: IExpertAgentMcpConfig;
  readonly dispose: () => Promise<void>;
}

interface LinkedTransportPair {
  readonly client: Transport;
  readonly server: Transport;
}

export function createSdkMcpServer(options: CreateSdkMcpServerOptions): SdkMcpServer {
  const server = new McpServer({
    name: options.name,
    version: options.version ?? "0.0.0",
  });

  for (const tool of options.tools) {
    registerSdkMcpTool(server, tool);
  }

  const clients = new Set<Client>();
  const mcpServer: IExpertAgentMcpServer = {
    name: options.name,
    transport: "in-process",
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.allowTools === undefined ? {} : { allowTools: options.allowTools }),
    ...(options.disallowTools === undefined ? {} : { disallowTools: options.disallowTools }),
    inProcess: {
      async listTools() {
        const client = await createInProcessClient(server, clients, options);
        const result = await client.listTools();
        await client.close();
        clients.delete(client);

        return result.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
          ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        }));
      },
      async callTool(name, args) {
        const client = await createInProcessClient(server, clients, options);

        try {
          return await client.callTool({
            name,
            arguments: isRecord(args) ? args : {},
          });
        } finally {
          await client.close();
          clients.delete(client);
        }
      },
      async dispose() {
        await Promise.allSettled([...clients].map((client) => client.close()));
        clients.clear();
        await server.close();
      },
    },
  };

  return {
    id: options.id,
    server,
    mcpServer,
    mcpConfig: {
      mcpServers: {
        [options.id]: mcpServer,
      },
    },
    dispose: async () => {
      if (mcpServer.transport === "in-process") {
        await mcpServer.inProcess.dispose?.();
      }
    },
  };
}

function registerSdkMcpTool(server: McpServer, tool: SdkMcpToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    },
    async (input) => toCallToolResult(await tool.call(input, {})),
  );
}

async function createInProcessClient(
  server: McpServer,
  clients: Set<Client>,
  options: CreateSdkMcpServerOptions,
): Promise<Client> {
  const client = new Client(
    {
      name: `${options.name}-in-process-client`,
      version: options.version ?? "0.0.0",
    },
    {
      capabilities: {},
    },
  );
  const transports = createLinkedTransportPair();

  clients.add(client);

  try {
    await Promise.all([server.connect(transports.server), client.connect(transports.client)]);
  } catch (error) {
    clients.delete(client);
    await Promise.allSettled([
      client.close(),
      transports.client.close(),
      transports.server.close(),
    ]);
    throw error;
  }

  return client;
}

function createLinkedTransportPair(): LinkedTransportPair {
  const client = new LinkedTransport();
  const server = new LinkedTransport();
  client.peer = server;
  server.peer = client;

  return { client, server };
}

class LinkedTransport implements Transport {
  peer: LinkedTransport | undefined;
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((message: JSONRPCMessage) => void) | undefined;
  private started = false;
  private closed = false;

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot start a closed MCP transport.");
    }

    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed) {
      throw new Error("Cannot send on a closed MCP transport.");
    }

    const peer = this.peer;
    if (peer === undefined || peer.closed) {
      throw new Error("Cannot send MCP message without a connected peer.");
    }

    queueMicrotask(() => {
      try {
        peer.onmessage?.(message);
      } catch (error) {
        peer.onerror?.(toError(error));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.onclose?.();
  }
}

function toCallToolResult(value: unknown): CallToolResult {
  if (isCallToolResult(value)) {
    return value;
  }

  if (typeof value === "string") {
    return {
      content: [{ type: "text", text: value }],
    };
  }

  const text = value === undefined ? "" : JSON.stringify(value, null, 2);

  return {
    content: [{ type: "text", text }],
    ...(isJsonObject(value) ? { structuredContent: value } : {}),
  };
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value["content"]);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
