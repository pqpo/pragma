import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "./index.ts";
import { en, zhHans, zhHant } from "./resources.ts";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("desktop translations", () => {
  it("keeps every locale resource structurally complete", () => {
    expect(resourceKeys(zhHans)).toEqual(resourceKeys(en));
    expect(resourceKeys(zhHant)).toEqual(resourceKeys(en));
  });

  it.each([
    ["en", "Settings"],
    ["zh-Hans", "设置"],
    ["zh-Hant", "設定"],
  ] as const)("renders navigation in %s", async (locale, expected) => {
    await i18n.changeLanguage(locale);
    expect(i18n.t("navigation.settings", { ns: "common" })).toBe(expected);
  });

  it.each([
    ["en", "Your AI workspace"],
    ["zh-Hans", "你的 AI 工作空间"],
    ["zh-Hant", "你的 AI 工作空間"],
  ] as const)("renders the Home title in %s", async (locale, expected) => {
    await i18n.changeLanguage(locale);
    expect(i18n.t("title", { ns: "home" })).toBe(expected);
  });
});

function resourceKeys(value: object, prefix = ""): string[] {
  return Object.entries(value)
    .flatMap(([key, child]) => {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      return typeof child === "object" && child !== null ? resourceKeys(child, path) : [path];
    })
    .sort();
}
