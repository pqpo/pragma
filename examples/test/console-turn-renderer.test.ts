import { describe, expect, it } from "vitest";

import { ConsoleTurnRenderer } from "../src/console/console-turn-renderer.ts";

describe("ConsoleTurnRenderer", () => {
  it("renders thinking, tool calls, and assistant output as distinct sections", () => {
    let output = "";
    const renderer = new ConsoleTurnRenderer({
      color: false,
      output: { write: (text) => (output += text) },
    });

    renderer.render({ type: "runtime.thought.delta", payload: { delta: "Checking context..." } });
    renderer.render({
      type: "runtime.tool.started",
      payload: { toolCallId: "tool-1", toolName: "get_current_time", inputPreview: {} },
    });
    renderer.render({
      type: "runtime.tool.completed",
      payload: {
        toolCallId: "tool-1",
        toolName: "get_current_time",
        outputPreview: "2026-07-12T10:00:00.000Z",
      },
    });
    renderer.render({ type: "runtime.message.delta", payload: { delta: "现在是 18:00。" } });
    renderer.complete("现在是 18:00。");

    expect(output).toContain("• Thinking\nChecking context...");
    expect(output).toContain("• Running get_current_time");
    expect(output).not.toContain("↳ {}");
    expect(output).toContain("✓ get_current_time completed");
    expect(output).toContain("• Expert\n现在是 18:00。");
    expect(output.match(/现在是 18:00。/gu)).toHaveLength(1);
  });

  it("falls back to the final result when no message event was emitted", () => {
    let output = "";
    const renderer = new ConsoleTurnRenderer({
      color: false,
      output: { write: (text) => (output += text) },
    });

    renderer.complete({ answer: 42 });

    expect(output).toContain('• Expert\n{\n  "answer": 42\n}');
  });

  it("makes an empty Runtime result visible", () => {
    let output = "";
    const renderer = new ConsoleTurnRenderer({
      color: false,
      output: { write: (text) => (output += text) },
    });

    renderer.complete("");

    expect(output).toContain("! Empty response — The Runtime returned no output.");
  });

  it("does not repeat a completed message after streaming deltas", () => {
    let output = "";
    const renderer = new ConsoleTurnRenderer({
      color: false,
      output: { write: (text) => (output += text) },
    });

    renderer.render({ type: "runtime.message.delta", payload: { delta: "hello" } });
    renderer.render({ type: "runtime.message.completed", payload: { text: "hello" } });
    renderer.complete("hello");

    expect(output.match(/hello/gu)).toHaveLength(1);
  });

});
