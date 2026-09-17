import { describe, expect, it } from "vitest";
import type {
  MissionConversationSnapshot,
  MissionChatUpdate,
} from "../../../../shared/contracts/index.ts";

import {
  applyMissionChatPatches,
  applyMissionChatUpdateBatch,
  hideInterruptedExecutionFallbackEntries,
  hidePreparingQueuedChatEntries,
  mergeLatestChatPage,
  missionTurnFinalReplyIds,
  orderMissionConversationEntries,
  prependChatPage,
  readyPendingQueuedRequestIds,
  reconcileMissionChatRefresh,
  startMissionContextOperation,
  touchMissionConversationCache,
} from "./mission-conversation-model.ts";
import { mergeContextWindow, mergeConversationState } from "./use-mission-conversation.ts";

describe("mission conversation model", () => {
  const streamingSnapshot = (content = "hel", revision = 1): MissionConversationSnapshot => ({
    missionId: "00000000-0000-4000-8000-000000000000",
    revision,
    entries: [
      {
        id: "answer",
        kind: "assistant",
        executionId: "00000000-0000-4000-8000-000000000001",
        invocationId: "00000000-0000-4000-8000-000000000002",
        content,
        streaming: true,
        createdAt: "2026-07-11T00:00:00.000Z",
      },
    ],
    page: {},
    pendingInteractions: [],
  });

  it("applies one frame of contiguous deltas without replaying intermediate snapshots", () => {
    const updates: MissionChatUpdate[] = [
      {
        missionId: streamingSnapshot().missionId,
        revision: 2,
        kind: "patch",
        patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: "lo" }],
      },
      {
        missionId: streamingSnapshot().missionId,
        revision: 3,
        kind: "patch",
        patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: " world" }],
      },
    ];

    const result = applyMissionChatUpdateBatch(streamingSnapshot(), updates);

    expect(result).toMatchObject({
      snapshot: { revision: 3, entries: [{ id: "answer", content: "hello world" }] },
      remaining: [],
      needsRefresh: false,
      requiresRender: false,
    });
    expect([...result.changedEntryIds]).toEqual(["answer"]);
  });

  it("does not advance the content revision when delayed state projections arrive", () => {
    const current = streamingSnapshot("hello", 4);
    const withState = mergeConversationState(current, {
      missionId: current.missionId,
      revision: 7,
      pendingInteractions: [],
      deliveries: [],
      hiddenEntryIds: [],
    });
    const withContext = mergeContextWindow(withState, {
      missionId: current.missionId,
      revision: 8,
    });

    expect(withContext?.revision).toBe(4);
    expect(withContext).toMatchObject({ stateRevision: 7, contextRevision: 8 });
    const patched = applyMissionChatUpdateBatch(withContext!, [
      {
        missionId: current.missionId,
        revision: 5,
        kind: "patch",
        patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: "!" }],
      },
    ]);
    expect(patched.snapshot.entries[0]).toMatchObject({ content: "hello!" });
  });

  it("rejects stale conversation state and context responses independently", () => {
    const current = streamingSnapshot("hello", 10);
    const freshState = mergeConversationState(current, {
      missionId: current.missionId,
      revision: 12,
      pendingInteractions: [],
      queue: { state: "idle", pendingCount: 0, supportsSteer: false, items: [] },
      execution: {
        id: "00000000-0000-4000-8000-000000000001",
        status: "succeeded",
        interruptible: false,
      },
      deliveries: [],
      hiddenEntryIds: [],
    });
    const staleState = mergeConversationState(freshState, {
      missionId: current.missionId,
      revision: 11,
      pendingInteractions: [],
      queue: { state: "running", pendingCount: 1, supportsSteer: false, items: [] },
      execution: {
        id: "00000000-0000-4000-8000-000000000001",
        status: "running",
        interruptible: true,
      },
      deliveries: [],
      hiddenEntryIds: [],
    });
    const freshContext = mergeContextWindow(staleState, {
      missionId: current.missionId,
      revision: 14,
      contextWindow: {
        supportsInspection: true,
        supportsCompaction: true,
        canCompact: true,
      },
    });
    const staleContext = mergeContextWindow(freshContext, {
      missionId: current.missionId,
      revision: 13,
    });

    expect(staleState).toBe(freshState);
    expect(staleState?.execution).toMatchObject({ status: "succeeded", interruptible: false });
    expect(staleContext).toBe(freshContext);
    expect(staleContext?.contextWindow?.canCompact).toBe(true);
  });

  it("keeps a revision gap pending for an authoritative refresh", () => {
    const update: MissionChatUpdate = {
      missionId: streamingSnapshot().missionId,
      revision: 3,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: "lo" }],
    };

    const result = applyMissionChatUpdateBatch(streamingSnapshot(), [update]);

    expect(result.snapshot).toEqual(streamingSnapshot());
    expect(result.remaining).toEqual([update]);
    expect(result.needsRefresh).toBe(true);
  });

  it("streams contiguous patches through a preceding invalidate", () => {
    const current = streamingSnapshot("previous turn", 10);
    const updates: MissionChatUpdate[] = [
      {
        missionId: current.missionId,
        revision: 11,
        kind: "invalidate",
      },
      {
        missionId: current.missionId,
        revision: 12,
        kind: "patch",
        patches: [
          {
            type: "entry.upsert",
            entry: {
              id: "next-thinking",
              kind: "thinking",
              content: "Inspecting",
              streaming: true,
              createdAt: "2026-07-11T00:01:00.000Z",
            },
          },
        ],
      },
      {
        missionId: current.missionId,
        revision: 13,
        kind: "patch",
        patches: [
          {
            type: "entry.append",
            entryId: "next-thinking",
            field: "content",
            delta: " the repository",
          },
        ],
      },
    ];

    const result = applyMissionChatUpdateBatch(current, updates);

    expect(result).toMatchObject({
      snapshot: {
        revision: 13,
        entries: [{ id: "answer" }, { id: "next-thinking", content: "Inspecting the repository" }],
      },
      remaining: [],
      needsRefresh: true,
      requiresRender: true,
    });
    expect([...result.changedEntryIds]).toEqual(["next-thinking"]);
  });

  it("inserts a late teammate entry before the coordinator final-answer anchor", () => {
    const current = {
      ...streamingSnapshot("Final answer", 1),
      entries: [
        {
          ...streamingSnapshot("Final answer", 1).entries[0]!,
          id: "coordinator-final",
          streaming: false,
        },
      ],
    };
    const teammate = {
      id: "teammate-thinking",
      kind: "thinking" as const,
      content: "Searching Android repositories",
      streaming: true,
      createdAt: "2026-07-11T00:00:01.000Z",
    };

    expect(
      applyMissionChatPatches(
        current,
        [{ type: "entry.upsert", entry: teammate, beforeEntryId: "coordinator-final" }],
        2,
      )?.entries.map((entry) => entry.id),
    ).toEqual(["teammate-thinking", "coordinator-final"]);
    expect(
      applyMissionChatPatches(
        current,
        [{ type: "entry.upsert", entry: teammate, beforeEntryId: "missing-final" }],
        2,
      ),
    ).toBeNull();

    const misplaced = { ...current, entries: [current.entries[0]!, teammate] };
    expect(
      applyMissionChatPatches(
        misplaced,
        [{ type: "entry.upsert", entry: teammate, beforeEntryId: "coordinator-final" }],
        2,
      )?.entries.map((entry) => entry.id),
    ).toEqual(["teammate-thinking", "coordinator-final"]);
  });

  it("ignores a refresh that completed behind the painted revision", () => {
    const current = streamingSnapshot("complete streamed answer", 8);
    const stale = {
      ...streamingSnapshot("complete", 6),
      entries: [
        {
          ...streamingSnapshot("complete", 6).entries[0]!,
          streaming: false,
        },
      ],
    };

    expect(mergeLatestChatPage(current, stale)).toBe(current);
  });

  it("materializes queued deltas before accepting a snapshot that advertises them", () => {
    const current = streamingSnapshot("hello", 5);
    const pending: MissionChatUpdate[] = [
      {
        missionId: current.missionId,
        revision: 6,
        kind: "patch",
        patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: " world" }],
      },
      {
        missionId: current.missionId,
        revision: 7,
        kind: "patch",
        patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: "!" }],
      },
    ];
    const staleProjection = {
      ...streamingSnapshot("hello", 7),
      entries: [{ ...current.entries[0]!, content: "hello", streaming: false }],
    } as MissionConversationSnapshot;

    expect(reconcileMissionChatRefresh(current, staleProjection, pending)).toMatchObject({
      snapshot: {
        revision: 7,
        entries: [{ id: "answer", content: "hello world!", streaming: false }],
      },
      remaining: [],
      needsRefresh: false,
    });
  });

  it("accepts structural metadata from a stale refresh without rolling back live text", () => {
    const current = streamingSnapshot("complete streamed answer", 8);
    const stale = {
      ...streamingSnapshot("complete", 6),
      entries: [
        {
          ...streamingSnapshot("complete", 6).entries[0]!,
          streaming: false,
        },
      ],
    } as MissionConversationSnapshot;

    expect(reconcileMissionChatRefresh(current, stale, [])).toMatchObject({
      snapshot: {
        revision: 8,
        entries: [{ content: "complete streamed answer", streaming: false }],
      },
      needsRefresh: false,
    });
  });

  it("requests another refresh when an in-flight snapshot predates a newer invalidate", () => {
    const current = streamingSnapshot("previous turn", 8);
    const pending: MissionChatUpdate[] = [
      { missionId: current.missionId, revision: 9, kind: "invalidate" },
      {
        missionId: current.missionId,
        revision: 10,
        kind: "patch",
        patches: [
          {
            type: "entry.upsert",
            entry: {
              id: "next-answer",
              kind: "assistant",
              content: "New stream",
              streaming: true,
              createdAt: "2026-07-11T00:01:00.000Z",
            },
          },
        ],
      },
    ];

    expect(
      reconcileMissionChatRefresh(current, streamingSnapshot("previous turn", 8), pending),
    ).toMatchObject({
      snapshot: {
        revision: 10,
        entries: [{ id: "answer" }, { id: "next-answer", content: "New stream" }],
      },
      needsRefresh: true,
      requiredRefreshRevision: 9,
    });
  });

  it("does not let a shorter or divergent live upsert rewrite append-only content", () => {
    const current = streamingSnapshot("complete streamed answer", 4);
    const entry = current.entries[0];
    if (entry?.kind !== "assistant") throw new Error("Expected an Assistant fixture entry.");
    const shorter = applyMissionChatPatches(
      current,
      [
        {
          type: "entry.upsert",
          entry: { ...entry, content: "complete", streaming: false },
        },
      ],
      5,
    );
    const divergent = applyMissionChatPatches(
      current,
      [
        {
          type: "entry.upsert",
          entry: { ...entry, content: "replacement projection", streaming: false },
        },
      ],
      5,
    );

    expect(shorter).toMatchObject({
      revision: 5,
      entries: [{ content: "complete streamed answer", streaming: false }],
    });
    expect(divergent).toMatchObject({
      revision: 5,
      entries: [{ content: "complete streamed answer", streaming: false }],
    });
  });

  it("identifies only the final completed Assistant reply in each Turn", () => {
    const createdAt = "2026-07-11T00:00:00.000Z";
    const entries = [
      {
        id: "turn-1-draft",
        kind: "assistant" as const,
        content: "draft",
        streaming: false,
        timelineSequence: 1,
        createdAt,
      },
      {
        id: "turn-1-final",
        kind: "assistant" as const,
        content: "final",
        streaming: false,
        timelineSequence: 1,
        createdAt,
      },
      {
        id: "turn-2-streaming",
        kind: "assistant" as const,
        content: "streaming",
        streaming: true,
        timelineSequence: 2,
        createdAt,
      },
      {
        id: "turn-2-final",
        kind: "assistant" as const,
        content: "done",
        streaming: false,
        timelineSequence: 2,
        createdAt,
      },
    ];

    expect([...missionTurnFinalReplyIds(entries)]).toEqual(["turn-1-final", "turn-2-final"]);
  });

  it("preserves durable event order across timestamps and inserts local messages", () => {
    const entries = orderMissionConversationEntries([
      {
        type: "durable",
        entry: {
          id: "thinking",
          kind: "thinking",
          content: "Reasoning",
          streaming: false,
          createdAt: "2026-07-11T00:00:02.000Z",
        },
      },
      {
        type: "durable",
        entry: {
          id: "answer",
          kind: "assistant",
          content: "Final answer",
          streaming: false,
          createdAt: "2026-07-11T00:00:01.000Z",
        },
      },
      {
        type: "local",
        entry: {
          id: "next-request",
          content: "Next question",
          createdAt: "2026-07-11T00:00:03.000Z",
          attachments: [],
          status: "pending",
        },
      },
    ]);

    expect(entries.map(({ entry }) => entry.id)).toEqual(["thinking", "answer", "next-request"]);
  });

  it("keeps a newer live answer after thinking when an older refresh arrives", () => {
    const current: MissionConversationSnapshot = {
      ...streamingSnapshot("answer", 8),
      entries: [
        {
          id: "thinking",
          kind: "thinking",
          content: "Reasoning",
          streaming: false,
          createdAt: "2026-07-11T00:00:02.000Z",
        },
        {
          ...streamingSnapshot("answer", 8).entries[0]!,
          createdAt: "2026-07-11T00:00:01.000Z",
        },
      ],
    };
    const stale: MissionConversationSnapshot = {
      ...current,
      revision: 7,
      entries: [
        current.entries[0]!,
        {
          id: "answer",
          kind: "assistant",
          content: "ans",
          streaming: true,
          createdAt: "2026-07-11T00:00:01.000Z",
        },
      ],
    };

    const merged = reconcileMissionChatRefresh(current, stale, []);
    expect(merged.snapshot.entries.map((entry) => entry.id)).toEqual(["thinking", "answer"]);
    expect(merged.snapshot.entries[1]).toMatchObject({ content: "answer" });
  });

  it.each([
    { queued: false, degraded: false },
    { queued: true, degraded: false },
    { queued: false, degraded: true },
  ])(
    "inserts recovered expert thinking before a shared answer ($queued, $degraded)",
    ({ queued, degraded }) => {
      const base = streamingSnapshot("Final answer", 8);
      const answer = base.entries[0]!;
      if (answer.kind !== "assistant") throw new Error("Expected an assistant fixture.");
      const thinking = [0, 1, 2].map((index) => ({
        ...answer,
        id: `research-thinking-${index}`,
        invocationId: "00000000-0000-4000-8000-000000000003",
        kind: "thinking" as const,
        content: `Research ${index}`,
        streaming: false,
      }));
      const stale: MissionConversationSnapshot = {
        ...base,
        revision: 7,
        entries: [...thinking, { ...answer, content: "Final" }],
        ...(degraded
          ? {
              syncIssues: [
                {
                  code: "execution_state_unavailable" as const,
                  section: "history" as const,
                  retryable: true,
                },
              ],
            }
          : {}),
      };
      const pending: MissionChatUpdate[] = queued
        ? [
            {
              missionId: base.missionId,
              revision: 9,
              kind: "patch",
              patches: [{ type: "entry.append", entryId: answer.id, field: "content", delta: "!" }],
            },
          ]
        : [];
      const result = reconcileMissionChatRefresh(base, stale, pending);
      expect(result.snapshot.entries.map((entry) => entry.id)).toEqual([
        ...thinking.map((entry) => entry.id),
        answer.id,
      ]);
      expect(result.snapshot.entries.at(-1)).toMatchObject({
        content: queued ? "Final answer!" : "Final answer",
      });
    },
  );

  it("keeps a recovered stale suffix before newer live messages", () => {
    const base = streamingSnapshot("Final answer", 8);
    const answer = base.entries[0]!;
    if (answer.kind !== "assistant") throw new Error("Expected an assistant fixture.");
    const first = { ...answer, id: "first", content: "First" };
    const missing = { ...answer, id: "missing", kind: "thinking" as const, content: "Research" };
    const current = { ...base, entries: [first, answer] };
    const stale = { ...base, revision: 7, entries: [first, missing] };
    expect(
      reconcileMissionChatRefresh(current, stale, []).snapshot.entries.map((entry) => entry.id),
    ).toEqual(["first", "missing", "answer"]);
    expect(
      reconcileMissionChatRefresh(
        base,
        { ...stale, entries: [first, missing] },
        [],
      ).snapshot.entries.map((entry) => entry.id),
    ).toEqual(["first", "missing", "answer"]);
  });

  it("preserves loaded history and its cursor when a stale latest page returns", () => {
    const base = streamingSnapshot("Answer", 8);
    const answer = { ...base.entries[0]!, timelineSequence: 3 };
    const earlier = { ...answer, id: "earlier", timelineSequence: 1 };
    const current = {
      ...base,
      entries: [earlier, answer],
      page: {
        oldestSequence: 1,
        newestSequence: 3,
        nextBeforeCursor: "older-page",
      },
    };
    const stale = {
      ...base,
      revision: 7,
      entries: [answer],
      page: {
        oldestSequence: 3,
        newestSequence: 3,
        nextBeforeCursor: "latest-page",
      },
    };
    const merged = reconcileMissionChatRefresh(current, stale, []).snapshot;
    expect(merged.entries.map((entry) => entry.id)).toEqual(["earlier", "answer"]);
    expect(merged.page).toEqual(current.page);
  });

  it("keeps loaded pages and the exhausted cursor after A -> B -> A navigation", () => {
    const snapshot = streamingSnapshot("Answer", 8);
    const entries = (start: number, end: number) =>
      Array.from({ length: end - start + 1 }, (_, offset) => {
        const sequence = start + offset;
        return {
          ...snapshot.entries[0]!,
          id: `entry-${sequence}`,
          timelineSequence: sequence,
        };
      });
    const latest = {
      ...snapshot,
      entries: entries(101, 150),
      page: { oldestSequence: 101, newestSequence: 150, nextBeforeCursor: "before-101" },
    };
    const middle = {
      ...snapshot,
      entries: entries(51, 100),
      page: { oldestSequence: 51, newestSequence: 100, nextBeforeCursor: "before-51" },
    };
    const oldest = {
      ...snapshot,
      entries: entries(1, 50),
      page: { oldestSequence: 1, newestSequence: 50 },
    };
    const cached = prependChatPage(prependChatPage(latest, middle), oldest);
    const cache = new Map([
      ["other-mission", streamingSnapshot("Other", 1)],
      [cached.missionId, cached],
    ]);

    touchMissionConversationCache(cache, cached.missionId);

    expect(cache.get(cached.missionId)).toBe(cached);
    expect(cache.get(cached.missionId)?.entries).toHaveLength(150);
    expect([...cache.keys()].at(-1)).toBe(cached.missionId);

    const refreshed = mergeLatestChatPage(cache.get(cached.missionId) ?? null, {
      ...latest,
      revision: 9,
    });
    expect(refreshed.entries.map((entry) => entry.timelineSequence)).toEqual(
      Array.from({ length: 150 }, (_, index) => index + 1),
    );
    expect(refreshed.page).toEqual({ oldestSequence: 101, newestSequence: 150 });
  });

  it("places a disjoint recovered turn between loaded older history and live output", () => {
    const base = streamingSnapshot("Answer", 8);
    const answer = { ...base.entries[0]!, timelineSequence: 3 };
    const earlier = { ...answer, id: "earlier", timelineSequence: 1 };
    const recovered = { ...answer, id: "recovered", timelineSequence: 2 };
    const current = { ...base, entries: [earlier, answer] };
    const stale = { ...base, revision: 7, entries: [recovered] };
    expect(
      reconcileMissionChatRefresh(current, stale, []).snapshot.entries.map((entry) => entry.id),
    ).toEqual(["earlier", "recovered", "answer"]);
  });

  it("hides only synthetic interrupted execution fallbacks from the conversation", () => {
    const createdAt = "2026-07-11T00:00:00.000Z";
    const executionId = "00000000-0000-4000-8000-000000000010";
    const interruptedFallback = {
      id: `result:${executionId}`,
      kind: "assistant" as const,
      executionId,
      content: "Execution interrupted.",
      streaming: false,
      createdAt,
    };
    const realReply = {
      ...interruptedFallback,
      id: "assistant:real-reply",
    };
    const failedFallback = {
      ...interruptedFallback,
      id: `result:00000000-0000-4000-8000-000000000011`,
      executionId: "00000000-0000-4000-8000-000000000011",
      content: "Execution failed: command exited with code 1",
    };

    expect(
      hideInterruptedExecutionFallbackEntries([interruptedFallback, realReply, failedFallback]).map(
        (entry) => entry.id,
      ),
    ).toEqual([realReply.id, failedFallback.id]);
  });

  it("keeps a preparing queued message out of the conversation until delivery is known", () => {
    const requestId = "00000000-0000-4000-8000-000000000012";
    const entry = {
      id: requestId,
      kind: "user" as const,
      content: "Adjust the implementation",
      createdAt: "2026-07-11T00:00:02.000Z",
    };

    expect(hidePreparingQueuedChatEntries([entry], new Set([requestId]))).toEqual([]);
    expect(hidePreparingQueuedChatEntries([entry], new Set())).toEqual([entry]);
  });

  it("releases a preparing queued message when it has started running", () => {
    const requestId = "00000000-0000-4000-8000-000000000012";
    const entry = {
      id: requestId,
      kind: "user" as const,
      content: "Adjust the implementation",
      createdAt: "2026-07-11T00:00:02.000Z",
      delivery: {
        requestedMode: "enqueue" as const,
        effectiveMode: "enqueue" as const,
        status: "running" as const,
      },
    };

    expect(hidePreparingQueuedChatEntries([entry], new Set([requestId]))).toEqual([entry]);
  });

  it("makes a queued message actionable as soon as its queue item is persisted", () => {
    const requestId = "00000000-0000-4000-8000-000000000012";
    const ready = readyPendingQueuedRequestIds(
      [
        {
          requestId,
          content: "Adjust the implementation",
          attachments: [],
        },
      ],
      new Set([requestId]),
      [],
    );

    expect([...ready]).toEqual([requestId]);
  });

  it("reuses the failed context operation when retrying", () => {
    const failed = [
      {
        id: "compact-1",
        createdAt: "2026-07-29T00:00:00.000Z",
        status: "failed" as const,
        error: "provider unavailable",
      },
    ];

    expect(
      startMissionContextOperation(failed, {
        id: "compact-1",
        createdAt: "2026-07-29T00:01:00.000Z",
        retry: true,
      }),
    ).toEqual([
      {
        id: "compact-1",
        createdAt: "2026-07-29T00:00:00.000Z",
        status: "running",
        error: undefined,
      },
    ]);
  });
});
