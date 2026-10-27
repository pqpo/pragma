import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopMemoryExtractionBoard,
  MissionChatUpdate,
  MissionStatusUpdate,
  MissionSummary,
  MissionUpdate,
} from "../../../shared/contracts/index.ts";
import { createNavigationAttentionMonitor } from "./navigation-attention-monitor.ts";
import { emptyNavigationAttention } from "./navigation-attention.ts";
import {
  readMissionOutputBoundaries,
  readUnreadMissionOutputIds,
  writeUnreadMissionOutputIds,
} from "./mission-unread-output.ts";

type API = Parameters<typeof createNavigationAttentionMonitor>[0];
const executionId = "00000000-0000-4000-8000-000000000009";
const task: MissionSummary = {
  id: "task",
  title: "Task",
  workspace: { basename: "workspace" },
  executor: { kind: "expert", name: "Expert" },
  source: { type: "task" },
  lifecycleStatus: "active",
  updatedAt: "2026-10-22T00:00:00.000Z",
};
const board = (attention = 0): DesktopMemoryExtractionBoard => {
  const lane = () => ({ tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 });
  return {
    lanes: {
      waiting: lane(),
      attention: { ...lane(), totalTasks: attention },
      running: lane(),
      completed: lane(),
    },
  };
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  await vi.advanceTimersByTimeAsync(0);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  const events = new EventTarget();
  vi.stubGlobal("window", events);
  let chat: (update: MissionChatUpdate) => void = () => undefined;
  let update: (update: MissionUpdate) => void = () => undefined;
  let status: (update: MissionStatusUpdate) => void = () => undefined;
  const unsubscribes = [vi.fn(), vi.fn(), vi.fn()];
  const api = {
    listMissions: vi.fn<API["listMissions"]>().mockResolvedValue([task]),
    listSkillRevisionJobs: vi.fn<API["listSkillRevisionJobs"]>().mockResolvedValue([]),
    listContextStoreRevisions: vi.fn<API["listContextStoreRevisions"]>().mockResolvedValue([]),
    listMemoryExtractionJobs: vi.fn<API["listMemoryExtractionJobs"]>().mockResolvedValue(board()),
    subscribeMissionChatUpdates: (listener: typeof chat) => {
      chat = listener;
      return unsubscribes[0]!;
    },
    subscribeMissionUpdates: (listener: typeof update) => {
      update = listener;
      return unsubscribes[1]!;
    },
    subscribeMissionStatusUpdates: (listener: typeof status) => {
      status = listener;
      return unsubscribes[2]!;
    },
  } satisfies API;
  const activity = { missions: false, memory: true };
  const onChange = vi.fn();
  const start = () => {
    const monitor = createNavigationAttentionMonitor(api, {
      storage,
      events,
      missionsActive: () => activity.missions,
      memoryEnabled: () => activity.memory,
      onChange,
    });
    cleanups.push(() => monitor.dispose());
    return monitor;
  };
  return {
    api,
    storage,
    activity,
    onChange,
    unsubscribes,
    start,
    chat: (event: MissionChatUpdate) => chat(event),
    update: (event: MissionUpdate) => update(event),
    status: (event: MissionStatusUpdate) => status(event),
    latest: () => onChange.mock.lastCall?.[0] ?? emptyNavigationAttention,
  };
}
function output(missionId = task.id, revision = 1): MissionChatUpdate {
  return {
    missionId,
    streamId: executionId,
    revision,
    kind: "patch",
    patches: [{ type: "entry.append", entryId: "reply", field: "content", delta: "answer" }],
  };
}

