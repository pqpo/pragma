import { describe, expect, it, vi } from "vitest";

import { mcpServerConnectionCacheKey } from "../src/mcp-tool-registry-cache-key.ts";
import { createMcpToolRegistryPool } from "../src/mcp-tools.ts";
import type { IExpertAgentMcpConfig } from "../src/agent/expert-agent.ts";

describe("McpToolRegistryPool", () => {
  it("shares one server connection across concurrent leases", async () => {
    let resolveTools: ((tools: readonly { name: string }[]) => void) | undefined;
    const listTools = vi.fn(
      async () =>
        await new Promise<readonly { name: string }[]>((resolve) => {
          resolveTools = resolve;
        }),
    );
    const dispose = vi.fn(async () => undefined);
    const inProcess = {
      listTools,
      async callTool() {
        return { content: [] };
      },
      dispose,
    };
    const pool = createMcpToolRegistryPool({ maxIdleEntries: 0 });

    const firstPromise = pool.acquire({
      mcpServers: {
        compile: { name: "Docs", transport: "in-process", inProcess },
      },
    });
    const secondPromise = pool.acquire({
      mcpServers: {
        runtime: { name: "Docs", transport: "in-process", inProcess },
      },
    });
    while (resolveTools === undefined) await Promise.resolve();
    resolveTools?.([{ name: "search" }]);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(listTools).toHaveBeenCalledOnce();
    expect(first.stats.openedConnections).toBe(1);
    expect(second.stats.coalescedConnections).toBe(1);
    expect(first.registry.tools[0]?.serverId).toBe("compile");
    expect(second.registry.tools[0]?.serverId).toBe("runtime");
    await first.release();
    expect(dispose).not.toHaveBeenCalled();
    await second.release();
    expect(dispose).toHaveBeenCalledOnce();
    await pool.close();
  });

  it("applies allowlists and approvals per lease without reopening the server", async () => {
    const listTools = vi.fn(async () => [
      { name: "read", description: "Read" },
      { name: "search", description: "Search" },
    ]);
    const inProcess = {
      listTools,
      async callTool() {
        return { content: [] };
      },
    };
    const pool = createMcpToolRegistryPool({ idleTtlMs: 1_000, maxIdleEntries: 32 });

    const compile = await pool.acquire({
      mcpServers: {
        verify: {
          name: "Docs",
          transport: "in-process",
          inProcess,
          allowTools: ["read"],
        },
      },
    });
    await compile.release();
    const runtime = await pool.acquire({
      mcpServers: {
        docs: {
          name: "Docs",
          transport: "in-process",
          inProcess,
          allowTools: ["search"],
          toolApprovals: { search: { mode: "ask" } },
        },
      },
    });

    expect(listTools).toHaveBeenCalledOnce();
    expect(compile.registry.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(runtime.registry.tools.map((tool) => tool.name)).toEqual(["search"]);
    expect(runtime.registry.tools[0]?.approval).toEqual({ mode: "ask" });
    expect(runtime.stats.reusedConnections).toBe(1);
    await runtime.release();
    await pool.close();
  });

  it("does not merge distinct in-process servers", async () => {
    const configuration = (): IExpertAgentMcpConfig => ({
      mcpServers: {
        local: {
          name: "Local",
          transport: "in-process",
          inProcess: {
            async listTools() {
              return [];
            },
            async callTool() {
              return { content: [] };
            },
          },
        },
      },
    });
    const pool = createMcpToolRegistryPool({ maxIdleEntries: 0 });

    const first = await pool.acquire(configuration());
    const second = await pool.acquire(configuration());

    expect(first.stats.openedConnections).toBe(1);
    expect(second.stats.openedConnections).toBe(1);
    await Promise.all([first.release(), second.release()]);
    await pool.close();
  });

  it("hard-closes active connections during final Host shutdown", async () => {
    const dispose = vi.fn(async () => undefined);
    const pool = createMcpToolRegistryPool();
    const lease = await pool.acquire({
      mcpServers: {
        local: {
          name: "Local",
          transport: "in-process",
          inProcess: {
            async listTools() {
              return [];
            },
            async callTool() {
              return { content: [] };
            },
            dispose,
          },
        },
      },
    });

    await pool.close();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(lease.release()).resolves.toBeUndefined();
    await expect(pool.acquire(undefined)).rejects.toThrow("pool is closed");
  });

  it("uses one connection key for equivalent external servers regardless of projections", () => {
    const first = {
      name: "Docs",
      transport: "streamable-http",
      url: "https://docs.example.test/mcp",
      token: "secret",
      allowTools: ["read"],
      toolApprovals: { read: { mode: "none" } },
    } as const;
    const second = {
      toolApprovals: { search: { mode: "ask" } },
      allowTools: ["search"],
      token: "secret",
      url: "https://docs.example.test/mcp",
      transport: "streamable-http",
      name: "Docs",
    } as const;

    expect(mcpServerConnectionCacheKey(first)).toBe(mcpServerConnectionCacheKey(second));
  });
});
