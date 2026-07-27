import type { DesktopResolvedLocale } from "./contracts/index.ts";

const TRADITIONAL_CHINESE_REGIONS = new Set(["HK", "MO", "TW"]);

export function resolveDesktopLocale(
  preferredSystemLanguages: readonly string[],
): DesktopResolvedLocale {
  for (const languageTag of preferredSystemLanguages) {
    const locale = parseLocale(languageTag);
    if (locale === undefined) continue;
    if (locale.language === "en") return "en";
    if (locale.language !== "zh") continue;
    if (locale.script === "Hant") return "zh-Hant";
    if (locale.script === "Hans") return "zh-Hans";
    if (TRADITIONAL_CHINESE_REGIONS.has(locale.region ?? "")) return "zh-Hant";
    return "zh-Hans";
  }
  return "en";
}

function parseLocale(languageTag: string): Intl.Locale | undefined {
  try {
    return new Intl.Locale(languageTag.replaceAll("_", "-"));
  } catch {
    return undefined;
  }
}
