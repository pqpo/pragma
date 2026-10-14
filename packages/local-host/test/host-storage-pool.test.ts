import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths } from "@pragma/core";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquireHostStoragePool } from "../src/host-storage-pool.ts";
import { createSqliteExecutionStore } from "../src/execution/sqlite-execution-store.ts";
import { createHostUsageStore } from "../src/host-usage-store.ts";

const workers = vi.hoisted(() => ({ active: new Set<object>(), peak: 0 }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...original,
    Worker: class extends original.Worker {
      constructor(...args: ConstructorParameters<typeof original.Worker>) {
        super(...args);
        workers.active.add(this);
        workers.peak = Math.max(workers.peak, workers.active.size);
        this.once("exit", () => workers.active.delete(this));
      }
    },
  };
});

describe("Shared Host storage lifecycle", () => {
  it("reopens Execution WAL metadata after another process holds an exclusive lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-execution-busy-"));
    const store = createSqliteExecutionStore({ pragmaHome: home });
    const pool = acquireHostStoragePool();
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/execution-file-v12.json", import.meta.url), "utf8"),
    );
    const id = "exclusive-owner";
    await store.create(
      { ...fixture.execution, executionId: id, version: 0, lastAppliedSequence: 0 },
      fixture.invocations[0],
    );
    await Promise.all(pool.clients.map((client) => client.call("get", id, undefined, false, home)));
    const locker = new DatabaseSync(new PragmaPaths({ pragmaHome: home }).executionDatabase(id));
    locker.exec(
      "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE execution SET payload=payload; COMMIT;",
    );
    const reading = store.get(id);
    const settled = reading.then(
      () => "resolved",
      () => "rejected",
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");
      locker.close();
      await expect(reading).resolves.toMatchObject({ executionId: id });
    } finally {
      if (locker.isOpen) locker.close();
      await Promise.allSettled([reading]);
      await store.close();
      await pool.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("recovers receipt reads after a real SQLite lock outlasts the previous retry window", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-receipt-busy-"));
    const file = join(home, "receipt.sqlite");
    const pool = acquireHostStoragePool();
    await pool.clients[0]!.call("mission-receipt:open", file);
    await pool.clients[1]!.call("mission-receipt:open", file);
    const locker = new DatabaseSync(file);
    locker.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
    // Checkpointing forces the exclusive connection to keep the WAL read lock.
    locker.exec("UPDATE delivery_metadata SET value=value WHERE key='cursor'; COMMIT;");
    const reading = pool.clients[1]!.call("mission-receipt:open", file);
    const settled = reading.then(
      () => "resolved",
      () => "rejected",
    );
    try {
      // This lock lasts longer than the old 75 ms retry budget.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");
      locker.close();
      await expect(reading).resolves.toBeDefined();
    } finally {
      if (locker.isOpen) locker.close();
      await Promise.allSettled([reading]);
      await pool.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("lets ID-only acknowledgements share the second lane with foreground reads", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-ack-lane-"));
    const pool = acquireHostStoragePool();
    const store = createSqliteExecutionStore({ pragmaHome: home });
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/execution-file-v12.json", import.meta.url), "utf8"),
    );
    const ids = ["one", "two", "three", "four"];
    for (const id of ids)
      await store.create(
        { ...fixture.execution, executionId: id, version: 0, lastAppliedSequence: 0 },
        fixture.invocations[0],
      );
    const post = Worker.prototype.postMessage;
    const deliveryWorkers = new Set<Worker>();
    const foregroundWorkers = new Set<Worker>();
    const held: (() => void)[] = [];
    const intercepted = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request,
      ...args
    ) {
      if (request?.operation === "ack") deliveryWorkers.add(this);
      if (request?.operation === "get") foregroundWorkers.add(this);
      held.push(() => Reflect.apply(post, this, [request, ...args]));
    });
    const acknowledgement = pool.execute("ack", ids[0]!, [], false, home);
    const reads = ids.map((id) => store.get(id));
    try {
      expect(foregroundWorkers.size).toBe(2);
      expect([...deliveryWorkers].every((worker) => foregroundWorkers.has(worker))).toBe(true);
    } finally {
      intercepted.mockRestore();
      held.forEach((release) => release());
      await Promise.all([acknowledgement, ...reads]);
      await store.close();
      await pool.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("loads the durable tracking cutoff before deferred historical reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-usage-deferred-cutoff-"));
    const databasePath = join(root, "usage.sqlite");
    const original = await createHostUsageStore({
      databasePath,
      now: new Date("2020-01-01T00:00:00.000Z"),
    });
    await original.close();
    const deferred = await createHostUsageStore({
      databasePath,
      deferred: true,
      now: new Date("2026-10-02T00:00:00.000Z"),
    });
    try {
      await deferred.assertAvailable();
      expect(deferred.trackingStartedAt).toBe("2020-01-01T00:00:00.000Z");
    } finally {
      await deferred.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps another warm Mission's reads and terminal facts available during a giant commit", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-giant-owner-isolation-"));
    const store = createSqliteExecutionStore({ pragmaHome: home });
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/execution-file-v12.json", import.meta.url), "utf8"),
    );
    const root = fixture.invocations[0];
    for (const executionId of ["giant", "warm"])
      await store.create(
        { ...fixture.execution, executionId, version: 0, lastAppliedSequence: 0 },
        root,
      );
    const post = Worker.prototype.postMessage;
    let release: (() => void) | undefined;
    const intercepted = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request,
      ...args
    ) {
      if (request?.operation === "commit" && request.executionId === "giant") {
        release = () => {
          release = undefined;
          Reflect.apply(post, this, [request, ...args]);
        };
        return;
      }
      return Reflect.apply(post, this, [request, ...args]);
    });
    const giant = store.commit({
      executionId: "giant",
      commitId: "large",
      events: [{ invocationId: "root", type: "progress", data: "x".repeat(33 * 1024 * 1024) }],
    });
    try {
      expect(await store.get("warm")).toMatchObject({ status: "running" });
      expect(
        (
          await store.commit({
            executionId: "warm",
            commitId: "terminal",
            invocations: [{ ...root, status: "succeeded" }],
            executionPatch: { status: "succeeded" },
          })
        ).execution.status,
      ).toBe("succeeded");
      expect(release).toBeDefined();
    } finally {
      release?.();
      intercepted.mockRestore();
      await giant;
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it.each(["prepare-owner", "deleted-usage-source"] as const)(
    "keeps %s and queued outbox work behind a warm owner's terminal commit",
    async (operation) => {
      const home = await mkdtemp(join(tmpdir(), "pragma-background-owner-isolation-"));
      const pool = acquireHostStoragePool();
      const store = createSqliteExecutionStore({ pragmaHome: home });
      const fixture = JSON.parse(
        await readFile(new URL("./fixtures/execution-file-v12.json", import.meta.url), "utf8"),
      );
      const root = fixture.invocations[0];
      await store.create(
        { ...fixture.execution, executionId: "warm", version: 0, lastAppliedSequence: 0 },
        root,
      );
      const post = Worker.prototype.postMessage;
      const blocked = new Set<Worker>();
      const held: (() => void)[] = [];
      const intercepted = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        request,
        ...args
      ) {
        if (request?.operation === operation) blocked.add(this);
        if (blocked.has(this)) {
          held.push(() => Reflect.apply(post, this, [request, ...args]));
          return;
        }
        return Reflect.apply(post, this, [request, ...args]);
      });
      const preparation =
        operation === "prepare-owner"
          ? pool.prepare(home, "old-owner")
          : pool.clients[1]!.call(
              operation,
              "old-owner",
              { deletionId: "00000000-0000-4000-8000-000000000002" },
              false,
              home,
            );
      const outbox = pool.execute("outbox", "warm", undefined, false, home);
      try {
        expect(await store.get("warm")).toMatchObject({ status: "running" });
        expect(
          (
            await store.commit({
              executionId: "warm",
              commitId: "terminal",
              executionPatch: { status: "succeeded" },
              invocations: [{ ...root, status: "succeeded" }],
            })
          ).execution.status,
        ).toBe("succeeded");
        expect(held).toHaveLength(2);
      } finally {
        intercepted.mockRestore();
        held.forEach((release) => release());
        await Promise.all([preparation, outbox]);
        await store.close();
        await pool.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
  it("keeps an old Usage proxy from closing a newly reopened database after worker failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-usage-worker-failure-"));
    const input = { databasePath: join(root, "usage.sqlite") };
    const first = await createHostUsageStore(input);
    const second = await createHostUsageStore(input);
    const post = Worker.prototype.postMessage;
    let terminate: Promise<number> | undefined;
    const intercepted = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request,
      ...args
    ) {
      if (request?.operation === "usage:assertAvailable" && terminate === undefined) {
        terminate = this.terminate();
        return;
      }
      return Reflect.apply(post, this, [request, ...args]);
    });
    try {
      await expect(first.assertAvailable()).rejects.toMatchObject({
        code: "HOST_STORAGE_WORKER_UNAVAILABLE",
      });
      await terminate;
      intercepted.mockRestore();
      await second.close();
      await first.assertAvailable();
      await expect(first.getMissionUsage("mission")).resolves.toBeDefined();
    } finally {
      intercepted.mockRestore();
      await Promise.allSettled([first.close(), second.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("never starts a third storage worker while close overlaps a new acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-pool-generation-"));
    const previous = acquireHostStoragePool();
    const accepted = [
      previous.clients[0]!.call("mission-receipt:open", join(root, "a.sqlite")),
      previous.clients[1]!.call("mission-receipt:open", join(root, "b.sqlite")),
    ];
    const closing = previous.close();
    const next = acquireHostStoragePool();
    try {
      await next.clients[0]!.call("mission-receipt:open", join(root, "c.sqlite"));
      await Promise.all(accepted);
      await closing;
      expect(workers.peak).toBeLessThanOrEqual(2);
    } finally {
      await next.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("finishes accepted reads before the last lease closes while a new lease is acquired", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-storage-close-"));
    const first = await createHostUsageStore({ databasePath: join(root, "one.sqlite") });
    const reads = Array.from({ length: 100 }, () => first.assertAvailable());
    const closing = first.close();
    const second = await createHostUsageStore({ databasePath: join(root, "two.sqlite") });
    try {
      await Promise.all(reads);
      await closing;
      await second.assertAvailable();
    } finally {
      await second.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
