import { describe, expect, it } from "vitest";

import { createToolStreamEvents } from "../src/stream.ts";

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
