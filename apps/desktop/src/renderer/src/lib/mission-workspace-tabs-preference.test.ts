import { describe, expect, it } from "vitest";
import type { MissionSummary } from "../../../shared/contracts/index.ts";
import {
  EMPTY_MISSION_WORKSPACE_TABS,
  reconcileMissionWorkspaceTabs,
  visibleMissionWorkspaces,
  addMissionWorkspaceTab,
  closeMissionWorkspaceTab,
  moveMissionWorkspaceTab,
  readMissionWorkspaceTabs,
  writeMissionWorkspaceTabs,
} from "./mission-workspace-tabs-preference.ts";
const mission = (
  path: string,
  updatedAt = "2026-10-22T00:00:00.000Z",
  completed = false,
): MissionSummary => ({
  id: path,
  title: path,
  workspace: { path, basename: path.slice(1) },
  executor: { kind: "expert", name: "Pragma" },
  source: { type: "task" },
  lifecycleStatus: completed ? "completed" : "active",
  updatedAt,
});
function storageFixture() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
const paths = (state: Parameters<typeof visibleMissionWorkspaces>[1]) =>
  visibleMissionWorkspaces([], state).map((workspace) => workspace.path);

describe("durable workspace tabs", () => {
  it("initializes once from active conversations, most recent first, and writes a real v1 record", () => {
    const storage = storageFixture();
    expect(readMissionWorkspaceTabs(storage).status).toBe("missing");
    const state = reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, [
      mission("/old"),
      mission("/recent", "2026-10-22T10:00:00.000Z"),
      mission("/done", undefined, true),
    ]);
    expect(paths(state)).toEqual(["/recent", "/old"]);
    expect(writeMissionWorkspaceTabs(storage, state)).toBe(true);
    expect(JSON.parse([...storage.values.values()][0]!)).toMatchObject({
      schemaVersion: "pragma.desktop.workspace-tabs/v1",
      initialized: true,
      orderPaths: ["/recent", "/old"],
    });
    expect(readMissionWorkspaceTabs(storage)).toEqual({ status: "ready", state });
  });

  it("keeps a closed active workspace closed after restart and later task updates", () => {
    const storage = storageFixture();
    const missions = [mission("/a"), mission("/b")];
    const state = closeMissionWorkspaceTab(
      reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, missions),
      "/a",
    );
    expect(writeMissionWorkspaceTabs(storage, state)).toBe(true);
    const restored = readMissionWorkspaceTabs(storage);
    expect(restored.status).toBe("ready");
    if (restored.status !== "ready") throw new Error("Preference did not restore");
    const refreshed = reconcileMissionWorkspaceTabs(restored.state, [
      mission("/a", "2026-10-22T12:00:00.000Z"),
      mission("/b"),
    ]);
    expect(paths(refreshed)).toEqual(["/b"]);
    expect(paths(addMissionWorkspaceTab(refreshed, { path: "/a", basename: "a" }))).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("remembers closing every tab and does not reseed on startup", () => {
    let state = reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, [mission("/a")]);
    state = closeMissionWorkspaceTab(state, "/a");
    const storage = storageFixture();
    expect(writeMissionWorkspaceTabs(storage, state)).toBe(true);
    const restored = readMissionWorkspaceTabs(storage);
    if (restored.status !== "ready") throw new Error("Preference did not restore");
    expect(paths(reconcileMissionWorkspaceTabs(restored.state, [mission("/a")]))).toEqual([]);
  });

  it("prepends a new workspace without sorting existing tabs after status updates", () => {
    let state = reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, [
      mission("/a"),
      mission("/b"),
    ]);
    state = moveMissionWorkspaceTab(state, "/b", "/a", "before");
    state = reconcileMissionWorkspaceTabs(state, [
      mission("/a", "2026-10-22T12:00:00.000Z"),
      mission("/b"),
      mission("/new"),
    ]);
    expect(paths(state)).toEqual(["/new", "/b", "/a"]);
    state = closeMissionWorkspaceTab(state, "/new");
    // A newly submitted Mission explicitly opens its chosen workspace again.
    expect(paths(addMissionWorkspaceTab(state, { path: "/new", basename: "new" }))).toEqual([
      "/new",
      "/b",
      "/a",
    ]);
  });

  it("opens a previously completed-only workspace when it gains an active task, while respecting explicit closes", () => {
    const initial = reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, [
      mission("/completed-only", undefined, true),
      mission("/open"),
    ]);
    expect(paths(initial)).toEqual(["/open"]);
    const refreshed = reconcileMissionWorkspaceTabs(initial, [
      mission("/completed-only"),
      mission("/open"),
    ]);
    expect(paths(refreshed)).toEqual(["/completed-only", "/open"]);
    const closed = closeMissionWorkspaceTab(refreshed, "/completed-only");
    expect(
      paths(reconcileMissionWorkspaceTabs(closed, [mission("/completed-only"), mission("/open")])),
    ).toEqual(["/open"]);
  });

  it("persists drag order, supports both directions, and rejects foreign drop targets", () => {
    const original = reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, [
      mission("/a"),
      mission("/b"),
      mission("/c"),
    ]);
    let state = moveMissionWorkspaceTab(original, "/a", "/c", "after");
    expect(paths(state)).toEqual(["/b", "/c", "/a"]);
    state = moveMissionWorkspaceTab(state, "/a", "/b", "before");
    expect(paths(state)).toEqual(["/a", "/b", "/c"]);
    expect(moveMissionWorkspaceTab(state, "/foreign", "/b", "before")).toBe(state);
    const storage = storageFixture();
    expect(writeMissionWorkspaceTabs(storage, state)).toBe(true);
    expect(readMissionWorkspaceTabs(storage)).toEqual({ status: "ready", state });
  });

  it.each(["broken JSON", JSON.stringify({ schemaVersion: "pragma.desktop.workspace-tabs/v99" })])(
    "preserves corrupt and future records without overwriting: %s",
    (raw) => {
      const storage = storageFixture();
      const valid = reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, [mission("/a")]);
      expect(writeMissionWorkspaceTabs(storage, valid)).toBe(true);
      const key = [...storage.values.keys()][0]!;
      storage.values.set(key, raw);
      expect(readMissionWorkspaceTabs(storage).status).toBe("invalid");
      expect(writeMissionWorkspaceTabs(storage, valid)).toBe(false);
      expect(storage.values.get(key)).toBe(raw);
    },
  );

  it("does not persist a partial first-load snapshot or replace preferences on storage failure", () => {
    const storage = storageFixture();
    expect(writeMissionWorkspaceTabs(storage, EMPTY_MISSION_WORKSPACE_TABS)).toBe(false);
    expect(storage.values.size).toBe(0);
    expect(
      readMissionWorkspaceTabs({
        getItem() {
          throw new Error("unavailable");
        },
      }).status,
    ).toBe("unavailable");
    const valid = reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, [mission("/a")]);
    expect(
      writeMissionWorkspaceTabs(
        {
          ...storage,
          setItem() {
            throw new Error("quota");
          },
        },
        valid,
      ),
    ).toBe(false);
    expect(storage.values.size).toBe(0);
  });
});
