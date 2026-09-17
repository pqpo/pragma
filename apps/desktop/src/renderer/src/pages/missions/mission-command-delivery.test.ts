import { describe, expect, it } from "vitest";

import {
  createMissionSendAttempt,
  mergeMissionQueuedMessages,
  rejectMissionCommandDelivery,
} from "./mission-command-delivery.ts";

const failed = {
  id: "11111111-1111-4111-8111-111111111111",
  content: "retry me",
  createdAt: "2026-09-01T00:00:00.000Z",
  attachments: [],
  status: "failed" as const,
};

describe("Mission command delivery state", () => {
  it("reuses the request id only for an uncertain submission", () => {
    expect(
      createMissionSendAttempt({
        content: failed.content,
        attachments: [],
        retry: { ...failed, retryMode: "same-request" },
        createRequestId: () => "22222222-2222-4222-8222-222222222222",
        now: () => "never",
      }).id,
    ).toBe(failed.id);
  });

  it("allocates a new request id after a durable rejection", () => {
    expect(
      createMissionSendAttempt({
        content: failed.content,
        attachments: [],
        retry: { ...failed, retryMode: "new-request" },
        createRequestId: () => "22222222-2222-4222-8222-222222222222",
        now: () => "never",
      }).id,
    ).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("restores a rejected queued message to the visible conversation", () => {
    expect(
      rejectMissionCommandDelivery({
        requestId: failed.id,
        optimisticMessages: [],
        submitted: { ...failed, status: "pending" },
      }),
    ).toEqual([{ ...failed, retryMode: "new-request" }]);
  });

  it("keeps one stable queue row while a local submission becomes durable", () => {
    const pending = [
      {
        requestId: failed.id,
        content: failed.content,
        attachments: [],
      },
    ];

    expect(mergeMissionQueuedMessages([], pending)).toEqual([
      {
        requestId: failed.id,
        content: failed.content,
        hasAttachments: false,
        persisted: false,
      },
    ]);
    expect(
      mergeMissionQueuedMessages(
        [{ requestId: failed.id, content: failed.content, hasAttachments: false }],
        pending,
      ),
    ).toEqual([
      {
        requestId: failed.id,
        content: failed.content,
        hasAttachments: false,
        persisted: true,
      },
    ]);
  });

  it("preserves durable FIFO order and appends submissions not persisted yet", () => {
    expect(
      mergeMissionQueuedMessages(
        [
          { requestId: "persisted-1", content: "first", hasAttachments: false },
          { requestId: "persisted-2", content: "second", hasAttachments: false },
        ],
        [
          { requestId: "persisted-2", content: "second", attachments: [] },
          { requestId: "pending-3", content: "third", attachments: [] },
        ],
      ).map((message) => message.requestId),
    ).toEqual(["persisted-1", "persisted-2", "pending-3"]);
  });
});
