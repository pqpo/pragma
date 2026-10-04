import { describe, expect, it, vi } from "vitest";

import { observeMissionExecution } from "../../src/missions/mission-execution-observer.ts";
import type { MissionStore } from "../../src/missions/repository/mission-store.ts";

describe("Mission execution observer", () => {
  it("settles successful admission without waiting for deferred product writes", async () => {
    const updateExecution = vi.fn(async () => {
      throw new Error("must be delivered in background");
    });
    const materialize = vi.fn(async () => {
      throw new Error("must be delivered in background");
    });
    const finished = vi.fn(async () => undefined);
    const terminal = vi.fn(async () => undefined);
    await expect(
      observeMissionExecution(
        { updateExecution } as unknown as MissionStore,
        "mission",
        {
          executionId: "execution",
          result: Promise.resolve("OK"),
          getState: async () => ({ status: "succeeded" }),
        },
        "2026-10-01T00:00:00.000Z",
        "request",
        finished,
        undefined,
        terminal,
        undefined,
        materialize,
        undefined,
        true,
      ),
    ).resolves.toBe("terminal");
    expect(terminal).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledOnce();
    expect(updateExecution).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });
  it("keeps the cancellation snapshot barrier when product writes are deferred", async () => {
    const updateExecution = vi.fn(async () => undefined);
    const materialize = vi.fn(async () => undefined);
    await observeMissionExecution(
      { updateExecution } as unknown as MissionStore,
      "mission",
      {
        executionId: "execution",
        result: Promise.reject(new Error("cancelled")),
        getState: async () => ({ status: "cancelled" }),
      },
      "2026-10-01T00:00:00.000Z",
      "request",
      async () => undefined,
      undefined,
      undefined,
      undefined,
      materialize,
      undefined,
      true,
    );
    expect(updateExecution).toHaveBeenCalledOnce();
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
  });
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

it("exposes the necessary terminal boundary before blocked history and cleanup", async () => {
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let durable!: () => void;
  const committed = new Promise<void>((resolve) => {
    durable = resolve;
  });
  const order: string[] = [];
  const observer = observeMissionExecution(
    {
      updateExecution: async () => {
        order.push("snapshot");
      },
    } as unknown as MissionStore,
    "mission",
    {
      executionId: "execution",
      result: Promise.resolve("answer"),
      getState: async () => ({ status: "succeeded" }),
    },
    "2026-10-03T00:00:00.000Z",
    "request",
    async () => {
      order.push("cleanup");
      await cleanup;
    },
    undefined,
    async () => {
      order.push("canonical");
    },
    undefined,
    async () => {
      order.push("history");
    },
    undefined,
    false,
    {
      onDurableTerminal: () => {
        order.push("durable");
        durable();
      },
    },
  );
  await committed;
  expect(order.slice(0, 3)).toEqual(["canonical", "snapshot", "durable"]);
  expect(order).not.toContain("history");
  releaseCleanup();
  await observer;
  expect(order).toEqual(["canonical", "snapshot", "durable", "cleanup", "history"]);
});

it("reports a failed necessary terminal write independently from enrichment failures", async () => {
  const failure = new Error("snapshot unavailable");
  const onDurableTerminal = vi.fn();
  await observeMissionExecution(
    {
      updateExecution: async () => {
        throw failure;
      },
    } as unknown as MissionStore,
    "mission",
    {
      executionId: "execution",
      result: Promise.resolve("answer"),
      getState: async () => ({ status: "succeeded" }),
    },
    "2026-10-03T00:00:00.000Z",
    "request",
    async () => undefined,
    undefined,
    undefined,
    undefined,
    async () => undefined,
    undefined,
    false,
    { onDurableTerminal, deferEnrichment: true },
  );
  expect(onDurableTerminal).toHaveBeenCalledWith(failure);
});
