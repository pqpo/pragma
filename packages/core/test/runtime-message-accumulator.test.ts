import type { ExpertAgentStreamEvent } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import { RuntimeMessageAccumulator } from "../src/execution/runtime-message-accumulator.ts";

describe("RuntimeMessageAccumulator", () => {
  it("keeps tool content typed and Host details outside the historical body", () => {
    const accumulator = new RuntimeMessageAccumulator({ id: "pi", kind: "pi" });
    const content = [
      { type: "text", text: '{"invocationId":"task-marker","status":"queued"}' },
      { type: "image", data: "image-bytes", mimeType: "image/png" },
      { type: "text", text: "Host follow-up hint" },
    ];
    const details = { invocationId: "task-marker", hostOnly: "host-marker" };
    const preview = { content, details, isError: false };
    const [message] = accumulator.consume(
      event("tool.completed", {
        toolCallId: "call",
        toolName: "inspect",
        kind: "tool",
        outputPreview: preview,
      }),
    );
    if (message?.role !== "toolResult") throw new Error("Expected a tool result message");
    expect(message).toMatchObject({ role: "toolResult", content, details, isError: false });
    expect(JSON.stringify(message.content).match(/task-marker/g)).toHaveLength(1);
    expect(JSON.stringify(message.content)).not.toContain("host-marker");
    expect(preview).toEqual({ content, details, isError: false });
  });

  it.each([
    undefined,
    "plain output",
    { result: { value: 7 }, details: "business data" },
    { content: [{ type: "text", text: "Summary" }], structuredContent: { value: 7 } },
    { content: [{ type: "text", text: "Summary" }], report: "Additional business data" },
  ])("retains non-envelope tool output: %j", (outputPreview) => {
    const [message] = new RuntimeMessageAccumulator({ id: "runtime", kind: "test" }).consume(
      event("tool.completed", {
        toolCallId: "call",
        toolName: "read",
        kind: "tool",
        outputPreview,
      }),
    );
    if (message?.role !== "toolResult") throw new Error("Expected a tool result message");
    expect(message.content).toEqual([
      {
        type: "text",
        text:
          typeof outputPreview === "string" ? outputPreview : (JSON.stringify(outputPreview) ?? ""),
      },
    ]);
  });

  it("retains unsupported historical content as text without serializing its envelope", () => {
    const block = {
      type: "resource",
      resource: { uri: "file:///report.txt", text: "Report body" },
    };
    const [message] = new RuntimeMessageAccumulator({ id: "runtime", kind: "test" }).consume(
      event("tool.completed", {
        toolCallId: "call",
        toolName: "read",
        kind: "tool",
        outputPreview: { content: [block], details: null, isError: true },
      }),
    );
    if (message?.role !== "toolResult") throw new Error("Expected a tool result message");
    expect(message).toMatchObject({ isError: true, details: null });
    expect(message.content).toEqual([
      { type: "text", text: `[Tool content rendered as text: resource]\n${JSON.stringify(block)}` },
    ]);
  });

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
        measurement: "reported" as const,
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
        measurement: "reported" as const,
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
