import {
  createEmptyUsage,
  createFileCanonicalEventFeed,
  createNoopLoggerProvider,
  type CanonicalEventFeed,
} from "@pragma/core";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MissionExecutionOwner } from "../src/missions/execution-owner.ts";
import { acquireHostStoragePool } from "../src/host-storage-pool.ts";
import { createMissionDeliveryRecovery } from "../src/missions/mission-delivery-recovery.ts";
import {
  createMissionDelivery,
  type MissionDeliveryStep,
} from "../src/missions/mission-delivery.ts";
import { createMissionStore } from "../src/missions/repository/mission-store.ts";

const resources: {
  root: string;
  feed: CanonicalEventFeed;
  delivery: Awaited<ReturnType<typeof createMissionDelivery>>;
}[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.delivery.close();
    await resource.feed.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});
const executionId = "00000000-0000-4000-8000-000000000111";
async function fixture(callback?: (step: MissionDeliveryStep) => Promise<void | "deferred">) {
  const root = await mkdtemp(join(tmpdir(), "pragma-mission-delivery-"));
  const mission = await createMissionStore({ missionsPath: join(root, "missions") }).create({
    workspace: { path: root, basename: "workspace" },
    goal: "Delivery test",
    project: { id: "studio", revision: 1 },
    executor: { kind: "expert", ref: "expert:v2vt1v01vzz6j24q", name: "Expert" },
  });
  const feed = await createFileCanonicalEventFeed({ pragmaHome: root });
  const usage = vi.fn(async () => undefined);
  const terminal = vi.fn(
    async (_mission, _execution, _request, _status, step: MissionDeliveryStep) =>
      await callback?.(step),
  );
  const path = join(root, "delivery.sqlite");
  const logger = createNoopLoggerProvider().createLogger({ component: "test.delivery" });
  const delivery = await createMissionDelivery({
    path,
    feed,
    logger,
    usage,
    terminal,
  });
  resources.push({ root, feed, delivery });
  return { root, path, mission, feed, delivery, usage, terminal, logger };
}
async function publish(feed: CanonicalEventFeed, kind: "usage" | "terminal") {
  const eventId = kind;
  const observation = {
    observationId: "obs",
    occurredAt: new Date().toISOString(),
    executionId,
    invocationId: executionId,
    contextId: "context",
    runId: "run",
    runtimeId: "pi",
    executor: { id: "expert", name: "Expert" },
    usage: createEmptyUsage(),
  };
  await feed.append([
    {
      schemaVersion: "pragma.canonical-event/v1",
      eventId,
      topic: "pragma.execution.event.committed",
      schemaRef: "pragma.execution-event/v5",
      sourceRef: {
        type: "pragma.execution-event",
        id: eventId,
        ownerRef: { type: "pragma.execution", id: executionId },
        cursor: "1",
      },
      relatedRefs: [],
      correlationId: executionId,
      occurredAt: new Date().toISOString(),
      payload: {
        schemaVersion: "pragma.execution-event/v5",
        eventId,
        cursor: { executionId, sequence: 1 },
        executionId,
        invocationId: executionId,
        type: kind === "usage" ? "runtime.usage.observed" : "execution.succeeded",
        data:
          kind === "usage"
            ? { schemaVersion: "pragma.runtime-usage-observed/v1", observation }
            : { output: "OK" },
        occurredAt: new Date().toISOString(),
      },
    },
  ]);
}
describe("Mission durable delivery", { timeout: 15000 }, () => {
  it("takes terminal custody while paused without waiting for a product observer", async () => {
    const target = await fixture(async () => await new Promise<void>(() => undefined));
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await publish(target.feed, "terminal");
    await target.delivery.takeCustody();
    expect(target.delivery.safeThrough()).toBe(1);
    expect(target.delivery.inspect()).toMatchObject({ pending: 5, state: "healthy" });
    expect(target.terminal).not.toHaveBeenCalled();
  });
  it("settles explicit Mission access without starting global dispatch or resetting failures", async () => {
    const target = await fixture();
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await publish(target.feed, "terminal");
    await target.delivery.takeCustody();
    const db = new DatabaseSync(target.path);
    try {
      db.prepare(
        "UPDATE delivery_tasks SET next_at=?,attempts=3,error_code='MISSION_DELIVERY_RETRY_PENDING' WHERE step=2",
      ).run(Date.now() + 60_000);
    } finally {
      db.close();
    }
    await target.delivery.settleMission(target.mission.id);
    expect(target.terminal).toHaveBeenCalledTimes(4);
    const recovered = new DatabaseSync(target.path);
    try {
      expect(
        recovered.prepare("SELECT step,attempts,error_code FROM delivery_tasks").all(),
      ).toEqual([{ step: 2, attempts: 3, error_code: "MISSION_DELIVERY_RETRY_PENDING" }]);
    } finally {
      recovered.close();
    }
  });
  it("defers released request custody without failure and resumes from the same step", async () => {
    let released = true;
    const target = await fixture(async () => (released ? "deferred" : undefined));
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    target.delivery.start();
    await publish(target.feed, "terminal");
    await vi.waitFor(() => expect(target.terminal).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(target.delivery.inspect()).toMatchObject({ state: "healthy", pending: 5 }),
    );
    await target.delivery.close();
    const database = new DatabaseSync(target.path);
    try {
      const rows = database.prepare("SELECT attempts,error_code FROM delivery_tasks").all();
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.attempts === 0 && row.error_code === null)).toBe(true);
    } finally {
      database.close();
    }
    released = false;
    target.delivery = await createMissionDelivery(target);
    resources[resources.length - 1]!.delivery = target.delivery;
    await target.delivery.retry(target.mission.id);
    target.terminal.mockClear();
    target.delivery.start();
    await vi.waitFor(() => expect(target.terminal).toHaveBeenCalledTimes(5));
  });
  it("pauses dispatch without waiting for a receipt blocked on real Mission admission", async () => {
    const owner = new MissionExecutionOwner();
    let entering!: () => void;
    const entered = new Promise<void>((resolve) => {
      entering = resolve;
    });
    const target = await fixture(async () => {
      entering();
      await owner.admit("mission", async () => undefined);
    });
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await owner.admit("mission", async () => {
      target.delivery.start();
      await publish(target.feed, "terminal");
      await entered;
      // The claimed receipt owns custody but waits for this reservation.
      await target.delivery.pause();
    });
    target.delivery.start();
    await vi.waitFor(() => expect(target.terminal).toHaveBeenCalledTimes(5));
  });
  it("pauses request background dispatch and resumes durable receipts on the next request", async () => {
    const target = await fixture();
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    target.delivery.start();
    await publish(target.feed, "usage");
    await vi.waitFor(() => expect(target.usage).toHaveBeenCalledOnce());
    await target.delivery.pause();
    await publish(target.feed, "terminal");
    expect(target.terminal).not.toHaveBeenCalled();
    target.delivery.start();
    await vi.waitFor(() => expect(target.terminal).toHaveBeenCalledTimes(5));
    expect(target.usage).toHaveBeenCalledOnce();
  });
  it("receives a fact before Mission association and delivers it after registration", async () => {
    const target = await fixture();
    await publish(target.feed, "usage");
    target.delivery.start();
    await vi.waitFor(() => expect(target.delivery.safeThrough()).toBe(1));
    expect(target.usage).not.toHaveBeenCalled();
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await vi.waitFor(() => expect(target.usage).toHaveBeenCalledOnce(), { timeout: 5000 });
  });
  it("isolates Memory failure from metadata and history; archive waits for history", async () => {
    const order: MissionDeliveryStep[] = [];
    const target = await fixture(async (step) => {
      order.push(step);
      if (step === "memory") throw new Error("memory unavailable");
    });
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await publish(target.feed, "terminal");
    target.delivery.start();
    await vi.waitFor(() => expect(order).toContain("archive"), { timeout: 7000 });
    expect(order).toContain("metadata");
    expect(order.indexOf("history")).toBeLessThan(order.indexOf("archive"));
    await vi.waitFor(() =>
      expect(target.delivery.inspect()).toMatchObject({ state: "degraded", pending: 1 }),
    );
  });
  it.each([false, true])(
    "replays staged work after restart with intake unavailable=%s",
    async (unavailable) => {
      const target = await fixture(async () => {
        throw new Error("offline");
      });
      await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
      await publish(target.feed, "terminal");
      target.delivery.start();
      await vi.waitFor(() => expect(target.delivery.inspect().state).toBe("degraded"));
      await target.delivery.close();
      const terminal = vi.fn(async () => undefined);
      let sourceUnavailable = unavailable;
      const read = vi.fn(async (...args: Parameters<CanonicalEventFeed["read"]>) => {
        if (sourceUnavailable) throw new Error("source unavailable");
        return await target.feed.read(...args);
      });
      const restored = await createMissionDelivery({
        ...target,
        feed: { ...target.feed, read },
        terminal,
      });
      resources[resources.length - 1]!.delivery = restored;
      await restored.retry(target.mission.id);
      restored.start();
      await vi.waitFor(() => expect(restored.inspect().pending).toBe(0), { timeout: 7000 });
      expect(terminal).toHaveBeenCalledTimes(5);
      expect(restored.safeThrough()).toBe(1);
      expect(read).toHaveBeenCalled();
      if (unavailable) {
        await vi.waitFor(() =>
          expect(restored.inspect()).toMatchObject({
            state: "degraded",
            errorCode: "MISSION_DELIVERY_RECEIVE_FAILED",
            pending: 0,
          }),
        );
        sourceUnavailable = false;
        restored.wake();
        // Intake uses a bounded backoff independently of replay. Recovery need not
        // finish within Vitest's default one-second assertion window under CI load.
        await vi.waitFor(() => expect(restored.inspect().state).toBe("healthy"), {
          timeout: 7000,
        });
        expect(restored.safeThrough()).toBe(1);
        expect(terminal).toHaveBeenCalledTimes(5);
      }
    },
  );
  it("does not write metadata or reset retry backoff when reading an existing association", async () => {
    const target = await fixture();
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await publish(target.feed, "usage");
    // Receive without delivering: the fact has no association until this call.
    const db = new DatabaseSync(target.path);
    try {
      db.prepare(
        "INSERT INTO delivery_tasks(id,execution_id,mission_id,sequence,payload,next_at,attempts,error_code) VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        "retry",
        executionId,
        target.mission.id,
        1,
        JSON.stringify({ kind: "usage" }),
        Date.now() + 60_000,
        3,
        "MISSION_DELIVERY_RETRY_PENDING",
      );
      const before = db
        .prepare("SELECT next_at,attempts FROM delivery_tasks WHERE id='retry'")
        .get();
      await target.delivery.register(
        { ...target.mission, title: "Updated title" },
        executionId,
        target.mission.initialMessageId,
      );
      expect(
        db.prepare("SELECT next_at,attempts FROM delivery_tasks WHERE id='retry'").get(),
      ).toEqual(before);
      const link = db
        .prepare("SELECT payload FROM execution_links WHERE execution_id=?")
        .get(executionId) as { payload: string };
      expect(JSON.parse(link.payload).mission.title).toBe(target.mission.title);
    } finally {
      db.close();
    }
  });
  it("quarantines an unreadable envelope and continues delivering unrelated valid facts", async () => {
    const target = await fixture();
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await publish(target.feed, "terminal");
    const page = await target.feed.read({ after: { sequence: 0 }, limit: 64 });
    const read = vi.fn(async (input: Parameters<CanonicalEventFeed["read"]>[0]) =>
      input.after?.sequence === 0
        ? {
            items: [
              {
                kind: "unreadable" as const,
                cursor: { sequence: 1 },
                eventId: "damaged",
                errorCode: "invalid_envelope" as const,
              },
              { ...page.items[0]!, cursor: { sequence: 2 } },
            ],
            nextCursor: { sequence: 2 },
          }
        : { items: [], nextCursor: { sequence: 2 } },
    );
    await target.delivery.close();
    const restored = await createMissionDelivery({ ...target, feed: { ...target.feed, read } });
    resources[resources.length - 1]!.delivery = restored;
    restored.start();
    await vi.waitFor(() => expect(target.terminal).toHaveBeenCalledTimes(5), { timeout: 7000 });
    expect(restored.safeThrough()).toBe(2);
    await vi.waitFor(() =>
      expect(restored.inspect()).toMatchObject({
        state: "degraded",
        pending: 1,
        errorCode: "MISSION_DELIVERY_INVALID_ENVELOPE",
      }),
    );
  });
  it("deletes and fences Executions whose association was never registered", async () => {
    const target = await fixture();
    await publish(target.feed, "usage");
    target.delivery.start();
    await vi.waitFor(() => expect(target.delivery.safeThrough()).toBe(1));
    expect(target.delivery.inspect().pending).toBe(1);
    await target.delivery.deleteMission(target.mission.id, {
      mission: target.mission,
      executionIds: [executionId],
    });
    await vi.waitFor(() => expect(target.delivery.inspect().pending).toBe(0));
    await publish(target.feed, "terminal");
    await vi.waitFor(() => expect(target.delivery.safeThrough()).toBe(2));
    await vi.waitFor(() => expect(target.delivery.inspect().pending).toBe(0));
    expect(target.usage).not.toHaveBeenCalled();
    expect(target.terminal).not.toHaveBeenCalled();
  });
  it("rejects rebinding an Execution to a different Mission or request", async () => {
    const target = await fixture();
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await expect(
      target.delivery.register(
        { ...target.mission, id: "00000000-0000-4000-8000-000000000222" },
        executionId,
        target.mission.initialMessageId,
      ),
    ).rejects.toThrow("OWNER_CONFLICT");
    await expect(
      target.delivery.register(target.mission, executionId, "another-request"),
    ).rejects.toThrow("OWNER_CONFLICT");
  });
  it("rejects a stale Feed page after a competing consumer delivered the same source", async () => {
    const target = await fixture();
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await publish(target.feed, "usage");
    const stalePage = await target.feed.read({ after: { sequence: 0 }, limit: 64 });
    let release!: () => void;
    let entered!: () => void;
    const received = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const other = await createMissionDelivery({
      ...target,
      feed: {
        ...target.feed,
        read: async (input) => {
          if (!first) return await target.feed.read(input);
          first = false;
          entered();
          await barrier;
          return stalePage;
        },
      },
    });
    other.start();
    await received;
    target.delivery.start();
    await vi.waitFor(() => expect(target.usage).toHaveBeenCalledOnce());
    release();
    await vi.waitFor(() => expect(other.safeThrough()).toBe(1));
    await other.close();
    expect(target.usage).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(target.delivery.inspect().pending).toBe(0));
  });
  it.each(["future", "wrong-owner"])(
    "retains an invalid Usage task (%s) while valid terminal steps continue",
    async (invalid) => {
      const target = await fixture();
      await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
      await publish(target.feed, "usage");
      const page = await target.feed.read({ after: { sequence: 0 }, limit: 64 });
      const item = page.items[0]!;
      if (item.kind !== "event") throw new Error("missing event");
      const event = item.event.payload as Record<string, unknown>;
      await target.feed.append([
        {
          ...item.event,
          eventId: "invalid-usage",
          sourceRef: { ...item.event.sourceRef, id: "invalid-usage" },
          payload: {
            ...event,
            eventId: "invalid-usage",
            data:
              invalid === "future"
                ? { schemaVersion: "future" }
                : {
                    ...(event.data as Record<string, unknown>),
                    observation: {
                      ...(event.data as { observation: Record<string, unknown> }).observation,
                      executionId: "00000000-0000-4000-8000-000000000999",
                    },
                  },
          },
        },
      ]);
      await publish(target.feed, "terminal");
      target.delivery.start();
      await vi.waitFor(() => expect(target.terminal).toHaveBeenCalledTimes(5), { timeout: 7000 });
      expect(target.delivery.safeThrough()).toBe(3);
      await vi.waitFor(() =>
        expect(target.delivery.inspect()).toMatchObject({
          state: "degraded",
          errorCode: "MISSION_DELIVERY_INVALID_TASK",
          pending: 1,
        }),
      );
    },
  );
  it("isolates an invalid payload without an owner and retains a later valid terminal", async () => {
    const target = await fixture();
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await publish(target.feed, "terminal");
    const page = await target.feed.read({ after: { sequence: 0 }, limit: 64 });
    const item = page.items[0]!;
    if (item.kind !== "event") throw new Error("missing event");
    const damaged = {
      ...item.event,
      eventId: "missing-owner",
      correlationId: undefined,
      sourceRef: { type: "pragma.execution-event", id: "missing-owner" },
      payload: {},
    };
    // Commit damage before the next valid terminal in source order.
    await target.delivery.close();
    const feed = {
      ...target.feed,
      read: async (input: Parameters<CanonicalEventFeed["read"]>[0]) =>
        input.after?.sequence === 0
          ? {
              items: [
                { kind: "event" as const, cursor: { sequence: 1 }, event: damaged },
                { ...item, cursor: { sequence: 2 } },
              ],
              nextCursor: { sequence: 2 },
            }
          : { items: [], nextCursor: { sequence: 2 } },
    };
    const restored = await createMissionDelivery({ ...target, feed });
    resources[resources.length - 1]!.delivery = restored;
    restored.start();
    await vi.waitFor(() => expect(target.terminal).toHaveBeenCalledTimes(5), { timeout: 7000 });
    expect(restored.safeThrough()).toBe(2);
    await vi.waitFor(() =>
      expect(restored.inspect()).toMatchObject({
        state: "degraded",
        pending: 1,
        errorCode: "MISSION_DELIVERY_INVALID_TASK",
      }),
    );
  });
  it("excludes unassociated work from the indexed claim candidates", async () => {
    const target = await fixture();
    const db = new DatabaseSync(target.path);
    try {
      const insert = db.prepare(
        "INSERT INTO delivery_tasks(id,execution_id,mission_id,sequence,payload) VALUES (?,?,?,?,?)",
      );
      db.exec("BEGIN");
      for (let index = 0; index < 1000; index++)
        insert.run(
          `unlinked-${index}`,
          `execution-${index}`,
          `unlinked:execution-${index}`,
          index,
          JSON.stringify({ kind: "terminal", status: "succeeded" }),
        );
      db.exec("COMMIT");
      const candidates = db
        .prepare(
          "SELECT id FROM delivery_tasks INDEXED BY delivery_linked_pending WHERE mission_id NOT GLOB 'unlinked:*' AND state='pending' AND next_at<=?",
        )
        .all(Date.now());
      expect(candidates).toEqual([]);
      await target.delivery.register(
        target.mission,
        "execution-0",
        target.mission.initialMessageId,
      );
      expect(
        db
          .prepare(
            "SELECT id FROM delivery_tasks INDEXED BY delivery_linked_pending WHERE mission_id NOT GLOB 'unlinked:*' AND state='pending' AND next_at<=?",
          )
          .all(Date.now()),
      ).toEqual([{ id: "unlinked-0" }]);
    } finally {
      db.close();
    }
  });
  it("rejects a future delivery protocol before changing database contents", async () => {
    const target = await fixture();
    await target.delivery.close();
    const db = new DatabaseSync(target.path);
    db.prepare("UPDATE delivery_metadata SET value='future' WHERE key='version'").run();
    db.close();
    await expect(createMissionDelivery(target)).rejects.toThrow(
      "Unsupported Mission delivery version",
    );
    const check = new DatabaseSync(target.path);
    expect(
      check.prepare("SELECT value FROM delivery_metadata WHERE key='version'").get(),
    ).toMatchObject({ value: "future" });
    check.close();
  });
  it("fences an owner without waiting for accounting", async () => {
    const target = await fixture();
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await target.delivery.fenceMission(target.mission.id, [executionId]);
    await expect(
      target.delivery.register(target.mission, executionId, target.mission.initialMessageId),
    ).rejects.toThrow("DELETED");
    await target.delivery.deleteMission(target.mission.id);
  });
  it("tombstones pending and future delivery for a deleted owner", async () => {
    const target = await fixture();
    await target.delivery.register(target.mission, executionId, target.mission.initialMessageId);
    await target.delivery.deleteMission(target.mission.id);
    await publish(target.feed, "terminal");
    target.delivery.start();
    await vi.waitFor(() => expect(target.delivery.safeThrough()).toBe(1));
    await vi.waitFor(() => expect(target.delivery.inspect().pending).toBe(0));
    expect(target.terminal).not.toHaveBeenCalled();
    await expect(
      target.delivery.register(target.mission, executionId, target.mission.initialMessageId),
    ).rejects.toThrow("DELETED");
  });
});

