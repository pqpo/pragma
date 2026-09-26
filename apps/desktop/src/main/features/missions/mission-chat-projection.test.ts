import { describe, expect, it } from "vitest";
import type { ExecutionOutputItem } from "@pragma/core";
import {
  consumeLiveChatOutput,
  isRootMissionRuntimeOutput,
  type LiveMissionChat,
} from "./mission-chat-live.ts";
import {
  finalizeHistoricalChatEntries,
  mergeMissionChatEntriesWithLive,
} from "./mission-chat-history.ts";

describe("Mission chat projection", () => {
  it("keeps interleaved expert token streams grouped by invocation", () => {
    const chat: LiveMissionChat = {
      executionId: "execution-1",
      entries: [],
      messageOrdinals: new Map(),
      close: async () => undefined,
    };
    const output = (
      invocationId: string,
      executorId: string,
      delta?: string,
    ): ExecutionOutputItem => ({
      sourceEventId: `${invocationId}:${delta ?? "completed"}`,
      executionId: chat.executionId,
      invocationId,
      executorId,
      contextId: `context:${invocationId}`,
      runId: `run:${invocationId}`,
      source: { kind: "runtime", runId: `run:${invocationId}`, path: [] },
      channel: "message",
      ...(delta === undefined ? { value: "completed" } : { delta }),
      occurredAt: "2026-08-24T00:00:00.000Z",
    });

    consumeLiveChatOutput(chat, output("invocation-a", "expert-a", "A1"));
    consumeLiveChatOutput(chat, output("invocation-b", "expert-b", "B1"));
    consumeLiveChatOutput(chat, output("invocation-a", "expert-a", "A2"));
    consumeLiveChatOutput(chat, output("invocation-b", "expert-b", "B2"));
    consumeLiveChatOutput(chat, output("invocation-a", "expert-a"));
    consumeLiveChatOutput(chat, output("invocation-b", "expert-b"));

    expect(chat.entries).toEqual([
      expect.objectContaining({
        kind: "assistant",
        invocationId: "invocation-a",
        executorId: "expert-a",
        content: "A1A2",
        streaming: false,
      }),
      expect.objectContaining({
        kind: "assistant",
        invocationId: "invocation-b",
        executorId: "expert-b",
        content: "B1B2",
        streaming: false,
      }),
    ]);
  });

  it("ignores a late Codex delta after completion for the same run", () => {
    const chat: LiveMissionChat = {
      executionId: "execution-1",
      entries: [],
      messageOrdinals: new Map(),
      close: async () => undefined,
    };
    const output = (input: {
      readonly sourceEventId: string;
      readonly delta?: string;
      readonly value?: unknown;
    }): ExecutionOutputItem => ({
      sourceEventId: input.sourceEventId,
      executionId: chat.executionId,
      invocationId: "invocation-a",
      executorId: "expert-a",
      contextId: "context:invocation-a",
      runId: "run:invocation-a",
      source: { kind: "runtime", runId: "run:invocation-a", path: [] },
      channel: "message",
      ...(input.delta === undefined ? {} : { delta: input.delta }),
      ...(input.value === undefined ? {} : { value: input.value }),
      occurredAt: "2026-08-24T00:00:00.000Z",
    });

    consumeLiveChatOutput(chat, output({ sourceEventId: "completed", value: "answer" }));
    expect(
      consumeLiveChatOutput(chat, output({ sourceEventId: "late-delta", delta: "answer" })),
    ).toEqual([]);
    expect(chat.entries).toHaveLength(1);
    expect(chat.entries[0]).toMatchObject({
      kind: "assistant",
      content: "answer",
      streaming: false,
    });
  });

  it("keeps assistant answers emitted after a tool call in the same Runtime run", () => {
    const chat: LiveMissionChat = {
      executionId: "execution-1",
      entries: [],
      messageOrdinals: new Map(),
      close: async () => undefined,
    };
    const base: Omit<ExecutionOutputItem, "sourceEventId" | "channel" | "occurredAt"> = {
      executionId: chat.executionId,
      invocationId: "teammate",
      parentInvocationId: "coordinator",
      executorId: "researcher",
      contextId: "researcher-context",
      runId: "teammate-run",
      source: { kind: "runtime", runId: "teammate-run", path: [] },
    };

    consumeLiveChatOutput(chat, {
      ...base,
      sourceEventId: "before-tool",
      channel: "message",
      value: {
        stopReason: "toolUse",
        content: [{ type: "text", text: "I will ask the user now." }],
      },
      occurredAt: "2026-09-17T13:44:30.000Z",
    });
    consumeLiveChatOutput(chat, {
      ...base,
      sourceEventId: "tool-started",
      channel: "tool",
      value: {
        toolCallId: "ask-user",
        toolName: "askUserQuestion",
        inputPreview: "Did you receive it?",
      },
      occurredAt: "2026-09-17T13:44:31.000Z",
    });
    consumeLiveChatOutput(chat, {
      ...base,
      sourceEventId: "tool-completed",
      channel: "tool",
      value: {
        toolCallId: "ask-user",
        toolName: "askUserQuestion",
        outputPreview: "Received",
      },
      occurredAt: "2026-09-17T13:44:32.000Z",
    });
    const finalPatches = consumeLiveChatOutput(chat, {
      ...base,
      sourceEventId: "after-tool",
      channel: "message",
      value: {
        stopReason: "stop",
        content: [{ type: "text", text: "The user answered: Received." }],
      },
      occurredAt: "2026-09-17T13:44:33.000Z",
    });

    expect(finalPatches).toEqual([
      expect.objectContaining({
        type: "entry.upsert",
        entry: expect.objectContaining({
          kind: "assistant",
          content: "The user answered: Received.",
          finalAnswer: true,
        }),
      }),
    ]);
    expect(chat.entries).toMatchObject([
      { kind: "assistant", content: "I will ask the user now.", streaming: false },
      { kind: "tool", toolName: "askUserQuestion", status: "succeeded" },
      {
        kind: "assistant",
        content: "The user answered: Received.",
        streaming: false,
        finalAnswer: true,
      },
    ]);
    expect(chat.entries[0]?.id).toContain(":assistant:0");
    expect(chat.entries[2]?.id).toContain(":assistant:1");
  });

  it("routes interleaved tool deltas by tool call id", () => {
    const chat: LiveMissionChat = {
      executionId: "execution-1",
      entries: [],
      messageOrdinals: new Map(),
      close: async () => undefined,
    };
    const base: Omit<ExecutionOutputItem, "sourceEventId" | "source" | "delta" | "value"> = {
      executionId: chat.executionId,
      invocationId: "invocation-a",
      contextId: "context-a",
      runId: "run-a",
      channel: "tool",
      occurredAt: "2026-09-23T00:00:00.000Z",
    };
    const start = (toolCallId: string): void => {
      consumeLiveChatOutput(chat, {
        ...base,
        sourceEventId: `${toolCallId}:started`,
        source: { kind: "tool", runId: "run-a", toolCallId, path: [] },
        value: { toolCallId, toolName: `tool_${toolCallId}` },
      });
    };
    const delta = (toolCallId: string, content: string): void => {
      consumeLiveChatOutput(chat, {
        ...base,
        sourceEventId: `${toolCallId}:delta`,
        source: { kind: "tool", runId: "run-a", toolCallId, path: [] },
        delta: content,
      });
    };

    start("a");
    start("b");
    delta("a", "output-a");
    delta("b", "output-b");

    expect(chat.entries).toMatchObject([
      { kind: "tool", toolCallId: "a", outputPreview: "output-a" },
      { kind: "tool", toolCallId: "b", outputPreview: "output-b" },
    ]);
  });

  it("ignores late thinking after a final answer but accepts a new run", () => {
    const chat: LiveMissionChat = {
      executionId: "execution-1",
      entries: [],
      messageOrdinals: new Map(),
      close: async () => undefined,
    };
    const output = (
      runId: string,
      channel: "thought" | "message",
      content: string,
      completed = false,
    ): ExecutionOutputItem => ({
      sourceEventId: `${runId}:${channel}:${content}`,
      executionId: chat.executionId,
      invocationId: "invocation-a",
      contextId: "context-a",
      runId,
      source: { kind: "runtime", runId, path: [] },
      channel,
      ...(completed
        ? { value: { stopReason: "stop", content: [{ type: "text", text: content }] } }
        : { delta: content }),
      occurredAt: runId === "run-a" ? "2026-08-24T00:00:00.000Z" : "2026-08-24T00:00:01.000Z",
    });

    consumeLiveChatOutput(chat, output("run-a", "thought", "Reasoning"));
    consumeLiveChatOutput(chat, output("run-a", "message", "Answer", true));
    expect(consumeLiveChatOutput(chat, output("run-a", "thought", " late"))).toEqual([]);
    expect(chat.entries.map((entry) => entry.kind)).toEqual(["thinking", "assistant"]);
    expect(chat.entries[0]).toMatchObject({ content: "Reasoning", streaming: false });

    consumeLiveChatOutput(chat, output("run-b", "thought", "New reasoning"));
    expect(chat.entries.at(-1)).toMatchObject({ kind: "thinking", content: "New reasoning" });

    consumeLiveChatOutput(chat, {
      ...output("run-c", "message", "Tool handoff", true),
      value: { stopReason: "toolUse", content: [{ type: "text", text: "Tool handoff" }] },
    });
    expect(consumeLiveChatOutput(chat, output("run-c", "thought", "After tool"))).toHaveLength(1);

    // Qoder completes intermediate assistant messages with a string and no stop reason.
    consumeLiveChatOutput(chat, {
      ...output("run-d", "message", "Intermediate", true),
      value: "Intermediate",
    });
    expect(
      consumeLiveChatOutput(chat, output("run-d", "thought", "After intermediate")),
    ).toHaveLength(1);
  });

  it("inserts late teammate thinking before the coordinator final answer", () => {
    const chat: LiveMissionChat = {
      executionId: "execution-1",
      entries: [],
      messageOrdinals: new Map(),
      close: async () => undefined,
    };
    const coordinatorBase: ExecutionOutputItem = {
      sourceEventId: "coordinator-delta",
      executionId: chat.executionId,
      invocationId: "coordinator",
      contextId: "coordinator-context",
      runId: "coordinator-run",
      source: { kind: "runtime", runId: "coordinator-run", path: [] },
      channel: "message",
      delta: "Final answer",
      occurredAt: "2026-08-24T00:00:00.000Z",
    };

    consumeLiveChatOutput(chat, coordinatorBase);
    consumeLiveChatOutput(chat, {
      ...coordinatorBase,
      sourceEventId: "coordinator-completed",
      delta: undefined,
      value: {
        stopReason: "stop",
        content: [{ type: "text", text: "Final answer" }],
      },
    });
    const finalAnswerId = chat.entries[0]!.id;

    const patches = consumeLiveChatOutput(chat, {
      sourceEventId: "teammate-late-thinking",
      executionId: chat.executionId,
      invocationId: "teammate",
      parentInvocationId: "coordinator",
      executorId: "developer-researcher",
      contextId: "teammate-context",
      runId: "teammate-run",
      source: { kind: "runtime", runId: "teammate-run", path: [] },
      channel: "thought",
      delta: "Searching Android repositories",
      occurredAt: "2026-08-24T00:00:01.000Z",
    });

    expect(patches).toEqual([
      expect.objectContaining({ type: "entry.upsert", beforeEntryId: finalAnswerId }),
    ]);
    expect(chat.entries).toMatchObject([
      {
        kind: "thinking",
        invocationId: "teammate",
        content: "Searching Android repositories",
      },
      { id: finalAnswerId, kind: "assistant", invocationId: "coordinator" },
    ]);

    const lateCoordinatorToolPatches = consumeLiveChatOutput(chat, {
      ...coordinatorBase,
      sourceEventId: "coordinator-late-tool",
      channel: "tool",
      delta: undefined,
      value: {
        toolCallId: "late-tool",
        toolName: "inspect_result",
        outputPreview: "done",
      },
    });
    expect(lateCoordinatorToolPatches[0]).toMatchObject({
      type: "entry.upsert",
      beforeEntryId: finalAnswerId,
    });
    expect(chat.entries.at(-1)).toMatchObject({ id: finalAnswerId, kind: "assistant" });

    const staleRootPatches = consumeLiveChatOutput(chat, {
      ...coordinatorBase,
      sourceEventId: "stale-root-tool",
      runId: "older-coordinator-run",
      source: { kind: "runtime", runId: "older-coordinator-run", path: [] },
      channel: "tool",
      delta: undefined,
      value: {
        toolCallId: "stale-tool",
        toolName: "inspect_earlier_result",
        outputPreview: "done",
      },
      occurredAt: "2026-08-23T23:59:59.000Z",
    });
    expect(staleRootPatches[0]).toMatchObject({
      type: "entry.upsert",
      beforeEntryId: finalAnswerId,
    });
    expect(chat.entries.at(-1)).toMatchObject({ id: finalAnswerId, kind: "assistant" });

    consumeLiveChatOutput(chat, {
      ...coordinatorBase,
      sourceEventId: "coordinator-continuation",
      runId: "coordinator-continuation-run",
      source: { kind: "runtime", runId: "coordinator-continuation-run", path: [] },
      channel: "thought",
      delta: "Synthesizing the teammate result",
      occurredAt: "2026-08-24T00:00:02.000Z",
    });
    expect(chat.entries.at(-1)).toMatchObject({
      kind: "thinking",
      invocationId: "coordinator",
      content: "Synthesizing the teammate result",
    });
  });

  it("keeps completion-only answers from a later coordinator run", () => {
    const chat: LiveMissionChat = {
      executionId: "execution-1",
      entries: [],
      messageOrdinals: new Map(),
      close: async () => undefined,
    };
    const completed = (runId: string, content: string): ExecutionOutputItem => ({
      sourceEventId: `${runId}:completed`,
      executionId: chat.executionId,
      invocationId: "coordinator",
      contextId: "coordinator-context",
      runId,
      source: { kind: "runtime", runId, path: [] },
      channel: "message",
      value: { stopReason: "stop", content: [{ type: "text", text: content }] },
      occurredAt: runId === "run-a" ? "2026-08-24T00:00:00.000Z" : "2026-08-24T00:00:01.000Z",
    });

    consumeLiveChatOutput(chat, completed("run-a", "First answer"));
    const patches = consumeLiveChatOutput(chat, completed("run-b", "Final answer"));

    expect(patches).toEqual([
      expect.objectContaining({
        type: "entry.upsert",
        entry: expect.objectContaining({ content: "Final answer", finalAnswer: true }),
      }),
    ]);
    expect(chat.entries).toMatchObject([
      { content: "First answer", finalAnswer: true },
      { content: "Final answer", finalAnswer: true },
    ]);

    const lateTeammatePatches = consumeLiveChatOutput(chat, {
      sourceEventId: "late-teammate",
      executionId: chat.executionId,
      invocationId: "teammate",
      parentInvocationId: "coordinator",
      contextId: "teammate-context",
      runId: "teammate-run",
      source: { kind: "runtime", runId: "teammate-run", path: [] },
      channel: "thought",
      delta: "Late work",
      occurredAt: "2026-08-24T00:00:01.000Z",
    });
    expect(lateTeammatePatches[0]).toMatchObject({
      type: "entry.upsert",
      beforeEntryId: chat.entries.at(-1)?.id,
    });
  });

  it("keeps post-final teammate output before the final answer after terminal refresh", () => {
    const entries = [
      {
        id: "coordinator-final",
        executionId: "execution-1",
        invocationId: "coordinator",
        kind: "assistant" as const,
        content: "Final answer",
        streaming: false,
        finalAnswer: true,
        createdAt: "2026-08-24T00:00:00.000Z",
      },
      {
        id: "teammate-late-thinking",
        executionId: "execution-1",
        invocationId: "teammate",
        kind: "thinking" as const,
        content: "Late diagnostic reasoning",
        streaming: false,
        createdAt: "2026-08-24T00:00:01.000Z",
      },
    ];

    expect(finalizeHistoricalChatEntries(entries, true, "coordinator")).toEqual([
      entries[1],
      entries[0],
    ]);
    expect(finalizeHistoricalChatEntries(entries, true)).toEqual([entries[1], entries[0]]);
    expect(finalizeHistoricalChatEntries(entries, false, "coordinator")).toEqual(entries);

    const intermediateRootMessage = {
      id: "coordinator-intermediate",
      executionId: "execution-1",
      invocationId: "coordinator",
      kind: "assistant" as const,
      content: "I will delegate this work",
      streaming: false,
      createdAt: "2026-08-24T00:00:00.000Z",
    };
    expect(
      finalizeHistoricalChatEntries([intermediateRootMessage, entries[1]!], true, "coordinator"),
    ).toEqual([intermediateRootMessage, entries[1]]);
  });

  it("keeps live thinking before a durable final answer during refresh", () => {
    const createdAt = "2026-08-24T00:00:00.000Z";
    const user = { id: "request", kind: "user" as const, content: "Ask", createdAt };
    const thinking = {
      id: "message:execution-1:invocation-a:run-a:thinking:0",
      kind: "thinking" as const,
      content: "Reasoning",
      streaming: false,
      createdAt,
    };
    const durableAnswer = {
      id: "message:execution-1:invocation-a:run-a:assistant:0",
      kind: "assistant" as const,
      content: "Answer",
      streaming: false,
      eventSequence: 7,
      finalAnswer: true,
      createdAt,
    };
    const liveAnswer = { ...durableAnswer, eventSequence: undefined, streaming: true };

    expect(
      mergeMissionChatEntriesWithLive([user, durableAnswer], [thinking, liveAnswer]),
    ).toMatchObject([
      { id: "request" },
      { id: thinking.id },
      { id: durableAnswer.id, streaming: true, eventSequence: 7 },
    ]);
    expect(mergeMissionChatEntriesWithLive([user], [thinking])).toMatchObject([
      { id: "request" },
      { id: thinking.id },
    ]);
    expect(mergeMissionChatEntriesWithLive([user, durableAnswer], [thinking])).toMatchObject([
      { id: "request" },
      { id: thinking.id },
      { id: durableAnswer.id },
    ]);

    expect(
      mergeMissionChatEntriesWithLive(
        [
          {
            ...durableAnswer,
            executorId: "0000000000pragma",
            executorName: "Pragma",
            executorAvatarId: "pragma.avatar.expert.01",
          },
        ],
        [{ ...liveAnswer, executorId: "0000000000pragma", executorName: undefined }],
      ),
    ).toMatchObject([
      {
        executorId: "0000000000pragma",
        executorName: "Pragma",
        executorAvatarId: "pragma.avatar.expert.01",
      },
    ]);
  });
  it("stops emitting visible patches after a streaming message reaches its content cap", () => {
    const chat: LiveMissionChat = {
      executionId: "execution-1",
      entries: [],
      messageOrdinals: new Map(),
      close: async () => undefined,
    };
    const output = (delta: string, sequence: number): ExecutionOutputItem => ({
      sourceEventId: `event-${sequence}`,
      executionId: chat.executionId,
      invocationId: "invocation-a",
      executorId: "expert-a",
      contextId: "context:invocation-a",
      runId: "run:invocation-a",
      source: { kind: "runtime", runId: "run:invocation-a", path: [] },
      channel: "message",
      delta,
      occurredAt: "2026-08-29T00:00:00.000Z",
    });

    consumeLiveChatOutput(chat, output("a".repeat(200_000), 1));
    expect(consumeLiveChatOutput(chat, output("x", 2))).toEqual([
      expect.objectContaining({ type: "entry.upsert" }),
    ]);
    expect(consumeLiveChatOutput(chat, output("y", 3))).toEqual([]);
    expect(chat.entries[0]).toMatchObject({
      kind: "assistant",
      content: `${"a".repeat(199_999)}…`,
    });
  });

  it("projects context compaction only from the root coordinator Runtime", () => {
    const rootSource = { kind: "runtime" as const, runId: "root-run", path: [] };

    expect(isRootMissionRuntimeOutput({ source: rootSource })).toBe(true);
    expect(
      isRootMissionRuntimeOutput({
        parentInvocationId: "coordinator-invocation",
        source: rootSource,
      }),
    ).toBe(false);
    expect(
      isRootMissionRuntimeOutput({
        source: {
          kind: "agent",
          runId: "runtime-child-run",
          sessionId: "runtime-child-session",
          parentSessionId: "root-session",
          path: [],
        },
      }),
    ).toBe(false);
  });
});
