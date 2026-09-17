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
