import { describe, expect, it, vi } from "vitest";

import type { MissionActivityReader } from "@pragma/local-host";

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
  it("uses the Local Host terminal activity for a detail read", async () => {
    const readModel = createMissionReadModel({
      missions: { get: async () => mission(), list: async () => [summary()] },
      activity: activityReader("succeeded"),
    });

    await expect(readModel.get(missionId)).resolves.toMatchObject({
      execution: {
        id: executionId,
        status: "succeeded",
        finishedAt: "2026-09-01T00:02:00.000Z",
      },
    });
  });

  it("projects active list summaries from the Local Host activity fact", async () => {
    const activity = activityReader("succeeded");
    const readModel = createMissionReadModel({
      missions: { get: async () => mission(), list: async () => [summary()] },
      activity,
    });

    await expect(readModel.list()).resolves.toEqual([
      expect.objectContaining({ execution: { id: executionId, status: "succeeded" } }),
    ]);
    expect(activity.readMany).toHaveBeenCalledOnce();
  });

  it("keeps persisted metadata when the activity authority is degraded", async () => {
    const readModel = createMissionReadModel({
      missions: { get: async () => mission(), list: async () => [summary()] },
      activity: activityReader("running", true),
    });

    await expect(readModel.get(missionId)).resolves.toMatchObject({
      execution: { status: "running" },
    });
  });
});

function activityReader(
  status: "running" | "succeeded",
  degraded = false,
): MissionActivityReader & {
  readonly read: ReturnType<typeof vi.fn<MissionActivityReader["read"]>>;
  readonly readMany: ReturnType<typeof vi.fn<MissionActivityReader["readMany"]>>;
} {
  const snapshot = {
    executionId,
    status,
    updatedAt: "2026-09-01T00:02:00.000Z",
    source: status === "succeeded" ? ("core-execution" as const) : ("persisted-metadata" as const),
    degraded,
  };
  return {
    read: vi.fn(async () => snapshot),
    readMany: vi.fn(async (inputs) => inputs.map(() => snapshot)),
  };
}
