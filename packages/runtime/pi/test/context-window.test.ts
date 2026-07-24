import { describe, expect, it, vi } from "vitest";

import {
  compactPiContextWindow,
  readPiContextWindow,
  type PiNativeSession,
} from "../src/session.ts";

describe("PI context window", () => {
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
});
