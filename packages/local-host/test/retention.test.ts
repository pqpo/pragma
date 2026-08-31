import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MISSION_RETENTION_POLICY,
  createMissionControllerStore,
  makeMissionEventCursor,
  planMissionRetention,
  serializedRetentionBytes,
} from "../src/index.ts";

const missionId = "00000000-0000-4000-8000-000000000201";
const workspaceIdentity = `sha256:${"c".repeat(64)}`;

describe("Mission retention", () => {
  it("freezes the representative local event and Inbox payload benchmark", () => {
    const eventSizes = {
      created: serializedRetentionBytes(
        event(1, "mission.created", {
          requestId: requestId(1),
          payloadHash: hash("a"),
          executor: { kind: "expert", id: "0123456789abcdef" },
          workspace: "/workspace",
        }),
      ),
      pinned: serializedRetentionBytes(
        event(1, "mission.binding.pinned", {
          schemaVersion: "pragma.mission-pinned-binding/v1",
          requestId: requestId(1),
          payloadHash: hash("a"),
          command: "expert.run",
          executor: {
            source: "project",
            ref: { kind: "expert", id: "0123456789abcdef" },
            project: { projectId: "project-1", revision: 17, fingerprint: "b".repeat(64) },
          },
          workspace: { canonicalPath: "/workspace", identityHash: workspaceIdentity },
          provenance: "new_run",
        }),
      ),
      started: serializedRetentionBytes(
        event(1, "run.started", {
          executionId: "00000000-0000-4000-8000-000000000202",
        }),
      ),
      progress4KiB: serializedRetentionBytes(
        event(1, "run.progress", {
          executionId: "00000000-0000-4000-8000-000000000202",
          turnId: "00000000-0000-4000-8000-000000000203",
          message: "x".repeat(4_096),
          usage: { inputTokens: 1_234, outputTokens: 5_678 },
        }),
      ),
      succeeded: serializedRetentionBytes(
        event(1, "run.succeeded", {
          executionId: "00000000-0000-4000-8000-000000000202",
          result: { answer: "x".repeat(512) },
        }),
      ),
    };
    const command = commandEnvelope("send", requestId(2), "x".repeat(4_096));
    const responseCommand = commandEnvelope("respond", requestId(3), "x".repeat(4_096));
    const commandSizes = {
      send4KiB: serializedRetentionBytes(command),
      respond4KiB: serializedRetentionBytes(responseCommand),
    };

    expect(eventSizes).toEqual({
      created: 459,
      pinned: 828,
      started: 291,
      progress4KiB: 4_498,
      succeeded: 828,
    });
    expect(commandSizes).toEqual({ send4KiB: 4_700, respond4KiB: 4_955 });
    expect(DEFAULT_MISSION_RETENTION_POLICY).toEqual({
      events: { maxCount: 2_000, maxBytes: 4 * 1024 * 1024 },
      terminalCommands: { maxCount: 1_000, maxBytes: 2 * 1024 * 1024 },
    });
  });

  it("compacts on the byte limit while retaining the newest continuous tail", () => {
    const events = [
      event(1, "mission.created", { requestId: requestId(11) }),
      event(2, "output.chunk", { value: "older" }),
      event(3, "output.chunk", { value: "newer" }),
    ];
    const plan = planMissionRetention({
      events,
      commands: [],
      state: {
        schemaVersion: "pragma.local-host-mission-aggregate/v1",
        missionId,
        nextFencingToken: "1",
        eventSequence: 3,
        operations: {},
      },
      policy: {
        events: {
          maxCount: 10,
          maxBytes: serializedRetentionBytes(events[2]),
        },
        terminalCommands: { maxCount: 10, maxBytes: 10_000 },
      },
    });

    expect(plan.retainedEvents.map((item) => item.sequence)).toEqual([1, 3]);
    expect(plan.removedEventCount).toBe(1);
  });

  it("retains identity/pinned/non-terminal anchors and expires cursors across a gap", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-retention-gap-"));
    try {
      const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const guard = await store.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000204",
        leaseMs: 10_000,
      });
      await store.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent("mission.created", { requestId: requestId(4) });
          await appendEvent("mission.binding.pinned", pinnedData());
          await appendEvent("run.started", {
            executionId: "00000000-0000-4000-8000-000000000205",
          });
          await appendEvent("run.progress", { message: "oldest" });
          await appendEvent("run.progress", { message: "old" });
          await appendEvent("run.succeeded", {
            executionId: "00000000-0000-4000-8000-000000000205",
            result: { ok: true },
          });
        },
      });

      const compactStore = createMissionControllerStore({
        missionsPath: join(root, "missions"),
        retention: {
          events: { maxCount: 1, maxBytes: 1_000_000 },
          terminalCommands: { maxCount: 1, maxBytes: 1_000_000 },
        },
      });
      const report = await compactStore.compactRetention({ missionId });
      expect(report.removedEventCount).toBe(2);
      const snapshot = await compactStore.readSnapshot({ missionId });
      expect(snapshot.events.map((item) => item.type)).toEqual([
        "mission.created",
        "mission.binding.pinned",
        "run.progress",
        "run.succeeded",
      ]);
      await expect(
        compactStore.readWatchBarrier({
          missionId,
          after: makeMissionEventCursor(missionId, 3),
        }),
      ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
      await expect(
        compactStore.readWatchBarrier({
          missionId,
          after: makeMissionEventCursor(missionId, 6),
        }),
      ).resolves.toMatchObject({ events: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps pending commands and compacts terminal command/operation projections together", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-retention-commands-"));
    try {
      const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const guard = await store.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000206",
        leaseMs: 10_000,
      });
      const first = await store.appendCommand(commandInput(requestId(5)));
      await store.processNext({
        missionId,
        guard,
        consumer: { apply: async () => ({ result: { index: 1 } }) },
      });
      const second = await store.appendCommand(commandInput(requestId(6)));
      await store.processNext({
        missionId,
        guard,
        consumer: { apply: async () => ({ result: { index: 2 } }) },
      });
      const pending = await store.appendCommand(commandInput(requestId(7)));

      const compactStore = createMissionControllerStore({
        missionsPath: join(root, "missions"),
        retention: {
          events: { maxCount: 100, maxBytes: 1_000_000 },
          terminalCommands: { maxCount: 1, maxBytes: 1_000_000 },
        },
      });
      const report = await compactStore.compactRetention({ missionId });
      expect(report.removedCommandCount).toBe(1);
      expect(report.removedOperationCount).toBe(1);
      await expect(
        compactStore.getOperation({ missionId, requestId: first.command.request.requestId }),
      ).resolves.toBeUndefined();
      await expect(
        compactStore.getOperation({ missionId, requestId: second.command.request.requestId }),
      ).resolves.toMatchObject({ state: "applied" });
      await expect(
        compactStore.getOperation({ missionId, requestId: pending.command.request.requestId }),
      ).resolves.toMatchObject({ state: "queued" });
      const commandFile = await readFile(
        join(root, "missions", missionId, "local-host", "command-inbox.json"),
        "utf8",
      );
      expect(JSON.parse(commandFile) as unknown[]).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays a compaction journal after a crash between atomic file replacements", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-retention-recovery-"));
    try {
      const missionsPath = join(root, "missions");
      const initial = createMissionControllerStore({ missionsPath });
      const guard = await initial.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000207",
        leaseMs: 10_000,
      });
      await initial.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent("mission.created", { requestId: requestId(8) });
          await appendEvent("run.started", { executionId: requestId(9) });
          await appendEvent("run.progress", { executionId: requestId(9), message: "old" });
          await appendEvent("run.progress", { executionId: requestId(9), message: "new" });
          await appendEvent("run.succeeded", { executionId: requestId(9), result: { ok: true } });
        },
      });
      const crashed = createMissionControllerStore({
        missionsPath,
        retention: { events: { maxCount: 1, maxBytes: 1_000_000 } },
        onJournalPhase: (phase) => {
          if (phase === "retention.events") throw new Error("crash after events rename");
        },
      });
      await expect(crashed.compactRetention({ missionId })).rejects.toThrow(
        "crash after events rename",
      );

      const recovered = createMissionControllerStore({
        missionsPath,
        retention: { events: { maxCount: 1, maxBytes: 1_000_000 } },
      });
      const snapshot = await recovered.readSnapshot({ missionId });
      expect(snapshot.events.map((item) => item.sequence)).toEqual([1, 4, 5]);
      expect(snapshot.snapshot.eventSequence).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function event(sequence: number, type: string, data: Record<string, unknown>) {
  return {
    schemaVersion: "pragma.local-host-mission-event/v1",
    eventId: eventId(sequence),
    missionId,
    sequence,
    occurredAt: "2026-08-27T00:00:00.000Z",
    type,
    data,
  };
}

