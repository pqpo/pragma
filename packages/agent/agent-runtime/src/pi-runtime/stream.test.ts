import { describe, expect, it } from "vitest";

import { createToolStreamEvents } from "./stream.ts";

describe("createToolStreamEvents", () => {
  it("maps tool completion events onto the active run source", () => {
    const events = createToolStreamEvents({
      runId: "run-1",
      source: {
        kind: "agent",
        runId: "run-1",
        path: [],
      },
      sequence: createTestSequence(),
      toolEvent: {
        type: "completed",
        toolCallId: "tool-1",
        toolName: "read",
        result: {
          content: [{ type: "text", text: "file content" }],
        },
        isError: false,
      },
    });

    expect(events).toMatchObject([
      {
        sequence: 0,
        runId: "run-1",
        source: {
          kind: "tool",
          runId: "run-1",
          toolCallId: "tool-1",
          path: [],
        },
        type: "tool.completed",
        payload: {
          toolName: "read",
        },
      },
      {
        sequence: 1,
        runId: "run-1",
        source: {
          kind: "tool",
          runId: "run-1",
          toolCallId: "tool-1",
          path: [],
        },
        type: "message.completed",
        payload: {
          role: "tool",
          contentType: "text",
          text: "file content",
        },
      },
    ]);
  });

  it("preserves subagent parent metadata on nested tool output", () => {
    const events = createToolStreamEvents({
      runId: "child-1",
      parentRunId: "parent-1",
      source: {
        kind: "subagent",
        runId: "child-1",
        parentRunId: "parent-1",
        agentType: "reviewer",
        toolCallId: "launch-1",
        path: [
          {
            runId: "parent-1",
          },
          {
            runId: "child-1",
            agentType: "reviewer",
          },
        ],
      },
      sequence: createTestSequence(),
      toolEvent: {
        type: "started",
        toolCallId: "tool-2",
        toolName: "grep",
        args: {
          pattern: "Runtime",
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      runId: "child-1",
      parentRunId: "parent-1",
      source: {
        kind: "tool",
        runId: "child-1",
        parentRunId: "parent-1",
        agentType: "reviewer",
        toolCallId: "tool-2",
        path: [
          {
            runId: "parent-1",
          },
          {
            runId: "child-1",
            agentType: "reviewer",
          },
        ],
      },
      type: "tool.started",
      payload: {
        toolName: "grep",
        inputPreview: {
          pattern: "Runtime",
        },
      },
    });
  });
});

function createTestSequence(): () => number {
  let sequence = 0;

  return () => sequence++;
}
