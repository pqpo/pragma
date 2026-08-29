import { describe, expect, it, vi } from "vitest";

import type { MissionControlApplication, MissionControlExecutionOutcome } from "@pragma/local-host";
import { createIntegrationError } from "@pragma/local-host/wire";

import { runCli, type CliIo, type CliLocalHost } from "../src/index.ts";
import { parseCliArgv } from "../src/parser/argv.ts";

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTION_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const COMMAND_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const INTERACTION_ID = "interaction-1";
const PAYLOAD_HASH = `sha256:${"a".repeat(64)}`;
const TIMESTAMP = "2026-08-27T00:00:00.000Z";

function createIo(): CliIo & { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
}

function createOperation(
  kind: string,
  state: "queued" | "applied" = "applied",
  result: Record<string, unknown> = { missionId: MISSION_ID, executionId: EXECUTION_ID },
) {
  return {
    schemaVersion: "pragma.local-host-mission-operation/v1" as const,
    operationId: OPERATION_ID,
    requestId: REQUEST_ID,
    payloadHash: PAYLOAD_HASH,
    commandId: COMMAND_ID,
    kind,
    state,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...(state === "applied" ? { result } : {}),
  };
}

function createMutationHost(
  options: {
    readonly operation?: ReturnType<typeof createOperation> | undefined;
    readonly execution?: MissionControlExecutionOutcome | undefined;
  } = {},
): {
  readonly host: CliLocalHost;
  readonly submit: ReturnType<typeof vi.fn>;
  readonly wait: ReturnType<typeof vi.fn>;
  readonly waitExecution: ReturnType<typeof vi.fn>;
} {
  const operation = options.operation ?? createOperation("send");
  const submit = vi.fn(async () => ({
    command: {} as never,
    operation,
    owner: "live" as const,
  }));
  const wait = vi.fn(async () => operation);
  const waitExecution = vi.fn(
    async (): Promise<MissionControlExecutionOutcome> =>
      options.execution ?? {
        executionId: EXECUTION_ID,
        status: "succeeded",
        result: { done: true },
      },
  );
  const missionControl = {
    submit,
    wait,
    waitExecution,
  } as unknown as MissionControlApplication;
  return {
    host: { missionControl } as unknown as CliLocalHost,
    submit,
    wait,
    waitExecution,
  };
}

