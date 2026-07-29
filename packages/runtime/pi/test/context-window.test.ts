import { describe, expect, it, vi } from "vitest";

import {
  canCompactPiContextWindow,
  compactPiContextBeforePrompt,
  compactPiContextWindow,
  readPiContextWindow,
  type PiNativeSession,
} from "../src/session.ts";

function piContextState(entries: readonly unknown[] = [], keepRecentTokens = 20_000) {
  return {
    sessionManager: { getBranch: () => entries },
    settingsManager: {
      getCompactionKeepRecentTokens: () => keepRecentTokens,
      applyOverrides: vi.fn(),
    },
  };
}

describe("PI context window", () => {
  it("reports when PI has older context that can actually be compacted", () => {
    const entry = (id: string, parentId: string | null, content: string) => ({
      type: "message" as const,
      id,
      parentId,
      timestamp: "2026-07-29T00:00:00.000Z",
      message: { role: "user" as const, content, timestamp: 0 },
    });
    const shortSession = {
      session: {
        ...piContextState([entry("recent", null, "short")]),
      },
      compactionKeepRecentTokens: 20_000,
    } as unknown as PiNativeSession;
    const longSession = {
      session: {
        ...piContextState(
          [entry("older", null, "older context"), entry("recent", "older", "recent context")],
          1,
        ),
      },
      compactionKeepRecentTokens: 1,
    } as unknown as PiNativeSession;

    expect(canCompactPiContextWindow(shortSession)).toBe(false);
    expect(canCompactPiContextWindow(longSession)).toBe(true);
  });

  it("calibrates PI's compaction budget for dense CJK text", () => {
    const entry = (id: string, parentId: string | null, content: string) => ({
      type: "message" as const,
      id,
      parentId,
      timestamp: "2026-07-29T00:00:00.000Z",
      message: { role: "user" as const, content, timestamp: 0 },
    });
    const entries = [
      entry("older", null, "旧".repeat(10_000)),
      entry("middle", "older", "中".repeat(10_000)),
      entry("recent", "middle", "新".repeat(10_000)),
    ];
    const state = piContextState(entries);
    const session = {
      session: state,
      compactionKeepRecentTokens: 20_000,
    } as unknown as PiNativeSession;

    expect(canCompactPiContextWindow(session)).toBe(true);
    expect(state.settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: 5_000 },
    });
  });

  it("preserves the configured recent budget when only older history uses dense text", () => {
    const entry = (id: string, parentId: string | null, content: string) => ({
      type: "message" as const,
      id,
      parentId,
      timestamp: "2026-07-29T00:00:00.000Z",
      message: { role: "user" as const, content, timestamp: 0 },
    });
    const state = piContextState([
      entry("older", null, "旧".repeat(20_000)),
      entry("recent", "older", "a".repeat(80_000)),
    ]);
    const session = {
      session: state,
      compactionKeepRecentTokens: 20_000,
    } as unknown as PiNativeSession;

    expect(canCompactPiContextWindow(session)).toBe(true);
    expect(state.settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: 20_000 },
    });
  });

  it("uses PI's bounded context estimate instead of cumulative billing usage", () => {
    const contextState = piContextState();
    const session = {
      session: {
        ...contextState,
        getContextUsage: () => ({
          tokens: 32_000,
          contextWindow: 128_000,
          percent: 25,
        }),
      },
    } as unknown as PiNativeSession;

    expect(readPiContextWindow(session)).toMatchObject({
      usedTokens: 32_000,
      contextWindowTokens: 128_000,
      percent: 25,
      measurement: "estimated",
    });
  });

  it("marks context usage backed by a completed model response as derived", () => {
    const assistantEntry = {
      type: "message" as const,
      id: "assistant",
      parentId: null,
      timestamp: "2026-07-29T00:00:00.000Z",
      message: {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "response" }],
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 10_000,
          output: 2_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12_000,
        },
      },
    };
    const session = {
      session: {
        ...piContextState([assistantEntry]),
        getContextUsage: () => ({
          tokens: 12_000,
          contextWindow: 128_000,
          percent: 9.375,
        }),
      },
    } as unknown as PiNativeSession;

    expect(readPiContextWindow(session)).toMatchObject({
      usedTokens: 12_000,
      measurement: "derived",
    });
  });

  it("reports the post-compaction estimate returned by PI", async () => {
    const compact = vi.fn(async () => ({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 100_000,
      estimatedTokensAfter: 18_000,
    }));
    const session = {
      session: {
        ...piContextState(),
        getContextUsage: () => ({
          tokens: null,
          contextWindow: 128_000,
          percent: null,
        }),
        compact,
      },
      compactionKeepRecentTokens: 20_000,
    } as unknown as PiNativeSession;

    await expect(compactPiContextWindow(session)).resolves.toMatchObject({
      usedTokens: 18_000,
      contextWindowTokens: 128_000,
      percent: 14.0625,
    });
    expect(compact).toHaveBeenCalledOnce();
  });

  it("compacts before a prompt at 75 percent context usage", async () => {
    const compact = vi.fn(async () => ({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 96_000,
      estimatedTokensAfter: 20_000,
    }));
    const session = {
      session: {
        ...piContextState(),
        getContextUsage: () => ({
          tokens: 96_000,
          contextWindow: 128_000,
          percent: 75,
        }),
        compact,
      },
      compactionKeepRecentTokens: 20_000,
    } as unknown as PiNativeSession;

    await expect(compactPiContextBeforePrompt(session)).resolves.toBe(true);
    expect(compact).toHaveBeenCalledOnce();
    expect(session.compactionTriggerOverride).toBeUndefined();
  });

  it("does not compact before a prompt below 75 percent usage", async () => {
    const compact = vi.fn();
    const session = {
      session: {
        ...piContextState(),
        getContextUsage: () => ({
          tokens: 95_999,
          contextWindow: 128_000,
          percent: 74.999,
        }),
        compact,
      },
    } as unknown as PiNativeSession;

    await expect(compactPiContextBeforePrompt(session)).resolves.toBe(false);
    expect(compact).not.toHaveBeenCalled();
  });

  it("fails the prompt preflight when automatic compaction fails", async () => {
    const session = {
      session: {
        ...piContextState(),
        getContextUsage: () => ({
          tokens: 100_000,
          contextWindow: 128_000,
          percent: 78.125,
        }),
        compact: vi.fn().mockRejectedValue(new Error("provider unavailable")),
      },
      compactionKeepRecentTokens: 20_000,
    } as unknown as PiNativeSession;

    await expect(compactPiContextBeforePrompt(session)).rejects.toThrow(
      "automatic context compaction failed before the prompt: provider unavailable",
    );
    expect(session.compactionTriggerOverride).toBeUndefined();
  });
});
