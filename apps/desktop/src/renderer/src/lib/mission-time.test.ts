import { describe, expect, it } from "vitest";

import { formatMissionDateTime, formatMissionTime } from "./mission-time.ts";

describe("mission time formatting", () => {
  const now = Date.parse("2026-07-15T12:00:00.000Z");

  it("uses compact relative labels for recent mission activity", () => {
    expect(formatMissionTime("2026-07-15T11:59:30.000Z", now)).toBe("Now");
    expect(formatMissionTime("2026-07-15T11:42:00.000Z", now)).toBe("18m");
    expect(formatMissionTime("2026-07-15T08:00:00.000Z", now)).toBe("4h");
    expect(formatMissionTime("2026-07-13T12:00:00.000Z", now)).toBe("2d");
  });

  it("handles invalid timestamps without leaking invalid date copy", () => {
    expect(formatMissionTime("invalid", now)).toBe("");
    expect(formatMissionDateTime("invalid")).toBe("");
  });
});
