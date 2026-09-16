import { describe, expect, it, vi } from "vitest";

import { MissionSchema } from "../../../shared/contracts/index.ts";
import { MissionStatusService } from "./mission-status-service.ts";
import { createMissionTerminalReconciler } from "./mission-terminal-reconciler.ts";

const missionId = "22222222-2222-4222-8222-222222222222";
const executionId = "44444444-4444-4444-8444-444444444444";

function mission(id = missionId, currentExecutionId = executionId) {
  return MissionSchema.parse({
    schemaVersion: "pragma.mission/v10",
    id,
    title: "Reconcile terminal",
    goal: "Repair without blocking reads",
    initialMessageId: "55555555-5555-4555-8555-555555555555",
    toolPermissionMode: "request-approval",
    workspace: { path: "/tmp/workspace", basename: "workspace" },
    project: { id: "studio", revision: 1 },
    executor: { kind: "expert", ref: "expert:v2vt1v01vzz6j24q", name: "Expert" },
    execution: {
      id: currentExecutionId,
      inputMessageId: "66666666-6666-4666-8666-666666666666",
      status: "running",
      startedAt: "2026-09-16T00:00:00.000Z",
    },
    lifecycleStatus: "active",
    contextMounts: [],
    origin: { type: "user" },
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  });
}

describe("Mission terminal reconciler", () => {
  it("coalesces duplicate work and publishes the Core terminal fact before repair settles", async () => {
    let finishRepair!: () => void;
    const repair = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finishRepair = resolve;
        }),
    );
    const listener = vi.fn();
    const status = new MissionStatusService(vi.fn());
    status.subscribe(listener);
    const getMission = vi.fn(async () => mission());
    const reconciler = createMissionTerminalReconciler({
      missions: { get: getMission },
      executions: {
        get: async () =>
          ({
            executionId,
            status: "succeeded",
            output: { type: "inline", value: { answer: 42 } },
            updatedAt: "2026-09-16T00:01:00.000Z",
          }) as never,
      },
      repair,
      status,
      audienceForMission: () => "user",
      reportFailure: vi.fn(),
      concurrency: 1,
    });

    reconciler.schedule([missionId, missionId]);

    expect(getMission).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(repair).toHaveBeenCalledOnce());
    expect(getMission).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      audience: "user",
      missionId,
      revision: 1,
      execution: { id: executionId, status: "succeeded" },
    });
    finishRepair();
    await repair.mock.results[0]?.value;
  });

  it("frees worker capacity after a bounded wait without duplicating the stuck Mission", async () => {
    const secondMissionId = "33333333-3333-4333-8333-333333333333";
    const secondExecutionId = "55555555-5555-4555-8555-555555555555";
    const getMission = vi.fn(async (id: string) => {
      if (id === missionId) return await new Promise<never>(() => undefined);
      return mission(secondMissionId, secondExecutionId);
    });
    const repair = vi.fn(async () => undefined);
    const reportFailure = vi.fn();
    const reconciler = createMissionTerminalReconciler({
      missions: { get: getMission },
      executions: {
        get: async () =>
          ({
            executionId: secondExecutionId,
            status: "succeeded",
            updatedAt: "2026-09-16T00:01:00.000Z",
          }) as never,
      },
      repair,
      status: new MissionStatusService(vi.fn()),
      audienceForMission: () => "user",
      reportFailure,
      concurrency: 1,
      timeoutMs: 5,
    });

    reconciler.schedule([missionId, secondMissionId]);
    await vi.waitFor(() => expect(repair).toHaveBeenCalledOnce());
    expect(reportFailure).toHaveBeenCalledWith({
      missionId,
      error: expect.objectContaining({ message: expect.stringContaining("timed out") }),
    });

    reconciler.schedule([missionId]);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(getMission.mock.calls.filter(([id]) => id === missionId)).toHaveLength(1);
  });

  it("rotates a bounded queue so repeatedly failing early Missions cannot starve later ones", async () => {
    const secondMissionId = "33333333-3333-4333-8333-333333333333";
    const secondExecutionId = "55555555-5555-4555-8555-555555555555";
    const repaired: string[] = [];
    const reportFailure = vi.fn();
    const reconciler = createMissionTerminalReconciler({
      missions: {
        get: async (id) =>
          id === missionId ? mission() : mission(secondMissionId, secondExecutionId),
      },
      executions: {
        get: async (id) =>
          ({
            executionId: id,
            status: "succeeded",
            updatedAt: "2026-09-16T00:01:00.000Z",
          }) as never,
      },
      repair: async ({ mission: candidate }) => {
        repaired.push(candidate.id);
        if (candidate.id === missionId) throw new Error("still degraded");
      },
      status: new MissionStatusService(vi.fn()),
      audienceForMission: () => "user",
      reportFailure,
      concurrency: 1,
      maxPending: 1,
    });

    reconciler.schedule([missionId, secondMissionId]);
    await vi.waitFor(() => expect(repaired).toEqual([missionId]));
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));

    reconciler.schedule([missionId, secondMissionId]);
    await vi.waitFor(() => expect(repaired).toEqual([missionId, secondMissionId]));
  });
});
