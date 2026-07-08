import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ExpertAgent } from "@pragma/core";
import { createMcpToolRegistry } from "@pragma/core";
import { createCodexWorkflowToolsMcpServer } from "../src/workflow-tools-mcp-server.ts";
import type { ExpertAgentPluginHooks } from "@pragma/core";
import type {
  ExpertAgentManagedTool,
  ExpertAgentToolCallResult,
} from "@pragma/core";

describe("createCodexWorkflowToolsMcpServer", () => {
  it("exposes context and managed tools over HTTP MCP", async () => {
    const agent = await createTestAgent({
      tools: [
        {
          name: "echo_note",
          description: "Echo a note.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
            additionalProperties: false,
          },
          call: async (args) => ({
            text: isRecord(args) && typeof args.text === "string" ? args.text : "",
          }),
        },
      ],
    });
    const server = await createCodexWorkflowToolsMcpServer({
      agent,
      getContext: () => undefined,
      logger: agent.logger,
      state: {},
    });
    const registry = await createMcpToolRegistry({
      mcpServers: {
        [server.id]: {
          name: server.name,
          url: server.url,
        },
      },
    });

    try {
      expect(registry.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["askUserQuestion", "list_expert_context", "echo_note"]),
      );

      const result = await registry.tools
        .find((tool) => tool.name === "echo_note")
        ?.call({ text: "hello" }, undefined);

      expect(readTextContent(result)).toBe("hello");
    } finally {
      await registry.dispose();
      await server.dispose();
    }
  });

  it("applies approval denial and tool hooks", async () => {
    const call = vi.fn(async () => ({
      text: "deleted",
    }));
    const hookEvents: string[] = [];
    const agent = await createTestAgent({
      tools: [
        {
          name: "delete_note",
          description: "Delete a note.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
            additionalProperties: false,
          },
          approval: {
            mode: "required",
            reason: "Delete needs approval.",
          },
          call,
        },
      ],
      hooks: {
        beforeToolCall: () => {
          hookEvents.push("before");
        },
        afterToolCall: (context) => {
          hookEvents.push(context.result === undefined ? "after-error" : "after-result");
        },
      },
    });
    const server = await createCodexWorkflowToolsMcpServer({
      agent,
      getContext: () => undefined,
      humanInteractionHandler: async () => ({
        kind: "tool_approval",
        approved: false,
        reason: "Denied.",
      }),
      logger: agent.logger,
      state: {},
    });
    const registry = await createMcpToolRegistry({
      mcpServers: {
        [server.id]: {
          name: server.name,
          url: server.url,
        },
      },
    });

    try {
      const result = await registry.tools
        .find((tool) => tool.name === "delete_note")
        ?.call({ path: "note.md" }, undefined);

      expect(readTextContent(result)).toBe("Denied.");
      expect(isRecord(result) ? result.isError : undefined).toBe(true);
      expect(call).not.toHaveBeenCalled();
      expect(hookEvents).toEqual(["before", "after-result"]);
    } finally {
      await registry.dispose();
      await server.dispose();
    }
  });

  it("passes approval-updated input to the managed tool", async () => {
    const call = vi.fn(async (args: unknown) => ({
      text: JSON.stringify(args),
    }));
    const agent = await createTestAgent({
      tools: [
        {
          name: "write_note",
          description: "Write a note.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
            additionalProperties: false,
          },
          approval: {
            mode: "required",
          },
          call,
        },
      ],
    });
    const server = await createCodexWorkflowToolsMcpServer({
      agent,
      getContext: () => undefined,
      humanInteractionHandler: async () => ({
        kind: "tool_approval",
        approved: true,
        updatedInput: {
          path: "approved.md",
        },
      }),
      logger: agent.logger,
      state: {},
    });
    const registry = await createMcpToolRegistry({
      mcpServers: {
        [server.id]: {
          name: server.name,
          url: server.url,
        },
      },
    });

    try {
      await registry.tools
        .find((tool) => tool.name === "write_note")
        ?.call({ path: "original.md" }, undefined);

      expect(call).toHaveBeenCalledWith(
        {
          path: "approved.md",
        },
        expect.any(AbortSignal),
        expect.objectContaining({
          humanInteraction: expect.any(Function),
          runContext: undefined,
        }),
      );
    } finally {
      await registry.dispose();
      await server.dispose();
    }
  });

  it("allows ask approval tools when no human handler is configured", async () => {
    const call = vi.fn(async () => ({
      text: "previewed",
    }));
    const agent = await createTestAgent({
      tools: [
        {
          name: "preview_note",
          description: "Preview a note.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
            additionalProperties: false,
          },
          approval: {
            mode: "ask",
            reason: "Preview can be confirmed when an interactive UI is available.",
          },
          call,
        },
      ],
    });
    const server = await createCodexWorkflowToolsMcpServer({
      agent,
      getContext: () => undefined,
      logger: agent.logger,
      state: {},
    });
    const registry = await createMcpToolRegistry({
      mcpServers: {
        [server.id]: {
          name: server.name,
          url: server.url,
        },
      },
    });

    try {
      const result = await registry.tools
        .find((tool) => tool.name === "preview_note")
        ?.call({ path: "note.md" }, undefined);

      expect(readTextContent(result)).toBe("previewed");
      expect(isRecord(result) ? result.isError : undefined).toBeUndefined();
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      await registry.dispose();
      await server.dispose();
    }
  });
});

async function createTestAgent(options: {
  readonly tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[];
  readonly hooks?: ExpertAgentPluginHooks | undefined;
}): Promise<ExpertAgent> {
  return await ExpertAgent.create({
    id: "codex-workflow-tools-test",
    name: "Codex Workflow Tools Test",
    description: "Agent used to test Codex workflow tools MCP server.",
    tags: [],
    version: "0.0.0",
    scope: "test",
    workspace: await mkdtemp(join(tmpdir(), "pragma-codex-tools-mcp-test-")),
    memory: false,
    tools: options.tools,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
}

function readTextContent(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return undefined;
  }

  const [first] = result.content;
  return isRecord(first) && typeof first.text === "string" ? first.text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
