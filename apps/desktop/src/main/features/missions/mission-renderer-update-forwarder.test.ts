import { describe, expect, it, vi } from "vitest";

import { MissionSchema, type MissionChatUpdate } from "../../../shared/contracts/index.ts";
import type { MissionStatusNotification } from "./mission-status-service.ts";
import {
  createMissionSummaryRefreshScheduler,
  forwardMissionChatNotification,
  forwardMissionStatusNotification,
  forwardMissionWorkNotification,
  projectMissionStatusNotification,
} from "./mission-renderer-update-forwarder.ts";

const missionId = "00000000-0000-4000-8000-000000000000";

describe("Mission renderer update forwarding", () => {
  it("serializes summary refreshes for the same Mission while allowing other Missions through", async () => {
    const otherMissionId = "00000000-0000-4000-8000-000000000001";
    let releaseFirstRefresh: (() => void) | undefined;
    const started: string[] = [];
    const refresh = createMissionSummaryRefreshScheduler(async ({ missionId: id }) => {
      started.push(id);
      if (id === missionId && started.filter((candidate) => candidate === missionId).length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstRefresh = resolve;
        });
      }
    }, []);

    const first = refresh({ audience: "user", missionId });
    const second = refresh({ audience: "user", missionId });
    const other = refresh({ audience: "user", missionId: otherMissionId });

    await vi.waitFor(() => expect(started).toEqual([missionId, otherMissionId]));
    releaseFirstRefresh?.();
    await Promise.all([first, second, other]);

    expect(started).toEqual([missionId, otherMissionId, missionId]);
  });

  it("retries a transient status refresh without reordering later notifications", async () => {
    const refresh = vi
      .fn<(notification: MissionStatusNotification) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(undefined);
    const schedule = createMissionSummaryRefreshScheduler(refresh, [0]);
    const notification = { audience: "user" as const, missionId };

    await expect(schedule(notification)).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, notification);
    expect(refresh).toHaveBeenNthCalledWith(2, notification);
  });

  it("forwards user chat patches in revision order without refreshing the Mission", () => {
    const send = vi.fn();
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
      });
    }

    expect(send.mock.calls).toEqual(updates.map((update) => ["missions:chat:updated", update]));
  });

  it("drops internal chat and work updates", () => {
    const send = vi.fn();

    forwardMissionChatNotification({
      notification: {
        audience: "internal",
        update: { kind: "invalidate", missionId, revision: 1 },
      },
      getSender: () => ({ send }),
    });
    forwardMissionWorkNotification({
      notification: {
        audience: "internal",
        update: { missionId, revision: 1 },
      },
      getSender: () => ({ send }),
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("does not use chat invalidation as a Mission summary signal", () => {
    const send = vi.fn();
    const update = { kind: "invalidate", missionId, revision: 1 } as const;

    forwardMissionChatNotification({
      notification: { audience: "user", update },
      getSender: () => ({ send }),
    });

    expect(send).toHaveBeenCalledWith("missions:chat:updated", update);
  });

  it("refreshes Mission summaries from the dedicated status channel", async () => {
    const refreshMissionSummary = vi.fn(async () => undefined);
    const reportSummaryRefreshFailure = vi.fn();

    forwardMissionStatusNotification({
      notification: { audience: "user", missionId },
      refreshMissionSummary,
      reportSummaryRefreshFailure,
    });

    await vi.waitFor(() =>
      expect(refreshMissionSummary).toHaveBeenCalledWith({ audience: "user", missionId }),
    );
    expect(reportSummaryRefreshFailure).not.toHaveBeenCalled();
  });

  it("projects the Core-backed terminal notification over a stale running snapshot", () => {
    const mission = MissionSchema.parse({
      schemaVersion: "pragma.mission/v10",
      id: missionId,
      title: "Stale status",
      goal: "Finish",
      initialMessageId: "00000000-0000-4000-8000-000000000002",
      toolPermissionMode: "request-approval",
      workspace: { path: "/tmp/workspace", basename: "workspace" },
      project: { id: "studio", revision: 1 },
      executor: { kind: "expert", ref: "expert:v2vt1v01vzz6j24q", name: "Expert" },
      execution: {
        id: "00000000-0000-4000-8000-000000000003",
        inputMessageId: "00000000-0000-4000-8000-000000000002",
        status: "running",
        startedAt: "2026-09-16T00:00:00.000Z",
      },
      lifecycleStatus: "active",
      contextMounts: [],
      origin: { type: "user" },
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    });

    expect(
      projectMissionStatusNotification(mission, {
        audience: "user",
        missionId,
        execution: { id: mission.execution!.id, status: "succeeded" },
      }),
    ).toMatchObject({ execution: { id: mission.execution!.id, status: "succeeded" } });
  });

  it("reports a failed status-driven summary refresh", async () => {
    const failure = new Error("unavailable");
    const reportSummaryRefreshFailure = vi.fn();

    forwardMissionStatusNotification({
      notification: { audience: "user", missionId },
      refreshMissionSummary: async () => await Promise.reject(failure),
      reportSummaryRefreshFailure,
    });

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
