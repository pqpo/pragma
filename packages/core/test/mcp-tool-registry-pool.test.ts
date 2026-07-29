import { describe, expect, it, vi } from "vitest";

import { mcpToolRegistryCacheKey } from "../src/mcp-tool-registry-cache-key.ts";
import { createMcpToolRegistryPool } from "../src/mcp-tools.ts";
import type { IExpertAgentMcpConfig } from "../src/agent/expert-agent.ts";

describe("McpToolRegistryPool", () => {
  it("shares one Registry while leases use the same MCP configuration", async () => {
    const listTools = vi.fn(async () => [
      { name: "search", description: "Search", inputSchema: { type: "object" } },
    ]);
    const dispose = vi.fn(async () => undefined);
    const config: IExpertAgentMcpConfig = {
      mcpServers: {
        docs: {
          name: "Docs",
          transport: "in-process",
          timeout: 1_000,
          inProcess: {
            listTools,
            async callTool() {
              return { content: [] };
            },
            dispose,
          },
        },
      },
    };
    const pool = createMcpToolRegistryPool({ maxIdleEntries: 0 });

    const first = await pool.acquire(config);
    const second = await pool.acquire(config);

    expect(first.registry).toBe(second.registry);
    expect(listTools).toHaveBeenCalledOnce();
    await first.release();
    expect(dispose).not.toHaveBeenCalled();
    await second.release();
    expect(dispose).toHaveBeenCalledOnce();
    await pool.close();
  });

  it("does not merge distinct in-process MCP configurations", async () => {
    const configuration = (): IExpertAgentMcpConfig => ({
      mcpServers: {
        local: {
          name: "Local",
          transport: "in-process",
          timeout: 1_000,
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

    expect(first.registry).not.toBe(second.registry);
    await Promise.all([first.release(), second.release()]);
    await pool.close();
  });

  it("uses the same cache key for equivalent external configurations", () => {
    const first = {
      mcpServers: {
        docs: {
          name: "Docs",
          transport: "streamable-http",
          url: "https://docs.example.test/mcp",
          token: "secret",
          allowTools: ["read", "search"],
          toolApprovals: {
            search: { mode: "ask" },
            read: { mode: "none" },
          },
        },
      },
    } satisfies IExpertAgentMcpConfig;
    const second = {
      mcpServers: {
        docs: {
          toolApprovals: {
            read: { mode: "none" },
            search: { mode: "ask" },
          },
          allowTools: ["search", "read"],
          token: "secret",
          url: "https://docs.example.test/mcp",
          transport: "streamable-http",
          name: "Docs",
        },
      },
    } satisfies IExpertAgentMcpConfig;

    expect(mcpToolRegistryCacheKey(first)).toBe(mcpToolRegistryCacheKey(second));
  });
});
