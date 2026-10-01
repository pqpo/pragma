import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createLoggerProvider } from "../src/logging/logger.ts";
import { withFileLock } from "../src/storage/file-lock.ts";
import {
  withStorageDiagnostics,
  readStorageFile,
  writeStorageFile,
  parseStorageJson,
} from "../src/storage/storage-diagnostics.ts";

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

it("records local lock waiting even when acquisition times out", async () => {
  vi.stubEnv("PRAGMA_STORAGE_DIAGNOSTICS", "1");
  const home = await mkdtemp(join(tmpdir(), "pragma-diagnostic-timeout-"));
  homes.push(home);
  const write = vi.fn();
  const logger = createLoggerProvider({ handler: { write } }).createLogger({ component: "test" });
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = join(home, "lock");
  const holder = withFileLock(lock, async () => {
    enter();
    await held;
  });
  await entered;
  try {
    await expect(
      withStorageDiagnostics(
        { family: "test", ownerId: "owner", operation: "timeout" },
        () => withFileLock(lock, async () => undefined, { timeoutMs: 20 }),
        logger,
      ),
    ).rejects.toMatchObject({ code: "pragma_file_lock_timeout" });
    const attributes = write.mock.calls[0]?.[0].attributes;
    expect(attributes.failed).toBe(true);
    expect(attributes.phases.lock_local_wait).toBeGreaterThan(0);
  } finally {
    release();
    await holder;
  }
});

it("records cross-process lock waiting on contention timeout without entering the operation", async () => {
  vi.stubEnv("PRAGMA_STORAGE_DIAGNOSTICS", "1");
  const home = await mkdtemp(join(tmpdir(), "pragma-diagnostic-cross-timeout-"));
  homes.push(home);
  const lock = join(home, "lock");
  await mkdir(lock);
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({
      version: 1,
      ownerToken: "foreign-owner",
      processId: process.ppid,
      processStartedAt: Date.now(),
      acquiredAt: Date.now(),
    }),
  );
  const write = vi.fn();
  const operation = vi.fn(async () => undefined);
  const logger = createLoggerProvider({ handler: { write } }).createLogger({ component: "test" });
  await expect(
    withStorageDiagnostics(
      { family: "test", ownerId: "owner", operation: "timeout" },
      () => withFileLock(lock, operation, { timeoutMs: 20 }),
      logger,
    ),
  ).rejects.toMatchObject({ code: "pragma_file_lock_timeout", contention: "active" });
  expect(operation).not.toHaveBeenCalled();
  const attributes = write.mock.calls[0]?.[0].attributes;
  expect(attributes.failed).toBe(true);
  expect(attributes.phases.lock_cross_process_wait).toBeGreaterThan(0);
});

it("measures physical I/O and both lock waits without exposing file paths or contents", async () => {
  vi.stubEnv("PRAGMA_STORAGE_DIAGNOSTICS", "1");
  const home = await mkdtemp(join(tmpdir(), "pragma-diagnostic-"));
  homes.push(home);
  const write = vi.fn();
  const logger = createLoggerProvider({ handler: { write } }).createLogger({ component: "test" });
  await withStorageDiagnostics(
    { family: "test", ownerId: "owner", operation: "read-write" },
    () =>
      withFileLock(join(home, "lock"), async () => {
        await writeStorageFile(join(home, "private-file"), '["private-content"]', "utf8");
        expect(parseStorageJson(await readStorageFile(join(home, "private-file"), "utf8"))).toEqual(
          ["private-content"],
        );
      }),
    logger,
  );
  const attributes = write.mock.calls[0]?.[0].attributes;
  expect(attributes).toMatchObject({
    reads: expect.any(Number),
    writes: expect.any(Number),
    readBytes: expect.any(Number),
    writtenBytes: expect.any(Number),
    parsedEntries: 1,
  });
  expect(attributes.reads).toBeGreaterThanOrEqual(1);
  expect(attributes.writes).toBeGreaterThanOrEqual(2);
  expect(attributes.readBytes).toBeGreaterThanOrEqual(19);
  expect(attributes.writtenBytes).toBeGreaterThan(19);
  expect(attributes.phases).toHaveProperty("lock_local_wait");
  expect(attributes.phases).toHaveProperty("lock_cross_process_wait");
  expect(JSON.stringify(write.mock.calls)).not.toContain(home);
  expect(JSON.stringify(write.mock.calls)).not.toContain("private-content");
});

it("does not charge detached work after its parent completes or let reporting failures change results", async () => {
  vi.stubEnv("PRAGMA_STORAGE_DIAGNOSTICS", "1");
  const home = await mkdtemp(join(tmpdir(), "pragma-diagnostic-detached-"));
  homes.push(home);
  const write = vi.fn();
  const logger = createLoggerProvider({ handler: { write } }).createLogger({ component: "test" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let background!: Promise<void>;
  await withStorageDiagnostics(
    { family: "request", ownerId: "owner", operation: "admission" },
    async () => {
      background = gate.then(() =>
        withStorageDiagnostics(
          { family: "execution", ownerId: "owner", operation: "background" },
          () => writeStorageFile(join(home, "file"), "data", "utf8"),
          logger,
        ),
      );
    },
    logger,
  );
  release();
  await background;
  expect(write.mock.calls[0]?.[0].attributes).toMatchObject({ writes: 0 });
  expect(write.mock.calls[1]?.[0].attributes).toMatchObject({ writes: 1 });
  expect(write.mock.calls[1]?.[0].attributes.parentSpanId).toBeUndefined();
  await expect(
    withStorageDiagnostics(
      { family: "test", ownerId: "owner", operation: "success" },
      async () => 42,
      {
        ...logger,
        info: () => {
          throw new Error("logger failure");
        },
      },
    ),
  ).resolves.toBe(42);
});

it("does not propagate detached I/O through a finished child into a still-active request", async () => {
  vi.stubEnv("PRAGMA_STORAGE_DIAGNOSTICS", "1");
  const home = await mkdtemp(join(tmpdir(), "pragma-diagnostic-boundary-"));
  homes.push(home);
  const write = vi.fn();
  const logger = createLoggerProvider({ handler: { write } }).createLogger({ component: "test" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let background!: Promise<void>;
  await withStorageDiagnostics(
    { family: "request", ownerId: "owner", operation: "outer" },
    async () => {
      await withStorageDiagnostics(
        { family: "store", ownerId: "owner", operation: "finished-child" },
        async () => {
          background = gate.then(() => writeStorageFile(join(home, "file"), "data", "utf8"));
        },
      );
      release();
      await background;
    },
    logger,
  );
  expect(write.mock.calls.map(([record]) => record.attributes.writes)).toEqual([0, 0]);
});