describe("navigation attention monitor", () => {
  it.each(["task", "automation"] as const)(
    "keeps completed %s unread output excluded across live events and stale refreshes",
    async (sourceType) => {
      const f = fixture();
      const source =
        sourceType === "task"
          ? ({ type: "task" } as const)
          : ({ type: "automation", automationRef: "automation:daily" } as const);
      const summary = { ...task, source };
      f.api.listMissions.mockResolvedValue([summary]);
      const event = (lifecycleStatus: "active" | "completed"): MissionUpdate => ({
        kind: "upsert",
        source,
        mission: {
          schemaVersion: "pragma.mission/v12",
          id: task.id,
          title: task.title,
          origin: source.type === "automation" ? source : { type: "user" },
          goal: "Research",
          initialMessageId: executionId,
          workspace: { path: "/workspace", basename: "workspace" },
          project: { id: "studio", revision: 1 },
          contextMounts: [],
          executor: { kind: "expert", ref: "expert:v2vt1v01vzz6j24q", name: "Expert" },
          lifecycleStatus,
          createdAt: task.updatedAt,
          updatedAt: task.updatedAt,
        },
      });
      const monitor = f.start();
      await monitor.refresh();
      f.chat(output());
      expect(f.latest().missions).toBe(true);
      const snapshot = deferred<MissionSummary[]>();
      f.api.listMissions.mockReturnValueOnce(snapshot.promise);
      const refresh = monitor.refresh();
      await vi.advanceTimersByTimeAsync(0);
      f.update(event("completed"));
      expect(f.latest().missions).toBe(false);
      f.chat(output(task.id, 2));
      expect(f.latest().missions).toBe(false);
      snapshot.resolve([summary]);
      await refresh;
      expect(f.latest().missions).toBe(false);
      expect(readUnreadMissionOutputIds(f.storage)).toContain(task.id);
      f.update(event("active"));
      expect(f.latest().missions).toBe(true);
    },
  );

  it("ignores completed automation unread output while retaining active Mission reminders", async () => {
    const f = fixture();
    const automation: MissionSummary = {
      ...task,
      id: "automation",
      source: { type: "automation", automationRef: "automation:daily" },
      lifecycleStatus: "completed",
    };
    f.api.listMissions.mockResolvedValue([task, automation]);
    writeUnreadMissionOutputIds(f.storage, [automation.id]);
    const monitor = f.start();
    await monitor.refresh();
    expect(f.latest().missions).toBe(false);
    f.chat(output());
    expect(f.latest().missions).toBe(true);
    f.api.listMissions.mockResolvedValue([{ ...task, lifecycleStatus: "completed" }, automation]);
    await monitor.refresh();
    expect(f.latest().missions).toBe(false);
    expect(readUnreadMissionOutputIds(f.storage)).toContain(task.id);
    f.api.listMissions.mockResolvedValue([task, automation]);
    await monitor.refresh();
    expect(f.latest().missions).toBe(true);
  });

  it("does not rerender the shell for every output chunk when the badge is unchanged", async () => {
    const f = fixture();
    const monitor = f.start();
    await monitor.refresh();
    f.chat(output());
    await vi.advanceTimersByTimeAsync(0);
    f.onChange.mockClear();
    f.chat(output(task.id, 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onChange).not.toHaveBeenCalled();
  });
  it("retains the rest of the initial snapshot when a concurrent status event arrives", async () => {
    const f = fixture();
    writeUnreadMissionOutputIds(f.storage, [task.id]);
    const request = deferred<MissionSummary[]>();
    f.api.listMissions.mockReturnValue(request.promise);
    const monitor = f.start();
    const loaded = monitor.refresh();
    await vi.advanceTimersByTimeAsync(0);
    f.status({
      missionId: "other",
      revision: 1,
      execution: { id: executionId, status: "running" },
    });
    request.resolve([
      task,
      { ...task, id: "other", execution: { id: executionId, status: "queued" } },
    ]);
    await loaded;
    expect(f.latest().missions).toBe(true);
    expect(f.api.listMissions).toHaveBeenCalledTimes(1);
    expect(f.api.listMemoryExtractionJobs).toHaveBeenCalledTimes(1);
  });

  it("shows revision dots only while user action is needed", async () => {
    const f = fixture();
    const skill = { job: { state: "pending_review" } } as Awaited<
      ReturnType<API["listSkillRevisionJobs"]>
    >[number];
    const knowledge = { state: "pending_review" } as Awaited<
      ReturnType<API["listContextStoreRevisions"]>
    >[number];
    f.api.listSkillRevisionJobs.mockResolvedValue([
      { ...skill, job: { ...skill.job, state: "running" } },
    ]);
    f.api.listContextStoreRevisions.mockResolvedValue([{ ...knowledge, state: "running" }]);
    const monitor = f.start();
    await monitor.refresh();
    expect(f.latest()).toMatchObject({ studio: false, skills: false, knowledge: false });
    f.api.listSkillRevisionJobs.mockResolvedValue([skill]);
    f.api.listContextStoreRevisions.mockResolvedValue([knowledge]);
    await monitor.refresh();
    expect(f.latest()).toMatchObject({ studio: true, skills: true, knowledge: true });
    f.api.listSkillRevisionJobs.mockResolvedValue([
      { ...skill, job: { ...skill.job, state: "publishing" } },
    ]);
    await monitor.refresh();
    expect(f.latest()).toMatchObject({ studio: true, skills: false, knowledge: true });
    f.api.listContextStoreRevisions.mockResolvedValue([{ ...knowledge, state: "merging" }]);
    await monitor.refresh();
    expect(f.latest()).toMatchObject({ studio: false, skills: false, knowledge: false });
  });

  it("replays a concurrent status change over a stale snapshot and rejects older events", async () => {
    const f = fixture();
    const request = deferred<MissionSummary[]>();
    f.api.listMissions.mockReturnValue(request.promise);
    const monitor = f.start();
    await vi.advanceTimersByTimeAsync(0);
    f.status({
      missionId: task.id,
      revision: 2,
      execution: { id: executionId, status: "running" },
    });
    request.resolve([
      { ...task, execution: { id: executionId, status: "waiting", waitReason: "human_input" } },
    ]);
    await monitor.refresh();
    expect(f.latest().missions).toBe(false);
    f.status({
      missionId: task.id,
      revision: 1,
      execution: { id: executionId, status: "waiting" },
    });
    expect(f.latest().missions).toBe(false);
  });

  it("cleans deleted Mission output outside Missions and ignores late events and snapshots", async () => {
    const f = fixture();
    const monitor = f.start();
    await monitor.refresh();
    f.chat(output());
    expect(f.latest().missions).toBe(true);
    const request = deferred<MissionSummary[]>();
    f.api.listMissions.mockReturnValue(request.promise);
    const refresh = monitor.refresh();
    await vi.advanceTimersByTimeAsync(0);
    f.update({ kind: "remove", missionId: task.id });
    f.chat(output(task.id, 2));
    request.resolve([task]);
    await refresh;
    expect(f.latest().missions).toBe(false);
    expect(readUnreadMissionOutputIds(f.storage)).toEqual([]);
    expect(readMissionOutputBoundaries(f.storage)).toEqual({});
  });

  it("refreshes other badges while the Mission endpoint is still pending", async () => {
    const f = fixture();
    const request = deferred<MissionSummary[]>();
    f.api.listMissions.mockReturnValue(request.promise);
    const monitor = f.start();
    await vi.advanceTimersByTimeAsync(0);
    f.api.listMemoryExtractionJobs.mockResolvedValue(board(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.latest().memory).toBe(true);
    expect(f.api.listMemoryExtractionJobs).toHaveBeenCalledTimes(2);
    expect(f.api.listMissions).toHaveBeenCalledTimes(1);
    request.resolve([task]);
    await monitor.refresh();
  });

  it("lets the active page own read tracking, then resumes tracking after leaving it", async () => {
    const f = fixture();
    const monitor = f.start();
    await monitor.refresh();
    f.activity.missions = true;
    f.chat(output());
    expect(readUnreadMissionOutputIds(f.storage)).toEqual([]);
    writeUnreadMissionOutputIds(f.storage, [task.id]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.latest().missions).toBe(true);
    writeUnreadMissionOutputIds(f.storage, []);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.latest().missions).toBe(false);
    f.activity.missions = false;
    f.chat(output(task.id, 2));
    expect(f.latest().missions).toBe(true);
  });

  it("keeps last successful badges on failure, retries, and respects the Memory setting", async () => {
    const f = fixture();
    f.activity.memory = false;
    const monitor = f.start();
    await monitor.refresh();
    expect(f.api.listMemoryExtractionJobs).not.toHaveBeenCalled();
    f.activity.memory = true;
    f.api.listMemoryExtractionJobs.mockResolvedValue(board(1));
    await monitor.refresh();
    expect(f.latest().memory).toBe(true);
    f.api.listMemoryExtractionJobs.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await monitor.refresh();
    expect(f.latest().memory).toBe(true);
    f.api.listMemoryExtractionJobs.mockResolvedValue(board());
    await monitor.refresh();
    expect(f.latest().memory).toBe(false);
  });

  it("unsubscribes, stops polling and ignores in-flight results after disposal", async () => {
    const f = fixture();
    const request = deferred<MissionSummary[]>();
    f.api.listMissions.mockReturnValue(request.promise);
    const monitor = f.start();
    await vi.advanceTimersByTimeAsync(0);
    monitor.dispose();
    f.onChange.mockClear();
    request.resolve([task]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.onChange).not.toHaveBeenCalled();
    expect(f.api.listMissions).toHaveBeenCalledTimes(1);
    expect(f.unsubscribes.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
  });
});
