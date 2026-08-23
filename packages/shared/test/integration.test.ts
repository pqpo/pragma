import { describe, expect, it } from "vitest";

import cliEventFixture from "./fixtures/integration/cli-event-v1.json" with { type: "json" };
import cliResultFixture from "./fixtures/integration/cli-result-v1.json" with { type: "json" };
import {
  BoardListResultSchema,
  BoardReadResultSchema,
  BoardSearchResultSchema,
  CliEventSchema,
  CliEventStreamSchema,
  CliResultSchema,
  createIntegrationError,
  ExecutorDescriptorSchema,
  FencingTokenSchema,
  HumanInteractionEnvelopeSchema,
  IntegrationCapabilitySchema,
  IntegrationErrorCodeSchema,
  IntegrationErrorExitCodes,
  IntegrationErrorRetryPolicies,
  IntegrationErrorSchema,
  IntegrationRequestMetaSchema,
  MissionCommandKindSchema,
  canTransitionMissionOperation,
  MissionCommandSchema,
  MissionOperationSchema,
  PayloadHashSchema,
  WorkspaceSelectionSchema,
} from "../src/integration/index.ts";

const requestId = "00000000-0000-4000-8000-000000000001";
const missionId = "00000000-0000-4000-8000-000000000002";
const executionId = "00000000-0000-4000-8000-000000000004";
const timestamp = "2026-08-19T00:00:00.000Z";
const semanticResourceId = "0123456789abcdef";
const payloadHash = `sha256:${"a".repeat(64)}`;

const request = {
  schemaVersion: "pragma.integration-request/v1",
  requestId,
  payloadHash,
  requestedAt: timestamp,
  client: {
    surface: "cli",
    version: "0.0.0",
    instanceId: "00000000-0000-4000-8000-000000000005",
  },
} as const;

const fixedError = {
  schemaVersion: "pragma.integration-error/v1",
  code: "INVALID_ARGUMENT",
  message: "Invalid input.",
  retryable: false,
  category: "usage",
} as const;

const boardItem = {
  id: "handoffs/example.md",
  namespace: "mission-board",
  priority: "normal",
  revision: "1",
  sizeBytes: 1,
  trigger: "manual",
} as const;

function cliResult(result: unknown) {
  return {
    schemaVersion: "pragma.cli-result/v1",
    requestId,
    command: "mission.get",
    ok: true,
    result,
    meta: {
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      cliVersion: "0.0.0",
      protocolVersion: "pragma.integration/v1",
    },
  };
}

