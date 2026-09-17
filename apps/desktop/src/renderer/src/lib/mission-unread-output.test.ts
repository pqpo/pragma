import { describe, expect, it, vi } from "vitest";
import type { MissionChatUpdate } from "../../../shared/contracts/index.ts";

import {
  acceptMissionChatUpdate,
  markMissionOutputReadIds,
  missionChatUpdateHasUserVisibleOutput,
  readUnreadMissionOutputIds,
  recordMissionChatUpdateIds,
  recordMissionOutputIds,
  writeUnreadMissionOutputIds,
} from "./mission-unread-output.ts";

const streamId = "00000000-0000-4000-8000-000000000099";

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

  it("uses the selection captured when output arrives even if the state update runs later", () => {
    const update: MissionChatUpdate = {
      missionId: "00000000-0000-4000-8000-000000000001",
      streamId,
      revision: 1,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "reply", field: "content", delta: "new" }],
    };
    let selectedMissionId: string = update.missionId;
    const selectedMissionIdAtReceipt = selectedMissionId;
    const deferredStateUpdate = (current: readonly string[]) =>
      recordMissionChatUpdateIds(current, update, selectedMissionIdAtReceipt);

    selectedMissionId = "00000000-0000-4000-8000-000000000002";

    expect(selectedMissionId).not.toBe(selectedMissionIdAtReceipt);
    expect(deferredStateUpdate([])).toEqual([]);
  });

  it("marks output unread when it arrives after switching to another Mission", () => {
    const update: MissionChatUpdate = {
      missionId: "00000000-0000-4000-8000-000000000001",
      streamId,
      revision: 1,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "reply", field: "content", delta: "new" }],
    };

    expect(recordMissionChatUpdateIds([], update, "00000000-0000-4000-8000-000000000002")).toEqual([
      update.missionId,
    ]);
  });

  it("does not resurrect a cleared dot when an invalidation arrives after switching away", () => {
    const base = { missionId: "mission-a", streamId, revision: 2 } as const;
    const afterOpen = markMissionOutputReadIds(["mission-a"], "mission-a");
    const afterSwitch = missionChatUpdateHasUserVisibleOutput({ ...base, kind: "invalidate" })
      ? recordMissionOutputIds(afterOpen, "mission-a", "mission-b")
      : afterOpen;

    expect(afterSwitch).toEqual([]);
  });

  it("recognizes visible Agent output but ignores user and bookkeeping-only patches", () => {
    const base = {
      missionId: "00000000-0000-4000-8000-000000000001",
      streamId,
      revision: 1,
    } as const;
    expect(missionChatUpdateHasUserVisibleOutput({ ...base, kind: "invalidate" })).toBe(false);
    expect(
      missionChatUpdateHasUserVisibleOutput({
        ...base,
        kind: "invalidate",
        userVisibleOutput: true,
      }),
    ).toBe(true);
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

  it("ignores finalAnswer and streaming-only upserts for content already displayed", () => {
    const missionId = "00000000-0000-4000-8000-000000000001";
    const current = {
      id: "reply",
      kind: "assistant" as const,
      content: "already visible",
      streaming: true,
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    expect(
      missionChatUpdateHasUserVisibleOutput(
        {
          missionId,
          streamId,
          revision: 2,
          kind: "patch",
          patches: [
            {
              type: "entry.upsert",
              entry: { ...current, streaming: false, finalAnswer: true },
            },
          ],
        },
        [current],
      ),
    ).toBe(false);
  });

  it("rejects duplicate and older revisions within one persisted stream epoch", () => {
    const update: MissionChatUpdate = {
      missionId: "00000000-0000-4000-8000-000000000001",
      streamId: "00000000-0000-4000-8000-000000000002",
      revision: 7,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "reply", field: "content", delta: "new" }],
    };
    const first = acceptMissionChatUpdate({}, update);
    expect(first.accepted).toBe(true);
    expect(acceptMissionChatUpdate(first.boundaries, update).accepted).toBe(false);
    expect(acceptMissionChatUpdate(first.boundaries, { ...update, revision: 6 }).accepted).toBe(
      false,
    );
    expect(
      acceptMissionChatUpdate(first.boundaries, {
        ...update,
        streamId: "00000000-0000-4000-8000-000000000003",
        revision: 1,
      }).accepted,
    ).toBe(true);
  });
});
