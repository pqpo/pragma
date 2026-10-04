import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMissionStore } from "../../src/missions/repository/mission-store.ts";
import {
  cleanupInternalMission,
  waitForInternalMissionTerminal,
  waitForInternalMissionRetry,
} from "../../src/missions/internal-mission-use-cases.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function missionFixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-internal-mission-"));
  roots.push(root);
  const store = createMissionStore({ missionsPath: join(root, "missions") });
  const mission = await store.create({
    workspace: { path: root, basename: "workspace" },
    goal: "Internal background task",
    project: { id: "project", revision: 1 },
    executor: { kind: "expert", ref: "expert:0000000000st0rev", name: "Store Revision Agent" },
    origin: { type: "system-store-revision", jobId: randomUUID(), storeId: randomUUID() },
    toolPermissionMode: "request-approval",
  });
  await store.updateExecution(mission.id, {
    id: randomUUID(),
    inputMessageId: mission.initialMessageId,
    status: "running",
    startedAt: new Date().toISOString(),
  });
  return { store, mission };
}

it.each(["succeeded", "failed", "cancelled"] as const)(
  "observes durable %s without changing approval or ownership",
  async (status) => {
    const { store, mission } = await missionFixture();
    const read = vi.fn(async (id: string) => {
      const current = await store.get(id);
      if (read.mock.calls.length === 2)
        return await store.updateExecution(id, { ...current.execution!, status });
      return current;
    });
    const result = await waitForInternalMissionTerminal({
      getMission: read,
      missionId: mission.id,
      timeoutMessage: "internal_timeout",
      pollIntervalMs: 1,
    });
    expect(result.execution?.status).toBe(status);
    expect(result.toolPermissionMode).toBe("request-approval");
    expect(result.origin).toEqual(mission.origin);
    expect(read).toHaveBeenCalledTimes(2);
  },
);

it("cancels polling without waiting for the next interval or deleting durable history", async () => {
  const { store, mission } = await missionFixture();
  const abort = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const operation = waitForInternalMissionTerminal({
    getMission: async (id) => {
      const value = await store.get(id);
      entered();
      return value;
    },
    missionId: mission.id,
    signal: abort.signal,
    timeoutMessage: "internal_timeout",
    pollIntervalMs: 60_000,
  });
  const rejection = expect(operation).rejects.toThrow("cancelled by owner");
  await ready;
  abort.abort(new Error("cancelled by owner"));
  await rejection;
  expect((await store.get(mission.id)).execution?.status).toBe("running");
});

it("preserves the consumer timeout diagnostic and does not change execution", async () => {
  const { store, mission } = await missionFixture();
  await expect(
    waitForInternalMissionTerminal({
      getMission: (id) => store.get(id),
      missionId: mission.id,
      timeoutMessage: "memory_curator_timeout",
      timeoutMs: 0,
    }),
  ).rejects.toThrow("memory_curator_timeout");
  expect((await store.get(mission.id)).execution?.status).toBe("running");
});

it("retains custody when deletion still fails after interrupt and permits targeted retry", async () => {
  const events: string[] = [];
  let deleteFails = true;
  const input = {
    missionId: randomUUID(),
    deleteMission: async () => {
      events.push("delete");
      if (deleteFails) throw new Error("storage busy");
    },
    interruptMission: async () => {
      events.push("interrupt");
      throw new Error("already terminal");
    },
  };
  expect(await cleanupInternalMission(input)).toBe(false);
  expect(events).toEqual(["delete", "interrupt", "delete"]);
  deleteFails = false;
  expect(await cleanupInternalMission(input)).toBe(true);
  expect(events).toEqual(["delete", "interrupt", "delete", "delete"]);
});

it("does not add a listener or schedule retry for an already aborted consumer", async () => {
  const abort = new AbortController();
  abort.abort(new Error("stopped"));
  const listen = vi.spyOn(abort.signal, "addEventListener");
  await expect(waitForInternalMissionRetry(60_000, abort.signal)).rejects.toThrow("stopped");
  expect(listen).not.toHaveBeenCalled();
});
