import { describe, expect, it, vi } from "vitest";

import {
  createMissionActivityReader,
  projectMissionExecutionActivity,
  type MissionEvent,
} from "../src/index.ts";

const missionId = "22222222-2222-4222-8222-222222222222";
const executionId = "44444444-4444-4444-8444-444444444444";

describe("Mission activity read model", () => {
  it("uses a durable terminal Mission event without reading Core", async () => {
    const getExecution = vi.fn();
    const reader = createMissionActivityReader({
      controller: controller([
        event(1, "run.started", { executionId }),
        event(2, "run.succeeded", { executionId }),
      ]),
      executions: { get: getExecution },
    });

    await expect(reader.read(input())).resolves.toMatchObject({
      executionId,
      status: "succeeded",
      source: "mission-events",
      degraded: false,
    });
    expect(getExecution).not.toHaveBeenCalled();
  });

  it("lets a canonical terminal Execution close a stale active event projection", async () => {
    const reader = createMissionActivityReader({
      controller: controller([event(1, "run.started", { executionId })]),
      executions: {
        get: async () =>
          ({
            executionId,
            status: "succeeded",
            updatedAt: "2026-09-01T00:02:00.000Z",
          }) as never,
      },
    });

    await expect(reader.read(input())).resolves.toMatchObject({
      status: "succeeded",
      source: "core-execution",
      updatedAt: "2026-09-01T00:02:00.000Z",
      degraded: true,
    });
  });

  it("returns persisted metadata as degraded when both authority reads fail", async () => {
    const onReadFailure = vi.fn();
    const reader = createMissionActivityReader({
      controller: {
        readSnapshot: async () => {
          throw new Error("events unavailable");
        },
      },
      executions: {
        get: async () => {
          throw new Error("execution unavailable");
        },
      },
      onReadFailure,
    });

    await expect(reader.read(input())).resolves.toMatchObject({
      status: "running",
      source: "persisted-metadata",
      degraded: true,
    });
    expect(onReadFailure).toHaveBeenCalledTimes(2);
  });

  it("does not let a later execution terminal event settle an earlier execution", () => {
    const laterExecutionId = "77777777-7777-4777-8777-777777777777";
    expect(
      projectMissionExecutionActivity(
        [
          event(1, "run.started", { executionId }),
          event(2, "run.started", { executionId: laterExecutionId }),
          event(3, "run.succeeded", { executionId: laterExecutionId }),
        ],
        executionId,
      ),
    ).toMatchObject({ status: "running" });
  });

  it("does not block the Mission rail behind a slow owner snapshot", async () => {
    const reader = createMissionActivityReader({
      controller: {
        readSnapshot: async () => await new Promise<never>(() => undefined),
      },
      executions: { get: vi.fn() },
      canonicalReadTimeoutMs: 20,
      listReadBudgetMs: 5,
    });
    const startedAt = performance.now();

    await expect(reader.readMany([input()])).resolves.toMatchObject([
      { status: "running", source: "persisted-metadata" },
    ]);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});

it("keeps a timed-out underlying control read in its slot until it actually settles", async () => {
  let release!: (value: never) => void;
  const gate = new Promise<never>((resolve) => {
    release = resolve;
  });
  const readSnapshot = vi.fn(() => gate);
  const reader = createMissionActivityReader({
    controller: { readSnapshot },
    executions: { get: async () => undefined },
    canonicalReadTimeoutMs: 5,
  });
  await reader.read(input());
  await reader.read(input());
  expect(readSnapshot).toHaveBeenCalledTimes(1);
  const waiting = reader.read(input());
  release({
    snapshot: { eventSequence: 2 },
    cursor: "cursor",
    events: [event(1, "run.started", { executionId }), event(2, "run.succeeded", { executionId })],
  } as never);
  expect(await waiting).toMatchObject({ status: "succeeded", source: "mission-events" });
  expect(readSnapshot).toHaveBeenCalledTimes(1);
});

function input() {
  return {
    missionId,
    execution: {
      id: executionId,
      status: "running" as const,
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  };
}

function controller(events: readonly MissionEvent[]) {
  return {
    readSnapshot: async () =>
      ({
        snapshot: { eventSequence: events.length },
        events,
        cursor: "cursor",
      }) as never,
  };
}

function event(sequence: number, type: string, data: Record<string, unknown>): MissionEvent {
  return {
    schemaVersion: "pragma.local-host-mission-event/v1",
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    missionId,
    sequence,
    occurredAt: `2026-09-01T00:00:0${sequence}.000Z`,
    type,
    data,
  };
}

it("reuses fresh list entries and rechecks degraded terminals without repeating the same warning", async () => {
  let events = [event(1, "run.started", { executionId })];
  const readSnapshot = vi.fn(async () => ({ events }) as never);
  const onReadFailure = vi.fn();
  let now = Date.now();
  const date = vi.spyOn(Date, "now").mockImplementation(() => now);
  const reader = createMissionActivityReader({
    controller: { readSnapshot },
    executions: {
      get: async () => ({ status: "cancelled", updatedAt: input().execution.updatedAt }) as never,
    },
    onReadFailure,
    activeCacheTtlMs: 100,
  });
  try {
    expect(await reader.readMany([input()])).toMatchObject([
      { status: "cancelled", degraded: true },
    ]);
    await reader.readMany([input()]);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    now += 101;
    await reader.readMany([input()]);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(onReadFailure).toHaveBeenCalledOnce();
    events = [...events, event(2, "run.interrupted", { executionId })];
    now += 101;
    expect(await reader.readMany([input()])).toMatchObject([
      { status: "cancelled", degraded: false, source: "mission-events" },
    ]);
    now += 10000;
    await reader.readMany([input()]);
    expect(readSnapshot).toHaveBeenCalledTimes(3);
    // A changed owner envelope invalidates its terminal cache.
    await reader.readMany([
      { ...input(), execution: { ...input().execution, updatedAt: "2026-09-02T00:00:00.000Z" } },
    ]);
    expect(readSnapshot).toHaveBeenCalledTimes(4);
    events = [event(1, "run.started", { executionId })];
    await reader.read(input());
    expect(onReadFailure).toHaveBeenCalledTimes(2);
  } finally {
    date.mockRestore();
  }
});

it("caches active list reads only for their TTL and invalidates a successor Execution", async () => {
  const readSnapshot = vi.fn(controller([event(1, "run.started", { executionId })]).readSnapshot);
  let now = Date.now();
  const date = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const reader = createMissionActivityReader({
      controller: { readSnapshot },
      executions: { get: async () => undefined },
      activeCacheTtlMs: 100,
    });
    await reader.readMany([input()]);
    await reader.readMany([input()]);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    now += 101;
    await reader.readMany([input()]);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    await reader.readMany([{ ...input(), execution: { ...input().execution, id: "successor" } }]);
    expect(readSnapshot).toHaveBeenCalledTimes(3);
  } finally {
    date.mockRestore();
  }
});

it("retains failure deduplication for a list larger than the single-owner cache", async () => {
  let now = Date.now();
  const date = vi.spyOn(Date, "now").mockImplementation(() => now);
  const onReadFailure = vi.fn();
  try {
    const reader = createMissionActivityReader({
      controller: controller([]),
      executions: {
        get: async () => ({ status: "cancelled", updatedAt: input().execution.updatedAt }) as never,
      },
      activeCacheTtlMs: 0,
      onReadFailure,
    });
    const inputs = Array.from({ length: 257 }, (_, index) => ({
      ...input(),
      missionId: `mission-${index}`,
      execution: { ...input().execution, id: `execution-${index}` },
    }));
    await reader.readMany(inputs);
    expect(onReadFailure).toHaveBeenCalledTimes(inputs.length);
    now += 1;
    await reader.readMany(inputs);
    expect(onReadFailure).toHaveBeenCalledTimes(inputs.length);
  } finally {
    date.mockRestore();
  }
});
