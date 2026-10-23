import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths } from "@pragma/core";
import { afterEach, expect, it, vi } from "vitest";
import { createEpisodicMemoryStore } from "../src/episodic/store.ts";
import { createEpisodicMemoryModule } from "../src/episodic/module.ts";
import { migrateEpisodicDataV5ToV6 } from "../src/storage/migrations/episodic-data/steps/v5-to-v6.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function historical() {
  const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-learning-notifications-"));
  roots.push(pragmaHome);
  const dir = new PragmaPaths({ pragmaHome }).memoryModuleDataRoot("pragma.memory.episodic");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "episodes.sqlite");
  await copyFile(new URL("./fixtures/episodic-data-v5.sqlite", import.meta.url), path);
  return { pragmaHome, path };
}

it("upgrades a real v5 writer database and preserves records and a recoverable source notification", async () => {
  const f = await historical();
  let store = await createEpisodicMemoryStore(f);
  const records = await store.list();
  expect(records).toHaveLength(1);
  const first = await store.readLearningNotification();
  expect(first).toMatchObject({ learningEligible: true, rootRef: records[0]!.rootRefs[0] });
  store.close();
  store = await createEpisodicMemoryStore(f);
  try {
    expect(await store.readLearningNotification()).toEqual(first);
    expect(await store.list()).toEqual(records);
    const db = new DatabaseSync(f.path);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    } finally {
      db.close();
    }
    expect((await stat(`${f.path}.v5.backup`)).isFile()).toBe(true);
  } finally {
    store.close();
  }
});

it("does not acknowledge a newer update, including after another consumer deletes and recreates the notification", async () => {
  const f = await historical();
  const store = await createEpisodicMemoryStore(f);
  const db = new DatabaseSync(f.path);
  try {
    const first = (await store.readLearningNotification())!;
    await store.acknowledgeLearningNotification(first);
    db.exec("UPDATE episodes SET updated_at='2026-08-03T00:00:00.000Z'");
    await store.acknowledgeLearningNotification(first);
    const second = (await store.readLearningNotification())!;
    expect(second.generation).toBeGreaterThan(first.generation);
    db.exec("UPDATE episodes SET updated_at='2026-08-04T00:00:00.000Z'");
    await store.acknowledgeLearningNotification(second);
    expect((await store.readLearningNotification())!.generation).toBeGreaterThan(second.generation);
  } finally {
    db.close();
    store.close();
  }
});

it("replays a failed source notification after restart without extracting the Episode again", async () => {
  const f = await historical();
  const notify = vi.fn(async () => {
    throw new Error("learning scheduler unavailable");
  });
  let module = await createEpisodicMemoryModule({ ...f, onProjectionChanged: notify });
  await expect(module.runMaintenanceOnce?.()).rejects.toThrow(
    "memory_learning_notification_delivery_failed",
  );
  expect(await module.store.readLearningNotification()).toBeDefined();
  module.close();
  const replay = vi.fn(async () => undefined);
  module = await createEpisodicMemoryModule({ ...f, onProjectionChanged: replay });
  try {
    await module.runMaintenanceOnce?.();
    expect(replay).toHaveBeenCalledOnce();
    expect(await module.store.readLearningNotification()).toBeUndefined();
  } finally {
    module.close();
  }
});

it("preserves captured learning denial when backfilling old Episode notifications", async () => {
  const f = await historical();
  const db = new DatabaseSync(f.path);
  db.exec(
    "UPDATE episode_evidence SET envelope_json=json_set(envelope_json,'$.policySnapshot.learning','disabled')",
  );
  db.close();
  const notify = vi.fn(async () => undefined);
  const module = await createEpisodicMemoryModule({ ...f, onProjectionChanged: notify });
  try {
    await module.runMaintenanceOnce?.();
    expect(notify).toHaveBeenCalledOnce(); // V6 pending roots are rescanned without granting source permission.
    expect(await module.store.list()).toHaveLength(1);
    expect(await module.store.listForLearning()).toEqual([]);
    expect(await module.store.readLearningNotification()).toBeUndefined();
  } finally {
    module.close();
  }
});

it("rolls back an interrupted adjacent upgrade and can retry it without losing the v5 source", async () => {
  const f = await historical();
  const db = new DatabaseSync(f.path);
  const original = db.exec.bind(db);
  const exec = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql.includes("PRAGMA user_version=6")) throw new Error("interrupted migration");
    return original(sql);
  });
  try {
    expect(() => migrateEpisodicDataV5ToV6(db)).toThrow("interrupted migration");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM episodes").get()).toEqual({ count: 1 });
    exec.mockRestore();
    migrateEpisodicDataV5ToV6(db);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  } finally {
    exec.mockRestore();
    db.close();
  }
});