describe("Mission delivery initialization recovery", () => {
  it("retries a real database open failure after background start and preserves custody", async () => {
    // Production keeps the shared Execution/Usage pool alive while this optional consumer retries.
    const pool = acquireHostStoragePool();
    const target = await fixture();
    await publish(target.feed, "usage");
    target.delivery.start();
    await vi.waitFor(() => expect(target.delivery.safeThrough()).toBe(1));
    await target.delivery.close();
    await rename(target.path, `${target.path}.saved`);
    await mkdir(target.path);
    const delivery: { current: Awaited<ReturnType<typeof createMissionDelivery>> | undefined } = {
      current: undefined,
    };
    const create = vi.fn(async () => await createMissionDelivery(target));
    const onUnavailable = vi.fn();
    const onRecovered = vi.fn();
    const recovery = createMissionDeliveryRecovery({
      delivery,
      create,
      onUnavailable,
      onRecovered,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await recovery.initialize();
      expect(onUnavailable).toHaveBeenCalledOnce();
      expect(delivery.current?.safeThrough() ?? 0).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(create).toHaveBeenCalledOnce();
      recovery.start();
      await recovery.initialize();
      expect(create).toHaveBeenCalledTimes(2);
      await rm(target.path, { recursive: true });
      await rename(`${target.path}.saved`, target.path);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(create).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await recovery.initialize();
      expect(create).toHaveBeenCalledTimes(3);
      expect(onRecovered).toHaveBeenCalledOnce();
      expect(delivery.current!.safeThrough()).toBe(1);
      resources[resources.length - 1]!.delivery = delivery.current!;
      await delivery.current!.register(
        target.mission,
        executionId,
        target.mission.initialMessageId,
      );
      await vi.waitFor(() => expect(target.usage).toHaveBeenCalledOnce());
      await recovery.close();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(create).toHaveBeenCalledTimes(3);
    } finally {
      await recovery.close();
      vi.useRealTimers();
      await pool.close();
    }
  });

  it("closes a database opened during shutdown without starting or publishing it", async () => {
    const target = await fixture();
    await target.delivery.close();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened: Awaited<ReturnType<typeof createMissionDelivery>> | undefined;
    const create = vi.fn(async () => {
      await gate;
      opened = await createMissionDelivery(target);
      return opened;
    });
    const delivery: { current: Awaited<ReturnType<typeof createMissionDelivery>> | undefined } = {
      current: undefined,
    };
    const onRecovered = vi.fn();
    const recovery = createMissionDeliveryRecovery({
      delivery,
      create,
      onUnavailable: vi.fn(),
      onRecovered,
    });
    const first = recovery.initialize();
    const second = recovery.initialize();
    recovery.start();
    const closing = recovery.close();
    release();
    await Promise.all([first, second, closing]);
    expect(create).toHaveBeenCalledOnce();
    expect(delivery.current).toBeUndefined();
    expect(onRecovered).not.toHaveBeenCalled();
    expect(() => opened!.inspect()).toThrow();
  });
});
