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
  IExpertAgentMcpConfig,
  ExpertAgentToolCallResult,
} from "@pragma/core";

describe("createCodexWorkflowToolsMcpServer", () => {
  it("exposes context, managed, and user MCP tools over HTTP MCP", async () => {
    const agent = await createTestAgent({
      mcp: {
        mcpServers: {
          docs: {
            name: "Docs MCP",
            inProcess: {
              listTools: async () => [
                {
                  name: "lookup",
                  description: "Lookup docs.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      query: { type: "string" },
                    },
                    required: ["query"],
                    additionalProperties: false,
                  },
                },
              ],
              callTool: async (_name, args) => ({
                content: [
                  {
                    type: "text",
                    text: isRecord(args) && typeof args.query === "string" ? args.query : "",
                  },
                ],
              }),
            },
          },
        },
      },
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
    const userMcpRegistry = await createMcpToolRegistry(agent.mcp);
    const server = await createCodexWorkflowToolsMcpServer({
      agent,
      getContext: () => undefined,
      logger: agent.logger,
      mcpTools: userMcpRegistry.tools,
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
        expect.arrayContaining([
          "askUserQuestion",
          "request_tool_approval",
          "list_expert_context",
          "echo_note",
          "mcp_docs_lookup",
        ]),
      );

      const result = await registry.tools
        .find((tool) => tool.name === "echo_note")
        ?.call({ text: "hello" }, undefined);
      const mcpResult = await registry.tools
        .find((tool) => tool.name === "mcp_docs_lookup")
        ?.call({ query: "context" }, undefined);

      expect(readTextContent(result)).toBe("hello");
      expect(readTextContent(mcpResult)).toBe("context");
    } finally {
      await registry.dispose();
      await server.dispose();
      await userMcpRegistry.dispose();
    }
  });

  it("bridges runtime permission prompt tools to the human interaction handler", async () => {
    const requests: unknown[] = [];
    const events: unknown[] = [];
    const agent = await createTestAgent({
      tools: [],
    });
    const server = await createCodexWorkflowToolsMcpServer({
      agent,
      getContext: () => undefined,
      humanInteractionHandler: async (request) => {
        requests.push(request);
        return {
          kind: "tool_approval",
          approved: true,
          updatedInput: {
            command: "echo patched",
          },
        };
      },
      logger: agent.logger,
      state: {
        runId: "run-1",
        emitter: {
          emit: (event) => {
            events.push(event);
          },
          complete: () => undefined,
        },
      },
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
        .find((tool) => tool.name === "request_tool_approval")
        ?.call(
          {
            toolName: "Bash",
            toolCallId: "tool-1",
            input: {
              command: "echo hello",
            },
          },
          undefined,
        );

      expect(requests).toEqual([
        {
          kind: "tool_approval",
          toolName: "Bash",
          toolCallId: "tool-1",
          reason: "Runtime requested tool approval.",
          input: {
            command: "echo hello",
          },
        },
      ]);
      expect(events).toEqual([
        expect.objectContaining({
          runId: "run-1",
          type: "tool.approval_requested",
          payload: expect.objectContaining({
            toolCallId: "tool-1",
            toolName: "Bash",
            kind: "tool",
            reason: "Runtime requested tool approval.",
            inputPreview: {
              command: "echo hello",
            },
          }),
        }),
      ]);
      expect(readTextContent(result)).toBe(
        JSON.stringify({
          behavior: "allow",
          updatedInput: {
            command: "echo patched",
          },
        }),
      );
      expect(isRecord(result) ? result.structuredContent : undefined).toEqual({
        behavior: "allow",
        updatedInput: {
          command: "echo patched",
        },
      });
    } finally {
      await registry.dispose();
      await server.dispose();
    }
  });

  it("lets runtime permission prompts pass through for Pragma workflow tools", async () => {
    const requests: unknown[] = [];
    const events: unknown[] = [];
    const agent = await createTestAgent({
      tools: [],
    });
    const server = await createCodexWorkflowToolsMcpServer({
      agent,
      getContext: () => undefined,
      humanInteractionHandler: async (request) => {
        requests.push(request);
        return {
          kind: "tool_approval",
          approved: false,
          reason: "Should not ask for workflow MCP tools.",
        };
      },
      logger: agent.logger,
      state: {
        runId: "run-1",
        emitter: {
          emit: (event) => {
            events.push(event);
          },
          complete: () => undefined,
        },
      },
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
        .find((tool) => tool.name === "request_tool_approval")
        ?.call(
          {
            toolName: "mcp__pragma__search_expert_context",
            toolCallId: "tool-1",
            input: {
              query: "runtime",
            },
          },
          undefined,
        );

      expect(requests).toEqual([]);
      expect(events).toEqual([]);
      expect(readTextContent(result)).toBe(
        JSON.stringify({
          behavior: "allow",
          updatedInput: {
            query: "runtime",
          },
        }),
      );
      expect(isRecord(result) ? result.structuredContent : undefined).toEqual({
        behavior: "allow",
        updatedInput: {
          query: "runtime",
        },
      });
    } finally {
      await registry.dispose();
      await server.dispose();
    }
  });

  it("keeps runtime permission prompt tools available under tool allowlists", async () => {
    const agent = await createTestAgent({
      tools: [
        {
          name: "echo_note",
          description: "Echo a note.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          call: async () => ({
            text: "ok",
          }),
        },
      ],
    });
    const server = await createCodexWorkflowToolsMcpServer({
      agent,
      getContext: () => ({
        attributes: {
          toolPolicy: {
            mode: "allow",
            allowedTools: ["echo_note"],
          },
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
      const toolNames = registry.tools.map((tool) => tool.name);

      expect(toolNames).toContain("request_tool_approval");
      expect(toolNames).toContain("echo_note");
      expect(toolNames).not.toContain("askUserQuestion");
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
  readonly mcp?: IExpertAgentMcpConfig | undefined;
}): Promise<ExpertAgent> {
  return await ExpertAgent.create({
    id: "codex-workflow-tools-test",
    name: "Codex Workflow Tools Test",
    description: "Agent used to test Codex workflow tools MCP server.",
    tags: [],
    version: "0.0.0",
    scope: "test",
    workspace: await mkdtemp(join(tmpdir(), "pragma-codex-tools-mcp-test-")),
    tools: options.tools,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
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
