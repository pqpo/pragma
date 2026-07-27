import { i18n } from "../i18n/index.ts";

export function formatTokens(value: number): string {
  return new Intl.NumberFormat(i18n.language, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}
