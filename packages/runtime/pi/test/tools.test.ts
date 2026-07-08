import { ExpertAgent } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { createCustomTools } from "../src/tools.ts";
import type { PiRuntimeStreamState } from "../src/types.ts";

describe("createCustomTools approval handling", () => {
  it("dispatches afterToolCall when approval is denied", async () => {
    const hookEvents: string[] = [];
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "agent-1",
      name: "Test Agent",
      description: "Test agent",
      tags: [],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/pragma-test",
      tools: [
        {
          name: "delete_note",
          description: "Delete a note.",
          inputSchema: { type: "object" },
          approval: {
            mode: "required",
            reason: "Delete needs approval.",
          },
          call: vi.fn(async () => ({
            text: "deleted",
          })),
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
    const emitted: unknown[] = [];
    const tools = createCustomTools({
      agent,
      authStorage: {} as never,
      cwd: "/tmp/pragma-test",
      mcpTools: [],
      modelRegistry: { getAll: () => [] } as never,
      parentSystemPrompt: "",
      lifecycle: {
        currentContext: undefined,
      } as never,
      streamState: {
        runId: "run-1",
        source: {
          kind: "agent",
          runId: "run-1",
          path: [{ runId: "run-1" }],
        },
        emitter: {
          emit: (event) => {
            emitted.push(event);
          },
          complete: () => {},
        },
      } satisfies PiRuntimeStreamState,
      humanInteractionHandler: async () => ({
        kind: "tool_approval",
        approved: false,
        reason: "Denied.",
      }),
    });

    const result = await tools
      .find((tool) => tool.name === "delete_note")
      ?.execute("tool-call-1", { path: "note.md" }, undefined, undefined, createExtensionContext());

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Denied." }],
    });
    expect(hookEvents).toEqual(["before", "after-result"]);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "tool.approval_requested",
        source: expect.objectContaining({
          kind: "tool",
          runId: "run-1",
          toolCallId: "tool-call-1",
          path: [{ runId: "run-1" }],
        }),
      }),
    );
  });

  it("passes updated approval input to the managed tool", async () => {
    const call = vi.fn(async (args: unknown) => ({
      text: JSON.stringify(args),
    }));
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "agent-1",
      name: "Test Agent",
      description: "Test agent",
      tags: [],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/pragma-test",
      tools: [
        {
          name: "write_note",
          description: "Write a note.",
          inputSchema: { type: "object" },
          approval: {
            mode: "required",
          },
          call,
        },
      ],
    });
    const tools = createCustomTools({
      agent,
      authStorage: {} as never,
      cwd: "/tmp/pragma-test",
      mcpTools: [],
      modelRegistry: { getAll: () => [] } as never,
      parentSystemPrompt: "",
      lifecycle: {
        currentContext: undefined,
      } as never,
      streamState: {},
      humanInteractionHandler: async () => ({
        kind: "tool_approval",
        approved: true,
        updatedInput: {
          path: "approved.md",
        },
      }),
    });

    await tools
      .find((tool) => tool.name === "write_note")
      ?.execute(
        "tool-call-1",
        { path: "original.md" },
        undefined,
        undefined,
        createExtensionContext(),
      );

    expect(call).toHaveBeenCalledWith(
      {
        path: "approved.md",
      },
      undefined,
      {
        toolCallId: "tool-call-1",
        humanInteraction: expect.any(Function),
      },
    );
  });

  it("allows ask approval tools when no human handler is configured", async () => {
    const call = vi.fn(async () => ({
      text: "previewed",
    }));
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "agent-1",
      name: "Test Agent",
      description: "Test agent",
      tags: [],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/pragma-test",
      tools: [
        {
          name: "preview_note",
          description: "Preview a note.",
          inputSchema: { type: "object" },
          approval: {
            mode: "ask",
            reason: "Preview can be confirmed when an interactive UI is available.",
          },
          call,
        },
      ],
    });
    const emitted: unknown[] = [];
    const tools = createCustomTools({
      agent,
      authStorage: {} as never,
      cwd: "/tmp/pragma-test",
      mcpTools: [],
      modelRegistry: { getAll: () => [] } as never,
      parentSystemPrompt: "",
      lifecycle: {
        currentContext: undefined,
      } as never,
      streamState: {
        runId: "run-1",
        emitter: {
          emit: (event) => {
            emitted.push(event);
          },
          complete: () => {},
        },
      } satisfies PiRuntimeStreamState,
    });

    const result = await tools
      .find((tool) => tool.name === "preview_note")
      ?.execute("tool-call-1", { path: "note.md" }, undefined, undefined, createExtensionContext());

    expect(result).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "previewed" }],
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([]);
  });

  it("only requests approval when the tool approval condition matches", async () => {
    const call = vi.fn(async () => ({
      text: "ran",
    }));
    const humanInteractionHandler = vi.fn(async () => ({
      kind: "tool_approval" as const,
      approved: true,
    }));
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "agent-1",
      name: "Test Agent",
      description: "Test agent",
      tags: [],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/pragma-test",
      tools: [
        {
          name: "bash",
          description: "Run a shell command.",
          inputSchema: { type: "object" },
          approval: {
            mode: "required",
            reason: "Shell command may delete files.",
            when: ({ input }) =>
              typeof input === "object" &&
              input !== null &&
              "command" in input &&
              typeof input.command === "string" &&
              /\brm\b/.test(input.command),
          },
          call,
        },
      ],
    });
    const emitted: unknown[] = [];
    const tools = createCustomTools({
      agent,
      authStorage: {} as never,
      cwd: "/tmp/pragma-test",
      mcpTools: [],
      modelRegistry: { getAll: () => [] } as never,
      parentSystemPrompt: "",
      lifecycle: {
        currentContext: undefined,
      } as never,
      streamState: {
        runId: "run-1",
        emitter: {
          emit: (event) => {
            emitted.push(event);
          },
          complete: () => {},
        },
      } satisfies PiRuntimeStreamState,
      humanInteractionHandler,
    });

    await tools
      .find((tool) => tool.name === "bash")
      ?.execute(
        "tool-call-1",
        { command: "ls -la" },
        undefined,
        undefined,
        createExtensionContext(),
      );
    await tools
      .find((tool) => tool.name === "bash")
      ?.execute(
        "tool-call-2",
        { command: "rm -rf tmp" },
        undefined,
        undefined,
        createExtensionContext(),
      );

    expect(call).toHaveBeenCalledTimes(2);
    expect(humanInteractionHandler).toHaveBeenCalledTimes(1);
    expect(humanInteractionHandler).toHaveBeenCalledWith({
      kind: "tool_approval",
      toolName: "bash",
      toolCallId: "tool-call-2",
      reason: "Shell command may delete files.",
      input: { command: "rm -rf tmp" },
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "tool.approval_requested",
      payload: {
        toolName: "bash",
        toolCallId: "tool-call-2",
      },
    });
  });
});

function createExtensionContext() {
  return {} as never;
}
