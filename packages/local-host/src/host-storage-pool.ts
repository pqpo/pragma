import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { ExecutionVersionConflictError, ExecutionFinalStatusConflictError } from "@pragma/core";

const MAX_RETAINED_REQUESTS = 128;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
function requestBytes(value: unknown): number {
  const seen = new WeakSet<object>();
  function* fields(current: object): Generator<unknown> {
    if (current instanceof Map) {
      for (const [key, item] of current) {
        yield key;
        yield item;
      }
      return;
    }
    if (current instanceof Set) {
      yield* current;
      return;
    }
    if (Array.isArray(current)) {
      yield* current;
      return;
    }
    for (const key in current)
      if (Object.hasOwn(current, key)) {
        yield key;
        yield (current as Record<string, unknown>)[key];
      }
  }
  const stack: Iterator<unknown>[] = [[value].values()];
  let bytes = 0;
  let visited = 0;
  while (stack.length > 0 && bytes <= MAX_RETAINED_BYTES) {
    const next = stack.at(-1)!.next();
    if (next.done) {
      stack.pop();
      continue;
    }
    if (++visited > 131_072 || stack.length > 1024) return MAX_RETAINED_BYTES + 1;
    const current = next.value;
    if (typeof current === "string") {
      bytes += Buffer.byteLength(current);
      continue;
    }
    if (current === null || typeof current !== "object") {
      bytes += 16;
      continue;
    }
    if (seen.has(current)) continue;
    seen.add(current);
    bytes += 32;
    if (ArrayBuffer.isView(current)) {
      bytes += current.byteLength;
      continue;
    }
    stack.push(fields(current));
  }
  return bytes;
}
function backpressure(): Error {
  return Object.assign(
    new Error("Host storage request capacity exceeded; durable producers must retry."),
    { code: "HOST_STORAGE_BACKPRESSURE" },
  );
}

