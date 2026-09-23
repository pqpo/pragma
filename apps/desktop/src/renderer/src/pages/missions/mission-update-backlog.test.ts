import type { MissionChatUpdate } from "../../../../shared/contracts/index.ts";
import { describe, expect, it } from "vitest";

import {
  enqueueMissionChatUpdate,
  MISSION_CHAT_PENDING_BYTE_LIMIT,
  MISSION_CHAT_PENDING_UPDATE_LIMIT,
} from "./mission-update-backlog.ts";

describe("Mission update backlog", () => {
  it("drops stale updates and remains within the item limit", () => {
    let pending: readonly MissionChatUpdate[] = [];
    let pendingBytes = 0;
    let overflows = 0;
    let highWaterItems = 0;
    let highWaterBytes = 0;

    for (let index = 0; index < 30_000; index += 1) {
      const enqueued = enqueueMissionChatUpdate(pending, pendingBytes, {
        missionId: "00000000-0000-4000-8000-000000000001",
        streamId: "00000000-0000-4000-8000-000000000002",
        revision: index + 1,
        kind: "invalidate",
      });
      pending = enqueued.pending;
      pendingBytes = enqueued.pendingBytes;
      if (enqueued.overflowed) overflows += 1;
      highWaterItems = Math.max(highWaterItems, pending.length);
      highWaterBytes = Math.max(highWaterBytes, pendingBytes);
    }

    expect(overflows).toBeGreaterThan(0);
    expect(highWaterItems).toBeLessThanOrEqual(MISSION_CHAT_PENDING_UPDATE_LIMIT);
    expect(highWaterBytes).toBeLessThanOrEqual(MISSION_CHAT_PENDING_BYTE_LIMIT);
  });

  it("drops a single update larger than the byte limit", () => {
    const enqueued = enqueueMissionChatUpdate([], 0, {
      missionId: "00000000-0000-4000-8000-000000000001",
      streamId: "00000000-0000-4000-8000-000000000002",
      revision: 1,
      kind: "patch",
      patches: [
        {
          type: "entry.append",
          entryId: "assistant:1",
          field: "content",
          delta: "x".repeat(MISSION_CHAT_PENDING_BYTE_LIMIT),
        },
      ],
    });

    expect(enqueued).toMatchObject({ pending: [], pendingBytes: 0, overflowed: true });
  });
});
