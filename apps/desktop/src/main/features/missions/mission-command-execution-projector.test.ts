import { describe, expect, it, vi } from "vitest";

import type { MissionControllerStore } from "@pragma/local-host";

import { MissionSchema } from "../../../shared/contracts/index.ts";
import { createMissionCommandExecutionProjector } from "./mission-command-execution-projector.ts";

const missionId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const executionId = "44444444-4444-4444-8444-444444444444";

function mission() {
  return MissionSchema.parse({
    schemaVersion: "pragma.mission/v10",
    id: missionId,
    title: "Projection",
    goal: "Project a follow-up turn",
    initialMessageId: "55555555-5555-4555-8555-555555555555",
    toolPermissionMode: "request-approval",
    workspace: { path: "/tmp/workspace", basename: "workspace" },
    project: { id: "studio", revision: 1 },
    executor: { kind: "expert", ref: "expert:v2vt1v01vzz6j24q", name: "Expert" },
    execution: {
      id: executionId,
      inputMessageId: requestId,
      status: "running",
      startedAt: "2026-09-01T00:00:00.000Z",
    },
    lifecycleStatus: "active",
    contextMounts: [],
    origin: { type: "user" },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
}

describe("Mission command execution projector", () => {
  it("projects a follow-up command through canonical run events exactly once", async () => {
    const events: Array<{ readonly type: string; readonly data: Record<string, unknown> }> = [];
    const controller = {
      getOperation: vi.fn(async () => ({ kind: "send" })),
      readSnapshot: vi.fn(async () => ({ events })),
      write: vi.fn(
        async ({ operation }: { readonly operation: (context: unknown) => Promise<unknown> }) =>
          await operation({
            appendEvent: async (type: string, data: Record<string, unknown>) => {
              events.push({ type, data });
              return {};
            },
          }),
      ),
    } as unknown as MissionControllerStore;
    const projector = createMissionCommandExecutionProjector({
      controller,
      ownerScope: {
        currentGuard: () => ({
          claimId: "66666666-6666-4666-8666-666666666666",
          fencingToken: "1",
        }),
      },
    });

    const staleMission = MissionSchema.parse({
      ...mission(),
      execution: { ...mission().execution!, inputMessageId: mission().initialMessageId },
    });
    await projector.link({ mission: staleMission, executionId, requestId });
    await projector.link({ mission: staleMission, executionId, requestId });
    await projector.terminal({
      mission: mission(),
      executionId,
      status: "succeeded",
      result: { answer: 42 },
    });

    expect(events).toEqual([
      { type: "run.started", data: { executionId } },
      { type: "run.succeeded", data: { executionId, result: { answer: 42 } } },
    ]);
    expect(controller.getOperation).toHaveBeenCalledWith({ missionId, requestId });
  });

  it("ignores executions that were not created by a durable send or steer command", async () => {
    const write = vi.fn();
    const controller = {
      getOperation: vi.fn(async () => undefined),
      write,
    } as unknown as MissionControllerStore;
    const projector = createMissionCommandExecutionProjector({
      controller,
      ownerScope: { currentGuard: () => undefined },
    });

    await projector.link({ mission: mission(), executionId, requestId });
    await projector.terminal({ mission: mission(), executionId, status: "cancelled" });

    expect(write).not.toHaveBeenCalled();
  });
});
