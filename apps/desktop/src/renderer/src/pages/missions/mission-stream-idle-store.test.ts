import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { MissionChatEntry } from "../../../../shared/contracts/index.ts";
import {
  applyMissionChatUpdateBatch,
  isMissionCoordinatorChatEntry,
  mergeLatestChatPage,
} from "./mission-conversation-model.ts";
import { useMissionConversation } from "./use-mission-conversation.ts";
import { MissionThinkingPlaceholder } from "./mission-chat-presentation.tsx";
import {
  canShowMissionStreamWaiting,
  missionEntryOutputChanged,
  missionRefreshOutputCandidates,
  MissionStreamIdleStore,
} from "./mission-stream-idle-store.ts";

const answer = (content: string): Extract<MissionChatEntry, { kind: "assistant" }> => ({
  id: "answer",
  kind: "assistant",
  content,
  streaming: true,
  executionId: "execution",
  createdAt: "2026-09-29T00:00:00.000Z",
});

describe("Mission stream idle indicator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows on send, hides on output and returns only after one second of silence across turns", () => {
    const store = new MissionStreamIdleStore();
    store.configure(true, "execution", true);
    expect(store.getSnapshot()).toBe(true);
    for (let turn = 0; turn < 3; turn += 1) {
      store.output("execution");
      expect(store.getSnapshot()).toBe(false);
      vi.advanceTimersByTime(999);
      expect(store.getSnapshot()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(store.getSnapshot()).toBe(true);
    }
    store.stop();
  });

  it("resets the deadline on every token without notifying React for each token", () => {
    const store = new MissionStreamIdleStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.configure(true, "execution", true);
    store.output("execution");
    listener.mockClear();
    for (let token = 0; token < 20; token += 1) {
      vi.advanceTimersByTime(100);
      store.output("execution");
    }
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it("starts a fresh deadline when reopening an active execution without recent output", () => {
    const store = new MissionStreamIdleStore();
    store.configure(true, "execution", false);
    expect(store.getSnapshot()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(store.getSnapshot()).toBe(true);
    store.stop();
  });

  it("preserves a committed output deadline when execution state arrives after the output", () => {
    const store = new MissionStreamIdleStore();
    store.configure(true, undefined, true);
    store.output("execution");
    vi.advanceTimersByTime(500);
    store.configure(true, "execution", true);
    expect(store.getSnapshot()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(store.getSnapshot()).toBe(true);
    store.stop();
  });

  it("keeps the initial indicator when an empty entry only establishes execution identity", () => {
    const store = new MissionStreamIdleStore();
    store.configure(true, undefined, true);
    expect(missionEntryOutputChanged(undefined, answer(""))).toBe(false);
    store.configure(true, "execution", false);
    expect(store.getSnapshot()).toBe(true);
    store.stop();
  });

  it("keeps first output when a new execution commits before React updates its binding", () => {
    const store = new MissionStreamIdleStore();
    store.configure(true, "previous", true);
    store.output("next", "next");
    store.configure(true, "next", true);
    expect(store.getSnapshot()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(store.getSnapshot()).toBe(true);
    store.stop();
  });

  it("ignores old execution updates and resets for the next execution", () => {
    const store = new MissionStreamIdleStore();
    store.configure(true, "execution", true);
    store.output("old-execution");
    expect(store.getSnapshot()).toBe(true);
    store.output("execution");
    store.configure(true, "next-execution", false);
    store.output("execution");
    vi.advanceTimersByTime(1_000);
    expect(store.getSnapshot()).toBe(true);
    store.stop();
  });

  it("hides and cancels its timer when disabled or unmounted, then resumes", () => {
    const store = new MissionStreamIdleStore();
    store.configure(true, "execution", true);
    store.output("execution");
    store.configure(false, "execution", false);
    vi.advanceTimersByTime(5_000);
    expect(store.getSnapshot()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    store.configure(true, "execution", false);
    expect(store.getSnapshot()).toBe(true);
    store.stop();
    vi.advanceTimersByTime(5_000);
    expect(store.getSnapshot()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders an accessible text status with no spinner", () => {
    const html = renderToStaticMarkup(
      createElement(MissionThinkingPlaceholder, { executorName: "Pragma" }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Pragma");
    expect(html).toContain("<span>");
    expect(html).not.toContain("<svg");
  });
});

describe("committed Mission output", () => {
  it("counts changed text but ignores empty bodies, identical snapshots and streaming flags", () => {
    expect(missionEntryOutputChanged(undefined, answer(""))).toBe(false);
    expect(missionEntryOutputChanged(undefined, answer("Hello"))).toBe(true);
    expect(missionEntryOutputChanged(answer("Hello"), answer("Hello world"))).toBe(true);
    expect(
      missionEntryOutputChanged(answer("Hello"), { ...answer("Hello"), streaming: false }),
    ).toBe(false);
    expect(missionEntryOutputChanged(undefined, { ...answer("Reasoning"), kind: "thinking" })).toBe(
      true,
    );
    expect(
      missionEntryOutputChanged(undefined, {
        id: "user",
        kind: "user",
        content: "Question",
        createdAt: answer("").createdAt,
      }),
    ).toBe(false);
  });

  it("counts tool preview and completion changes, but not identical tool state", () => {
    const tool: MissionChatEntry = {
      id: "tool",
      kind: "tool",
      toolCallId: "call",
      toolName: "shell",
      status: "running",
      createdAt: answer("").createdAt,
    };
    expect(missionEntryOutputChanged(undefined, tool)).toBe(true);
    expect(missionEntryOutputChanged(tool, { ...tool })).toBe(false);
    expect(missionEntryOutputChanged(tool, { ...tool, inputPreview: "ls" })).toBe(true);
    expect(
      missionEntryOutputChanged(tool, { ...tool, status: "succeeded", outputPreview: "files" }),
    ).toBe(true);
  });
});

describe("Mission waiting eligibility", () => {
  it("suppresses waiting for inactive, completed and human interaction states", () => {
    expect(canShowMissionStreamWaiting(null, true, false, false)).toBe(true);
    expect(canShowMissionStreamWaiting(null, false, false, false)).toBe(false);
    expect(canShowMissionStreamWaiting(null, true, true, false)).toBe(false);
    expect(canShowMissionStreamWaiting(null, true, false, true)).toBe(false);
  });

  it("suppresses paused queues and recovery states", () => {
    const chat = {
      missionId: "mission",
      revision: 1,
      entries: [],
      page: {},
      pendingInteractions: [],
      execution: { id: "execution", status: "running" as const, interruptible: true },
    };
    expect(
      canShowMissionStreamWaiting(
        { ...chat, queue: { state: "paused", pendingCount: 1, supportsSteer: false, items: [] } },
        true,
        false,
        false,
      ),
    ).toBe(false);
    for (const state of [
      "reconciling",
      "orphaned",
      "interrupt_uncertain",
      "recovery_failed",
      "deletion_pending",
    ] as const) {
      expect(
        canShowMissionStreamWaiting(
          {
            ...chat,
            controlHealth: { state, observedAt: answer("").createdAt, availableActions: [] },
          },
          true,
          false,
          false,
        ),
      ).toBe(false);
    }
    // Approval status in history is not a current human-interaction signal: it remains
    // approval_required until the tool finishes, including after the user has approved it.
    const tool: MissionChatEntry = {
      id: "tool",
      kind: "tool",
      executionId: "execution",
      toolCallId: "call",
      toolName: "shell",
      status: "approval_required",
      createdAt: answer("").createdAt,
    };
    expect(canShowMissionStreamWaiting({ ...chat, entries: [tool] }, true, true, false)).toBe(
      false,
    );
    expect(canShowMissionStreamWaiting({ ...chat, entries: [tool] }, true, false, false)).toBe(
      true,
    );
  });
});

describe("Mission output visibility", () => {
  it("keeps the waiting indicator visible while hidden team members stream", () => {
    vi.useFakeTimers();
    const store = new MissionStreamIdleStore();
    store.configure(true, "execution", true);
    const hidden = { ...answer("Member is working"), executorId: "member" };
    if (isMissionCoordinatorChatEntry(hidden, "coordinator")) store.output(hidden.executionId);
    expect(store.getSnapshot()).toBe(true);
    const visible = { ...answer("Coordinator response"), executorId: "coordinator" };
    if (isMissionCoordinatorChatEntry(visible, "coordinator")) store.output(visible.executionId);
    expect(store.getSnapshot()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(store.getSnapshot()).toBe(true);
    expect(isMissionCoordinatorChatEntry(hidden, undefined)).toBe(false);
    expect(isMissionCoordinatorChatEntry(answer("Unattributed output"), undefined)).toBe(true);
    store.stop();
    vi.useRealTimers();
  });

  it("preserves activity and its deadline when the indicator view unsubscribes and remounts", () => {
    vi.useFakeTimers();
    const store = new MissionStreamIdleStore();
    store.configure(true, "execution", true);
    const unsubscribe = store.subscribe(vi.fn());
    store.output("execution");
    vi.advanceTimersByTime(500);
    unsubscribe();
    store.output("execution");
    vi.advanceTimersByTime(999);
    expect(store.getSnapshot()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()).toBe(true);
    const remounted = vi.fn();
    const cleanup = store.subscribe(remounted);
    store.output("execution");
    expect(remounted).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toBe(false);
    cleanup();
    store.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe("refreshed Mission output", () => {
  const snapshot = (entries: readonly MissionChatEntry[], revision = 2) => ({
    missionId: "mission",
    revision,
    entries: [...entries],
    page: {},
    pendingInteractions: [],
    execution: { id: "execution", status: "running" as const, interruptible: true },
  });

  function conversation(isOutputVisible?: (entry: MissionChatEntry) => boolean) {
    let result: ReturnType<typeof useMissionConversation> | undefined;
    // Exercise the hook's imperative update boundary without mounting the chat UI.
    function Probe() {
      result = useMissionConversation({
        missionId: "mission",
        api: undefined,
        refreshRevision: 0,
        syncUnavailableMessage: "Unavailable",
        formatError: String,
        isOutputVisible,
      });
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    if (result === undefined) throw new Error("Conversation hook did not render");
    return result;
  }

  it("hides waiting when an operation refresh beats IPC, without resetting on its replay", () => {
    vi.useFakeTimers();
    const hook = conversation();
    try {
      const current = snapshot([answer("seed")], 1);
      const next = snapshot([answer("seed new text")]);
      hook.update(current);
      hook.streamIdleStore.configure(true, "execution", true);
      hook.update((previous) => mergeLatestChatPage(previous, next));
      expect(hook.liveEntryStore.get("answer")?.kind).toBe("assistant");
      expect(hook.streamIdleStore.getSnapshot()).toBe(false);

      vi.advanceTimersByTime(500);
      const replay = applyMissionChatUpdateBatch(next, [
        {
          kind: "patch",
          missionId: "mission",
          streamId: "00000000-0000-4000-8000-000000000099",
          revision: 2,
          patches: [{ type: "entry.upsert", entry: next.entries[0]! }],
        },
      ]);
      hook.update(replay.snapshot);
      vi.advanceTimersByTime(499);
      expect(hook.streamIdleStore.getSnapshot()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(hook.streamIdleStore.getSnapshot()).toBe(true);
    } finally {
      hook.streamIdleStore.stop();
      vi.useRealTimers();
    }
  });

  it("ignores initial history, hidden members and historical executions at the update boundary", () => {
    const hook = conversation((entry) => isMissionCoordinatorChatEntry(entry, "coordinator"));
    try {
      hook.streamIdleStore.configure(true, "execution", true);
      hook.update(snapshot([answer("initial history")], 1));
      expect(hook.streamIdleStore.getSnapshot()).toBe(true);
      hook.update((previous) =>
        mergeLatestChatPage(
          previous,
          snapshot([
            answer("initial history"),
            { ...answer("hidden output"), id: "member", executorId: "member" },
            { ...answer("past output"), id: "past", executionId: "past-execution" },
          ]),
        ),
      );
      expect(hook.streamIdleStore.getSnapshot()).toBe(true);
    } finally {
      hook.streamIdleStore.stop();
    }
  });

  it("recovers changed and new output even when an invalidate already advanced the revision", () => {
    const current = snapshot([answer("seed")]);
    const next = snapshot([answer("seed new text"), { ...answer("new message"), id: "new" }]);
    expect(missionRefreshOutputCandidates(current, next).map((entry) => entry.id)).toEqual([
      "answer",
      "new",
    ]);
    expect(
      missionEntryOutputChanged(
        current.entries[0],
        missionRefreshOutputCandidates(current, next)[0]!,
      ),
    ).toBe(true);
    expect(
      missionEntryOutputChanged(
        current.entries[0],
        missionRefreshOutputCandidates(current, current)[0]!,
      ),
    ).toBe(false);
  });

  it("excludes initial history, older revisions and historical executions", () => {
    const current = snapshot([answer("latest")]);
    const past = {
      ...answer("older history"),
      id: "old",
      executionId: "old-execution",
      createdAt: "2026-09-28T00:00:00.000Z",
    };
    const otherExecution = {
      ...answer("other execution"),
      id: "other",
      executionId: "old-execution",
    };
    expect(missionRefreshOutputCandidates(null, current)).toEqual([]);
    expect(missionRefreshOutputCandidates(current, snapshot([answer("stale")], 1))).toEqual([]);
    expect(missionRefreshOutputCandidates(current, snapshot([past, otherExecution]))).toEqual([]);
  });
});
