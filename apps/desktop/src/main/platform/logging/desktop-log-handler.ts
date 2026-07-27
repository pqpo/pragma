import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import type { PragmaLogHandler, PragmaPaths } from "@pragma/core";
import type { PragmaLogRecord } from "@pragma/shared";

const gzipAsync = promisify(gzip);
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_ARCHIVE_BYTES = 256 * 1024 * 1024;
const DEFAULT_BUFFER_RECORDS = 2_000;
const DIAGNOSTIC_APPLICATION = "desktop";

export interface DesktopLogHandler extends PragmaLogHandler {
  readonly activate: () => Promise<void>;
  readonly flush: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export function createDesktopLogHandler(options: {
  readonly paths: PragmaPaths;
  readonly bootId: string;
  readonly maxFileBytes?: number | undefined;
  readonly maxArchiveBytes?: number | undefined;
  readonly maxBufferedRecords?: number | undefined;
  readonly operationRetentionDays?: number | undefined;
  readonly failureRetentionDays?: number | undefined;
  readonly now?: (() => Date) | undefined;
}): DesktopLogHandler {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_ARCHIVE_BYTES;
  const maxBufferedRecords = options.maxBufferedRecords ?? DEFAULT_BUFFER_RECORDS;
  assertPositiveInteger(maxFileBytes, "maxFileBytes");
  assertPositiveInteger(maxArchiveBytes, "maxArchiveBytes");
  assertPositiveInteger(maxBufferedRecords, "maxBufferedRecords");
  const now = options.now ?? (() => new Date());
  const activeFiles = new Map<string, { path: string; index: number }>();
  const buffered: PragmaLogRecord[] = [];
  const queue: PragmaLogRecord[] = [];
  let active = false;
  let closed = false;
  let draining: Promise<void> | undefined;
  const reportPersistenceFailure = createPersistenceFailureReporter();

  const enqueue = (record: PragmaLogRecord): void => {
    if (!appendPrioritized(queue, record, maxBufferedRecords)) return;
    draining ??= drainQueue().finally(() => {
      draining = undefined;
      if (queue.length > 0) enqueueDrain();
    });
  };
  const enqueueDrain = (): void => {
    draining ??= drainQueue().finally(() => {
      draining = undefined;
      if (queue.length > 0) enqueueDrain();
    });
  };
  const drainQueue = async (): Promise<void> => {
    while (queue.length > 0) {
      const record = queue.shift()!;
      try {
        await persistRecord({
          paths: options.paths,
          bootId: options.bootId,
          record,
          maxFileBytes,
          now: now(),
          activeFiles,
        });
      } catch (error) {
        reportPersistenceFailure(error);
      }
    }
  };
  const flush = async (): Promise<void> => {
    while (draining !== undefined || queue.length > 0) {
      if (draining === undefined) enqueueDrain();
      await draining;
    }
  };

  return {
    write(record) {
      if (closed) return;
      if (!active) {
        appendPrioritized(buffered, record, maxBufferedRecords);
        return;
      }
      enqueue(record);
    },
    async activate() {
      if (active || closed) return;
      await mkdir(options.paths.diagnosticApplicationRoot(DIAGNOSTIC_APPLICATION), {
        recursive: true,
        mode: 0o700,
      });
      active = true;
      for (const record of buffered.splice(0)) enqueue(record);
      await flush();
      await maintainArchive({
        root: options.paths.diagnosticApplicationRoot(DIAGNOSTIC_APPLICATION),
        operationRetentionDays: options.operationRetentionDays ?? 14,
        failureRetentionDays: options.failureRetentionDays ?? 30,
        maxArchiveBytes,
        now: now(),
      }).catch(reportPersistenceFailure);
    },
    async flush() {
      await flush();
    },
    async close() {
      if (closed) return;
      if (!active) {
        await this.activate().catch(reportPersistenceFailure);
      }
      closed = true;
      await flush();
      for (const file of activeFiles.values()) {
        await compressFile(file.path).catch(reportPersistenceFailure);
      }
    },
  };
}

async function persistRecord(options: {
  readonly paths: PragmaPaths;
  readonly bootId: string;
  readonly record: PragmaLogRecord;
  readonly maxFileBytes: number;
  readonly now: Date;
  readonly activeFiles: Map<string, { path: string; index: number }>;
}): Promise<void> {
  const date = options.now.toISOString().slice(0, 10);
  const root = options.paths.diagnosticBootRoot(DIAGNOSTIC_APPLICATION, date, options.bootId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const prefix = options.record.stream === "failure" ? "errors" : "operations";
  const key = `${date}:${prefix}`;
  let active = options.activeFiles.get(key) ?? {
    path:
      options.record.stream === "failure"
        ? options.paths.diagnosticFailureLog(DIAGNOSTIC_APPLICATION, date, options.bootId, 1)
        : options.paths.diagnosticOperationLog(DIAGNOSTIC_APPLICATION, date, options.bootId, 1),
    index: 1,
  };
  const line = `${JSON.stringify(options.record)}\n`;
  const currentBytes = await fileSize(active.path);
  if (currentBytes > 0 && currentBytes + Buffer.byteLength(line) > options.maxFileBytes) {
    await compressFile(active.path);
    const nextIndex = active.index + 1;
    active = {
      index: nextIndex,
      path:
        options.record.stream === "failure"
          ? options.paths.diagnosticFailureLog(
              DIAGNOSTIC_APPLICATION,
              date,
              options.bootId,
              nextIndex,
            )
          : options.paths.diagnosticOperationLog(
              DIAGNOSTIC_APPLICATION,
              date,
              options.bootId,
              nextIndex,
            ),
    };
  }
  options.activeFiles.set(key, active);
  await appendFile(active.path, line, { encoding: "utf8", mode: 0o600 });
}

async function maintainArchive(options: {
  readonly root: string;
  readonly operationRetentionDays: number;
  readonly failureRetentionDays: number;
  readonly maxArchiveBytes: number;
  readonly now: Date;
}): Promise<void> {
  const files = await listFiles(options.root);
  const retained: { path: string; bytes: number; mtimeMs: number; failure: boolean }[] = [];
  for (const path of files) {
    const details = await stat(path);
    const failure = basename(path).startsWith("errors-");
    const retentionDays = failure ? options.failureRetentionDays : options.operationRetentionDays;
    if (details.mtimeMs < options.now.getTime() - retentionDays * 86_400_000) {
      await unlink(path);
    } else {
      retained.push({ path, bytes: details.size, mtimeMs: details.mtimeMs, failure });
    }
  }
  let total = retained.reduce((sum, file) => sum + file.bytes, 0);
  for (const file of retained.toSorted(
    (left, right) => Number(left.failure) - Number(right.failure) || left.mtimeMs - right.mtimeMs,
  )) {
    if (total <= options.maxArchiveBytes) break;
    await unlink(file.path);
    total -= file.bytes;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function fileSize(path: string): Promise<number> {
  return await stat(path)
    .then((value) => value.size)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
}

async function compressFile(path: string): Promise<void> {
  if ((await fileSize(path)) === 0) return;
  const compressed = await gzipAsync(await readFile(path));
  let created = true;
  await writeFile(`${path}.gz`, compressed, { mode: 0o600, flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      created = false;
    },
  );
  if (created) await unlink(path);
}

function appendPrioritized(
  records: PragmaLogRecord[],
  record: PragmaLogRecord,
  capacity: number,
): boolean {
  if (records.length >= capacity) {
    const operationIndex = records.findIndex((item) => item.stream === "operation");
    if (operationIndex >= 0) records.splice(operationIndex, 1);
    else if (record.stream === "operation") return false;
    else records.shift();
  }
  records.push(record);
  return true;
}

function createPersistenceFailureReporter(): (error: unknown) => void {
  let reported = false;
  return (error) => {
    if (reported) return;
    reported = true;
    try {
      console.error(
        JSON.stringify({
          level: "error",
          component: "desktop.logging",
          event: "log_persistence_failed",
          message: safeErrorMessage(error),
        }),
      );
    } catch {
      // Persistence failure reporting must not interfere with the caller.
    }
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function safeErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "[UNSERIALIZABLE]";
  }
}
