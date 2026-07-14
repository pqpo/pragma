import { describe, expect, it } from "vitest";

import { readCurrentLocalTime } from "../src/support/current-time.ts";

describe("current local time", () => {
  it("formats the local clock with an explicit offset and IANA time zone", () => {
    const current = readCurrentLocalTime(new Date(2026, 6, 14, 10, 3, 35, 123));

    expect(current).toEqual({
      timestamp: expect.stringMatching(/^2026-07-14T10:03:35\.123[+-]\d{2}:\d{2}$/),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });
});
