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
        runId: "run-1",
        source: {
          kind: "tool",
          runId: "run-1",
          toolCallId: "tool-1",
          path: [],
        },
        type: "tool.completed",
        payload: {
          toolCallId: "tool-1",
          toolName: "read",
          kind: "tool",
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
        toolKind: "subagent",
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
        toolKind: "subagent",
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
        toolCallId: "tool-2",
        toolName: "grep",
        kind: "subagent",
        inputPreview: {
          pattern: "Runtime",
        },
      },
    });
  });

  it("maps tool updates to tool.delta instead of message.delta", () => {
    const events = createToolStreamEvents({
      runId: "run-1",
      source: {
        kind: "agent",
        runId: "run-1",
        path: [],
      },
      toolEvent: {
        type: "updated",
        toolCallId: "tool-1",
        toolName: "bash",
        args: {},
        partialResult: "hello",
      },
    });

    expect(events).toMatchObject([
      {
        type: "tool.delta",
        payload: {
          toolCallId: "tool-1",
          toolName: "bash",
          channel: "message",
          delta: "hello",
        },
      },
    ]);
  });
});
