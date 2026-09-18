import { describe, expect, it, vi } from "vitest";
import type {
  MissionChatEntry,
  MissionConversationSnapshot,
  MissionChatUpdate,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";

import {
  applyMissionChatPatches,
  applyMissionChatUpdateBatch,
  hideInterruptedExecutionFallbackEntries,
  hideQueuedChatEntries,
  includedPendingFirstTokenExecutionIds,
  materializeMissionChatSnapshot,
  mergeLatestChatPage,
  MissionFirstTokenUpdateBuffer,
  missionTurnFinalReplyIds,
  orderMissionConversationEntries,
  prependChatPage,
  readyPendingQueuedRequestIds,
  reconcileMissionChatRefresh,
  startMissionContextOperation,
  touchMissionConversationCache,
  visiblePatchExecutionIds,
} from "./mission-conversation-model.ts";
import {
  cacheMissionConversationSnapshot,
  conversationFromPage,
  isMissionConversationCacheReady,
  loadMissionConversationProjection,
  mergeContextWindow,
  mergeConversationState,
} from "./use-mission-conversation.ts";

const chatStreamId = "00000000-0000-4000-8000-000000000099";

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
        streamId: chatStreamId,
        revision: 2,
        kind: "patch",
        patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: "lo" }],
      },
      {
        missionId: streamingSnapshot().missionId,
        streamId: chatStreamId,
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

  it("keeps pure content appends incremental until a structural boundary", () => {
    const entries = Array.from({ length: 5_000 }, (_, index) => ({
      ...streamingSnapshot(String(index)).entries[0]!,
      id: `answer-${index}`,
      executionId: `execution-${index}`,
    }));
    const current = { ...streamingSnapshot("", 1), entries };
    const liveEntries = new Map<string, MissionChatEntry>(
      entries.map((entry) => [entry.id, entry] as const),
    );
    const readEntry = vi.fn((entryId: string) => liveEntries.get(entryId));
    const update: MissionChatUpdate = {
      missionId: current.missionId,
      streamId: chatStreamId,
      revision: 2,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "answer-4999", field: "content", delta: "!" }],
    };

    const appended = applyMissionChatUpdateBatch(current, [update], {
      deferContentEntries: true,
      readEntry,
    });

    expect(appended.snapshot.entries).toBe(entries);
    expect(readEntry).toHaveBeenCalledOnce();
    expect(appended.changedEntries.get("answer-4999")).toMatchObject({ content: "4999!" });
    expect(appended.snapshot.entries.at(-1)).toMatchObject({ content: "4999" });

    for (const entry of appended.changedEntries.values()) liveEntries.set(entry.id, entry);
    const materialized = materializeMissionChatSnapshot(appended.snapshot, (entryId) =>
      liveEntries.get(entryId),
    );
    expect(materialized.entries.at(-1)).toBe(appended.changedEntries.get("answer-4999"));

    const structural = applyMissionChatUpdateBatch(
      appended.snapshot,
      [
        {
          ...update,
          revision: 3,
          patches: [
            {
              type: "entry.upsert",
              entry: {
                id: "late-thinking",
                kind: "thinking",
                content: "new",
                streaming: true,
                createdAt: "2026-07-11T00:00:01.000Z",
              },
              beforeEntryId: "answer-4999",
            },
          ],
        },
      ],
      { deferContentEntries: true, readEntry: (entryId) => liveEntries.get(entryId) },
    );
    expect(structural.requiresRender).toBe(true);
    expect(structural.snapshot.entries.at(-2)).toMatchObject({ id: "late-thinking" });
    expect(structural.snapshot.entries.at(-1)).toMatchObject({ content: "4999!" });
  });

  it("materializes deferred content before exposing a snapshot through the shared cache", () => {
    const current = { ...streamingSnapshot("seed", 1), stateRevision: 1 };
    const liveEntries = new Map(current.entries.map((entry) => [entry.id, entry] as const));
    const update: MissionChatUpdate = {
      missionId: current.missionId,
      streamId: chatStreamId,
      revision: 2,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: " next" }],
    };
    const result = applyMissionChatUpdateBatch(current, [update], {
      deferContentEntries: true,
      readEntry: (entryId) => liveEntries.get(entryId),
    });
    for (const entry of result.changedEntries.values()) liveEntries.set(entry.id, entry);
    expect(result.snapshot.entries[0]).toMatchObject({ content: "seed" });

    const cache = new Map<string, MissionConversationSnapshot>();
    cacheMissionConversationSnapshot(cache, current.missionId, result.snapshot, (entryId) =>
      liveEntries.get(entryId),
    );

    expect(cache.get(current.missionId)).toMatchObject({
      revision: 2,
      entries: [{ id: "answer", content: "seed next" }],
    });
  });

  it("resolves first visible tokens through constant-time metadata for multiple executions", () => {
    const current = streamingSnapshot("existing", 1);
    const lookup = vi.fn((entryId: string) =>
      entryId === "answer-a" ? "execution-a" : entryId === "answer-b" ? "execution-b" : undefined,
    );
    const update: MissionChatUpdate = {
      missionId: current.missionId,
      streamId: chatStreamId,
      revision: 2,
      kind: "patch",
      patches: [
        { type: "entry.append", entryId: "answer-a", field: "content", delta: "a" },
        { type: "entry.append", entryId: "answer-b", field: "content", delta: "b" },
        {
          type: "entry.upsert",
          entry: {
            id: "answer-c",
            kind: "assistant",
            executionId: "execution-c",
            content: "c",
            streaming: true,
            createdAt: "2026-07-11T00:00:01.000Z",
          },
        },
      ],
    };

    expect([...visiblePatchExecutionIds(update, current, lookup)]).toEqual([
      "execution-a",
      "execution-b",
      "execution-c",
    ]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("attributes first tokens by contiguous revision when a future upsert arrives first", () => {
    const current = streamingSnapshot("existing", 1);
    const tracker = new MissionFirstTokenUpdateBuffer(10);
    const readExecution = (entryId: string) => (entryId === "entry-x" ? "execution-a" : undefined);
    const revision12: MissionChatUpdate = {
      missionId: current.missionId,
      streamId: chatStreamId,
      revision: 12,
      kind: "patch",
      patches: [
        {
          type: "entry.upsert",
          entry: {
            id: "entry-x",
            kind: "assistant",
            executionId: "execution-b",
            content: "",
            streaming: true,
            createdAt: "2026-07-11T00:00:02.000Z",
          },
        },
      ],
    };
    const revision11: MissionChatUpdate = {
      missionId: current.missionId,
      streamId: chatStreamId,
      revision: 11,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "entry-x", field: "content", delta: "first" }],
    };
    const revision13: MissionChatUpdate = {
      missionId: current.missionId,
      streamId: chatStreamId,
      revision: 13,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "entry-x", field: "content", delta: "next" }],
    };

    expect([...tracker.push(revision12, readExecution)]).toEqual([]);
    expect([...tracker.push(revision11, readExecution)]).toEqual(["execution-a"]);
    expect([...tracker.push(revision13, readExecution)]).toEqual(["execution-b"]);
    expect([...tracker.push(revision11, readExecution)]).toEqual([]);

    const revision14: MissionChatUpdate = {
      missionId: current.missionId,
      streamId: chatStreamId,
      revision: 14,
      kind: "patch",
      patches: [
        {
          type: "entry.upsert",
          entry: {
            id: "entry-x",
            kind: "assistant",
            content: "",
            streaming: true,
            createdAt: "2026-07-11T00:00:03.000Z",
          },
        },
      ],
    };
    const revision15: MissionChatUpdate = {
      missionId: current.missionId,
      streamId: chatStreamId,
      revision: 15,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "entry-x", field: "content", delta: "orphan" }],
    };
    expect([...tracker.push(revision14, readExecution)]).toEqual([]);
    expect([...tracker.push(revision15, readExecution)]).toEqual([]);
  });

  it("replays a startup token after a refresh establishes the missing revision watermark", () => {
    const current = streamingSnapshot("", 1);
    const tracker = new MissionFirstTokenUpdateBuffer(0);
    const update: MissionChatUpdate = {
      missionId: current.missionId,
      streamId: chatStreamId,
      revision: 2,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: "first" }],
    };
    const readExecution = (entryId: string) =>
      current.entries.find((entry) => entry.id === entryId)?.executionId;

    expect([...tracker.push(update, readExecution)]).toEqual([]);
    tracker.reset(current.revision);
    expect([...tracker.push(update, readExecution)]).toEqual([
      "00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("retains the active execution fallback for entries without execution ownership", () => {
    const current = streamingSnapshot("", 1);
    const tracker = new MissionFirstTokenUpdateBuffer(current.revision);
    const update: MissionChatUpdate = {
      missionId: current.missionId,
      streamId: chatStreamId,
      revision: 2,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: "first" }],
    };

    expect([...tracker.push(update, () => undefined, "active-execution")]).toEqual([
      "active-execution",
    ]);
  });

  it("records a pending token already included at the refreshed page boundary", () => {
    const snapshot = streamingSnapshot("first", 12);
    const boundaryUpdate: MissionChatUpdate = {
      missionId: snapshot.missionId,
      streamId: chatStreamId,
      revision: 12,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: "first" }],
    };
    const olderUnknownOwnership: MissionChatUpdate = {
      ...boundaryUpdate,
      revision: 11,
    };

    expect([
      ...includedPendingFirstTokenExecutionIds(snapshot, [olderUnknownOwnership, boundaryUpdate]),
    ]).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect([...includedPendingFirstTokenExecutionIds(snapshot, [olderUnknownOwnership])]).toEqual(
      [],
    );

    const futureEntry: MissionChatEntry = {
      id: "answer",
      kind: "assistant",
      executionId: "future-execution",
      content: "",
      streaming: true,
      createdAt: "2026-07-11T00:00:00.000Z",
    };
    const ownershipChangesAfterAppend: MissionChatUpdate = {
      ...boundaryUpdate,
      patches: [
        ...boundaryUpdate.patches,
        {
          type: "entry.upsert",
          entry: futureEntry,
        },
      ],
    };
    expect([
      ...includedPendingFirstTokenExecutionIds(
        {
          ...snapshot,
          entries: [futureEntry],
        },
        [ownershipChangesAfterAppend],
      ),
    ]).toEqual([]);

    const explicitOwnership: MissionChatUpdate = {
      ...boundaryUpdate,
      revision: 11,
      patches: [
        {
          type: "entry.upsert",
          entry: { ...futureEntry, executionId: "pending-execution" },
        },
      ],
    };
    const laterAppend: MissionChatUpdate = {
      ...boundaryUpdate,
      revision: 12,
    };
    expect([
      ...includedPendingFirstTokenExecutionIds(
        { ...snapshot, revision: 13, entries: [futureEntry] },
        [laterAppend, explicitOwnership],
      ),
    ]).toEqual(["pending-execution"]);

    const entryWithoutOwnership: MissionChatEntry = {
      id: "answer",
      kind: "assistant",
      content: "first",
      streaming: true,
      createdAt: "2026-07-11T00:00:00.000Z",
    };
    expect([
      ...includedPendingFirstTokenExecutionIds(
        {
          ...snapshot,
          entries: [entryWithoutOwnership],
          execution: {
            id: "active-execution",
            status: "running",
            interruptible: true,
          },
        },
        [boundaryUpdate],
      ),
    ]).toEqual(["active-execution"]);
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
        streamId: chatStreamId,
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

  it("preserves delivery metadata when a later history page omits queue state", () => {
    const requestId = "00000000-0000-4000-8000-000000000012";
    const current: MissionConversationSnapshot = {
      missionId: streamingSnapshot().missionId,
      revision: 2,
      entries: [
        {
          id: requestId,
          kind: "user",
          content: "Queued guidance",
          createdAt: "2026-07-11T00:00:01.000Z",
          delivery: {
            requestedMode: "enqueue",
            effectiveMode: "enqueue",
            status: "queued",
          },
        },
      ],
      page: { oldestSequence: 1, newestSequence: 1 },
      pendingInteractions: [],
      queue: {
        state: "running",
        pendingCount: 1,
        supportsSteer: true,
        items: [{ requestId, content: "Queued guidance", hasAttachments: false }],
      },
    };

    const refreshed = conversationFromPage(
      {
        missionId: current.missionId,
        revision: 3,
        entries: [
          {
            id: requestId,
            kind: "user",
            content: "Queued guidance",
            createdAt: "2026-07-11T00:00:01.000Z",
          },
        ],
        page: current.page,
      },
      current,
    );

    expect(refreshed.entries[0]).toMatchObject({
      id: requestId,
      delivery: { status: "queued" },
    });
    expect(refreshed.queue?.items).toHaveLength(1);
  });

  it("keeps a revision gap pending for an authoritative refresh", () => {
    const update: MissionChatUpdate = {
      missionId: streamingSnapshot().missionId,
      streamId: chatStreamId,
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
        streamId: chatStreamId,
        revision: 11,
        kind: "invalidate",
      },
      {
        missionId: current.missionId,
        streamId: chatStreamId,
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
        streamId: chatStreamId,
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
        streamId: chatStreamId,
        revision: 6,
        kind: "patch",
        patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: " world" }],
      },
      {
        missionId: current.missionId,
        streamId: chatStreamId,
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
      {
        missionId: current.missionId,
        streamId: chatStreamId,
        revision: 9,
        kind: "invalidate",
      },
      {
        missionId: current.missionId,
        streamId: chatStreamId,
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

  it("accepts shorter and divergent rewrites from a newer patch revision", () => {
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
      entries: [{ content: "complete", streaming: false }],
    });
    expect(divergent).toMatchObject({
      revision: 5,
      entries: [{ content: "replacement projection", streaming: false }],
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
              streamId: chatStreamId,
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

  it("keeps newer cached output while history is temporarily unavailable", () => {
    const base = streamingSnapshot("Latest live answer", 8);
    const staleAnswer = {
      ...base.entries[0]!,
      id: "stale-answer",
      content: "Older projected answer",
      timelineSequence: 2,
    };
    const current = {
      ...base,
      entries: [staleAnswer, { ...base.entries[0]!, timelineSequence: 3 }],
      page: { oldestSequence: 2, newestSequence: 3, nextBeforeCursor: "cached-cursor" },
    };
    const unavailable = {
      ...base,
      entries: [staleAnswer],
      page: {
        oldestSequence: 2,
        newestSequence: 2,
        nextBeforeCursor: "stale-cursor",
      },
      syncIssues: [
        {
          code: "execution_state_unavailable" as const,
          section: "history" as const,
          retryable: true as const,
        },
      ],
    };

    const merged = mergeLatestChatPage(current, unavailable);

    expect(merged.entries.map((entry) => entry.id)).toEqual(["stale-answer", "answer"]);
    expect(merged.page.nextBeforeCursor).toBe("cached-cursor");
    expect(merged.syncIssues).toEqual(unavailable.syncIssues);
  });

  it("clears a recovered history issue when retry returns the same chat revision", () => {
    const available = streamingSnapshot("Recovered answer", 8);
    const degraded: MissionConversationSnapshot = {
      ...available,
      syncIssues: [
        {
          code: "execution_state_unavailable",
          section: "history",
          retryable: true,
        },
      ],
    };

    const recovered = reconcileMissionChatRefresh(degraded, available, []).snapshot;

    expect(recovered.syncIssues).toBeUndefined();
    expect(recovered.entries).toEqual(available.entries);
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

  it("keeps bounded-history truncation metadata after loading an earlier page", () => {
    const latest = {
      ...streamingSnapshot("Latest", 8),
      page: {
        nextBeforeCursor: "earlier",
        truncation: { omittedEntries: 4, truncatedFields: 2 },
      },
    };
    const earlier = {
      ...streamingSnapshot("Earlier", 8),
      entries: [{ ...streamingSnapshot("Earlier", 8).entries[0]!, id: "earlier" }],
      page: {},
    };

    expect(prependChatPage(latest, earlier).page.truncation).toEqual({
      omittedEntries: 4,
      truncatedFields: 2,
    });
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

    expect(hideQueuedChatEntries([entry], new Set([requestId]))).toEqual([]);
    expect(hideQueuedChatEntries([entry], new Set())).toEqual([entry]);
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

    expect(hideQueuedChatEntries([entry], new Set())).toEqual([entry]);
  });

  it("keeps a durable queued message hidden even when the queue state arrives separately", () => {
    const entry = {
      id: "00000000-0000-4000-8000-000000000012",
      kind: "user" as const,
      content: "Adjust the implementation",
      createdAt: "2026-07-11T00:00:02.000Z",
      delivery: {
        requestedMode: "enqueue" as const,
        effectiveMode: "enqueue" as const,
        status: "queued" as const,
      },
    };

    expect(hideQueuedChatEntries([entry], new Set())).toEqual([]);
  });

  it("moves a confirmed queued steer to its activation position", () => {
    const entries = orderMissionConversationEntries([
      {
        type: "durable",
        entry: {
          id: "queued",
          kind: "user",
          content: "Change direction",
          createdAt: "2026-07-11T00:00:01.000Z",
          delivery: {
            requestedMode: "steer",
            effectiveMode: "steer",
            status: "succeeded",
            activatedAt: "2026-07-11T00:00:04.000Z",
          },
        },
      },
      {
        type: "durable",
        entry: {
          id: "active-answer",
          kind: "assistant",
          content: "Working",
          streaming: true,
          createdAt: "2026-07-11T00:00:03.000Z",
        },
      },
      {
        type: "durable",
        entry: {
          id: "later-tool",
          kind: "tool",
          toolCallId: "call-1",
          toolName: "read",
          status: "succeeded",
          createdAt: "2026-07-11T00:00:05.000Z",
        },
      },
    ]);

    expect(entries.map((entry) => entry.entry.id)).toEqual([
      "active-answer",
      "queued",
      "later-tool",
    ]);
  });

  it("does not treat page-only prefetch data as a renderable conversation cache", () => {
    const pageOnly = streamingSnapshot();
    const withState = mergeConversationState(pageOnly, {
      missionId: pageOnly.missionId,
      revision: 2,
      pendingInteractions: [],
      queue: { state: "idle", pendingCount: 0, supportsSteer: false, items: [] },
      deliveries: [],
      hiddenEntryIds: [],
    });

    expect(isMissionConversationCacheReady(pageOnly)).toBe(false);
    expect(isMissionConversationCacheReady(withState)).toBe(true);
  });

  it("refetches conversation state when a concurrent chat page is newer", async () => {
    const missionId = streamingSnapshot().missionId;
    const conversationState = (revision: number) => ({
      missionId,
      revision,
      pendingInteractions: [],
      deliveries: [],
      hiddenEntryIds: [],
    });
    const getMissionConversationState = vi
      .fn()
      .mockResolvedValueOnce(conversationState(1))
      .mockResolvedValueOnce(conversationState(2));
    const api = {
      getMissionChatPage: vi.fn().mockResolvedValue({
        missionId,
        revision: 2,
        entries: [],
        page: {},
      }),
      getMissionConversationState,
    } as unknown as PragmaDesktopAPI;

    const projection = await loadMissionConversationProjection(api, missionId);

    expect(projection.state?.revision).toBe(2);
    expect(getMissionConversationState).toHaveBeenCalledTimes(2);
  });

  it("keeps a readable chat page when conversation control state is unavailable", async () => {
    const missionId = streamingSnapshot().missionId;
    const page = { missionId, revision: 3, entries: [], page: {} };
    const api = {
      getMissionChatPage: vi.fn().mockResolvedValue(page),
      getMissionConversationState: vi.fn().mockRejectedValue(new Error("state unavailable")),
    } as unknown as PragmaDesktopAPI;

    await expect(loadMissionConversationProjection(api, missionId)).resolves.toEqual({
      page,
      stateUnavailable: true,
    });
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
