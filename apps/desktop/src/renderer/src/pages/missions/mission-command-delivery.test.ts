import { describe, expect, it } from "vitest";

import {
  createMissionSendAttempt,
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
});
