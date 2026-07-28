import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../i18n/index.ts";
import { formatTokens } from "./usage-format.ts";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("usage formatting", () => {
  it("formats large totals compactly for the active locale", async () => {
    expect(formatTokens(12_345)).toContain("12");

    await i18n.changeLanguage("zh-Hans");
    expect(formatTokens(12_345)).toContain("1.2");
  });
});
