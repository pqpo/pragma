import type { ExpertAgentStreamEvent } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import { RuntimeMessageAccumulator } from "../src/execution/runtime-message-accumulator.ts";

describe("RuntimeMessageAccumulator", () => {
  it("normalizes thinking, tool calls, tool results, and final text", () => {
    const accumulator = new RuntimeMessageAccumulator({ id: "runtime", kind: "test" });

    expect(
      accumulator.consume(event("thought.delta", { contentType: "text", delta: "check" })),
    ).toEqual([]);
    expect(
      accumulator.consume(
        event("tool.started", {
          toolCallId: "call-1",
          toolName: "clock",
          kind: "tool",
          inputPreview: { zone: "Asia/Shanghai" },
        }),
      ),
    ).toMatchObject([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "check" },
          { type: "toolCall", id: "call-1", name: "clock" },
        ],
      },
    ]);
    expect(
      accumulator.consume(
        event("tool.completed", {
          toolCallId: "call-1",
          toolName: "clock",
          kind: "tool",
          outputPreview: "14:30",
        }),
      ),
    ).toMatchObject([{ role: "toolResult", toolCallId: "call-1", isError: false }]);
    accumulator.consume(
      event("message.delta", { role: "assistant", contentType: "text", delta: "It is 14:30" }),
    );
    expect(
      accumulator.consume(
        event("message.completed", {
          role: "assistant",
          contentType: "text",
          text: "It is 14:30",
        }),
      ),
    ).toMatchObject([{ role: "assistant", content: [{ type: "text", text: "It is 14:30" }] }]);
  });

  it("preserves a Runtime-provided normalized message", () => {
    const accumulator = new RuntimeMessageAccumulator({ id: "runtime", kind: "test" });
    const message = {
      role: "assistant" as const,
      content: [{ type: "thinking" as const, thinking: "", redacted: true }],
      api: "test",
      provider: "runtime",
      model: "model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: 1,
    };
    expect(
      accumulator.consume(
        event("message.completed", {
          role: "assistant",
          contentType: "text",
          message,
        }),
      ),
    ).toEqual([message]);
  });

  it("does not duplicate a tool call already present in a completed Runtime message", () => {
    const accumulator = new RuntimeMessageAccumulator({ id: "pi", kind: "pi" });
    const message = {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "call-1", name: "clock", arguments: {} }],
      api: "pi",
      provider: "pi",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse" as const,
      timestamp: 1,
    };

    expect(
      accumulator.consume(
        event("message.completed", {
          role: "assistant",
          contentType: "text",
          message,
        }),
      ),
    ).toEqual([message]);
    expect(
      accumulator.consume(
        event("tool.started", {
          toolCallId: "call-1",
          toolName: "clock",
          kind: "tool",
          inputPreview: {},
        }),
      ),
    ).toEqual([]);
  });
});

function event<TType extends ExpertAgentStreamEvent["type"]>(
  type: TType,
  payload: Extract<ExpertAgentStreamEvent, { readonly type: TType }>["payload"],
): Extract<ExpertAgentStreamEvent, { readonly type: TType }> {
  return {
    schemaVersion: "pragma.stream/v1",
    eventId: `${type}-event`,
    sequence: 1,
    runId: "run",
    emittedAt: new Date().toISOString(),
    source: { kind: "agent", runId: "run", path: [] },
    type,
    payload,
  } as unknown as Extract<ExpertAgentStreamEvent, { readonly type: TType }>;
}
