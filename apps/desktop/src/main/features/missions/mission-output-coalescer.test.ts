import type { ExecutionOutputItem } from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMissionOutputCoalescer } from "./mission-output-coalescer.ts";

afterEach(() => vi.useRealTimers());

describe("Mission output coalescer", () => {
  it("emits the first token immediately and combines later deltas at 20 FPS", () => {
    vi.useFakeTimers();
    const emitted: ExecutionOutputItem[] = [];
    const coalescer = createMissionOutputCoalescer({ emit: (item) => emitted.push(item) });

    coalescer.push(output("first", "A"));
    coalescer.push(output("second", "B"));
    coalescer.push(output("third", "C"));

    expect(emitted.map((item) => item.delta)).toEqual(["A"]);
    vi.advanceTimersByTime(49);
    expect(emitted).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(emitted.map((item) => item.delta)).toEqual(["A", "BC"]);
    expect(coalescer.stats()).toMatchObject({ rawItems: 3, emittedItems: 2, coalescedItems: 1 });
  });

  it("flushes text before structural output and on close", () => {
    vi.useFakeTimers();
    const emitted: ExecutionOutputItem[] = [];
    const coalescer = createMissionOutputCoalescer({ emit: (item) => emitted.push(item) });

    coalescer.push(output("first", "A"));
    coalescer.push(output("second", "B"));
    coalescer.push({ ...output("completed", ""), delta: undefined, value: "AB" });
    coalescer.push(output("after", "C"));
    coalescer.push(output("buffered", "D"));
    coalescer.close();

    expect(emitted.map((item) => item.sourceEventId)).toEqual([
      "first",
      "second",
      "completed",
      "after",
      "buffered",
    ]);
  });

  it("bounds a 200 item-per-second stream to approximately 20 emissions per second", () => {
    vi.useFakeTimers();
    const emitted: ExecutionOutputItem[] = [];
    const coalescer = createMissionOutputCoalescer({ emit: (item) => emitted.push(item) });

    for (let index = 0; index < 30_000; index += 1) {
      coalescer.push(output(`event-${index}`, "x"));
      vi.advanceTimersByTime(5);
    }
    coalescer.close();

    expect(emitted).toHaveLength(3_001);
    expect(emitted.reduce((total, item) => total + (item.delta?.length ?? 0), 0)).toBe(30_000);
  });

  it("flushes early when the buffered text reaches its size bound", () => {
    vi.useFakeTimers();
    const emitted: ExecutionOutputItem[] = [];
    const coalescer = createMissionOutputCoalescer({
      emit: (item) => emitted.push(item),
      maxBufferedCharacters: 3,
    });

    coalescer.push(output("first", "A"));
    coalescer.push(output("second", "B"));
    coalescer.push(output("third", "C"));
    coalescer.push(output("fourth", "D"));

    expect(emitted.map((item) => item.delta)).toEqual(["A", "BCD"]);
  });

  it("preserves every raw tool delta boundary", () => {
    vi.useFakeTimers();
    const emitted: ExecutionOutputItem[] = [];
    const coalescer = createMissionOutputCoalescer({ emit: (item) => emitted.push(item) });

    coalescer.push(toolOutput("tool-a-first", "tool-a", '{"text":"A1"}'));
    coalescer.push(toolOutput("tool-a-second", "tool-a", '{"text":"A2"}'));
    coalescer.push(toolOutput("tool-a-third", "tool-a", '{"text":"A3"}'));
    vi.advanceTimersByTime(50);

    expect(
      emitted.map((item) => ({ toolCallId: item.source.toolCallId, delta: item.delta })),
    ).toEqual([
      { toolCallId: "tool-a", delta: '{"text":"A1"}' },
      { toolCallId: "tool-a", delta: '{"text":"A2"}' },
      { toolCallId: "tool-a", delta: '{"text":"A3"}' },
    ]);
  });
});

function output(sourceEventId: string, delta: string): ExecutionOutputItem {
  return {
    sourceEventId,
    executionId: "execution",
    invocationId: "invocation",
    contextId: "context",
    runId: "run",
    source: { kind: "agent", runId: "run", path: [] },
    channel: "thought",
    delta,
    occurredAt: "2026-09-22T00:00:00.000Z",
  };
}

function toolOutput(sourceEventId: string, toolCallId: string, delta: string): ExecutionOutputItem {
  return {
    ...output(sourceEventId, delta),
    source: { kind: "tool", runId: "run", toolCallId, path: [] },
    channel: "tool",
  };
}
