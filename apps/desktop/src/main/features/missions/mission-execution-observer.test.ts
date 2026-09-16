import { describe, expect, it, vi } from "vitest";

import { observeMissionExecution } from "./mission-execution-observer.ts";
import type { MissionStore } from "./mission-store.ts";

describe("Mission execution observer", () => {
  it("publishes a terminal Mission state even when its chat projection fails", async () => {
    const updateExecution = vi.fn();
    const onSideEffectError = vi.fn();
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
        undefined,
        undefined,
        () => {
          throw new Error("projection failed");
        },
        onSideEffectError,
      ),
    ).resolves.toBe("terminal");

    expect(updateExecution).toHaveBeenCalledWith(
      "mission-1",
      expect.objectContaining({ id: "execution-1", status: "cancelled" }),
      { executionId: "execution-1", statuses: ["queued", "running", "waiting"] },
    );
    expect(onSideEffectError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "projection failed",
      }),
    );
  });

  it("projects the canonical terminal before updating the v10 recovery snapshot", async () => {
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

  it("does not let terminal cleanup failure roll back the committed status", async () => {
    const updateExecution = vi.fn(async () => undefined);
    const onSideEffectError = vi.fn();

    await expect(
      observeMissionExecution(
        { updateExecution } as unknown as MissionStore,
        "mission-1",
        {
          executionId: "execution-1",
          result: Promise.resolve({ answer: 42 }),
          getState: async () => ({ status: "succeeded" }),
        },
        "2026-09-09T00:00:00.000Z",
        "message-1",
        () => {
          throw new Error("cleanup failed");
        },
        undefined,
        undefined,
        undefined,
        undefined,
        onSideEffectError,
      ),
    ).resolves.toBe("terminal");

    expect(updateExecution).toHaveBeenCalledWith(
      "mission-1",
      expect.objectContaining({ status: "succeeded" }),
      expect.any(Object),
    );
    expect(onSideEffectError).toHaveBeenCalledOnce();
  });

  it("does not let a v10 snapshot write failure hide the canonical terminal", async () => {
    const projected = vi.fn(async () => undefined);
    const onSideEffectError = vi.fn();

    await expect(
      observeMissionExecution(
        {
          updateExecution: vi.fn(async () => {
            throw new Error("snapshot unavailable");
          }),
        } as unknown as MissionStore,
        "mission-1",
        {
          executionId: "execution-1",
          result: Promise.resolve({ answer: 42 }),
          getState: async () => ({ status: "succeeded" }),
        },
        "2026-09-09T00:00:00.000Z",
        "message-1",
        () => undefined,
        undefined,
        projected,
        undefined,
        undefined,
        onSideEffectError,
      ),
    ).resolves.toBe("terminal");

    expect(projected).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" }));
    expect(onSideEffectError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "snapshot unavailable" }),
    );
  });
});
