import type { ExecutionOutputItem } from "@pragma/core";
import { describe, expect, it } from "vitest";

import { ExecutionOutputAccumulator } from "../src/console/execution-output-accumulator.ts";

describe("ExecutionOutputAccumulator", () => {
  it("normalizes answer, thinking, progress, and completed-message fallback", () => {
    const accumulator = new ExecutionOutputAccumulator({ includeRoutineProgress: false });

    expect(accumulator.consume(output("thought", "Considering "))).toEqual([
      { kind: "thinking", text: "Considering ", append: true },
    ]);
    expect(accumulator.consume(output("message", "the answer"))).toEqual([
      { kind: "answer", text: "the answer", append: true },
    ]);
    expect(
      accumulator.consume(
        outputValue("message", { content: [{ type: "text", text: "duplicate" }] }),
      ),
    ).toEqual([]);
    expect(
      accumulator.consume(outputValue("progress", { stage: "turn.start", message: "Starting" })),
    ).toEqual([]);
    expect(
      accumulator.consume(outputValue("progress", { stage: "context.load", message: "Ready" })),
    ).toEqual([{ kind: "progress", text: "context.load — Ready", append: false }]);

    const completedOnly = new ExecutionOutputAccumulator();
    expect(completedOnly.consume(outputValue("message", "completed answer"))).toEqual([
      { kind: "answer", text: "completed answer", append: false },
    ]);
    expect(completedOnly.consume(outputValue("result", "completed answer"))).toEqual([]);
  });

  it("does not let an empty message delta suppress the completed-message fallback", () => {
    const accumulator = new ExecutionOutputAccumulator();

    expect(accumulator.consume(output("message", ""))).toEqual([]);
    expect(accumulator.consume(outputValue("message", "completed answer"))).toEqual([
      { kind: "answer", text: "completed answer", append: false },
    ]);
  });

  it("deduplicates cumulative tool output and unwraps structured Runtime deltas", () => {
    const accumulator = new ExecutionOutputAccumulator();
    expect(
      accumulator.consume(
        outputValue("tool", {
          toolCallId: "call-1",
          toolName: "search",
          inputPreview: { query: "Pragma" },
        }),
      ),
    ).toEqual([
      {
        kind: "tool",
        text: '→ search\n{\n  "query": "Pragma"\n}',
        append: false,
      },
    ]);
    expect(accumulator.consume(output("tool", "first"))).toEqual([
      { kind: "tool-output", text: "first", append: true },
    ]);
    expect(accumulator.consume(output("tool", "first result"))).toEqual([
      { kind: "tool-output", text: " result", append: true },
    ]);
    expect(
      accumulator.consume(
        output("tool", JSON.stringify({ content: [{ type: "text", text: "structured output" }] })),
      ),
    ).toEqual([{ kind: "tool-output", text: "structured output", append: true }]);
    expect(
      accumulator.consume(
        outputValue("tool", {
          toolCallId: "call-1",
          toolName: "search",
          outputPreview: "first result",
        }),
      ),
    ).toEqual([{ kind: "tool", text: "✓ search completed", append: false }]);
  });

  it("uses the completion preview when a tool produced no output deltas", () => {
    const accumulator = new ExecutionOutputAccumulator();
    accumulator.consume(outputValue("tool", { toolCallId: "call-2", toolName: "clock" }));

    expect(
      accumulator.consume(
        outputValue("tool", {
          toolCallId: "call-2",
          toolName: "clock",
          outputPreview: "10:30 +08:00",
        }),
      ),
    ).toEqual([
      { kind: "tool", text: "✓ clock completed", append: false },
      { kind: "tool-output", text: "10:30 +08:00", append: false },
    ]);
  });

  it("does not repeat the completion preview when tool output arrives before its start event", () => {
    const accumulator = new ExecutionOutputAccumulator();

    expect(accumulator.consume(output("tool", "streamed output"))).toEqual([
      { kind: "tool-output", text: "streamed output", append: true },
    ]);
    expect(
      accumulator.consume(
        outputValue("tool", {
          toolCallId: "call-3",
          toolName: "search",
          outputPreview: "streamed output",
        }),
      ),
    ).toEqual([{ kind: "tool", text: "✓ search completed", append: false }]);
  });
});

function output(channel: ExecutionOutputItem["channel"], delta: string): ExecutionOutputItem {
  return {
    sourceEventId: `${channel}-${delta}`,
    executionId: "execution",
    invocationId: "invocation",
    executorId: "expert",
    contextId: "context",
    runId: "run",
    source: { kind: "agent", runId: "run", path: [] },
    channel,
    delta,
    occurredAt: new Date().toISOString(),
  };
}

function outputValue(channel: ExecutionOutputItem["channel"], value: unknown): ExecutionOutputItem {
  return { ...output(channel, ""), delta: undefined, value };
}
