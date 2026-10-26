import { describe, expect, it, vi } from "vitest";

import {
  mergeExpertAgentToolApprovals,
  resolveExpertAgentToolApprovalRequirement,
} from "../src/tools/managed-tool.ts";

import {
  createMcpToolRegistryPool,
  createPragmaLogger,
  defineExpert,
  definePluginEntry,
  executeExecutionTool,
  resolveExecutionTools,
} from "../src/index.ts";

describe("managed tool approval merging", () => {
  it("does not let a conditional requirement disable an unconditional policy", async () => {
    const merged = mergeExpertAgentToolApprovals(
      { mode: "required", when: () => false },
      { mode: "ask" },
    );

    expect(merged).toMatchObject({ mode: "required" });
    expect(merged?.when).toBeUndefined();
    await expect(
      resolveExpertAgentToolApprovalRequirement(merged, {
        kind: "tool_approval",
        toolName: "write",
        input: {},
      }),
    ).resolves.toBe("required");
  });
  it.each([false, true])(
    "keeps a conditional policy when merging neutral none (reverse=%s)",
    async (reverse) => {
      const conditional = { mode: "required" as const, when: () => false };
      const none = { mode: "none" as const };
      const merged = reverse
        ? mergeExpertAgentToolApprovals(none, conditional)
        : mergeExpertAgentToolApprovals(conditional, none);
      expect(merged?.when).toBe(conditional.when);
      await expect(
        resolveExpertAgentToolApprovalRequirement(merged, {
          kind: "tool_approval",
          toolName: "write",
          input: {},
        }),
      ).resolves.toBe("none");
    },
  );

  it("retains required approval on ordinary tools with lifecycle names", async () => {
    const call = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }] }));
    const agent = await defineExpert({
      id: "ordinary",
      name: "Ordinary",
      description: "Ordinary managed tools",
      tags: [],
      scope: "test",
      workspace: process.cwd(),
      tools: [
        {
          name: "spawn_expert",
          description: "Unrelated tool with the same name",
          inputSchema: { type: "object", properties: {} },
          approval: { mode: "required" },
          call,
        },
      ],
    });
    const tool = resolveExecutionTools({ agent, getContext: () => undefined }).tools.find(
      (candidate) => candidate.name === "spawn_expert",
    )!.tool;
    const handler = vi.fn(async () => ({ kind: "tool_approval" as const, approved: false }));
    const result = await executeExecutionTool({
      agent,
      tool,
      toolCallId: "ordinary",
      args: {},
      signal: undefined,
      humanInteractionHandler: handler,
      logger: createPragmaLogger(undefined, { component: "test" }),
      state: {},
    });
    expect(result.isError).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalled();
  });

  it.each(["none", "ask", "required"] as const)(
    "enforces plugin-required MCP approval over server %s through the real executor",
    async (serverMode) => {
      const call = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
      const agent = await defineExpert({
        id: "writer",
        name: "Writer",
        description: "Writer",
        tags: [],
        scope: "test",
        workspace: process.cwd(),
        executionToolApprovals: { mcp_docs_write: { mode: "none" } },
        mcp: {
          mcpServers: {
            docs: {
              name: "Docs",
              transport: "in-process",
              toolApprovals: { write: { mode: serverMode } },
              inProcess: { listTools: async () => [{ name: "write" }], callTool: call },
            },
          },
        },
        plugins: [
          {
            entry: definePluginEntry({
              manifest: {
                schemaVersion: "pragma.plugin/v2",
                id: "approval-policy",
                name: "Approval policy",
                description: "Require confirmation for writes",
                version: "0.0.0",
                tags: [],
                runtime: {
                  type: "expert-agent-plugin",
                  entry: "./index.js",
                  trust: "trusted-host",
                },
                capabilities: [],
                configuration: { type: "object", properties: {}, additionalProperties: false },
                permissions: { filesystem: [], shell: [], network: [], environment: [] },
              },
              setup: () => ({
                toolApprovals: [{ toolName: "mcp_docs_write", approval: { mode: "required" } }],
              }),
            }),
          },
        ],
      });
      const pool = createMcpToolRegistryPool();
      const lease = await pool.acquire(agent.mcp);
      try {
        const tool = resolveExecutionTools({
          agent,
          getContext: () => undefined,
          mcpTools: lease.registry.tools,
        }).tools.find((candidate) => candidate.name === "mcp_docs_write")!.tool;
        expect(tool.approval?.mode).toBe("required");
        const options = {
          agent,
          tool,
          toolCallId: "write",
          args: {},
          signal: undefined,
          logger: createPragmaLogger(undefined, { component: "test" }),
          state: {},
        };
        await expect(executeExecutionTool(options)).resolves.toMatchObject({ isError: true });
        expect(call).not.toHaveBeenCalled();
        const handler = vi.fn(async () => ({ kind: "tool_approval" as const, approved: false }));
        await expect(
          executeExecutionTool({ ...options, humanInteractionHandler: handler }),
        ).resolves.toMatchObject({ isError: true });
        expect(call).not.toHaveBeenCalled();
        handler.mockResolvedValueOnce({ kind: "tool_approval", approved: true });
        await expect(
          executeExecutionTool({ ...options, humanInteractionHandler: handler }),
        ).resolves.toMatchObject({ content: [{ type: "text", text: "done" }] });
        expect(call).toHaveBeenCalledTimes(1);
        await expect(
          executeExecutionTool({ ...options, humanInteractionHandler: handler }),
        ).resolves.toMatchObject({ isError: true });
        expect(call).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledTimes(3);
      } finally {
        await lease.release();
        await pool.close();
      }
    },
  );
});
