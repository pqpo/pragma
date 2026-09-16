import { describe, expect, it, vi } from "vitest";

import {
  MissionSchema,
  type Mission,
  type MissionSummary,
} from "../../../shared/contracts/index.ts";
import { createMissionReadModel } from "./mission-read-model.ts";

const missionId = "22222222-2222-4222-8222-222222222222";
const executionId = "44444444-4444-4444-8444-444444444444";

function mission(): Mission {
  return MissionSchema.parse({
    schemaVersion: "pragma.mission/v10",
    id: missionId,
    title: "Canonical status",
    goal: "Prefer the Core terminal fact",
    initialMessageId: "55555555-5555-4555-8555-555555555555",
    toolPermissionMode: "request-approval",
    workspace: { path: "/tmp/workspace", basename: "workspace" },
    project: { id: "studio", revision: 1 },
    executor: { kind: "expert", ref: "expert:v2vt1v01vzz6j24q", name: "Expert" },
    execution: {
      id: executionId,
      inputMessageId: "66666666-6666-4666-8666-666666666666",
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

function summary(): MissionSummary {
  return {
    id: missionId,
    title: "Canonical status",
    workspace: { basename: "workspace" },
    executor: { kind: "expert", name: "Expert" },
    execution: { id: executionId, status: "running" },
    source: { type: "task" },
    lifecycleStatus: "active",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("Mission read model", () => {
  it("uses the Core terminal record for a detail read", async () => {
    const readModel = createMissionReadModel({
      missions: { get: async () => mission(), list: async () => [summary()] },
      executions: {
        get: async () =>
          ({
            executionId,
            status: "succeeded",
            output: { type: "inline", value: { answer: 42 } },
            updatedAt: "2026-09-01T00:02:00.000Z",
          }) as never,
      },
    });

    await expect(readModel.get(missionId)).resolves.toMatchObject({
      execution: {
        id: executionId,
        status: "succeeded",
        finishedAt: "2026-09-01T00:02:00.000Z",
      },
    });
  });

  it("never fans out canonical reads from the availability-critical list", async () => {
    const getExecution = vi.fn(async () => await new Promise<never>(() => undefined));
    const readModel = createMissionReadModel({
      missions: { get: async () => mission(), list: async () => [summary()] },
      executions: { get: getExecution },
    });

    await expect(readModel.list()).resolves.toEqual([summary()]);
    expect(getExecution).not.toHaveBeenCalled();
  });

  it("bounds a canonical detail read and returns persisted metadata on timeout", async () => {
    const onReadFailure = vi.fn();
    const readModel = createMissionReadModel({
      missions: { get: async () => mission(), list: async () => [summary()] },
      executions: { get: async () => await new Promise<never>(() => undefined) },
      canonicalReadTimeoutMs: 1,
      onReadFailure,
    });

    await expect(readModel.get(missionId)).resolves.toMatchObject({
      execution: { status: "running" },
    });
    expect(onReadFailure).toHaveBeenCalledWith(
      expect.objectContaining({ missionId, error: expect.any(Error) }),
    );
  });
});
