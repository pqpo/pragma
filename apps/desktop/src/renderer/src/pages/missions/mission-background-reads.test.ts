import { expect, it, vi } from "vitest";
import type {
  MissionConversationState,
  MissionContextWindowSnapshot,
} from "../../../../shared/contracts/index.ts";
import { createMissionBackgroundReads, createMissionRefresh } from "./mission-background-reads.ts";
import {
  applyMissionChatPatches,
  createMissionConversationBase,
} from "./mission-conversation-model.ts";
import { mergeContextWindow, mergeConversationState } from "./use-mission-conversation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const state: MissionConversationState = {
  missionId: "mission",
  revision: 1,
  pendingInteractions: [],
  deliveries: [],
  hiddenEntryIds: [],
};
const context: MissionContextWindowSnapshot = { missionId: "mission", revision: 1 };

it("hydrates Context independently after a stale in-flight read while live output is already applied", async () => {
  const gate = deferred<MissionContextWindowSnapshot>();
  let snapshot = createMissionConversationBase("mission");
  const getMissionContextWindow = vi
    .fn()
    .mockReturnValueOnce(gate.promise)
    .mockResolvedValue({
      missionId: "mission",
      revision: 1,
      contextWindow: { supportsInspection: true, supportsCompaction: false, canCompact: false },
    });
  const reads = createMissionBackgroundReads({
    api: { getMissionConversationState: vi.fn().mockResolvedValue(state), getMissionContextWindow },
    missionId: "mission",
    onControl: vi.fn(),
    onContext: (value) => {
      snapshot = mergeContextWindow(snapshot, value)!;
    },
    onControlError: vi.fn(),
    onContextError: vi.fn(),
  });
  const pending = reads.refreshContext();
  snapshot = applyMissionChatPatches(
    snapshot,
    [
      {
        type: "context-window.update",
        usage: {
          usedTokens: 1,
          contextWindowTokens: 100,
          percent: 1,
          measurement: "reported",
          observedAt: "2026-10-01T00:00:00.000Z",
        },
      },
      {
        type: "entry.upsert",
        entry: {
          id: "answer",
          kind: "assistant",
          content: "ok",
          streaming: true,
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      },
    ],
    1,
  )!;
  void reads.refreshContext();
  expect(snapshot.entries[0]).toMatchObject({ content: "ok" });
  expect(snapshot.contextWindow).toBeUndefined();
  gate.resolve({ missionId: "mission", revision: 0 });
  await pending;
  await vi.waitFor(() => expect(snapshot.contextWindow?.supportsInspection).toBe(true));
  expect(getMissionContextWindow).toHaveBeenCalledTimes(2);
  expect(snapshot.entries[0]).toMatchObject({ content: "ok" });
  reads.close();
});

it("applies control before a slow Context, coalesces each burst, and discards late results on close", async () => {
  const controlGate = deferred<MissionConversationState>();
  const contextGate = deferred<MissionContextWindowSnapshot>();
  const getMissionConversationState = vi
    .fn()
    .mockReturnValueOnce(controlGate.promise)
    .mockResolvedValue(state);
  const getMissionContextWindow = vi.fn().mockReturnValue(contextGate.promise);
  const onControl = vi.fn();
  const onContext = vi.fn();
  const reads = createMissionBackgroundReads({
    api: { getMissionConversationState, getMissionContextWindow },
    missionId: "mission",
    onControl,
    onContext,
    onControlError: vi.fn(),
    onContextError: vi.fn(),
  });
  const controlReading = reads.refreshControl();
  const contextReading = reads.refreshContext();
  for (let index = 0; index < 10; index++) {
    void reads.refreshControl();
    void reads.refreshContext();
  }
  expect(getMissionConversationState).toHaveBeenCalledTimes(1);
  controlGate.resolve(state);
  await controlReading;
  await Promise.resolve();
  expect(onControl).toHaveBeenCalledWith(state);
  expect(getMissionConversationState).toHaveBeenCalledTimes(2);
  expect(onContext).not.toHaveBeenCalled();
  reads.close();
  contextGate.resolve(context);
  await contextReading;
  expect(onContext).not.toHaveBeenCalled();
  expect(getMissionContextWindow).toHaveBeenCalledTimes(1);
});

it.each(["control", "context"] as const)(
  "isolates a %s failure and retries only that reader",
  async (kind) => {
    const error = new Error("read unavailable");
    const getMissionConversationState = vi.fn().mockResolvedValue(state);
    const getMissionContextWindow = vi.fn().mockResolvedValue(context);
    const failedRead = kind === "control" ? getMissionConversationState : getMissionContextWindow;
    const otherRead = kind === "control" ? getMissionContextWindow : getMissionConversationState;
    failedRead.mockRejectedValueOnce(error);
    const onContext = vi.fn();
    const onControl = vi.fn();
    const onControlError = vi.fn();
    const onContextError = vi.fn();
    const reads = createMissionBackgroundReads({
      api: { getMissionConversationState, getMissionContextWindow },
      missionId: "mission",
      onControl,
      onContext,
      onControlError,
      onContextError,
    });
    await Promise.all([reads.refreshControl(), reads.refreshContext()]);
    expect(kind === "control" ? onControlError : onContextError).toHaveBeenCalledWith(error);
    expect(kind === "control" ? onContext : onControl).toHaveBeenCalledWith(
      kind === "control" ? context : state,
    );
    await (kind === "control" ? reads.refreshControl() : reads.refreshContext());
    expect(kind === "control" ? onControl : onContext).toHaveBeenCalledWith(
      kind === "control" ? state : context,
    );
    expect(otherRead).toHaveBeenCalledTimes(1);
  },
);

it("shares a slow history read and lets action callers await its one dirty follow-up", async () => {
  const first = deferred<void>();
  const next = deferred<void>();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
  const refresh = createMissionRefresh(read, () => false);
  const initial = refresh();
  for (let i = 0; i < 10; i++) expect(refresh()).toBe(initial);
  expect(read).toHaveBeenCalledTimes(1);
  let settled = false;
  void initial.then(() => {
    settled = true;
  });
  first.resolve();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  expect(settled).toBe(false);
  next.resolve();
  await initial;
  expect(settled).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
});

it("lets all control callers await the dirty follow-up without waiting for Context", async () => {
  const first = deferred<MissionConversationState>();
  const next = deferred<MissionConversationState>();
  const contextGate = deferred<MissionContextWindowSnapshot>();
  const onControl = vi.fn();
  const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
  const reads = createMissionBackgroundReads({
    api: { getMissionConversationState: read, getMissionContextWindow: () => contextGate.promise },
    missionId: "mission",
    onControl,
    onContext: vi.fn(),
    onControlError: vi.fn(),
    onContextError: vi.fn(),
  });
  void reads.refreshContext();
  const initial = reads.refreshControl();
  const action = reads.refreshControl();
  expect(action).toBe(initial);
  let settled = false;
  void action.then(() => {
    settled = true;
  });
  first.resolve(state);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(settled).toBe(false);
  const fresh = { ...state, revision: 2 };
  next.resolve(fresh);
  await action;
  expect(onControl).toHaveBeenLastCalledWith(fresh);
  expect(settled).toBe(true);
  reads.close();
  contextGate.resolve(context);
});

it("settles a control refresh during continuous text output without rereading control", async () => {
  const gate = deferred<MissionConversationState>();
  let snapshot = mergeConversationState(createMissionConversationBase("mission"), {
    ...state,
    revision: 0,
  })!;
  snapshot = applyMissionChatPatches(
    snapshot,
    [
      {
        type: "entry.upsert",
        entry: {
          id: "answer",
          kind: "assistant",
          content: "",
          streaming: true,
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      },
    ],
    1,
  )!;
  const read = vi
    .fn()
    .mockReturnValueOnce(gate.promise)
    .mockResolvedValue({ ...state, revision: 20 });
  const reads = createMissionBackgroundReads({
    api: {
      getMissionConversationState: read,
      getMissionContextWindow: vi.fn().mockResolvedValue(context),
    },
    missionId: "mission",
    onControl: (value) => {
      if (value.revision < Math.max(snapshot.stateRevision ?? 0, snapshot.controlRevision ?? 0)) {
        void reads.refreshControl();
        return;
      }
      snapshot = mergeConversationState(snapshot, value)!;
    },
    onContext: vi.fn(),
    onControlError: vi.fn(),
    onContextError: vi.fn(),
  });
  const pending = reads.refreshControl();
  for (let revision = 2; revision <= 20; revision++) {
    snapshot = applyMissionChatPatches(
      snapshot,
      [{ type: "entry.append", entryId: "answer", field: "content", delta: "x" }],
      revision,
    )!;
  }
  gate.resolve(state);
  await pending;
  expect(read).toHaveBeenCalledTimes(1);
  expect(snapshot.stateRevision).toBe(1);
  expect(snapshot.revision).toBe(20);
  expect(snapshot.entries[0]).toMatchObject({ content: "x".repeat(19), streaming: true });
  reads.close();
});
