import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMissionControllerStore,
  MissionAggregateStateSchema,
  MissionCommandTransactionSchema,
  type MissionControlClock,
  type MissionControllerJournalPhase,
} from "../src/index.ts";

const paths: string[] = [];
const missionId = "00000000-0000-4000-8000-000000000001";

afterEach(async () => {
  await Promise.all(
    paths.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("MissionControllerStore", () => {
  it("fences an expired owner and only advances the decimal token on a new owner", async () => {
    const time = mutableClock("2026-08-24T00:00:00.000Z");
    const store = await createStore(time);
    const first = await store.claim({
      missionId,
      claimId: "00000000-0000-4000-8000-000000000010",
      leaseMs: 1_000,
    });
    await expect(
      store.claim({ missionId, claimId: "00000000-0000-4000-8000-000000000011", leaseMs: 1_000 }),
    ).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
    time.advance(1_001);
    const takeover = await store.claim({
      missionId,
      claimId: "00000000-0000-4000-8000-000000000011",
      leaseMs: 1_000,
    });

    expect(first.fencingToken).toBe("1");
    expect(takeover.fencingToken).toBe("2");
    await expect(store.assertWriteGuard({ missionId, guard: first })).rejects.toMatchObject({
      code: "MISSION_FENCING_REJECTED",
    });
    await expect(store.assertWriteGuard({ missionId, guard: takeover })).resolves.toBeUndefined();
  });

  it("rejects non-finite or non-positive lease durations before persisting", async () => {
    const store = await createStore();
    const claimId = "00000000-0000-4000-8000-000000000012";
    for (const leaseMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(store.claim({ missionId, claimId, leaseMs })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    const guard = await store.claim({ missionId, claimId, leaseMs: 1_000 });
    await expect(store.renew({ missionId, guard, leaseMs: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("binds run requests atomically and rejects a payload conflict", async () => {
    const store = await createStore();
    const requestId = "00000000-0000-4000-8000-000000000020";
    const hash = payloadHash("run-a");

    await expect(store.bindRunRequest({ requestId, payloadHash: hash, missionId })).resolves.toBe(
      missionId,
    );
    await expect(store.bindRunRequest({ requestId, payloadHash: hash, missionId })).resolves.toBe(
      missionId,
    );
    await expect(
      store.bindRunRequest({ requestId, payloadHash: payloadHash("run-b"), missionId }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("makes command append idempotent and persists applied command events", async () => {
    const store = await createStore();
    const guard = await store.claim({
      missionId,
      claimId: "00000000-0000-4000-8000-000000000030",
      leaseMs: 10_000,
    });
    const command = commandInput("send", "00000000-0000-4000-8000-000000000031");

    const first = await store.appendCommand(command);
    const retry = await store.appendCommand(command);
    const apply = vi.fn(async () => ({ result: { delivered: true } }));
    await store.processNext({ missionId, guard, consumer: { apply } });

    expect(retry).toEqual(first);
    expect(apply).toHaveBeenCalledOnce();
    await expect(
      store.getOperation({ missionId, requestId: command.request.requestId }),
    ).resolves.toMatchObject({ state: "applied", result: { delivered: true } });
    const snapshot = await store.readSnapshot({ missionId });
    expect(snapshot.events.map((event) => event.type)).toEqual([
      "command.accepted",
      "command.applied",
    ]);
    await expect(
      store.appendCommand({
        ...command,
        request: { ...command.request, payloadHash: payloadHash("changed") },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("commits a semantic-write event after concurrently advanced Inbox poller events", async () => {
    const root = await temporaryRoot();
    const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
    const guard = await store.claim({
      missionId,
      claimId: "00000000-0000-4000-8000-000000000032",
      leaseMs: 10_000,
    });
    let beginMutation!: () => void;
    let releaseMutation!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      beginMutation = resolve;
    });
    const mutationReleased = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const semanticWrite = store.coordinateSemanticWrite({
      missionId,
      guard,
      operation: { name: "mission.options.update", input: { mode: "full-access" } },
      eventType: "mission.options.updated",
      eventData: {},
      apply: async () => {
        beginMutation();
        await mutationReleased;
      },
    });
    await mutationStarted;

    const command = commandInput("send", "00000000-0000-4000-8000-000000000033");
    const poller = store.startPolling({
      missionId,
      guard,
      consumer: { apply: async () => ({ result: { delivered: true } }) },
      initialDelayMs: 1,
      maxDelayMs: 5,
      jitter: () => 0,
      onLeaseLost: () => undefined,
    });
    await store.appendCommand(command);
    await vi.waitFor(async () =>
      expect(await store.getOperation({ missionId, requestId: command.request.requestId })).toMatchObject({
        state: "applied",
      }),
    );

    releaseMutation();
    await semanticWrite;
    await poller.stop();

    const snapshot = await store.readSnapshot({ missionId });
    expect(snapshot.snapshot.eventSequence).toBe(3);
    expect(snapshot.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(snapshot.events.map((event) => event.type)).toEqual([
      "command.accepted",
      "command.applied",
      "mission.options.updated",
    ]);
    expect((await store.readSnapshot({ missionId, after: snapshot.cursor })).events).toEqual([]);
    const lines = (await readFile(
      join(root, "missions", missionId, "local-host", "events.jsonl"),
      "utf8",
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly sequence: number });
    expect(lines.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("rejects strict steer without a complete target and never sends on target change", async () => {
    const time = mutableClock("2026-08-24T00:00:00.000Z");
    const store = await createStore(time);
    await store.claim({ missionId, claimId: "00000000-0000-4000-8000-000000000040", leaseMs: 1 });
    const missingTurn = commandInput("steer", "00000000-0000-4000-8000-000000000041", {
      executionId: "00000000-0000-4000-8000-000000000042",
    });
    await expect(store.appendCommand(missingTurn)).rejects.toMatchObject({
      code: "STEER_TARGET_NOT_ACTIVE",
    });

    const strict = commandInput(
      "steer",
      "00000000-0000-4000-8000-000000000043",
      { executionId: "00000000-0000-4000-8000-000000000044", turnId: "turn-1" },
      "1",
    );
    await store.appendCommand(strict);
    const apply = vi.fn(async () => ({ result: { sent: true } }));
    time.advance(2);
    const takeover = await store.claim({
      missionId,
      claimId: "00000000-0000-4000-8000-000000000045",
      leaseMs: 10_000,
    });
    await store.processNext({ missionId, guard: takeover, consumer: { apply } });

    expect(apply).not.toHaveBeenCalled();
    await expect(
      store.getOperation({ missionId, requestId: strict.request.requestId }),
    ).resolves.toMatchObject({ state: "rejected", error: { code: "STEER_TARGET_CHANGED" } });
  });

  it("captures strict fencing targets atomically and expires only pending expired commands", async () => {
    const time = mutableClock("2026-08-24T00:00:00.000Z");
    const store = await createStore(time);
    const guard = await store.claim({
      missionId,
      claimId: "00000000-0000-4000-8000-000000000046",
      leaseMs: 10_000,
    });
    const strict = commandInput(
      "steer",
      "00000000-0000-4000-8000-000000000047",
      { executionId: "00000000-0000-4000-8000-000000000048", turnId: "turn-1" },
      "untrusted-producer-token",
    );
    const appended = await store.appendCommand(strict);
    expect(appended.command.targetFencingToken).toBe(guard.fencingToken);

    const expiredOne = {
      ...commandInput("send", "00000000-0000-4000-8000-000000000049"),
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
    const fresh = commandInput("send", "00000000-0000-4000-8000-000000000060");
    const expiredTwo = {
      ...commandInput("send", "00000000-0000-4000-8000-000000000061"),
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
    await store.appendCommand(expiredOne);
    await store.appendCommand(fresh);
    await store.appendCommand(expiredTwo);
    await expect(store.expireCommands({ missionId, guard })).resolves.toBe(2);
    await expect(
      store.getOperation({ missionId, requestId: fresh.request.requestId }),
    ).resolves.toMatchObject({ state: "queued" });
    await expect(
      store.getOperation({ missionId, requestId: expiredOne.request.requestId }),
    ).resolves.toMatchObject({ state: "expired" });
    await expect(
      store.getOperation({ missionId, requestId: expiredTwo.request.requestId }),
    ).resolves.toMatchObject({ state: "expired" });
  });

  it("replays an acknowledged command after a crash and repairs only a torn JSONL tail", async () => {
    const root = await temporaryRoot();
    const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
    const missionRoot = join(root, "missions", missionId, "local-host");
    await mkdir(missionRoot, { recursive: true });
    const command = {
      ...commandInput("send", "00000000-0000-4000-8000-000000000062"),
      schemaVersion: "pragma.mission-command/v1" as const,
      commandId: "00000000-0000-4000-8000-000000000063",
      state: "accepted" as const,
      createdAt: "2026-08-24T00:00:00.000Z",
      acknowledgedAt: "2026-08-24T00:00:01.000Z",
    };
    await writeFile(
      join(missionRoot, ".command-transaction.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.local-host-mission-command-transaction/v1",
        missionId,
        commandId: command.commandId,
        command,
        event: {
          schemaVersion: "pragma.local-host-mission-event/v1",
          eventId: "00000000-0000-4000-8000-000000000064",
          missionId,
          sequence: 1,
          occurredAt: command.acknowledgedAt,
          type: "command.accepted",
          data: { commandId: command.commandId },
        },
        operation: {
          schemaVersion: "pragma.local-host-mission-operation/v1",
          operationId: "00000000-0000-4000-8000-000000000065",
          requestId: command.request.requestId,
          payloadHash: command.request.payloadHash,
          commandId: command.commandId,
          kind: "send",
          state: "applying",
          createdAt: command.createdAt,
          updatedAt: command.acknowledgedAt,
        },
      })}\n`,
    );
    const guard = await store.claim({
      missionId,
      claimId: "00000000-0000-4000-8000-000000000066",
      leaseMs: 1_000,
    });
    const apply = vi.fn(async () => ({ result: { replayed: true } }));
    await store.processNext({ missionId, guard, consumer: { apply } });
    expect(apply).toHaveBeenCalledOnce();
    await expect(
      store.getOperation({ missionId, requestId: command.request.requestId }),
    ).resolves.toMatchObject({ state: "applied", result: { replayed: true } });

    const eventPath = join(missionRoot, "events.jsonl");
    await writeFile(
      eventPath,
      `${JSON.stringify({ schemaVersion: "pragma.local-host-mission-event/v1", eventId: "00000000-0000-4000-8000-000000000067", missionId, sequence: 3, occurredAt: "2026-08-24T00:00:03.000Z", type: "complete", data: {} })}\n{"half"`,
    );
    await expect(store.readSnapshot({ missionId })).resolves.toMatchObject({
      events: [expect.objectContaining({ eventId: "00000000-0000-4000-8000-000000000067" })],
    });
    await expect(readFile(eventPath, "utf8")).resolves.toMatch(/\n$/);
    await writeFile(eventPath, '{"bad"}\n');
    await expect(store.readSnapshot({ missionId })).rejects.toThrow();
  });

  it("replays a command transaction before serving a snapshot and rejects future aggregate schemas", async () => {
    const root = await temporaryRoot();
    const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
    const missionRoot = join(root, "missions", missionId, "local-host");
    await mkdir(missionRoot, { recursive: true });
    const replayedCommand = {
      ...commandInput("send", "00000000-0000-4000-8000-000000000050"),
      schemaVersion: "pragma.mission-command/v1" as const,
      commandId: "00000000-0000-4000-8000-000000000051",
      state: "applied" as const,
      createdAt: "2026-08-24T00:00:00.000Z",
      acknowledgedAt: "2026-08-24T00:00:01.000Z",
      appliedAt: "2026-08-24T00:00:02.000Z",
    };
    const transaction = MissionCommandTransactionSchema.parse({
      schemaVersion: "pragma.local-host-mission-command-transaction/v1",
      missionId,
      commandId: replayedCommand.commandId,
      command: replayedCommand,
      event: {
        schemaVersion: "pragma.local-host-mission-event/v1",
        eventId: "00000000-0000-4000-8000-000000000052",
        missionId,
        sequence: 1,
        occurredAt: "2026-08-24T00:00:02.000Z",
        type: "command.applied",
        data: { commandId: replayedCommand.commandId },
      },
      operation: {
        schemaVersion: "pragma.local-host-mission-operation/v1",
        operationId: "00000000-0000-4000-8000-000000000053",
        requestId: replayedCommand.request.requestId,
        payloadHash: replayedCommand.request.payloadHash,
        commandId: replayedCommand.commandId,
        kind: "send",
        state: "applied",
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:02.000Z",
        result: { delivered: true },
      },
    });
    await writeFile(
      join(missionRoot, ".command-transaction.json"),
      `${JSON.stringify(transaction)}\n`,
    );
    const recovered = await store.readSnapshot({ missionId });
    expect(recovered.events).toHaveLength(1);
    await expect(
      store.getOperation({ missionId, requestId: replayedCommand.request.requestId }),
    ).resolves.toMatchObject({ state: "applied" });

    await writeFile(
      join(missionRoot, "aggregate.json"),
      `${JSON.stringify({ schemaVersion: "pragma.local-host-mission-aggregate/v9", missionId, nextFencingToken: "1", eventSequence: 0, operations: {} })}\n`,
    );
    await expect(store.readSnapshot({ missionId })).rejects.toThrow(
      "Invalid Mission aggregate persistence schema",
    );

    const parsed = MissionAggregateStateSchema.parse({
      schemaVersion: "pragma.local-host-mission-aggregate/v1",
      missionId,
      nextFencingToken: "1",
      eventSequence: 0,
      operations: {},
    });
    expect(parsed.eventSequence).toBe(0);
    await expect(readFile(join(missionRoot, "aggregate.json"), "utf8")).resolves.toContain("/v9");
  });

  it.each([
    "command-append.prepare",
    "command-append.command",
    "command-append.operation",
    "command-append.clear",
  ] as const)(
    "recovers a pending command and operation projection after %s",
    async (crashPoint) => {
      const root = await temporaryRoot();
      let interrupted = false;
      const interruptedStore = createMissionControllerStore({
        missionsPath: join(root, "missions"),
        onJournalPhase: crashOnce(crashPoint, () => {
          interrupted = true;
        }),
      });
      const input = commandInput("send", "00000000-0000-4000-8000-000000000070");
      await expect(interruptedStore.appendCommand(input)).rejects.toThrow(
        `simulated crash at ${crashPoint}`,
      );
      expect(interrupted).toBe(true);

      const recovered = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const guard = await recovered.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000071",
        leaseMs: 1_000,
      });
      const apply = vi.fn(async () => ({ result: { replayed: true } }));
      await recovered.processNext({ missionId, guard, consumer: { apply } });
      expect(apply).toHaveBeenCalledOnce();
      await expect(
        recovered.getOperation({ missionId, requestId: input.request.requestId }),
      ).resolves.toMatchObject({
        state: "applied",
        result: { replayed: true },
      });
    },
  );

  it.each([
    "command-outcome.prepare",
    "command-outcome.command",
    "command-outcome.event",
    "command-outcome.state",
    "command-outcome.clear",
  ] as const)(
    "recovers every accepted-command transaction boundary after %s",
    async (crashPoint) => {
      const root = await temporaryRoot();
      const clean = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const guard = await clean.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000072",
        leaseMs: 1_000,
      });
      const input = commandInput("send", "00000000-0000-4000-8000-000000000073");
      await clean.appendCommand(input);
      const interrupted = createMissionControllerStore({
        missionsPath: join(root, "missions"),
        onJournalPhase: crashOnce(crashPoint),
      });
      await expect(
        interrupted.processNext({
          missionId,
          guard,
          consumer: { apply: async () => ({ result: { shouldNotRun: true } }) },
        }),
      ).rejects.toThrow(`simulated crash at ${crashPoint}`);

      const recovered = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const apply = vi.fn(async () => ({ result: { acceptedReplay: true } }));
      await recovered.processNext({ missionId, guard, consumer: { apply } });
      expect(apply).toHaveBeenCalledOnce();
      const snapshot = await recovered.readSnapshot({ missionId });
      expect(snapshot.events.filter((event) => event.type === "command.accepted")).toHaveLength(1);
      await expect(
        recovered.getOperation({ missionId, requestId: input.request.requestId }),
      ).resolves.toMatchObject({
        state: "applied",
      });
    },
  );

  it.each(["event.prepare", "event.append", "event.state-sequence", "event.clear"] as const)(
    "recovers ordinary event append and state sequence after %s",
    async (crashPoint) => {
      const root = await temporaryRoot();
      const initial = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const guard = await initial.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000074",
        leaseMs: 1_000,
      });
      const interrupted = createMissionControllerStore({
        missionsPath: join(root, "missions"),
        onJournalPhase: crashOnce(crashPoint),
      });
      await expect(
        interrupted.write({
          missionId,
          guard,
          operation: async ({ appendEvent }) =>
            await appendEvent("mission.test.event", {}, "00000000-0000-4000-8000-000000000075"),
        }),
      ).rejects.toThrow(`simulated crash at ${crashPoint}`);
      const recovered = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const snapshot = await recovered.readSnapshot({ missionId });
      expect(snapshot.snapshot.eventSequence).toBe(1);
      expect(snapshot.events).toEqual([
        expect.objectContaining({ eventId: "00000000-0000-4000-8000-000000000075" }),
      ]);
      await recovered.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) =>
          await appendEvent("mission.test.event", {}, "00000000-0000-4000-8000-000000000075"),
      });
      expect((await recovered.readSnapshot({ missionId })).events).toHaveLength(1);
    },
  );

  it("bounds poller backoff and jitter, resets after a command, and reports a lost lease", async () => {
    const time = mutableClock("2026-08-24T00:00:00.000Z");
    const store = await createStore(time);
    const guard = await store.claim({
      missionId,
      claimId: "00000000-0000-4000-8000-000000000076",
      leaseMs: 10_000,
    });
    const scheduled: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler,
      delay,
      ...args
    ) => {
      scheduled.push(Number(delay));
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout);
    const lost = vi.fn();
    const poller = store.startPolling({
      missionId,
      guard,
      consumer: { apply: async () => ({ result: {} }) },
      initialDelayMs: 5,
      maxDelayMs: 20,
      jitter: () => 2,
      onLeaseLost: lost,
    });
    try {
      await vi.waitFor(
        () =>
          expect(scheduled.filter((delay) => delay > 0 && delay <= 25).slice(0, 3)).toEqual([
            6, 13, 25,
          ]),
        { timeout: 2_000 },
      );

      const beforeCommand = scheduled.length;
      await store.appendCommand(commandInput("send", "00000000-0000-4000-8000-000000000077"));
      await vi.waitFor(
        async () =>
          expect(
            await store.getOperation({
              missionId,
              requestId: "00000000-0000-4000-8000-000000000077",
            }),
          ).toMatchObject({ state: "applied" }),
        { timeout: 2_000 },
      );
      expect(scheduled.slice(beforeCommand)).toContain(6);
      time.advance(10_001);
      await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce(), { timeout: 2_000 });
    } finally {
      await poller.stop();
      timeout.mockRestore();
    }
  });
});

async function createStore(clock?: MissionControlClock) {
  const root = await temporaryRoot();
  return createMissionControllerStore({
    missionsPath: join(root, "missions"),
    ...(clock === undefined ? {} : { clock }),
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-local-host-m4-"));
  paths.push(root);
  return root;
}

function mutableClock(
  initial: string,
): MissionControlClock & { advance(milliseconds: number): void } {
  let milliseconds = Date.parse(initial);
  return {
    now: () => new Date(milliseconds),
    advance: (increment) => {
      milliseconds += increment;
    },
  };
}

function commandInput(
  kind: "send" | "steer",
  requestId: string,
  target?: { readonly executionId: string; readonly turnId?: string },
  targetFencingToken?: string,
) {
  return {
    missionId,
    kind,
    request: {
      schemaVersion: "pragma.integration-request/v1" as const,
      requestId,
      payloadHash: payloadHash(requestId),
      requestedAt: "2026-08-24T00:00:00.000Z",
      client: {
        surface: "cli" as const,
        version: "test",
        instanceId: "00000000-0000-4000-8000-000000000099",
      },
    },
    ...(target === undefined ? {} : { target }),
    ...(targetFencingToken === undefined ? {} : { targetFencingToken }),
    payload: { kind, input: { prompt: "continue" } },
  };
}

function payloadHash(input: string): string {
  return `sha256:${input
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a")}`;
}

function crashOnce(phase: MissionControllerJournalPhase, observed?: () => void) {
  let crashed = false;
  return (current: MissionControllerJournalPhase): void => {
    if (crashed || current !== phase) return;
    crashed = true;
    observed?.();
    throw new Error(`simulated crash at ${phase}`);
  };
}
