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

  it.each([
    ["en", "The built-in general-purpose Agent for everyday work and expert orchestration."],
    ["zh-Hans", "内置通用 Agent，可直接处理日常工作并协调专业专家。"],
    ["zh-Hant", "內建通用 Agent，可直接處理日常工作並協調專業專家。"],
  ] as const)("renders the built-in Pragma description in %s", async (locale, expected) => {
    await i18n.changeLanguage(locale);
    expect(i18n.t("builtInExperts.pragma.description", { ns: "common" })).toBe(expected);
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
