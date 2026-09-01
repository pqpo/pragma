import { describe, expect, it } from "vitest";

import {
  hideInterruptedExecutionFallbackEntries,
  hidePreparingQueuedChatEntries,
  missionTurnFinalReplyIds,
  readyPendingQueuedRequestIds,
  startMissionContextOperation,
} from "./mission-conversation-model.ts";

describe("mission conversation model", () => {
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
