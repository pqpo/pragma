import { describe, expect, it } from "vitest";

import { createUsageFromTokenCounts, mergeUsage } from "../../src/runtime/usage.ts";

describe("runtime usage helpers", () => {
  it("normalizes token counts and subtracts cache reads from input tokens", () => {
    expect(
      createUsageFromTokenCounts({
        inputTokens: 10.8,
        outputTokens: 3.2,
        cacheReadTokens: 4,
        cacheWriteTokens: Number.NaN,
      }),
    ).toEqual({
      input: 6,
      output: 3,
      cacheRead: 4,
      cacheWrite: 0,
      totalTokens: 13,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    });
  });

  it("merges optional usage records including one-hour cache writes", () => {
    const usage = mergeUsage(
      createUsageFromTokenCounts({
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 3,
        cacheWrite1hTokens: 5,
      }),
      createUsageFromTokenCounts({
        inputTokens: 4,
        outputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 2,
      }),
    );

    expect(usage).toMatchObject({
      input: 13,
      output: 8,
      cacheRead: 1,
      cacheWrite: 5,
      cacheWrite1h: 5,
      totalTokens: 27,
    });
  });
});
