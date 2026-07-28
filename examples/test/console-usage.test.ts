import { describe, expect, it } from "vitest";

import { formatConsoleUsage } from "../src/console/console-usage.ts";

describe("console usage summary", () => {
  it("formats a session usage total", () => {
    expect(
      formatConsoleUsage({
        measurement: "reported",
        input: 1_500,
        output: 150,
        cacheRead: 300,
        cacheWrite: 30,
        cacheWrite1h: 4,
        totalTokens: 1_980,
        cost: { input: 0.15, output: 0.3, cacheRead: 0.03, cacheWrite: 0.015, total: 0.495 },
      }),
    ).toBe(
      [
        "\n总 Usage:",
        "  input=1,500 · output=150",
        "  cacheRead=300 · cacheWrite=30 · cacheWrite1h=4",
        "  totalTokens=1,980 · cost=$0.495000",
      ].join("\n"),
    );
  });

  it("makes missing usage explicit", () => {
    expect(formatConsoleUsage(undefined)).toBe("\n总 Usage: 暂无可用数据。");
  });
});