interface Response {
  requestId: number;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; code?: unknown; stack?: string };
}
interface WorkerClient {
  isIdle(): boolean;
  canAssist(): boolean;
  load(): number;
  generation(): number;
  call<T>(
    operation: string,
    executionId: string,
    input?: unknown,
    canonical?: boolean,
    pragmaHome?: string,
    byteCost?: number,
  ): Promise<T>;
  close(): Promise<void>;
}
function client(): WorkerClient {
  let worker: Worker | undefined;
  let nextId = 0;
  let generation = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const calls = new Set<Promise<unknown>>();
  let backgroundCalls = 0;
  let retainedBytes = 0;
  let failure: Error | undefined;
  let closeOperation: Promise<void> | undefined;
  const slots = new Set<() => void>();
  const start = (): Worker => {
    if (worker !== undefined) return worker;
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const packaged = new URL(`./sqlite-execution-worker.${extension}`, import.meta.url);
    const moduleWorker = new URL(
      `./execution/sqlite-execution-worker.${extension}`,
      import.meta.url,
    );
    // Desktop bundles the Host entry and workers into one output directory; Node preserves subdirectories.
    const url = existsSync(moduleWorker) ? moduleWorker : packaged;
    generation++;
    worker = new Worker(url, {
      ...(extension === "ts" ? { execArgv: [...process.execArgv, "--import", "tsx"] } : {}),
    });
    const activeWorker = worker;
    const fail = (error: Error) => {
      if (worker !== activeWorker) return;
      if (failure === undefined) generation++;
      Object.assign(error, { code: "HOST_STORAGE_WORKER_UNAVAILABLE" });
      failure = error;
      for (const item of pending.values()) item.reject(error);
      pending.clear();
      for (const release of slots) release();
      slots.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => {
      fail(new Error(`Execution storage worker exited (${code}).`));
    });
    worker.on("message", (message: Response) => {
      const item = pending.get(message.requestId);
      if (item === undefined) return;
      pending.delete(message.requestId);
      const release = slots.values().next().value;
      if (release !== undefined) {
        slots.delete(release);
        release();
      }
      if (message.ok) item.resolve(message.value);
      else {
        const serialized = message.error!;
        let error: Error;
        if (serialized.name === "ExecutionVersionConflictError") {
          const match = /expected (\d+), received (\d+)/.exec(serialized.message);
          error = new ExecutionVersionConflictError(Number(match?.[1]), Number(match?.[2]));
        } else if (serialized.name === "ExecutionFinalStatusConflictError") {
          error = new ExecutionFinalStatusConflictError("Execution", "terminal", "different");
          error.message = serialized.message;
        } else {
          error = new Error(serialized.message);
          error.name = serialized.name;
        }
        if (serialized.code !== undefined) Object.assign(error, { code: serialized.code });
        if (serialized.stack !== undefined) error.stack = serialized.stack;
        item.reject(error);
      }
      if (pending.size === 0) worker?.unref();
    });
    worker.unref();
    return worker;
  };
  return {
    isIdle: () => pending.size === 0 && closeOperation === undefined && failure === undefined,
    canAssist: () =>
      backgroundCalls === 0 &&
      retainedBytes <= MAX_RETAINED_BYTES &&
      closeOperation === undefined &&
      failure === undefined,
    load: () => calls.size + (closeOperation === undefined ? 0 : MAX_RETAINED_REQUESTS),
    generation: () => generation,
    call<T>(
      operation: string,
      executionId: string,
      input?: unknown,
      canonical?: boolean,
      pragmaHome?: string,
      byteCost?: number,
    ): Promise<T> {
      const bytes = byteCost ?? requestBytes(input);
      if (
        operation !== "close" &&
        (calls.size >= MAX_RETAINED_REQUESTS ||
          (retainedBytes + bytes > MAX_RETAINED_BYTES && calls.size > 0))
      )
        return Promise.reject(backpressure());
      retainedBytes += bytes;
      const background =
        operation.startsWith("usage") ||
        [
          "prepare-owner",
          "deleted-usage-source",
          "outbox",
          "archive",
          "mission-receipt:stagePage",
          "mission-receipt:inspect",
        ].includes(operation);
      // ID-only acknowledgements yield to foreground requests in the worker.
      // They must not reserve the whole lane while queued. Outbox reads can
      // contain large facts, so they retain the background isolation barrier.
      if (background) backgroundCalls++;
      const task = (async () => {
        if (operation !== "close" && closeOperation !== undefined) await closeOperation;
        while (pending.size >= 64) {
          await new Promise<void>((resolve) => slots.add(resolve));
          if (failure !== undefined) throw failure;
        }
        if (failure !== undefined) {
          const failed = worker;
          if (failed !== undefined) await failed.terminate();
          if (worker === failed) {
            worker = undefined;
            failure = undefined;
          }
        }
        const active = start();
        active.ref();
        const requestId = ++nextId;
        return await new Promise<T>((resolve, reject) => {
          pending.set(requestId, { resolve: (value) => resolve(value as T), reject });
          try {
            active.postMessage({ requestId, operation, executionId, input, canonical, pragmaHome });
          } catch (error) {
            pending.delete(requestId);
            const release = slots.values().next().value;
            if (release !== undefined) {
              slots.delete(release);
              release();
            }
            if (pending.size === 0) active.unref();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      })();
      calls.add(task);
      const finished = () => {
        calls.delete(task);
        retainedBytes -= bytes;
        if (background) backgroundCalls--;
      };
      void task.then(finished, finished);
      return task;
    },
    close() {
      if (closeOperation !== undefined) return closeOperation;
      if (worker === undefined) return Promise.resolve();
      let active = worker;
      const accepted = [...calls];
      const operation = (async () => {
        try {
          await Promise.allSettled(accepted);
          active = worker ?? active;
          if (failure === undefined) await this.call("close", "");
        } finally {
          await active.terminate();
          worker = undefined;
          failure = undefined;
        }
      })().finally(() => {
        if (closeOperation === operation) closeOperation = undefined;
      });
      closeOperation = operation;
      return operation;
    },
  };
}

let workerPool:
  | {
      clients: WorkerClient[];
      references: number;
      preparations: Map<string, Promise<boolean>>;
      owners: Map<string, Promise<unknown>>;
      ownerRequests: number;
      ownerBytes: number;
      oversizedOwners: number;
      deliveryRequests: number;
      deliveryBytes: number;
    }
  | undefined;

export function acquireHostStoragePool() {
  const pool = (workerPool ??= {
    clients: [client(), client()],
    references: 0,
    preparations: new Map(),
    owners: new Map(),
    ownerRequests: 0,
    ownerBytes: 0,
    oversizedOwners: 0,
    deliveryRequests: 0,
    deliveryBytes: 0,
  });
  pool.references++;
  let released = false;
  return {
    clients: pool.clients,
    execute<T>(
      operation: string,
      id: string,
      input: unknown,
      canonical: boolean,
      root: string,
    ): Promise<T> {
      const bytes = requestBytes(input);
      const oversized = bytes > MAX_RETAINED_BYTES;
      const delivery = operation === "outbox" || operation === "ack";
      if (
        delivery
          ? pool.deliveryRequests >= 64 || pool.deliveryBytes + bytes > 8 * 1024 * 1024
          : pool.ownerRequests >= MAX_RETAINED_REQUESTS ||
            (oversized ? pool.oversizedOwners > 0 : pool.ownerBytes + bytes > MAX_RETAINED_BYTES)
      )
        return Promise.reject(backpressure());
      if (delivery) {
        pool.deliveryRequests++;
        pool.deliveryBytes += bytes;
      } else {
        pool.ownerRequests++;
        pool.ownerBytes += oversized ? 0 : bytes;
        if (oversized) pool.oversizedOwners++;
      }
      // Delivery reads and event-ID acknowledgements have their own sequence.
      // Their SQL/CAS and canonical deletion fence protect custody; they must
      // never become a prerequisite of this owner's next necessary commit.
      const key = JSON.stringify([root, id, delivery ? "delivery" : "control"]);
      const previous = pool.owners.get(key);
      const perform = () => {
        const target =
          oversized ||
          ["outbox", "ack", "archive"].includes(operation) ||
          (pool.preparations.size === 0 &&
            pool.clients[1]!.canAssist() &&
            (pool.clients[1]!.isIdle() || pool.clients[1]!.load() < pool.clients[0]!.load()))
            ? pool.clients[1]!
            : pool.clients[0]!;
        return target.call<T>(operation, id, input, canonical, root, bytes);
      };
      const pending = (
        previous === undefined ? perform() : previous.catch(() => undefined).then(perform)
      ).finally(() => {
        if (delivery) {
          pool.deliveryRequests--;
          pool.deliveryBytes -= bytes;
        } else {
          pool.ownerRequests--;
          pool.ownerBytes -= oversized ? 0 : bytes;
          if (oversized) pool.oversizedOwners--;
        }
        if (pool.owners.get(key) === pending) pool.owners.delete(key);
      });
      pool.owners.set(key, pending);
      return pending;
    },
    prepare(pragmaHome: string, executionId: string): Promise<boolean> {
      const key = JSON.stringify([pragmaHome, executionId]);
      const existing = pool.preparations.get(key);
      if (existing !== undefined) return existing;
      const operation = pool.clients[1]!.call<boolean>(
        "prepare-owner",
        executionId,
        undefined,
        false,
        pragmaHome,
      ).finally(() => {
        if (pool.preparations.get(key) === operation) pool.preparations.delete(key);
      });
      pool.preparations.set(key, operation);
      return operation;
    },
    async close() {
      if (released) return;
      released = true;
      if (--pool.references === 0) {
        await Promise.all(pool.clients.map((client) => client.close()));
      }
    },
  };
}
