import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import {
  UsagePage,
  UsageTrendChart,
  usageTrendLabelIndexes,
  usageTrendPoints,
} from "./UsagePage.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("UsagePage", () => {
  it("renders the compact period selector and loading state", () => {
    const html = renderToStaticMarkup(<UsagePage />);

    expect(html).toContain("<h1>Usage</h1>");
    expect(html).toContain("7 days");
    expect(html).toContain("30 days");
    expect(html).toContain("All time");
    expect(html).toContain("Loading usage");
  });

  it("provides Simplified Chinese usage copy", async () => {
    await i18n.changeLanguage("zh-Hans");

    const html = renderToStaticMarkup(<UsagePage />);

    expect(html).toContain("<h1>用量</h1>");
    expect(html).toContain("正在加载用量");
    expect(i18n.t("inclusiveNote", { ns: "usage" })).toBe(
      "用量包含子调用树，不同维度数字可能重叠，删除的对象数据不在列表中。",
    );
    expect(i18n.t("missionListNote", { ns: "usage" })).toBe("删除的 Mission 不在列表中。");
  });

  it("keeps trend endpoints inside the SVG plot area", () => {
    expect(usageTrendPoints([10, 20])).toEqual([
      { x: 1, y: 53 },
      { x: 99, y: 14 },
    ]);
  });

  it("labels both chart axes and exposes exact Token totals for every node", () => {
    const html = renderToStaticMarkup(
      <UsageTrendChart
        label="Daily token usage"
        overview={{
          revision: 1,
          trackingStartedAt: "2026-01-01T00:00:00.000Z",
          timezone: "UTC",
          totals: {
            input: 1_000,
            output: 200,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1_200,
          },
          daily: [
            {
              date: "2026-01-01",
              input: 1_000,
              output: 200,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1_200,
            },
            {
              date: "2026-01-02",
              input: 200,
              output: 100,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 300,
            },
          ],
        }}
      />,
    );

    expect(html).toContain('class="usage-chart-y-axis"');
    expect(html).toContain('class="usage-chart-x-axis"');
    expect(html).toContain("Jan 1");
    expect(html).toContain("1,200 tokens");
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('aria-label="Jan 1, 2026: 1,200 tokens"');
    expect(usageTrendLabelIndexes(30)).toEqual([0, 14, 29]);
  });
});
