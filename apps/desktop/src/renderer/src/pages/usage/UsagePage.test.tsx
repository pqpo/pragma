import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import { UsagePage } from "./UsagePage.tsx";

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
  });
});
