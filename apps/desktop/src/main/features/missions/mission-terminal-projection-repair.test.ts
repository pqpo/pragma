import { describe, expect, it, vi } from "vitest";

import { MissionSchema } from "../../../shared/contracts/index.ts";
import type { MissionProjectionMismatch } from "./mission-read-model.ts";
import { MissionStatusService } from "./mission-status-service.ts";
import { createMissionTerminalProjectionRepair } from "./mission-terminal-projection-repair.ts";

const missionId = "22222222-2222-4222-8222-222222222222";
const executionId = "44444444-4444-4444-8444-444444444444";

function mismatch(): MissionProjectionMismatch {
  return {
    mission: MissionSchema.parse({
      schemaVersion: "pragma.mission/v10",
      id: missionId,
      title: "Repair terminal",
      goal: "Repair independently",
      initialMessageId: "55555555-5555-4555-8555-555555555555",
      toolPermissionMode: "request-approval",
      workspace: { path: "/tmp/workspace", basename: "workspace" },
      project: { id: "studio", revision: 1 },
      executor: { kind: "expert", ref: "expert:v2vt1v01vzz6j24q", name: "Expert" },
      execution: {
        id: executionId,
        inputMessageId: "66666666-6666-4666-8666-666666666666",
        status: "running",
        startedAt: "2026-09-16T00:00:00.000Z",
      },
      lifecycleStatus: "active",
      contextMounts: [],
      origin: { type: "user" },
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    }),
    executionId,
    status: "succeeded",
    finishedAt: "2026-09-16T00:01:00.000Z",
  };
}

function ownerScope() {
  const guard = { claimId: "77777777-7777-4777-8777-777777777777", fencingToken: "1" };
  return {
    currentGuard: vi.fn(() => guard),
    acquire: vi.fn(async () => guard),
    runWithGuard: vi.fn(async (_missionId, _guard, operation: () => Promise<void>) => {
      await operation();
    }),
    release: vi.fn(async () => undefined),
  } as never;
}

describe("Mission terminal projection repair", () => {
  it("repairs the terminal event even when the v10 snapshot remains unavailable", async () => {
    const terminal = vi.fn(async () => undefined);
    const updateExecution = vi.fn(async () => await Promise.reject(new Error("snapshot failed")));
    const listener = vi.fn();
    const status = new MissionStatusService(vi.fn());
    status.subscribe(listener);
    const reporter = {
      eventFailure: vi.fn(),
      snapshotFailure: vi.fn(),
      rebuilt: vi.fn(),
    };
    const repair = createMissionTerminalProjectionRepair({
      ownerScope: ownerScope(),
      missions: { updateExecution } as never,
      events: { terminal },
      status,
      audienceForMission: () => "user",
      reporter,
    });

    await expect(repair(mismatch())).rejects.toBeInstanceOf(AggregateError);
    expect(terminal).toHaveBeenCalledOnce();
    expect(updateExecution).toHaveBeenCalledTimes(3);
    expect(reporter.rebuilt).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      audience: "user",
      missionId,
      execution: { id: executionId, status: "succeeded" },
    });
  });

  it("repairs the v10 snapshot even when the terminal event remains unavailable", async () => {
    const terminal = vi.fn(async () => await Promise.reject(new Error("event failed")));
    const updateExecution = vi.fn(async () => mismatch().mission);
    const reporter = {
      eventFailure: vi.fn(),
      snapshotFailure: vi.fn(),
      rebuilt: vi.fn(),
    };
    const repair = createMissionTerminalProjectionRepair({
      ownerScope: ownerScope(),
      missions: { updateExecution } as never,
      events: { terminal },
      status: new MissionStatusService(vi.fn()),
      audienceForMission: () => "user",
      reporter,
    });

    await expect(repair(mismatch())).rejects.toBeInstanceOf(AggregateError);
    expect(terminal).toHaveBeenCalledTimes(3);
    expect(updateExecution).toHaveBeenCalledOnce();
    expect(reporter.eventFailure).toHaveBeenCalledOnce();
    expect(reporter.rebuilt).not.toHaveBeenCalled();
  });
});
