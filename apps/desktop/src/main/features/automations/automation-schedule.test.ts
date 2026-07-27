import { describe, expect, it } from "vitest";

import { previewScheduleOccurrences } from "./automation-schedule.ts";

describe("Automation schedules", () => {
  it("previews fixed intervals from the first occurrence after the requested time", () => {
    const occurrences = previewScheduleOccurrences(
      {
        kind: "interval",
        every: 2,
        unit: "hours",
        anchorAt: "2026-07-23T00:00:00.000Z",
      },
      new Date("2026-07-23T03:00:00.000Z"),
      3,
    );

    expect(occurrences.map((value) => value.toISOString())).toEqual([
      "2026-07-23T04:00:00.000Z",
      "2026-07-23T06:00:00.000Z",
      "2026-07-23T08:00:00.000Z",
    ]);
  });

  it("applies IANA time zones to calendar schedules", () => {
    const occurrences = previewScheduleOccurrences(
      {
        kind: "calendar",
        frequency: "weekdays",
        time: "09:00",
        timezone: "Asia/Shanghai",
      },
      new Date("2026-07-23T02:00:00.000Z"),
      2,
    );

    expect(occurrences.map((value) => value.toISOString())).toEqual([
      "2026-07-24T01:00:00.000Z",
      "2026-07-27T01:00:00.000Z",
    ]);
  });

  it("respects active windows and rejects invalid time zones", () => {
    expect(
      previewScheduleOccurrences(
        {
          kind: "cron",
          expression: "0 * * * *",
          timezone: "UTC",
          window: {
            startsAt: "2026-07-23T02:30:00.000Z",
            endsAt: "2026-07-23T04:30:00.000Z",
          },
        },
        new Date("2026-07-23T00:00:00.000Z"),
        5,
      ).map((value) => value.toISOString()),
    ).toEqual(["2026-07-23T03:00:00.000Z", "2026-07-23T04:00:00.000Z"]);
    expect(() =>
      previewScheduleOccurrences(
        {
          kind: "cron",
          expression: "0 9 * * *",
          timezone: "Mars/Olympus",
        },
        new Date("2026-07-23T00:00:00.000Z"),
      ),
    ).toThrow("Invalid IANA timezone");
  });
});
