const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatMissionTime(isoTimestamp: string, now = Date.now()): string {
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) return "";

  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE_MS) return i18n.t("now", { ns: "missions" });
  if (elapsed < HOUR_MS)
    return i18n.t("minutesShort", { ns: "missions", count: Math.floor(elapsed / MINUTE_MS) });
  if (elapsed < DAY_MS)
    return i18n.t("hoursShort", { ns: "missions", count: Math.floor(elapsed / HOUR_MS) });
  if (elapsed < 7 * DAY_MS)
    return i18n.t("daysShort", { ns: "missions", count: Math.floor(elapsed / DAY_MS) });

  return new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

export function formatMissionDateTime(isoTimestamp: string): string {
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) return "";

  return new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}
import { i18n } from "../i18n/index.ts";
