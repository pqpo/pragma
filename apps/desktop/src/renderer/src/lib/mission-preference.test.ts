import { describe, expect, it, vi } from "vitest";

import {
  readLastOpenedMissionId,
  selectPreferredMissionId,
  writeLastOpenedMissionId,
} from "./mission-preference.ts";

describe("mission preference", () => {
  it("reads and writes the last opened Mission", () => {
    expect(readLastOpenedMissionId({ getItem: () => " mission-id " })).toBe("mission-id");
    expect(readLastOpenedMissionId({ getItem: () => null })).toBeNull();

    const setItem = vi.fn();
    writeLastOpenedMissionId({ setItem, removeItem: vi.fn() }, "mission-id");

    expect(setItem).toHaveBeenCalledWith("pragma.desktop.missions.last-opened-id", "mission-id");
  });

  it("clears the preference and tolerates unavailable storage", () => {
    const removeItem = vi.fn();
    writeLastOpenedMissionId({ setItem: vi.fn(), removeItem }, null);
    expect(removeItem).toHaveBeenCalledWith("pragma.desktop.missions.last-opened-id");

    expect(
      readLastOpenedMissionId({
        getItem: () => {
          throw new Error("unavailable");
        },
      }),
    ).toBeNull();
    expect(() =>
      writeLastOpenedMissionId(
        {
          setItem: () => {
            throw new Error("unavailable");
          },
          removeItem: () => {
            throw new Error("unavailable");
          },
        },
        "mission-id",
      ),
    ).not.toThrow();
  });

  it("prefers the last opened Mission and falls back to the first sorted Mission", () => {
    const missions = [{ id: "newest" }, { id: "older" }];
    expect(selectPreferredMissionId(missions, "older")).toBe("older");
    expect(selectPreferredMissionId(missions, "deleted")).toBe("newest");
    expect(selectPreferredMissionId([], "deleted")).toBeNull();
  });
});
