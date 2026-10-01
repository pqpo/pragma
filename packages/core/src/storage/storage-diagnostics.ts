import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, type FileHandle } from "node:fs/promises";
import type { PragmaLogger } from "../logging/logger.ts";

interface StorageMeasurements {
  reads: number;
  writes: number;
  readBytes: number;
  writtenBytes: number;
  parsedEntries: number;
  phases: Record<string, number>;
}
interface StorageSpan {
  readonly id: string;
  readonly parent?: StorageSpan | undefined;
  readonly logger: PragmaLogger;
  readonly requestId?: string | undefined;
  readonly measurements: StorageMeasurements;
  active: boolean;
}
const spans = new AsyncLocalStorage<StorageSpan>();

/** Opt-in diagnostics only. Detached work cannot charge a completed request. */
export async function withStorageDiagnostics<T>(
  fields: {
    readonly family: string;
    readonly ownerId: string;
    readonly operation: string;
    readonly requestId?: string | undefined;
  },
  action: () => Promise<T>,
  logger?: PragmaLogger,
): Promise<T> {
  const inherited = spans.getStore();
  const parent = inherited?.active ? inherited : undefined;
  const sink = logger ?? parent?.logger;
  if (process.env["PRAGMA_STORAGE_DIAGNOSTICS"] !== "1" || sink === undefined)
    return await action();
  const span: StorageSpan = {
    id: randomUUID(),
    parent,
    logger: sink,
    requestId: fields.requestId ?? parent?.requestId,
    active: true,
    measurements: {
      reads: 0,
      writes: 0,
      readBytes: 0,
      writtenBytes: 0,
      parsedEntries: 0,
      phases: {},
    },
  };
  const startedAt = performance.now();
  let failed = false;
  try {
    return await spans.run(span, action);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    span.active = false;
    // Diagnostic failures must never change durable operation results.
    try {
      sink.info("storage.operation_measured", "Storage operation measured", {
        ...fields,
        ...(span.requestId === undefined ? {} : { requestId: span.requestId }),
        spanId: span.id,
        ...(parent === undefined ? {} : { parentSpanId: parent.id }),
        startedAtMs: startedAt,
        elapsedMs: performance.now() - startedAt,
        failed,
        ...span.measurements,
      });
    } catch {
      /* Preserve the operation's result. */
    }
  }
}

export function recordStorageMeasurement(
  values: Partial<Omit<StorageMeasurements, "phases">>,
): void {
  for (let span = spans.getStore(); span !== undefined; span = span.parent) {
    if (!span.active) break;
    for (const key of ["reads", "writes", "readBytes", "writtenBytes", "parsedEntries"] as const) {
      span.measurements[key] += values[key] ?? 0;
    }
  }
}
export function recordStoragePhase(phase: string, durationMs: number): void {
  for (let span = spans.getStore(); span !== undefined; span = span.parent) {
    if (!span.active) break;
    span.measurements.phases[phase] = (span.measurements.phases[phase] ?? 0) + durationMs;
  }
}
export async function measureStoragePhase<T>(phase: string, action: () => Promise<T>): Promise<T> {
  if (!spans.getStore()?.active) return await action();
  const startedAt = performance.now();
  try {
    return await action();
  } finally {
    recordStoragePhase(phase, performance.now() - startedAt);
  }
}

export function measureStorageComputation<T>(phase: string, action: () => T): T {
  if (!spans.getStore()?.active) return action();
  const startedAt = performance.now();
  try {
    return action();
  } finally {
    recordStoragePhase(phase, performance.now() - startedAt);
  }
}

export const readStorageFile = (async (...args: Parameters<typeof readFile>) =>
  await measureStoragePhase("read", async () => {
    recordStorageMeasurement({ reads: 1 });
    const value = await readFile(...args);
    recordStorageMeasurement({
      readBytes: typeof value === "string" ? Buffer.byteLength(value) : value.byteLength,
    });
    return value;
  })) as typeof readFile;

export const writeStorageFile = (async (...args: Parameters<typeof writeFile>) =>
  await measureStoragePhase("write", async () => {
    const value = args[1];
    recordStorageMeasurement({
      writes: 1,
      writtenBytes:
        typeof value === "string"
          ? Buffer.byteLength(value)
          : ArrayBuffer.isView(value)
            ? value.byteLength
            : 0,
    });
    await writeFile(...args);
  })) as typeof writeFile;

export const replaceStorageFile = (async (...args: Parameters<typeof rename>) =>
  await measureStoragePhase("atomic_replace", async () => await rename(...args))) as typeof rename;

export function parseStorageJson(content: string): unknown {
  if (!spans.getStore()?.active) return JSON.parse(content) as unknown;
  const startedAt = performance.now();
  try {
    const value: unknown = JSON.parse(content);
    recordStorageMeasurement({ parsedEntries: Array.isArray(value) ? value.length : 1 });
    return value;
  } finally {
    recordStoragePhase("parse", performance.now() - startedAt);
  }
}

export async function writeStorageHandle(handle: FileHandle, content: string): Promise<void> {
  await measureStoragePhase("write", async () => {
    recordStorageMeasurement({ writes: 1, writtenBytes: Buffer.byteLength(content) });
    await handle.writeFile(content, "utf8");
  });
}

export function stringifyStorageJson(value: unknown, space?: number): string | undefined {
  if (!spans.getStore()?.active) return JSON.stringify(value, null, space);
  const startedAt = performance.now();
  try {
    return JSON.stringify(value, null, space);
  } finally {
    recordStoragePhase("serialize", performance.now() - startedAt);
  }
}
