import { describe, expect, it } from "vitest";

import { toMissionQueueCommand } from "./mission-queue-command.ts";

describe("Mission queue commands", () => {
  it.each(["queue.steer", "queue.try-steer", "queue.remove"] as const)(
    "uses a new command request ID for %s while preserving the queue item target",
    (kind) => {
      const command = toMissionQueueCommand(
        {
          id: "00000000-0000-4000-8000-000000000001",
          requestId: "00000000-0000-4000-8000-000000000002",
          queueItemRequestId: "00000000-0000-4000-8000-000000000003",
        },
        kind,
      );

      expect(command.requestId).toBe("00000000-0000-4000-8000-000000000002");
      expect(command.payload.requestId).toBe("00000000-0000-4000-8000-000000000003");
      if (kind === "queue.try-steer") {
        expect(command).not.toHaveProperty("target");
      } else {
        expect(command.target?.queueItemId).toBe("00000000-0000-4000-8000-000000000003");
      }
    },
  );
});