describe("M8 mutation and queue command surface", () => {
  it("parses all seven durable mutation commands with strict target options", () => {
    expect(
      parseCliArgv(["mission", "send", MISSION_ID, "--prompt", "hello"]).command,
    ).toMatchObject({
      kind: "mission-send",
      missionId: MISSION_ID,
      prompt: "hello",
      wait: false,
      detach: false,
      ackTimeoutSeconds: 30,
    });
    expect(
      parseCliArgv([
        "mission",
        "steer",
        MISSION_ID,
        "--prompt",
        "correct",
        "--expected-execution",
        EXECUTION_ID,
      ]).command,
    ).toMatchObject({ kind: "mission-steer", expectedExecutionId: EXECUTION_ID });
    expect(
      parseCliArgv([
        "mission",
        "respond",
        MISSION_ID,
        "--interaction",
        INTERACTION_ID,
        "--answer",
        "yes",
      ]).command,
    ).toMatchObject({ kind: "mission-respond", interactionId: INTERACTION_ID });
    expect(
      parseCliArgv(["mission", "interrupt", MISSION_ID, "--expected-execution", EXECUTION_ID])
        .command,
    ).toMatchObject({ kind: "mission-interrupt", expectedExecutionId: EXECUTION_ID });
    expect(
      parseCliArgv(["mission", "queue", "remove", MISSION_ID, "--request", REQUEST_ID]).command,
    ).toMatchObject({ kind: "queue-remove", requestIdToRemove: REQUEST_ID });
    expect(parseCliArgv(["mission", "queue", "resume", MISSION_ID]).command).toMatchObject({
      kind: "queue-resume",
    });
    expect(
      parseCliArgv([
        "mission",
        "queue",
        "steer",
        MISSION_ID,
        "--request",
        REQUEST_ID,
        "--expected-execution",
        EXECUTION_ID,
      ]).command,
    ).toMatchObject({ kind: "queue-steer", requestIdToSteer: REQUEST_ID });
  });

  it("keeps send strict-option rejection while steer accepts an optional target", () => {
    expect(() =>
      parseCliArgv([
        "mission",
        "send",
        MISSION_ID,
        "--prompt",
        "hello",
        "--expected-execution",
        EXECUTION_ID,
      ]),
    ).toThrow("Unknown option --expected-execution");
    expect(
      parseCliArgv(["mission", "steer", MISSION_ID, "--prompt", "hello"]).command,
    ).toMatchObject({ kind: "mission-steer", missionId: MISSION_ID });
  });

  it.each([
    [
      "flow invalid JSON",
      ["flow", "run", "flow:aaaaaaaaaaaaaaaa", "--workspace", "/workspace", "--input-json", "-"],
      "{",
      "INPUT_SCHEMA_INVALID",
      "Input must be valid JSON.",
    ],
    [
      "flow non-object JSON",
      ["flow", "run", "flow:aaaaaaaaaaaaaaaa", "--workspace", "/workspace", "--input-json", "-"],
      "[]",
      "INPUT_SCHEMA_INVALID",
      "Input JSON must be an object.",
    ],
    [
      "respond invalid JSON",
      ["mission", "respond", MISSION_ID, "--interaction", INTERACTION_ID, "--answers-json", "-"],
      "{",
      "INVALID_ARGUMENT",
      "Input must be valid JSON.",
    ],
    [
      "respond non-object JSON",
      ["mission", "respond", MISSION_ID, "--interaction", INTERACTION_ID, "--answers-json", "-"],
      "[]",
      "INVALID_ARGUMENT",
      "Input JSON must be an object.",
    ],
  ] as const)(
    "uses generic bounded JSON errors for %s",
    async (_label, argv, input, code, message) => {
      const io = createIo();
      const localHost =
        argv[0] === "flow"
          ? ({
              resolveWorkspace: async () => ({}) as never,
              run: { start: vi.fn() },
            } as unknown as CliLocalHost)
          : ({
              missionControl: { submit: vi.fn(), wait: vi.fn() },
            } as unknown as CliLocalHost);

      await expect(
        runCli([...argv, "--format=json"], io, {
          localHost,
          readStdin: async () => new TextEncoder().encode(input),
        }),
      ).resolves.toBe(2);
      const output = JSON.parse(io.stdout[0]!);
      expect(output.error).toMatchObject({ code, message });
      expect(JSON.stringify(output)).not.toContain("Flow input");
    },
  );

  it("normalizes send input, uses the shared Inbox operation, and applies the 30 second ack default", async () => {
    const io = createIo();
    const { host, submit, wait } = createMutationHost({
      operation: createOperation("send"),
    });

    await expect(
      runCli(
        ["mission", "send", MISSION_ID, "--prompt", "  hello\r\nworld  ", "--format=json"],
        io,
        { localHost: host },
      ),
    ).resolves.toBe(0);

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: MISSION_ID,
        kind: "send",
        payload: { kind: "send", input: { prompt: "hello\nworld" } },
      }),
    );
    expect(wait).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: MISSION_ID, timeoutMs: 30_000 }),
    );
    expect(JSON.parse(io.stdout[0]!)).toMatchObject({
      command: "mission.send",
      status: "succeeded",
    });
    expect(io.stderr).toEqual([]);
  });

  it("does not wait for a detached command", async () => {
    const io = createIo();
    const { host, wait } = createMutationHost({
      operation: createOperation("send", "queued"),
    });

    await expect(
      runCli(
        ["mission", "send", MISSION_ID, "--prompt", "hello", "--detach", "--format=json"],
        io,
        { localHost: host },
      ),
    ).resolves.toBe(0);

    expect(wait).not.toHaveBeenCalled();
    expect(JSON.parse(io.stdout[0]!)).toMatchObject({
      command: "mission.send",
      status: "accepted",
    });
  });

  it("returns the shared input_required envelope for non-interactive --wait", async () => {
    const io = createIo();
    const interaction = {
      schemaVersion: "pragma.human-interaction/v1" as const,
      kind: "request" as const,
      missionId: MISSION_ID,
      executionId: EXECUTION_ID,
      interactionId: INTERACTION_ID,
      sensitive: false,
      interaction: { kind: "approval" as const, prompt: "Approve?" },
    };
    const { host, waitExecution } = createMutationHost({
      operation: createOperation("send"),
      execution: { executionId: EXECUTION_ID, status: "waiting", interaction },
    });

    await expect(
      runCli(["mission", "send", MISSION_ID, "--prompt", "hello", "--wait", "--format=json"], io, {
        localHost: host,
        terminal: { isControllingTerminal: () => false, readLine: async () => "" },
      }),
    ).resolves.toBe(3);

    expect(waitExecution).toHaveBeenCalledWith({
      missionId: MISSION_ID,
      executionId: EXECUTION_ID,
    });
    expect(JSON.parse(io.stdout[0]!)).toMatchObject({
      command: "mission.send",
      status: "input_required",
      interaction,
    });
    expect(io.stderr).toEqual([]);
  });

  it("passes --answers-json as the complete HumanInteractionResponse object", async () => {
    const io = createIo();
    const { host, submit } = createMutationHost({ operation: createOperation("respond") });
    const response = {
      answers: { confirmation: "yes" },
      notes: "approved by the operator",
    };

    await expect(
      runCli(
        [
          "mission",
          "respond",
          MISSION_ID,
          "--interaction",
          INTERACTION_ID,
          "--answers-json",
          "-",
          "--format=json",
        ],
        io,
        {
          localHost: host,
          readStdin: async () => new TextEncoder().encode(JSON.stringify(response)),
        },
      ),
    ).resolves.toBe(0);

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "respond",
        payload: { kind: "respond", response },
      }),
    );
  });

  it("keeps queue list on the Core prompt projection and ignores Inbox operations", async () => {
    const io = createIo();
    const host = {
      listMissionQueue: async () => ({
        missionId: MISSION_ID,
        sessionId: "session-1",
        state: "paused",
        pendingCount: 1,
        supportsSteer: true,
        items: [
          {
            position: 1,
            requestId: REQUEST_ID,
            executionId: EXECUTION_ID,
            status: "queued",
            content: "queued prompt",
            hasAttachments: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
            steerable: true,
          },
        ],
        operations: [{ requestId: "inbox-operation", state: "applied" }],
      }),
    } as unknown as CliLocalHost;

    await expect(
      runCli(["mission", "queue", "list", MISSION_ID, "--format=json"], io, {
        localHost: host,
      }),
    ).resolves.toBe(0);

    const output = JSON.parse(io.stdout[0]!) as { result: Record<string, unknown> };
    expect(output.result).toMatchObject({
      missionId: MISSION_ID,
      state: "paused",
      pendingCount: 1,
      supportsSteer: true,
      items: [{ requestId: REQUEST_ID, content: "queued prompt" }],
    });
    expect(output.result).not.toHaveProperty("operations");
  });

  it("preserves a strict Flow rejection reason from the shared control contract", async () => {
    const io = createIo();
    const submit = vi.fn(async () => {
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "Flow Missions do not support chat messages.",
        details: { missionId: MISSION_ID, reason: "send_not_supported" },
      });
    });
    const host = {
      missionControl: {
        submit,
        wait: vi.fn(),
      } as unknown as MissionControlApplication,
    } as unknown as CliLocalHost;

    await expect(
      runCli(["mission", "send", MISSION_ID, "--prompt", "hello", "--format=json"], io, {
        localHost: host,
      }),
    ).resolves.toBe(4);
    expect(JSON.parse(io.stdout[0]!)).toMatchObject({
      status: "failed",
      error: { code: "COMMAND_REJECTED", details: { reason: "send_not_supported" } },
    });
  });
});
