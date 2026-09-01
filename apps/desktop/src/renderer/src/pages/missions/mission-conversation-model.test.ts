import { describe, expect, it } from "vitest";
import type { MissionChatSnapshot, MissionChatUpdate } from "../../../../shared/contracts/index.ts";

import {
  applyMissionChatPatches,
  applyMissionChatUpdateBatch,
  hideInterruptedExecutionFallbackEntries,
  hidePreparingQueuedChatEntries,
  mergeLatestChatPage,
  missionTurnFinalReplyIds,
  readyPendingQueuedRequestIds,
  reconcileMissionChatRefresh,
  startMissionContextOperation,
} from "./mission-conversation-model.ts";

describe("mission conversation model", () => {
  const streamingSnapshot = (content = "hel", revision = 1): MissionChatSnapshot => ({
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
    } as MissionChatSnapshot;

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
    } as MissionChatSnapshot;

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
