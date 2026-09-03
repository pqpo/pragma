import { describe, expect, it, vi } from "vitest";

import {
  markMissionOutputReadIds,
  missionChatUpdateHasUserVisibleOutput,
  readUnreadMissionOutputIds,
  recordMissionOutputIds,
  writeUnreadMissionOutputIds,
} from "./mission-unread-output.ts";

describe("Mission unread output state", () => {
  it("persists unread Mission ids and tolerates invalid local state", () => {
    expect(
      readUnreadMissionOutputIds({ getItem: () => '["mission-a","mission-b","mission-a"," "]' }),
    ).toEqual(["mission-a", "mission-b"]);
    expect(readUnreadMissionOutputIds({ getItem: () => "{invalid" })).toEqual([]);

    const setItem = vi.fn();
    writeUnreadMissionOutputIds({ setItem, removeItem: vi.fn() }, ["mission-a", "mission-a"]);
    expect(setItem).toHaveBeenCalledWith(
      "pragma.desktop.missions.unread-output-ids.v1",
      '["mission-a"]',
    );
  });

  it("removes local state when every Mission output has been read", () => {
    const removeItem = vi.fn();
    writeUnreadMissionOutputIds({ setItem: vi.fn(), removeItem }, []);
    expect(removeItem).toHaveBeenCalledWith("pragma.desktop.missions.unread-output-ids.v1");
  });

  it("clears unread output on open and marks later background output unread again", () => {
    const read = markMissionOutputReadIds(["mission-a"], "mission-a");
    expect(read).toEqual([]);
    expect(recordMissionOutputIds(read, "mission-a", "mission-b")).toEqual(["mission-a"]);
    expect(recordMissionOutputIds(["mission-a"], "mission-a", "mission-a")).toEqual([]);
  });

  it("recognizes visible Agent output but ignores user and bookkeeping-only patches", () => {
    const base = { missionId: "00000000-0000-4000-8000-000000000001", revision: 1 } as const;
    expect(missionChatUpdateHasUserVisibleOutput({ ...base, kind: "invalidate" })).toBe(true);
    expect(
      missionChatUpdateHasUserVisibleOutput({
        ...base,
        kind: "patch",
        patches: [{ type: "entry.append", entryId: "reply", field: "content", delta: "new" }],
      }),
    ).toBe(true);
    expect(
      missionChatUpdateHasUserVisibleOutput({
        ...base,
        kind: "patch",
        patches: [
          {
            type: "context-window.update",
            usage: {
              usedTokens: 1,
              contextWindowTokens: 2,
              percent: 50,
              measurement: "reported",
              observedAt: "2026-09-03T00:00:00.000Z",
            },
          },
        ],
      }),
    ).toBe(false);
  });
});
