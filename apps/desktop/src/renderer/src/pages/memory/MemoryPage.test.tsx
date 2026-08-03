import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import { MemoryPage } from "./MemoryPage.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("MemoryPage", () => {
  it("renders the first-level layered Memory management entry", () => {
    const html = renderToStaticMarkup(<MemoryPage />);

    expect(html).toContain("<h1>Memory</h1>");
    expect(html).toContain("Episodes");
    expect(html).toContain("Facts");
    expect(html).toContain("Health");
    expect(html).toContain("Search memory");
  });

  it("provides Simplified Chinese copy", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(<MemoryPage />);

    expect(html).toContain("<h1>记忆</h1>");
    expect(html).toContain("情景记忆");
    expect(html).toContain("健康状态");
  });
});
