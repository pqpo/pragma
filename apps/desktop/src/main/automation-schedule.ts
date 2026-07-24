import { Cron } from "croner";
import type { PragmaScheduleTrigger } from "@pragma/interpreter/ast";

const WEEKDAY_NUMBER = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
} as const;

export function previewScheduleOccurrences(
  trigger: PragmaScheduleTrigger,
  from = new Date(),
  count = 5,
): Date[] {
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error("Schedule preview count must be between 1 and 10.");
  }
  if (trigger.kind === "once") {
    const occurrence = new Date(trigger.at);
    return occurrence.getTime() > from.getTime() ? [occurrence] : [];
  }
  if (trigger.kind === "interval") {
    const everyMs = intervalMilliseconds(trigger.every, trigger.unit);
    const anchor = Date.parse(trigger.anchorAt);
    const firstIndex = Math.max(0, Math.floor((from.getTime() - anchor) / everyMs) + 1);
    const occurrences: Date[] = [];
    for (let index = firstIndex; occurrences.length < count; index += 1) {
      const occurrence = new Date(anchor + index * everyMs);
      if (!withinWindow(occurrence, trigger.window)) continue;
      if (pastWindow(occurrence, trigger.window)) break;
      occurrences.push(occurrence);
    }
    return occurrences;
  }

  assertTimeZone(trigger.timezone);
  const expression = trigger.kind === "cron" ? trigger.expression : calendarCronExpression(trigger);
  const window = trigger.window;
  const startAt =
    window?.startsAt === undefined
      ? from
      : new Date(Math.max(from.getTime(), Date.parse(window.startsAt) - 1));
  const cron = new Cron(expression, {
    timezone: trigger.timezone,
    paused: true,
  });
  return cron
    .nextRuns(Math.max(count * 3, count), startAt)
    .filter((date) => date.getTime() > from.getTime() && withinWindow(date, window))
    .slice(0, count);
}

export function nextScheduleOccurrence(
  trigger: PragmaScheduleTrigger,
  from = new Date(),
): Date | undefined {
  return previewScheduleOccurrences(trigger, from, 1)[0];
}

function calendarCronExpression(
  trigger: Extract<PragmaScheduleTrigger, { readonly kind: "calendar" }>,
): string {
  const [hour, minute] = trigger.time.split(":").map(Number) as [number, number];
  switch (trigger.frequency) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${trigger.weekdays!.map((day) => WEEKDAY_NUMBER[day]).join(",")}`;
    case "monthly":
      return `${minute} ${hour} ${trigger.dayOfMonth!} * *`;
  }
}

function intervalMilliseconds(
  every: number,
  unit: Extract<PragmaScheduleTrigger, { readonly kind: "interval" }>["unit"],
): number {
  const minute = 60_000;
  switch (unit) {
    case "minutes":
      return every * minute;
    case "hours":
      return every * 60 * minute;
    case "days":
      return every * 24 * 60 * minute;
    case "weeks":
      return every * 7 * 24 * 60 * minute;
  }
}

function withinWindow(
  occurrence: Date,
  window:
    | Extract<PragmaScheduleTrigger, { readonly kind: "interval" | "calendar" | "cron" }>["window"]
    | undefined,
): boolean {
  return (
    (window?.startsAt === undefined || occurrence.getTime() >= Date.parse(window.startsAt)) &&
    (window?.endsAt === undefined || occurrence.getTime() <= Date.parse(window.endsAt))
  );
}

function pastWindow(
  occurrence: Date,
  window:
    | Extract<PragmaScheduleTrigger, { readonly kind: "interval" | "calendar" | "cron" }>["window"]
    | undefined,
): boolean {
  return window?.endsAt !== undefined && occurrence.getTime() > Date.parse(window.endsAt);
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new Error(`Invalid IANA timezone: ${timeZone}`);
  }
}
