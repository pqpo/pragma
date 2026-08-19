import { describe, expect, it } from "vitest";

import cliEventFixture from "./fixtures/integration/cli-event-v1.json" with { type: "json" };
import cliResultFixture from "./fixtures/integration/cli-result-v1.json" with { type: "json" };
import {
  CliEventSchema,
  CliEventStreamSchema,
  CliResultSchema,
  IntegrationErrorCodeSchema,
  IntegrationErrorExitCodes,
  canTransitionMissionOperation,
  MissionCommandSchema,
  MissionOperationSchema,
  WorkspaceSelectionSchema,
} from "../src/integration/index.ts";

const requestId = "00000000-0000-4000-8000-000000000001";
const missionId = "00000000-0000-4000-8000-000000000002";
const executionId = "00000000-0000-4000-8000-000000000004";
const timestamp = "2026-08-19T00:00:00.000Z";

describe("integration wire v1", () => {
  it("parses the saved v1 JSON and JSONL golden fixtures", () => {
    expect(CliResultSchema.parse(cliResultFixture).ok).toBe(true);
    expect(CliEventSchema.parse(cliEventFixture).type).toBe("stream.end");
  });

  it("rejects incompatible result branches and future versions", () => {
    const result = {
      schemaVersion: "pragma.cli-result/v1",
      requestId,
      command: "mission.get",
      ok: true,
      result: {},
      error: {
        schemaVersion: "pragma.integration-error/v1",
        code: "INTERNAL_ERROR",
        message: "must not be present",
        retryable: false,
        category: "execution",
      },
      meta: {
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
        cliVersion: "0.0.0",
        protocolVersion: "pragma.integration/v1",
      },
    };

    expect(CliResultSchema.safeParse(result).success).toBe(false);
    expect(
      CliResultSchema.safeParse({ ...result, schemaVersion: "pragma.cli-result/v2" }).success,
    ).toBe(false);
  });

  it("requires a cursor only for replayable events", () => {
    const event = {
      schemaVersion: "pragma.cli-event/v1",
      requestId,
      eventId: "00000000-0000-4000-8000-000000000003",
      sequence: 0,
      emittedAt: timestamp,
      replayable: false,
      type: "output.delta",
      data: { itemId: "item", channel: "assistant", delta: "hello" },
    };

    expect(CliEventSchema.safeParse(event).success).toBe(true);
    expect(CliEventSchema.safeParse({ ...event, replayable: true }).success).toBe(false);
    expect(CliEventSchema.safeParse({ ...event, cursor: "not-allowed" }).success).toBe(false);
  });

  it("models only forward operation transitions and one final stream end", () => {
    expect(canTransitionMissionOperation("accepted", "queued")).toBe(true);
    expect(canTransitionMissionOperation("applied", "queued")).toBe(false);
    const end = {
      schemaVersion: "pragma.cli-event/v1",
      requestId,
      eventId: "00000000-0000-4000-8000-000000000010",
      sequence: 2,
      emittedAt: timestamp,
      replayable: true,
      cursor: "cursor-2",
      type: "stream.end",
      data: { status: "completed", exitCode: 0 },
    };
    const snapshot = {
      ...end,
      eventId: "00000000-0000-4000-8000-000000000011",
      sequence: 1,
      cursor: "cursor-1",
      type: "mission.snapshot",
      data: { missionId, status: "active" },
    };

    expect(CliEventStreamSchema.safeParse([snapshot, end]).success).toBe(true);
    expect(CliEventStreamSchema.safeParse([end, snapshot]).success).toBe(false);
  });

  it("enforces strict steer targets and command payload kinds", () => {
    const request = {
      schemaVersion: "pragma.integration-request/v1",
      requestId,
      payloadHash: `sha256:${"a".repeat(64)}`,
      requestedAt: timestamp,
      client: {
        surface: "cli",
        version: "0.0.0",
        instanceId: "00000000-0000-4000-8000-000000000005",
      },
    };
    const command = {
      schemaVersion: "pragma.mission-command/v1",
      commandId: "00000000-0000-4000-8000-000000000006",
      request,
      missionId,
      kind: "steer",
      target: { executionId },
      payload: { kind: "steer", input: { prompt: "Focus on tests" } },
      targetFencingToken: "1",
      state: "pending",
      createdAt: timestamp,
    };

    expect(MissionCommandSchema.safeParse(command).success).toBe(true);
    expect(MissionCommandSchema.safeParse({ ...command, target: undefined }).success).toBe(false);
    expect(
      MissionCommandSchema.safeParse({
        ...command,
        payload: { kind: "send", input: { prompt: "wrong" } },
      }).success,
    ).toBe(false);
  });

  it("validates operation terminal and workspace identity invariants", () => {
    const operation = {
      schemaVersion: "pragma.mission-operation/v1",
      operationId: "00000000-0000-4000-8000-000000000007",
      requestId,
      missionId,
      kind: "run",
      state: "applied",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const workspace = {
      schemaVersion: "pragma.integration-workspace/v1",
      requestedPath: ".",
      canonicalPath: "/workspace",
      displayName: "workspace",
      identityHash: `sha256:${"b".repeat(64)}`,
      access: { exists: true, readable: true, writable: true },
      source: "cwd",
    };

    expect(MissionOperationSchema.safeParse(operation).success).toBe(false);
    expect(WorkspaceSelectionSchema.safeParse(workspace).success).toBe(true);
    expect(
      WorkspaceSelectionSchema.safeParse({ ...workspace, identityHash: "not-a-hash" }).success,
    ).toBe(false);
  });

  it("maps every stable error code to exactly one supported process exit code", () => {
    expect(Object.keys(IntegrationErrorExitCodes).sort()).toEqual(
      [...IntegrationErrorCodeSchema.options].sort(),
    );
    expect(new Set(Object.values(IntegrationErrorExitCodes))).toEqual(
      new Set([2, 3, 4, 5, 6, 7, 10, 130]),
    );
  });
});
