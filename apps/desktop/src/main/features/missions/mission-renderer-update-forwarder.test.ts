import { describe, expect, it, vi } from "vitest";

import type { MissionChatUpdate } from "../../../shared/contracts/index.ts";
import {
  forwardMissionChatNotification,
  forwardMissionStatusNotification,
  forwardMissionWorkNotification,
} from "./mission-renderer-update-forwarder.ts";

const missionId = "00000000-0000-4000-8000-000000000000";
const executionId = "00000000-0000-4000-8000-000000000003";
const streamId = "00000000-0000-4000-8000-000000000004";

describe("Mission renderer update forwarding", () => {
  it("forwards user chat patches in revision order", () => {
    const send = vi.fn();
    const updates: MissionChatUpdate[] = [1, 2, 3].map((revision) => ({
      kind: "patch",
      missionId,
      streamId,
      revision,
      patches: [
        { type: "entry.append", entryId: "answer", field: "content", delta: String(revision) },
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

  it("forwards a status delta without reading the Mission", () => {
    const send = vi.fn();

    forwardMissionStatusNotification({
      notification: {
        audience: "user",
        missionId,
        revision: 7,
        execution: { id: executionId, status: "succeeded" },
      },
      getSender: () => ({ send }),
    });

    expect(send).toHaveBeenCalledWith("missions:status:updated", {
      missionId,
      revision: 7,
      execution: { id: executionId, status: "succeeded" },
    });
  });

  it("drops internal chat, status, and work updates", () => {
    const send = vi.fn();

    forwardMissionChatNotification({
      notification: {
        audience: "internal",
        update: { kind: "invalidate", missionId, streamId, revision: 1 },
      },
      getSender: () => ({ send }),
    });
    forwardMissionStatusNotification({
      notification: { audience: "internal", missionId, revision: 1 },
      getSender: () => ({ send }),
    });
    forwardMissionWorkNotification({
      notification: { audience: "internal", update: { missionId, revision: 1 } },
      getSender: () => ({ send }),
    });

    expect(send).not.toHaveBeenCalled();
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