function eventId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function requestId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence + 300).padStart(12, "0")}`;
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function pinnedData() {
  return {
    schemaVersion: "pragma.mission-pinned-binding/v1" as const,
    requestId: requestId(10),
    payloadHash: hash("d"),
    command: "expert.run" as const,
    executor: {
      source: "project" as const,
      ref: { kind: "expert" as const, id: "0123456789abcdef" },
      project: { projectId: "project-1", revision: 1, fingerprint: "b".repeat(64) },
    },
    workspace: { canonicalPath: "/workspace", identityHash: workspaceIdentity },
    provenance: "new_run" as const,
  };
}

function commandInput(id: string) {
  return {
    missionId,
    kind: "send" as const,
    request: {
      schemaVersion: "pragma.integration-request/v1" as const,
      requestId: id,
      payloadHash: hash(id),
      requestedAt: "2026-08-27T00:00:00.000Z",
      client: {
        surface: "cli" as const,
        version: "test",
        instanceId: "00000000-0000-4000-8000-000000000299",
      },
    },
    payload: { kind: "send" as const, input: { prompt: "continue" } },
  };
}

function commandEnvelope(kind: "send" | "respond", id: string, value: string) {
  return {
    schemaVersion: "pragma.mission-command/v2",
    commandId: eventId(Number(id.slice(-3)) + 20),
    request: {
      schemaVersion: "pragma.integration-request/v1",
      requestId: id,
      payloadHash: hash(id),
      requestedAt: "2026-08-27T00:00:00.000Z",
      client: {
        surface: "cli",
        version: "0.0.0",
        instanceId: "00000000-0000-4000-8000-000000000299",
      },
    },
    missionId,
    kind,
    payload:
      kind === "send"
        ? { kind, input: { prompt: value } }
        : {
            kind,
            response: {
              schemaVersion: "pragma.human-interaction/v1",
              kind: "response",
              missionId,
              executionId: "00000000-0000-4000-8000-000000000202",
              interactionId: "interaction-1",
              sensitive: false,
              interaction: { kind: "text", text: value },
            },
          },
    state: "pending",
    createdAt: "2026-08-27T00:00:00.000Z",
  };
}
