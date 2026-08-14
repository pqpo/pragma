import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeTurnContext } from "@pragma/core";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
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
