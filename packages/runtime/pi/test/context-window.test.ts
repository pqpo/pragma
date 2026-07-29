import { describe, expect, it, vi } from "vitest";

import {
  canCompactPiContextWindow,
  compactPiContextBeforePrompt,
  compactPiContextWindow,
  readPiContextWindow,
  type PiNativeSession,
} from "../src/session.ts";

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
        sessionManager: { getBranch: () => [entry("recent", null, "short")] },
        settingsManager: { getCompactionKeepRecentTokens: () => 20_000 },
      },
    } as unknown as PiNativeSession;
    const longSession = {
      session: {
        sessionManager: {
          getBranch: () => [
            entry("older", null, "older context"),
            entry("recent", "older", "recent context"),
          ],
        },
        settingsManager: { getCompactionKeepRecentTokens: () => 1 },
      },
    } as unknown as PiNativeSession;

    expect(canCompactPiContextWindow(shortSession)).toBe(false);
    expect(canCompactPiContextWindow(longSession)).toBe(true);
  });

  it("uses PI's bounded context estimate instead of cumulative billing usage", () => {
    const session = {
      session: {
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

  it("reports the post-compaction estimate returned by PI", async () => {
    const compact = vi.fn(async () => ({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 100_000,
      estimatedTokensAfter: 18_000,
    }));
    const session = {
      session: {
        getContextUsage: () => ({
          tokens: null,
          contextWindow: 128_000,
          percent: null,
        }),
        compact,
      },
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
        getContextUsage: () => ({
          tokens: 96_000,
          contextWindow: 128_000,
          percent: 75,
        }),
        compact,
      },
    } as unknown as PiNativeSession;

    await expect(compactPiContextBeforePrompt(session)).resolves.toBe(true);
    expect(compact).toHaveBeenCalledOnce();
    expect(session.compactionTriggerOverride).toBeUndefined();
  });

  it("does not compact before a prompt below 75 percent usage", async () => {
    const compact = vi.fn();
    const session = {
      session: {
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
        getContextUsage: () => ({
          tokens: 100_000,
          contextWindow: 128_000,
          percent: 78.125,
        }),
        compact: vi.fn().mockRejectedValue(new Error("provider unavailable")),
      },
    } as unknown as PiNativeSession;

    await expect(compactPiContextBeforePrompt(session)).rejects.toThrow(
      "automatic context compaction failed before the prompt: provider unavailable",
    );
    expect(session.compactionTriggerOverride).toBeUndefined();
  });
});
