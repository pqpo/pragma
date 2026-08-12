import { describe, expect, it, vi } from "vitest";

import type { MissionChatUpdate } from "../../../shared/contracts/index.ts";
import {
  forwardMissionChatNotification,
  forwardMissionWorkNotification,
} from "./mission-renderer-update-forwarder.ts";

const missionId = "00000000-0000-4000-8000-000000000000";

describe("Mission renderer update forwarding", () => {
  it("forwards user chat patches in revision order without refreshing the Mission", () => {
    const send = vi.fn();
    const refreshMissionSummary = vi.fn(async () => undefined);
    const reportSummaryRefreshFailure = vi.fn();
    const updates: MissionChatUpdate[] = [1, 2, 3].map((revision) => ({
      kind: "patch",
      missionId,
      revision,
      patches: [
        {
          type: "entry.append",
          entryId: "answer",
          field: "content",
          delta: String(revision),
        },
      ],
    }));

    for (const update of updates) {
      forwardMissionChatNotification({
        notification: { audience: "user", update },
        getSender: () => ({ send }),
        refreshMissionSummary,
        reportSummaryRefreshFailure,
      });
    }

    expect(send.mock.calls).toEqual(updates.map((update) => ["missions:chat:updated", update]));
    expect(refreshMissionSummary).not.toHaveBeenCalled();
    expect(reportSummaryRefreshFailure).not.toHaveBeenCalled();
  });

  it("drops internal chat and work updates", () => {
    const send = vi.fn();
    const refreshMissionSummary = vi.fn(async () => undefined);

    forwardMissionChatNotification({
      notification: {
        audience: "internal",
        update: { kind: "invalidate", missionId, revision: 1 },
      },
      getSender: () => ({ send }),
      refreshMissionSummary,
      reportSummaryRefreshFailure: vi.fn(),
    });
    forwardMissionWorkNotification({
      notification: {
        audience: "internal",
        update: { missionId, revision: 1 },
      },
      getSender: () => ({ send }),
    });

    expect(send).not.toHaveBeenCalled();
    expect(refreshMissionSummary).not.toHaveBeenCalled();
  });

  it("forwards invalidation before asynchronously refreshing the Mission summary", async () => {
    const send = vi.fn();
    let finishRefresh: (() => void) | undefined;
    const refreshMissionSummary = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const reportSummaryRefreshFailure = vi.fn();
    const update = { kind: "invalidate", missionId, revision: 1 } as const;

    forwardMissionChatNotification({
      notification: { audience: "user", update },
      getSender: () => ({ send }),
      refreshMissionSummary,
      reportSummaryRefreshFailure,
    });

    expect(send).toHaveBeenCalledWith("missions:chat:updated", update);
    expect(refreshMissionSummary).toHaveBeenCalledWith(missionId);
    expect(reportSummaryRefreshFailure).not.toHaveBeenCalled();
    finishRefresh?.();
    await vi.waitFor(() => expect(reportSummaryRefreshFailure).not.toHaveBeenCalled());
  });

  it("reports a failed summary refresh without blocking invalidation delivery", async () => {
    const send = vi.fn();
    const failure = new Error("unavailable");
    const reportSummaryRefreshFailure = vi.fn();
    const update = { kind: "invalidate", missionId, revision: 1 } as const;

    forwardMissionChatNotification({
      notification: { audience: "user", update },
      getSender: () => ({ send }),
      refreshMissionSummary: async () => await Promise.reject(failure),
      reportSummaryRefreshFailure,
    });

    expect(send).toHaveBeenCalledWith("missions:chat:updated", update);
    await vi.waitFor(() =>
      expect(reportSummaryRefreshFailure).toHaveBeenCalledWith(failure, missionId),
    );
  });

  it("forwards user work updates without Mission access", () => {
    const send = vi.fn();
    const update = { missionId, revision: 1 };

    forwardMissionWorkNotification({
      notification: { audience: "user", update },
      getSender: () => ({ send }),
    });

    expect(send).toHaveBeenCalledWith("missions:work:updated", update);
  });
});
