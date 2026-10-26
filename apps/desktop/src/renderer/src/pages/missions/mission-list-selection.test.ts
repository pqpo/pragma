import { expect, it } from "vitest";
import type { MissionSummary } from "../../../../shared/contracts/index.ts";
import {
  missionTabSelectionKey,
  filterMissionTabMissions,
  selectMissionTabId,
  resolveUnlistedMissionSelection,
} from "./mission-list-selection.ts";

it("retains an internal detail, falls back for a deleted Mission, and surfaces other read failures", async () => {
  await expect(
    resolveUnlistedMissionSelection({
      id: "hidden",
      getSource: async () => ({ type: "internal" }),
      isCurrent: () => true,
    }),
  ).resolves.toBe("detail");
  await expect(
    resolveUnlistedMissionSelection({
      id: "deleted",
      getSource: async () => {
        throw { code: "mission_not_found" };
      },
      isCurrent: () => true,
    }),
  ).resolves.toBe("deleted");
  const error = new Error("Host disconnected");
  await expect(
    resolveUnlistedMissionSelection({
      id: "hidden",
      getSource: async () => {
        throw error;
      },
      isCurrent: () => true,
    }),
  ).rejects.toBe(error);
});

it.each([false, true])(
  "ignores a stale source response after the user navigates (rejected=%s)",
  async (rejected) => {
    let complete!: () => void;
    const ready = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let current = true;
    const pending = resolveUnlistedMissionSelection({
      id: "hidden",
      getSource: async () => {
        await ready;
        if (rejected) throw new Error("stale error");
        return { type: "internal" };
      },
      isCurrent: () => current,
    });
    current = false;
    complete();
    await expect(pending).resolves.toBe("stale");
  },
);

function summary(id: string, overrides: Partial<MissionSummary> = {}): MissionSummary {
  return {
    id,
    title: id,
    workspace: { path: "/workspace/a", basename: "a" },
    executor: { kind: "expert", name: "Expert" },
    source: { type: "task" },
    lifecycleStatus: "active",
    updatedAt: "2026-10-26T00:00:00Z",
    ...overrides,
  };
}

it("defaults to the first displayed group and respects pins and update order", () => {
  const completed = summary("completed", { lifecycleStatus: "completed" });
  const older = summary("older", { updatedAt: "2026-10-25T00:00:00Z" });
  const newer = summary("newer");
  const waiting = summary("waiting", { execution: { status: "waiting" } });
  const pinnedWaiting = summary("pinned-waiting", {
    execution: { status: "waiting" },
    updatedAt: "2026-10-24T00:00:00Z",
  });
  expect(
    selectMissionTabId(
      [completed, older, newer, waiting, pinnedWaiting],
      ["older", "pinned-waiting"],
    ),
  ).toBe("pinned-waiting");
  expect(selectMissionTabId([completed, older, newer], [])).toBe("newer");
  expect(selectMissionTabId([completed, older, newer], ["older"])).toBe("older");
  expect(selectMissionTabId([completed], [])).toBe("completed");
  expect(selectMissionTabId([], [])).toBeNull();
});

it("restores a remembered conversation even when its group or order changes", () => {
  const first = summary("first");
  const second = summary("second", { lifecycleStatus: "completed" });
  expect(selectMissionTabId([first, second], [], "second")).toBe("second");
  expect(selectMissionTabId([first], [], "deleted-or-filtered")).toBe("first");
  expect(selectMissionTabId([], [], "second")).toBeNull();
});

it("keeps separate memories for every workspace and source, including all workspaces", () => {
  const all = missionTabSelectionKey("task", null);
  const a = missionTabSelectionKey("task", "/workspace/a");
  const b = missionTabSelectionKey("task", "/workspace/b");
  const automation = missionTabSelectionKey("automation", "/workspace/a");
  const selections = {
    [all]: "all-second",
    [a]: "a-second",
    [b]: "b-first",
    [automation]: "automation-second",
  };
  expect(new Set([all, a, b, automation]).size).toBe(4);
  // The parent retains this plain snapshot while the Missions page is unmounted.
  const restored = { ...selections };
  for (const [key, id] of Object.entries(restored)) {
    expect(selectMissionTabId([summary("first"), summary(id)], [], restored[key])).toBe(id);
  }
  expect(
    selectMissionTabId(
      [summary("first")],
      [],
      restored[missionTabSelectionKey("task", "/workspace/new")],
    ),
  ).toBe("first");
});

it("uses the same workspace, source and search candidates for every navigation path", () => {
  const entries = [
    summary("completed", { title: "Match completed", lifecycleStatus: "completed" }),
    summary("waiting", { title: "MATCH waiting", execution: { status: "waiting" } }),
    summary("other-workspace", {
      title: "Match elsewhere",
      workspace: { path: "/workspace/b", basename: "b" },
    }),
    summary("hidden", { title: "Match hidden", source: { type: "internal" } }),
    summary("filtered"),
  ];
  const candidates = filterMissionTabMissions(entries, "task", "/workspace/a", " match ");
  expect(candidates.map((entry) => entry.id)).toEqual(["completed", "waiting"]);
  expect(selectMissionTabId(candidates, [], "filtered")).toBe("waiting");
  const managed = summary("managed", {
    source: {
      type: "managed-automation",
      kind: "knowledge-revision",
      jobId: "job",
      storeId: "store",
    },
  });
  expect(filterMissionTabMissions([...entries, managed], "automation", null, "")).toEqual([
    managed,
  ]);
  expect(
    filterMissionTabMissions(entries, "task", "/workspace/b", "").map((entry) => entry.id),
  ).toEqual(["other-workspace"]);
});