function streamEnd(status: "completed" | "failed" | "interrupted", sequence = 1) {
  return {
    schemaVersion: "pragma.cli-event/v1",
    requestId,
    eventId: `00000000-0000-4000-8000-0000000000${sequence + 20}`,
    sequence,
    emittedAt: timestamp,
    replayable: true,
    cursor: `cursor-${sequence}`,
    type: "stream.end",
    data: {
      status,
      exitCode: status === "completed" ? 0 : status === "interrupted" ? 130 : 10,
      ...(status === "failed" ? { error: fixedError } : {}),
    },
  };
}

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

  it("accepts every JSON value in successful CLI results and rejects non-JSON values", () => {
    for (const result of [{ key: [true, null] }, ["item", 1], "value", 1, true, null]) {
      expect(CliResultSchema.safeParse(cliResult(result)).success).toBe(true);
    }

    for (const result of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => undefined]) {
      expect(CliResultSchema.safeParse(cliResult(result)).success).toBe(false);
    }
    expect(CliResultSchema.safeParse({ ...cliResult(null), error: fixedError }).success).toBe(false);
    expect(
      CliResultSchema.safeParse({
        ...cliResult(null),
        ok: false,
        result: undefined,
        error: fixedError,
      }).success,
    ).toBe(true);
  });

  it("requires a final stream.end while retaining complete-stream invariants", () => {
    const snapshot = {
      schemaVersion: "pragma.cli-event/v1",
      requestId,
      eventId: "00000000-0000-4000-8000-000000000019",
      sequence: 0,
      emittedAt: timestamp,
      replayable: true,
      cursor: "cursor-0",
      type: "mission.snapshot",
      data: { missionId, status: "active" },
    };

    for (const status of ["completed", "failed", "interrupted"] as const) {
      expect(CliEventStreamSchema.safeParse([snapshot, streamEnd(status)]).success).toBe(true);
    }
    expect(CliEventStreamSchema.safeParse([]).success).toBe(false);
    expect(CliEventStreamSchema.safeParse([snapshot]).success).toBe(false);
    expect(
      CliEventStreamSchema.safeParse([snapshot, streamEnd("completed"), streamEnd("completed", 2)]).success,
    ).toBe(false);
    expect(
      CliEventStreamSchema.safeParse([streamEnd("completed"), snapshot]).success,
    ).toBe(false);

    // A single event remains the explicit entry point for incremental JSONL parsing.
    expect(CliEventSchema.safeParse(snapshot).success).toBe(true);
  });

  it("accepts M2 top-level schemas and rejects unknown fields and future versions", () => {
    const executor = {
      schemaVersion: "pragma.integration-executor/v1",
      ref: { kind: "expert", id: semanticResourceId },
      name: "Example expert",
      description: "",
      source: "built_in",
      availability: { status: "ready", blockingCodes: [] },
      workspace: { required: true, allowNonGitDirectory: false },
      capabilities: { interactive: true, resumable: true, steerable: true, supportsQueue: true },
    };
    const operation = {
      schemaVersion: "pragma.mission-operation/v1",
      operationId: "00000000-0000-4000-8000-000000000007",
      requestId,
      missionId,
      kind: "run",
      state: "applied",
      createdAt: timestamp,
      updatedAt: timestamp,
      result: { missionId },
    };
    const command = {
      schemaVersion: "pragma.mission-command/v1",
      commandId: "00000000-0000-4000-8000-000000000006",
      request,
      missionId,
      kind: "send",
      payload: { kind: "send", input: { prompt: "Continue" } },
      state: "pending",
      createdAt: timestamp,
    };
    const humanRequest = {
      schemaVersion: "pragma.human-interaction/v1",
      kind: "request",
      missionId,
      executionId,
      interactionId: "interaction-1",
      interaction: { kind: "question", prompt: "Proceed?" },
    };
    const boardList = {
      schemaVersion: "pragma.board-list/v1",
      missionId,
      items: [boardItem],
    };
    const boardRead = {
      schemaVersion: "pragma.board-read/v1",
      missionId,
      item: { ...boardItem, content: "content", contentRange: { start: 0, end: 7, totalBytes: 7 } },
    };
    const boardSearch = {
      schemaVersion: "pragma.board-search/v1",
      missionId,
      query: "content",
      matches: [{ item: boardItem, line: 1, snippet: "content" }],
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
    const schemas = [
      ["integration request", IntegrationRequestMetaSchema, request],
      [
        "integration capability",
        IntegrationCapabilitySchema,
        {
          schemaVersion: "pragma.integration-capability/v1",
          protocol: "pragma.integration/v1",
          readableVersions: ["pragma.cli-result/v1"],
          migratableFromVersions: [],
          features: ["cli"],
        },
      ],
      ["integration error", IntegrationErrorSchema, fixedError],
      ["workspace", WorkspaceSelectionSchema, workspace],
      ["executor", ExecutorDescriptorSchema, executor],
      ["operation", MissionOperationSchema, operation],
      ["command", MissionCommandSchema, command],
      ["human interaction", HumanInteractionEnvelopeSchema, humanRequest],
      ["board list", BoardListResultSchema, boardList],
      ["board read", BoardReadResultSchema, boardRead],
      ["board search", BoardSearchResultSchema, boardSearch],
      ["CLI result", CliResultSchema, cliResult({})],
      ["CLI event", CliEventSchema, event],
    ] as const;

    for (const [name, schema, value] of schemas) {
      expect(schema.safeParse(value).success, `${name} valid`).toBe(true);
      expect(schema.safeParse({ ...value, unexpected: true }).success, `${name} strict`).toBe(false);
      expect(
        schema.safeParse({ ...value, schemaVersion: value.schemaVersion.replace("/v1", "/v2") })
          .success,
        `${name} future version`,
      ).toBe(false);
    }

    expect(ExecutorDescriptorSchema.safeParse({ ...executor, ref: { kind: "expert" } }).success).toBe(
      false,
    );
    expect(HumanInteractionEnvelopeSchema.safeParse({ ...humanRequest, kind: "invalid" }).success).toBe(
      false,
    );
    expect(CliEventSchema.safeParse({ ...event, data: { itemId: "item", delta: 1 } }).success).toBe(
      false,
    );
  });

  it("covers board schemas, command state and target matrices, and primitive boundaries", () => {
    const commandPayloads = [
      ["send", { kind: "send", input: { prompt: "Send" } }, undefined],
      ["steer", { kind: "steer", input: { prompt: "Steer" } }, { executionId }],
      ["respond", { kind: "respond", response: { decision: "yes" } }, undefined],
      ["interrupt", { kind: "interrupt", reason: "Stop" }, undefined],
      ["queue.remove", { kind: "queue.remove", requestId }, undefined],
      ["queue.resume", { kind: "queue.resume" }, undefined],
      [
        "queue.steer",
        { kind: "queue.steer", requestId, input: { prompt: "Steer queued" } },
        { executionId },
      ],
    ] as const;

    for (const [kind, payload, target] of commandPayloads) {
      const command = {
        schemaVersion: "pragma.mission-command/v1",
        commandId: "00000000-0000-4000-8000-000000000006",
        request,
        missionId,
        kind,
        payload,
        ...(target === undefined ? {} : { target }),
        state: "pending",
        createdAt: timestamp,
      };
      expect(MissionCommandSchema.safeParse(command).success, `${kind} command`).toBe(true);
    }
    for (const state of ["pending", "accepted", "applied", "rejected", "expired"] as const) {
      expect(
        MissionCommandSchema.safeParse({
          schemaVersion: "pragma.mission-command/v1",
          commandId: "00000000-0000-4000-8000-000000000006",
          request,
          missionId,
          kind: "send",
          payload: { kind: "send", input: { prompt: "Send" } },
          state,
          createdAt: timestamp,
        }).success,
        `${state} command state`,
      ).toBe(true);
    }
    expect(
      MissionCommandSchema.safeParse({
        schemaVersion: "pragma.mission-command/v1",
        commandId: "00000000-0000-4000-8000-000000000006",
        request,
        missionId,
        kind: "queue.steer",
        payload: { kind: "queue.steer", requestId, input: { prompt: "Steer" } },
        state: "pending",
        createdAt: timestamp,
      }).success,
    ).toBe(false);
    expect([...MissionCommandKindSchema.options]).toHaveLength(commandPayloads.length);

    for (const token of ["1", "9007199254740993", "9".repeat(128)]) {
      expect(FencingTokenSchema.safeParse(token).success).toBe(true);
    }
    for (const token of ["0", "01", "-1", "1.0"]) {
      expect(FencingTokenSchema.safeParse(token).success).toBe(false);
    }
    expect(PayloadHashSchema.safeParse(payloadHash).success).toBe(true);
    expect(PayloadHashSchema.safeParse(`sha256:${"A".repeat(64)}`).success).toBe(false);
    expect(PayloadHashSchema.safeParse(`sha256:${"a".repeat(63)}`).success).toBe(false);
  });

  it("enforces exhaustive retry policies and requires explicit dynamic retryability", () => {
    expect(Object.keys(IntegrationErrorRetryPolicies).sort()).toEqual(
      [...IntegrationErrorCodeSchema.options].sort(),
    );
    expect(IntegrationErrorSchema.safeParse({ ...fixedError, retryable: true }).success).toBe(false);
    expect(
      createIntegrationError({
        code: "CURSOR_EXPIRED",
        message: "Cursor expired.",
        category: "conflict",
      }).retryable,
    ).toBe(true);
    expect(
      createIntegrationError({
        code: "EXECUTION_FAILED",
        message: "Retry after a transient failure.",
        retryable: true,
        category: "execution",
      }).retryable,
    ).toBe(true);
    expect(
      createIntegrationError({
        code: "INTERNAL_ERROR",
        message: "Do not retry this error.",
        retryable: false,
        category: "execution",
      }).retryable,
    ).toBe(false);
  });
});
