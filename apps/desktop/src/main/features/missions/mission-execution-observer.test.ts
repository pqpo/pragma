import { describe, expect, it, vi } from "vitest";

import { observeMissionExecution } from "./mission-execution-observer.ts";
import type { MissionStore } from "./mission-store.ts";

describe("Mission execution observer", () => {
  it("does not publish a terminal Mission state when its chat projection fails", async () => {
    const updateExecution = vi.fn();
    const missions = { updateExecution } as unknown as MissionStore;
    const executionFailure = new Error("interrupted");

    await expect(
      observeMissionExecution(
        missions,
        "mission-1",
        {
          executionId: "execution-1",
          result: Promise.reject(executionFailure),
          getState: async () => ({ status: "cancelled" }),
        },
        "2026-09-09T00:00:00.000Z",
        "message-1",
        () => undefined,
        undefined,
        () => {
          throw new Error("projection failed");
        },
      ),
    ).rejects.toThrow("projection failed");

    expect(updateExecution).not.toHaveBeenCalled();
  });

  it("publishes cancellation only after its terminal projection commits", async () => {
    const updateExecution = vi.fn(async () => undefined);
    const missions = { updateExecution } as unknown as MissionStore;
    const projected = vi.fn();

    await expect(
      observeMissionExecution(
        missions,
        "mission-1",
        {
          executionId: "execution-1",
          result: Promise.reject(new Error("interrupted")),
          getState: async () => ({ status: "cancelled" }),
        },
        "2026-09-09T00:00:00.000Z",
        "message-1",
        () => undefined,
        undefined,
        projected,
      ),
    ).resolves.toBe("terminal");

    expect(projected).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
    expect(updateExecution).toHaveBeenCalledWith(
      "mission-1",
      expect.objectContaining({ id: "execution-1", status: "cancelled" }),
      { executionId: "execution-1", statuses: ["queued", "running", "waiting"] },
    );
    expect(projected.mock.invocationCallOrder[0]).toBeLessThan(
      updateExecution.mock.invocationCallOrder[0]!,
    );
  });
});
