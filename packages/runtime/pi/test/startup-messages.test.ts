import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeTurnContext } from "@pragma/core";
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
});

function createNativeSession() {
  const messages: unknown[] = [];
  const session = {
    messages,
    model: undefined,
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
): RuntimeTurnContext<PiNativeEvent> {
  return {
    runId: "run-1",
    attempt: 1,
    isRetry: false,
    rawQuery: "user prompt",
    prompt: "user prompt",
    startupMessages,
    signal: new AbortController().signal,
    source: { kind: "runtime", runId: "run-1", path: [] },
    stream: {
      write: vi.fn(),
      writeNative: vi.fn(),
    },
  };
}
