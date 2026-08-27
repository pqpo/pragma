import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createMissionControllerStore,
  createMissionWatchApplication,
  makeMissionEventCursor,
  type MissionEvent,
  type MissionWatchEvent,
} from "../src/index.ts";

const missionId = "00000000-0000-4000-8000-000000000301";

describe("Mission watch", () => {
  it("emits replay, snapshot, ready, and follow events from one barrier without claiming", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-watch-follow-"));
    try {
      const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const guard = await store.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000302",
        leaseMs: 10_000,
      });
      await store.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent(
            "mission.created",
            { requestId: "00000000-0000-4000-8000-000000000303" },
            "00000000-0000-4000-8000-000000000305",
          );
          await appendEvent(
            "run.started",
            {
              executionId: "00000000-0000-4000-8000-000000000304",
            },
            "00000000-0000-4000-8000-000000000306",
          );
        },
      });
      const before = (await store.readSnapshot({ missionId })).snapshot.lease;
      const output: MissionWatchEvent[] = [];
      const watch = createMissionWatchApplication({ controller: store, pollIntervalMs: 5 });
      const result = await watch.watch({
        missionId,
        replay: 1,
        until: "terminal",
        onEvent: async (event) => {
          output.push(event);
          if (event.type === "watch.ready") {
            await store.write({
              missionId,
              guard,
              operation: async ({ appendEvent }) =>
                await appendEvent(
                  "run.succeeded",
                  {
                    executionId: "00000000-0000-4000-8000-000000000304",
                    result: { ok: true },
                  },
                  "00000000-0000-4000-8000-000000000307",
                ),
            });
          }
        },
      });

      expect(output.map((event) => event.type)).toEqual([
        "run.started",
        "mission.snapshot",
        "watch.ready",
        "run.succeeded",
      ]);
      expect(output[0]).toMatchObject({
        eventId: "00000000-0000-4000-8000-000000000306",
        replayable: true,
        cursor: makeMissionEventCursor(missionId, 2),
      });
      expect(output[3]).toMatchObject({
        eventId: "00000000-0000-4000-8000-000000000307",
        replayable: true,
        cursor: makeMissionEventCursor(missionId, 3),
      });
      expect(output[1]).toMatchObject({
        type: "mission.snapshot",
        replayable: false,
        data: { status: "running", eventSequence: 2 },
      });
      expect(output[1]).not.toHaveProperty("cursor");
      expect(output[2]).toMatchObject({
        type: "watch.ready",
        replayable: false,
        data: { cursor: makeMissionEventCursor(missionId, 2) },
      });
      expect(output[2]).not.toHaveProperty("cursor");
      expect(result).toEqual({
        missionId,
        status: "completed",
        missionContinues: false,
        lastCursor: makeMissionEventCursor(missionId, 3),
        until: "terminal",
      });
      expect((await store.readSnapshot({ missionId })).snapshot.lease).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the barrier lifecycle status for replay 0 and stops at a terminal snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-watch-replay-zero-"));
    try {
      const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const guard = await store.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000308",
        leaseMs: 10_000,
      });
      await store.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent(
            "mission.created",
            { requestId: "00000000-0000-4000-8000-000000000309" },
            "00000000-0000-4000-8000-000000000313",
          );
          await appendEvent(
            "run.succeeded",
            { result: { answer: 42 } },
            "00000000-0000-4000-8000-000000000314",
          );
        },
      });
      const readBarrier = vi.spyOn(store, "readWatchBarrier");
      const output: MissionWatchEvent[] = [];
      const result = await createMissionWatchApplication({ controller: store }).watch({
        missionId,
        replay: 0,
        until: "terminal",
        onEvent: (event) => output.push(event),
      });

      expect(output.map((event) => event.type)).toEqual(["mission.snapshot", "watch.ready"]);
      expect(output[0]).toMatchObject({ data: { status: "succeeded", eventSequence: 2 } });
      expect(result.status).toBe("completed");
      expect(readBarrier).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops at a durable human input-required event without taking ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-watch-input-required-"));
    try {
      const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const guard = await store.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000316",
        leaseMs: 10_000,
      });
      await store.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent("mission.created", {
            requestId: "00000000-0000-4000-8000-000000000317",
          });
          await appendEvent("run.input_required", {
            executionId: "00000000-0000-4000-8000-000000000318",
            interaction: { kind: "question", title: "Continue" },
          });
        },
      });
      const output: MissionWatchEvent[] = [];
      const result = await createMissionWatchApplication({ controller: store }).watch({
        missionId,
        replay: 0,
        until: "input-required",
        onEvent: (event) => output.push(event),
      });

      expect(output.map((event) => event.type)).toEqual(["mission.snapshot", "watch.ready"]);
      expect(output[0]).toMatchObject({ data: { status: "input_required" } });
      expect(result).toMatchObject({
        status: "completed",
        missionContinues: true,
        until: "input-required",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deduplicates a repeated durable eventId while preserving the original event identity", async () => {
    const duplicate: MissionEvent = {
      schemaVersion: "pragma.local-host-mission-event/v1",
      eventId: "00000000-0000-4000-8000-000000000310",
      missionId,
      sequence: 1,
      occurredAt: "2026-08-27T00:00:00.000Z",
      type: "run.succeeded",
      data: { result: { ok: true } },
    };
    const snapshot = {
      schemaVersion: "pragma.local-host-mission-aggregate/v1" as const,
      missionId,
      nextFencingToken: "1",
      eventSequence: 2,
      operations: {},
    };
    const readWatchBarrier = vi.fn(async () => ({
      snapshot,
      cursor: makeMissionEventCursor(missionId, 2),
      barrierSequence: 2,
      events: [duplicate, { ...duplicate, sequence: 2 }],
      latestStatusEventType: "run.succeeded",
    }));
    const output: MissionWatchEvent[] = [];
    const result = await createMissionWatchApplication({
      controller: { readWatchBarrier },
    }).watch({
      missionId,
      until: "terminal",
      onEvent: (event) => output.push(event),
    });

    expect(output.filter((event) => event.type === "run.succeeded")).toHaveLength(1);
    expect(output[0]).toMatchObject({
      eventId: duplicate.eventId,
      cursor: makeMissionEventCursor(missionId, 1),
    });
    expect(result.lastCursor).toBe(makeMissionEventCursor(missionId, 2));
  });

  it("detaches normally on abort without touching the Mission owner lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-watch-detach-"));
    try {
      const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const guard = await store.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000311",
        leaseMs: 10_000,
      });
      await store.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) =>
          await appendEvent(
            "mission.created",
            { requestId: "00000000-0000-4000-8000-000000000312" },
            "00000000-0000-4000-8000-000000000315",
          ),
      });
      const before = (await store.readSnapshot({ missionId })).snapshot.lease;
      const controller = new AbortController();
      const output: MissionWatchEvent[] = [];
      const result = await createMissionWatchApplication({
        controller: store,
        pollIntervalMs: 100,
      }).watch({
        missionId,
        replay: 0,
        signal: controller.signal,
        onEvent: (event) => {
          output.push(event);
          if (event.type === "watch.ready") controller.abort();
        },
      });

      expect(result).toMatchObject({ status: "detached", missionContinues: true });
      expect(output.map((event) => event.type)).toEqual(["mission.snapshot", "watch.ready"]);
      expect((await store.readSnapshot({ missionId })).snapshot.lease).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps malformed and cross-Mission cursors to CURSOR_INVALID", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-watch-cursor-"));
    try {
      const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
      await expect(
        store.readWatchBarrier({ missionId, after: "not-a-cursor" }),
      ).rejects.toMatchObject({
        code: "CURSOR_INVALID",
      });
      await expect(
        store.readWatchBarrier({
          missionId,
          after: makeMissionEventCursor("00000000-0000-4000-8000-000000000399", 0),
        }),
      ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
      const guard = await store.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000324",
        leaseMs: 10_000,
      });
      await store.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) =>
          await appendEvent("mission.created", {
            requestId: "00000000-0000-4000-8000-000000000325",
          }),
      });
      await expect(
        store.readWatchBarrier({ missionId, after: makeMissionEventCursor(missionId, 2) }),
      ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a nonexistent Mission without claiming or polling", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-watch-missing-"));
    try {
      const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
      await expect(store.readWatchBarrier({ missionId })).rejects.toMatchObject({
        code: "MISSION_NOT_FOUND",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays the same durable event after a consumer disconnects from its prior cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-watch-reconnect-"));
    try {
      const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const guard = await store.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000319",
        leaseMs: 10_000,
      });
      await store.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent(
            "mission.created",
            { requestId: "00000000-0000-4000-8000-000000000320" },
            "00000000-0000-4000-8000-000000000321",
          );
          await appendEvent(
            "run.succeeded",
            { executionId: "00000000-0000-4000-8000-000000000322", result: { ok: true } },
            "00000000-0000-4000-8000-000000000323",
          );
        },
      });

      const watcher = createMissionWatchApplication({ controller: store, pollIntervalMs: 5 });
      await expect(
        watcher.watch({
          missionId,
          after: makeMissionEventCursor(missionId, 0),
          until: "terminal",
          onEvent: (event) => {
            if (event.type === "mission.created") throw new Error("consumer disconnected");
          },
        }),
      ).rejects.toThrow("consumer disconnected");

      const output: MissionWatchEvent[] = [];
      const result = await watcher.watch({
        missionId,
        after: makeMissionEventCursor(missionId, 0),
        until: "terminal",
        onEvent: (event) => output.push(event),
      });
      expect(output.filter((event) => event.replayable).map((event) => event.eventId)).toEqual([
        "00000000-0000-4000-8000-000000000321",
        "00000000-0000-4000-8000-000000000323",
      ]);
      expect(result.lastCursor).toBe(makeMissionEventCursor(missionId, 2));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
