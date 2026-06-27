import { ExpertAgent } from "@expertmesh/agent-core";
import { describe, expect, it, vi } from "vitest";

import { createCustomTools } from "../../src/pi-runtime/tools.ts";
import type { PiRuntimeStreamState } from "../../src/pi-runtime/types.ts";

describe("createCustomTools approval handling", () => {
  it("dispatches afterToolCall when approval is denied", async () => {
    const hookEvents: string[] = [];
    const agent = await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "agent-1",
      displayName: "Test Agent",
      description: "Test agent",
      tags: [],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/expertmesh-test",
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
      cwd: "/tmp/expertmesh-test",
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
      context: {
        attributes: {
          toolApprovalHandler: async () => ({
            approved: false,
            reason: "Denied.",
          }),
        },
      },
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
      schemaVersion: "expertmesh.expert/v1",
      id: "agent-1",
      displayName: "Test Agent",
      description: "Test agent",
      tags: [],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/expertmesh-test",
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
      cwd: "/tmp/expertmesh-test",
      mcpTools: [],
      modelRegistry: { getAll: () => [] } as never,
      parentSystemPrompt: "",
      lifecycle: {
        currentContext: undefined,
      } as never,
      streamState: {},
      context: {
        attributes: {
          toolApprovalHandler: async () => ({
            approved: true,
            updatedInput: {
              path: "approved.md",
            },
          }),
        },
      },
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
        approval: expect.any(Function),
      },
    );
  });
});

function createExtensionContext() {
  return {} as never;
}
