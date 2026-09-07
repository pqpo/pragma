import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeTurnContext } from "@pragma/core";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  collectPiUsage,
  consumePiStartupMessages,
  createPiNativeSession,
  startPiTurn,
  type PiNativeEvent,
} from "../src/session.ts";

describe("PI startup messages", () => {
  it("consumes mounted startup messages once without mutating native history", () => {
    const native = createNativeSession();

    expect(consumePiStartupMessages(native)).toEqual([
      { role: "user", content: "always-on context" },
    ]);
    expect(consumePiStartupMessages(native)).toEqual([]);
    expect(native.session.messages).toEqual([]);
  });

  it("prepends turn startup messages after pre-prompt compaction", async () => {
    const native = createNativeSession();
    const startupMessages = consumePiStartupMessages(native);

    await startPiTurn(native, createTurn(startupMessages));

    expect(native.session.prompt).toHaveBeenCalledWith("always-on context\n\nuser prompt");
  });

  it("waits for PI to finish an overflow compaction retry before completing the turn", async () => {
    const native = createNativeSession();
    for (let index = 0; index < 5; index += 1) {
      native.session.messages.push({
        role: "user",
        content: [{ type: "text", text: `existing message ${index}` }],
        timestamp: index,
      });
    }
    let publish: Parameters<AgentSession["subscribe"]>[0] | undefined;
    vi.mocked(native.session.subscribe).mockImplementation((listener) => {
      publish = listener;
      return () => undefined;
    });
    vi.mocked(native.session.prompt).mockImplementation(async () => {
      const truncated = createAssistantMessage("truncated", "length", 100);
      publish?.({ type: "message_end", message: truncated });
      publish?.({ type: "compaction_start", reason: "overflow" });
      publish?.({
        type: "compaction_end",
        reason: "overflow",
        result: {
          summary: "summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 128_000,
          estimatedTokensAfter: 20_000,
          usage: createPiUsage(50),
        },
        aborted: false,
        willRetry: true,
      });
      const completed = createAssistantMessage("done after retry", "stop", 100);
      native.session.messages.splice(0, native.session.messages.length, completed);
      publish?.({ type: "message_end", message: completed });
    });
    const turn = createTurn([]);

    await expect(startPiTurn(native, turn)).resolves.toEqual({
      runtimeSessionId: native.session.sessionId,
    });

    expect(turn.stream.writeNative).toHaveBeenCalledTimes(4);
    expect(turn.stream.writeNative).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "compaction_end",
          willRetry: true,
        }),
        operationId: expect.any(String),
        trigger: "overflow",
      }),
    );
    expect(native.pendingCompactionOperationId).toBeUndefined();
    expect(native.session.messages).toHaveLength(1);
    expect(native.messageCountBeforeRun).toBe(5);
    expect(native.assistantMessagesSinceRunStart).toHaveLength(2);
    expect(native.usageObservationsSinceRunStart).toHaveLength(3);
    expect(collectPiUsage(native)).toMatchObject({ output: 250, totalTokens: 60_250 });
    expect(turn.stream.writeNative).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ type: "message_end" }),
        usage: expect.objectContaining({ output: 250, totalTokens: 60_250 }),
      }),
    );
  });

  it("reports per-attempt streaming usage while retaining run-wide fallback usage", async () => {
    const native = createNativeSession();
    let publish: Parameters<AgentSession["subscribe"]>[0] | undefined;
    let response = createAssistantMessage("invalid structured output", "stop", 100);
    vi.mocked(native.session.subscribe).mockImplementation((listener) => {
      publish = listener;
      return () => undefined;
    });
    vi.mocked(native.session.prompt).mockImplementation(async () => {
      native.session.messages.push(response);
      publish?.({ type: "message_end", message: response });
    });

    await startPiTurn(native, createTurn([]));
    response = createAssistantMessage("valid structured output", "stop", 50);
    const retryTurn = {
      ...createTurn([]),
      attempt: 2,
      isRetry: true,
    } satisfies RuntimeTurnContext<PiNativeEvent>;
    await startPiTurn(native, retryTurn);

    expect(retryTurn.stream.writeNative).toHaveBeenLastCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ output: 50, totalTokens: 20_050 }),
      }),
    );
    expect(collectPiUsage(native)).toMatchObject({ output: 150, totalTokens: 40_150 });
  });

  it("fails an unfinished compaction when the turn ends", async () => {
    const native = createNativeSession();
    native.pendingCompactionOperationId = "compact-orphaned";
    native.pendingCompactionTrigger = "auto";
    const turn = createTurn([]);

    await startPiTurn(native, turn);

    expect(turn.stream.write).toHaveBeenCalledWith({
      runId: "run-1",
      source: { kind: "runtime", runId: "run-1", path: [] },
      type: "progress",
      payload: {
        stage: "context.compaction.failed",
        data: {
          operationId: "compact-orphaned",
          trigger: "auto",
          runtimeId: "cloud-pi-agent",
          errorMessage: "PI Runtime turn ended before context compaction completed.",
        },
      },
    });
    expect(native.pendingCompactionOperationId).toBeUndefined();
    expect(native.pendingCompactionTrigger).toBeUndefined();
  });

  it("cleans up an unfinished compaction when publishing its failure throws", async () => {
    const native = createNativeSession();
    const unsubscribe = vi.fn();
    vi.mocked(native.session.subscribe).mockReturnValue(unsubscribe);
    native.pendingCompactionOperationId = "compact-orphaned";
    native.pendingCompactionTrigger = "auto";
    const turn = createTurn([]);
    vi.mocked(turn.stream.write).mockImplementation(() => {
      throw new Error("stream unavailable");
    });

    await expect(startPiTurn(native, turn)).rejects.toThrow("stream unavailable");

    expect(native.pendingCompactionOperationId).toBeUndefined();
    expect(native.pendingCompactionTrigger).toBeUndefined();
    expect(native.streamState).toEqual({
      runId: undefined,
      source: undefined,
      emitter: undefined,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("passes image blocks only when the selected model supports vision", async () => {
    const path = join(tmpdir(), `pragma-pi-image-${randomUUID()}.png`);
    await writeFile(path, "image-bytes");
    try {
      const native = createNativeSession(["text", "image"]);
      const turn = createTurn(
        [],
        [
          {
            id: "00000000-0000-4000-8000-000000000001",
            kind: "image",
            name: "screen.png",
            path,
            mimeType: "image/png",
          },
        ],
      );

      await startPiTurn(native, turn);

      expect(native.session.prompt).toHaveBeenCalledWith("user prompt", {
        images: [
          {
            type: "image",
            data: Buffer.from("image-bytes").toString("base64"),
            mimeType: "image/png",
          },
        ],
      });
    } finally {
      await rm(path, { force: true });
    }
  });

  it("does not pass image blocks when the selected model is text-only", async () => {
    const path = join(tmpdir(), `pragma-pi-image-${randomUUID()}.png`);
    await writeFile(path, "image-bytes");
    try {
      const native = createNativeSession(["text"]);
      const turn = createTurn(
        [],
        [
          {
            id: "00000000-0000-4000-8000-000000000001",
            kind: "image",
            name: "screen.png",
            path,
            mimeType: "image/png",
          },
        ],
      );

      await startPiTurn(native, turn);

      expect(native.session.prompt).toHaveBeenCalledWith("user prompt");
    } finally {
      await rm(path, { force: true });
    }
  });
});

function createNativeSession(input?: ("text" | "image")[]) {
  const messages: unknown[] = [];
  const session = {
    messages,
    model:
      input === undefined
        ? undefined
        : {
            provider: "test",
            id: "vision-model",
            input,
          },
    prompt: vi.fn(async () => {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      });
    }),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    getContextUsage: vi.fn(() => ({ tokens: 0, contextWindow: 128_000, percent: 0 })),
    sessionManager: { getBranch: () => [] },
    settingsManager: {
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    },
  } as unknown as AgentSession;

  return createPiNativeSession({
    agent: { id: "pi-test" } as Parameters<typeof createPiNativeSession>[0]["agent"],
    session,
    streamState: {},
    models: {
      modelRegistry: {} as Parameters<typeof createPiNativeSession>[0]["models"]["modelRegistry"],
      modelRuntime: {} as Parameters<typeof createPiNativeSession>[0]["models"]["modelRuntime"],
    },
    compactionKeepRecentTokens: 20_000,
    startupMessages: [{ role: "user", content: "always-on context" }],
  });
}

function createAssistantMessage(
  text: string,
  stopReason: "stop" | "length",
  output: number,
): Extract<AgentSession["messages"][number], { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: createPiUsage(output),
    stopReason,
    timestamp: Date.now(),
  };
}

function createPiUsage(
  output: number,
): Extract<AgentSession["messages"][number], { role: "assistant" }>["usage"] {
  return {
    input: 20_000,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 20_000 + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createTurn(
  startupMessages: RuntimeTurnContext<PiNativeEvent>["startupMessages"],
  attachments: RuntimeTurnContext<PiNativeEvent>["attachments"] = [],
): RuntimeTurnContext<PiNativeEvent> {
  return {
    runId: "run-1",
    attempt: 1,
    isRetry: false,
    rawQuery: "user prompt",
    prompt: "user prompt",
    attachments,
    startupMessages,
    features: {} as never,
    steps: {} as never,
    signal: new AbortController().signal,
    source: { kind: "runtime", runId: "run-1", path: [] },
    stream: {
      write: vi.fn(),
      writeNative: vi.fn(),
    },
  };
}
