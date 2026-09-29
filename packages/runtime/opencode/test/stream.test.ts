import { describe, expect, it } from "vitest";
import { OpenCodeStream, type OpenCodeStreamEvent } from "../src/stream.ts";

describe("OpenCode stream normalization", () => {
  it("routes 1.x text-field deltas by part type and does not append full snapshots again", () => {
    const stream = new OpenCodeStream();
    const events: OpenCodeStreamEvent[] = [];
    const emit = (type: string, data: Record<string, unknown>) =>
      events.push(...stream.consume({ type, data }));
    emit("message.updated", { info: { id: "user", role: "user" } });
    emit("message.part.updated", {
      part: { id: "input", messageID: "user", type: "text", text: "User prompt" },
    });
    emit("message.updated", { info: { id: "answer", role: "assistant" } });
    emit("message.part.updated", {
      part: { id: "thinking", messageID: "answer", type: "reasoning", text: "" },
    });
    emit("message.part.delta", { partID: "thinking", field: "text", delta: "Think once." });
    emit("message.part.updated", {
      part: {
        id: "thinking",
        messageID: "answer",
        type: "reasoning",
        text: "Think once.",
        time: { end: 1 },
      },
    });
    emit("message.part.updated", {
      part: { id: "text", messageID: "answer", type: "text", text: "" },
    });
    emit("message.part.delta", { partID: "text", field: "text", delta: "Hello" });
    emit("message.part.updated", {
      part: { id: "text", messageID: "answer", type: "text", text: "Hello" },
    });
    emit("message.part.updated", {
      part: {
        id: "text",
        messageID: "answer",
        type: "text",
        text: "Hello world.",
        time: { end: 2 },
      },
    });
    emit("message.part.updated", {
      part: {
        id: "text",
        messageID: "answer",
        type: "text",
        text: "Hello world.",
        time: { end: 2 },
      },
    });
    emit("message.part.delta", { partID: "text", field: "text", delta: " stale" });
    events.push(...stream.finish("Hello world."));
    expect(events).toEqual([
      { kind: "thought-delta", text: "Think once." },
      { kind: "message-delta", text: "Hello" },
      { kind: "message-delta", text: " world." },
      { kind: "message-completed", text: "Hello world.", final: true, thinking: "Think once." },
    ]);
  });

  it("closes an assistant segment before tools and settles each 1.x tool exactly once", () => {
    const stream = new OpenCodeStream();
    stream.consume({ type: "message.updated", data: { info: { id: "first", role: "assistant" } } });
    expect(
      stream.consume({
        type: "message.part.updated",
        data: { part: { id: "pre", messageID: "first", type: "text", text: "Before tool." } },
      }),
    ).toEqual([{ kind: "message-delta", text: "Before tool." }]);
    const terminal = {
      type: "message.part.updated",
      data: {
        part: {
          messageID: "first",
          type: "tool",
          callID: "tool",
          tool: "context",
          state: { status: "completed", input: { query: "test" }, output: "result" },
        },
      },
    };
    expect(stream.consume(terminal)).toEqual([
      { kind: "message-completed", text: "Before tool.", final: false },
      { kind: "tool-started", id: "tool", name: "context", value: { query: "test" } },
      { kind: "tool-completed", id: "tool", name: "context", value: "result" },
    ]);
    expect(stream.consume(terminal)).toEqual([]);
    stream.consume({
      type: "message.updated",
      data: { info: { id: "second", role: "assistant" } },
    });
    expect(
      stream.consume({
        type: "message.part.updated",
        data: {
          part: {
            id: "post",
            messageID: "second",
            type: "text",
            text: "After tool.",
            time: { end: 1 },
          },
        },
      }),
    ).toEqual([{ kind: "message-delta", text: "After tool." }]);
    expect(stream.finish("After tool.")).toEqual([
      { kind: "message-completed", text: "After tool.", final: true },
    ]);
  });

  it("uses 2.x ended snapshots to fill missing tails without removing legitimate repeated deltas", () => {
    const stream = new OpenCodeStream();
    const data = { assistantMessageID: "first", ordinal: 0 };
    expect(
      stream.consume({ type: "session.reasoning.delta", data: { ...data, delta: "Think." } }),
    ).toEqual([{ kind: "thought-delta", text: "Think." }]);
    expect(
      stream.consume({ type: "session.reasoning.ended", data: { ...data, text: "Think." } }),
    ).toEqual([]);
    stream.consume({ type: "session.text.delta", data: { ...data, delta: "ha" } });
    stream.consume({ type: "session.text.delta", data: { ...data, delta: "ha" } });
    const ended = { type: "session.text.ended", data: { ...data, text: "haha!" } };
    expect(stream.consume(ended)).toEqual([{ kind: "message-delta", text: "!" }]);
    expect(stream.consume(ended)).toEqual([]);
    expect(
      stream.consume({ type: "session.text.delta", data: { ...data, delta: "late" } }),
    ).toEqual([]);
    expect(stream.finish("haha!")).toEqual([
      { kind: "message-completed", text: "haha!", final: true, thinking: "Think." },
    ]);
  });

  it("keeps distinct 2.x messages with identical text and parallel tools in native order", () => {
    const stream = new OpenCodeStream();
    stream.consume({
      type: "session.text.delta",
      data: { assistantMessageID: "one", ordinal: 0, delta: "Same" },
    });
    expect(
      stream.consume({ type: "session.tool.input.started", data: { id: "a", name: "A" } }),
    ).toEqual([]);
    expect(
      stream.consume({ type: "session.tool.called", data: { id: "a", input: { path: "A" } } }),
    ).toEqual([
      { kind: "message-completed", text: "Same", final: false },
      { kind: "tool-started", id: "a", name: "A", value: { path: "A" } },
    ]);
    stream.consume({ type: "session.tool.input.started", data: { id: "b", name: "B" } });
    stream.consume({ type: "session.tool.called", data: { id: "b", input: { path: "B" } } });
    const done = { type: "session.tool.success", data: { id: "a", content: "ok" } };
    expect(stream.consume(done)).toEqual([
      { kind: "tool-completed", id: "a", name: "A", value: "ok" },
    ]);
    expect(stream.consume(done)).toEqual([]);
    expect(
      stream.consume({
        type: "session.text.ended",
        data: { assistantMessageID: "two", ordinal: 0, text: "Same" },
      }),
    ).toEqual([{ kind: "message-delta", text: "Same" }]);
  });
  it("holds 2.x tools behind previously started content whose deltas are batched", () => {
    const stream = new OpenCodeStream();
    const data = { assistantMessageID: "first", ordinal: 0 };
    stream.consume({ type: "session.reasoning.started", data });
    stream.consume({ type: "session.text.started", data });
    expect(
      stream.consume({
        type: "session.tool.input.started",
        data: { assistantMessageID: "first", id: "probe", name: "execute" },
      }),
    ).toEqual([]);
    expect(
      stream.consume({
        type: "session.tool.called",
        data: { assistantMessageID: "first", id: "probe", input: { marker: "probe" } },
      }),
    ).toEqual([]);
    expect(
      stream.consume({
        type: "session.tool.success",
        data: { assistantMessageID: "first", id: "probe", content: "result" },
      }),
    ).toEqual([]);
    expect(
      stream.consume({ type: "session.reasoning.delta", data: { ...data, delta: "Think." } }),
    ).toEqual([{ kind: "thought-delta", text: "Think." }]);
    stream.consume({ type: "session.reasoning.ended", data: { ...data, text: "Think." } });
    expect(
      stream.consume({ type: "session.text.delta", data: { ...data, delta: "Before." } }),
    ).toEqual([{ kind: "message-delta", text: "Before." }]);
    expect(
      stream.consume({ type: "session.text.ended", data: { ...data, text: "Before." } }),
    ).toEqual([
      { kind: "message-completed", text: "Before.", thinking: "Think.", final: false },
      { kind: "tool-started", id: "probe", name: "execute", value: { marker: "probe" } },
      { kind: "tool-completed", id: "probe", name: "execute", value: "result" },
    ]);
    stream.consume({
      type: "session.text.delta",
      data: { assistantMessageID: "second", ordinal: 0, delta: "Final." },
    });
    stream.consume({
      type: "session.text.ended",
      data: { assistantMessageID: "second", ordinal: 0, text: "Final." },
    });
    expect(
      stream.consume({ type: "session.step.ended", data: { assistantMessageID: "second" } }),
    ).toEqual([]);
    expect(stream.finish("Final.")).toEqual([
      { kind: "message-completed", text: "Final.", final: true },
    ]);
  });

  it("does not copy thought-only tool preparation into the final message", () => {
    const stream = new OpenCodeStream();
    stream.consume({
      type: "session.reasoning.delta",
      data: { assistantMessageID: "first", ordinal: 0, delta: "Prepare." },
    });
    stream.consume({
      type: "session.reasoning.ended",
      data: { assistantMessageID: "first", ordinal: 0, text: "Prepare." },
    });
    stream.consume({
      type: "session.tool.input.started",
      data: { assistantMessageID: "first", id: "probe", name: "execute" },
    });
    stream.consume({
      type: "session.tool.called",
      data: { assistantMessageID: "first", id: "probe", input: {} },
    });
    stream.consume({
      type: "session.text.delta",
      data: { assistantMessageID: "second", ordinal: 0, delta: "Final." },
    });
    expect(stream.finish("Final.")).toEqual([
      { kind: "message-completed", text: "Final.", final: true },
    ]);
  });
  it("waits for 1.x pending input to become an actual tool invocation", () => {
    const stream = new OpenCodeStream();
    stream.consume({ type: "message.updated", data: { info: { id: "one", role: "assistant" } } });
    const part = { type: "tool", messageID: "one", callID: "probe", tool: "context" };
    expect(
      stream.consume({
        type: "message.part.updated",
        data: { part: { ...part, state: { status: "pending", input: {} } } },
      }),
    ).toEqual([]);
    expect(
      stream.consume({
        type: "message.part.updated",
        data: { part: { ...part, state: { status: "running", input: { marker: "probe" } } } },
      }),
    ).toEqual([{ kind: "tool-started", id: "probe", name: "context", value: { marker: "probe" } }]);
    const done = {
      type: "message.part.updated",
      data: {
        part: { ...part, state: { status: "completed", input: { marker: "probe" }, output: "ok" } },
      },
    };
    expect(stream.consume(done)).toEqual([
      { kind: "tool-completed", id: "probe", name: "context", value: "ok" },
    ]);
    expect(stream.consume(done)).toEqual([]);
  });

  it("retains a tool name when malformed 2.x input fails before called", () => {
    const stream = new OpenCodeStream();
    stream.consume({ type: "session.tool.input.started", data: { id: "probe", name: "context" } });
    expect(
      stream.consume({
        type: "session.tool.failed",
        data: { id: "probe", error: "Malformed input" },
      }),
    ).toEqual([
      { kind: "tool-started", id: "probe", name: "context", value: undefined },
      { kind: "tool-failed", id: "probe", name: "context", value: "Malformed input" },
    ]);
  });
});