it("upgrades a historical Semantic governance notification and wakes learning after invalidation", async () => {
  const f = await historical();
  const dir = new PragmaPaths(f).memoryModuleDataRoot("pragma.memory.semantic");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "facts.sqlite");
  await copyFile(new URL("./fixtures/semantic-data-v6.sqlite", import.meta.url), path);
  const { createSemanticMemoryModule } = await import("../src/semantic/module.ts");
  const notify = vi.fn(async () => undefined);
  const module = await createSemanticMemoryModule({ ...f, onProjectionChanged: notify });
  try {
    const before = await module.store.list();
    expect(before[0]!.status).toBe("invalidated");
    expect(await module.store.listForLearning()).toHaveLength(1);
    await module.runMaintenanceOnce?.();
    expect(notify).toHaveBeenCalledOnce();
    expect(await module.store.list()).toEqual(before);
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
      db.exec(
        "UPDATE evidence SET envelope_json=json_set(envelope_json,'$.policySnapshot.learning','disabled')",
      );
      expect(await module.store.listForLearning()).toEqual([]);
    } finally {
      db.close();
    }
    expect((await stat(`${path}.v6.backup`)).isFile()).toBe(true);
  } finally {
    module.close();
  }
});

it("upgrades real v6 notifications, preserves CAS generations and wakes after forget without the forgotten source", async () => {
  const f = await historical();
  await copyFile(new URL("./fixtures/episodic-data-v6.sqlite", import.meta.url), f.path);
  const historicalDb = new DatabaseSync(f.path, { readOnly: true });
  const before = historicalDb
    .prepare("SELECT root_ref_json AS root, generation FROM learning_notifications LIMIT 1")
    .get() as { root: string; generation: number };
  historicalDb.close();
  const notify = vi.fn(async () => undefined);
  const module = await createEpisodicMemoryModule({ ...f, onProjectionChanged: notify });
  try {
    const record = (await module.store.list())[0]!;
    const upgraded = (await module.store.readLearningNotification())!;
    expect(upgraded.sourceChanged).toBe(true);
    expect(upgraded.generation).toBeGreaterThan(before.generation);
    await module.store.acknowledgeLearningNotification({
      rootRef: JSON.parse(before.root),
      generation: before.generation,
    });
    expect(await module.store.readLearningNotification()).toEqual(upgraded);
    await module.runMaintenanceOnce?.();
    await module.store.forget({
      id: record.id,
      expectedRevision: record.revision,
      actorRef: record.rootRefs[0]!,
      reason: "Forget test source",
      now: new Date(),
    });
    const deleted = (await module.store.readLearningNotification())!;
    expect(deleted).toMatchObject({ sourceChanged: true, learningEligible: false });
    expect(deleted.generation).toBeGreaterThan(upgraded.generation);
    await module.store.acknowledgeLearningNotification(upgraded);
    expect(await module.store.readLearningNotification()).toEqual(deleted);
    await module.runMaintenanceOnce?.();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(await module.store.listForLearning()).toEqual([]);
    expect(await module.store.readLearningNotification()).toBeUndefined();
    expect((await stat(`${f.path}.v6.backup`)).isFile()).toBe(true);
  } finally {
    module.close();
  }
});

it("rolls back an interrupted v6→v7 notification upgrade and rejects future versions", async () => {
  const f = await historical();
  await copyFile(new URL("./fixtures/episodic-data-v6.sqlite", import.meta.url), f.path);
  const { migrateEpisodicDataV6ToV7 } =
    await import("../src/storage/migrations/episodic-data/steps/v6-to-v7.ts");
  const db = new DatabaseSync(f.path);
  const exec = db.exec.bind(db);
  const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql.includes("PRAGMA user_version=7")) throw new Error("interrupted");
    return exec(sql);
  });
  try {
    expect(() => migrateEpisodicDataV6ToV7(db)).toThrow("interrupted");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM episodes").get()).toEqual({ count: 1 });
    spy.mockRestore();
    migrateEpisodicDataV6ToV7(db);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    db.exec("PRAGMA user_version=8");
  } finally {
    spy.mockRestore();
    db.close();
  }
  await expect(createEpisodicMemoryStore(f)).rejects.toThrow("unsupported-state-version");
});
