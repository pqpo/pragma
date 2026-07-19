import type { SessionEventPage } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { listAllRootSessionEvents } from "../src/session-events.ts";

describe("Steward session events", () => {
  it("follows every session event page", async () => {
    const first = { eventId: "first" } as SessionEventPage["items"][number];
    const second = { eventId: "second" } as SessionEventPage["items"][number];
    const listEvents = vi
      .fn()
      .mockResolvedValueOnce({ items: [first], nextCursor: { offset: 1_000 } })
      .mockResolvedValueOnce({ items: [second] });

    await expect(listAllRootSessionEvents({ listEvents })).resolves.toEqual([first, second]);
    expect(listEvents).toHaveBeenNthCalledWith(1, {
      scope: { kind: "root" },
      limit: 1_000,
    });
    expect(listEvents).toHaveBeenNthCalledWith(2, {
      scope: { kind: "root" },
      limit: 1_000,
      after: { offset: 1_000 },
    });
  });
});
