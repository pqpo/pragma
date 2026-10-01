import { Worker } from "node:worker_threads";
import { DesktopStorageCleanupOverviewSchema } from "../../../shared/contracts/storage-cleanup.ts";
import type { PragmaLogger, PragmaPaths, StorageOverview } from "@pragma/core";

const STARTUP_DELAY_MS = 5 * 60_000;
const CHECK_INTERVAL_MS = 60_000;
const INSPECTION_INTERVAL_MS = 6 * 60 * 60_000;

export function inspectCapacityInWorker(
  paths: PragmaPaths,
  signal: AbortSignal,
  workerUrl = new URL("./storage-capacity-worker.js", import.meta.url),
): Promise<StorageOverview> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { pragmaHome: paths.root },
    });
    const finish = (error?: unknown, overview?: StorageOverview) => {
      signal.removeEventListener("abort", abort);
      worker.removeAllListeners();
      void worker.terminate();
      if (overview !== undefined) resolve(overview);
      else reject(error);
    };
    const abort = () => finish(new Error("Storage inspection cancelled."));
    worker.once("message", (message: unknown) => {
      const parsed = DesktopStorageCleanupOverviewSchema.shape.storage.safeParse(message);
      if (parsed.success) finish(undefined, parsed.data);
      else finish(parsed.error);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => finish(new Error(`Storage inspection worker exited (${code}).`)));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Idle statistics only. No write gate, automatic deletion, or per-request disk work. */
export function createStorageCapacityInspection(input: {
  readonly paths: PragmaPaths;
  readonly logger: PragmaLogger;
  readonly isIdle: () => boolean;
  readonly inspect?: (signal: AbortSignal) => Promise<StorageOverview>;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: AbortController | undefined;
  let nextAt = 0;
  let closed = false;
  const tick = () => {
    if (!input.isIdle()) {
      active?.abort();
      return;
    }
    if (active !== undefined || Date.now() < nextAt) return;
    nextAt = Date.now() + INSPECTION_INTERVAL_MS;
    const controller = new AbortController();
    active = controller;
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
    timeout.unref();
    void (
      input.inspect?.(controller.signal) ?? inspectCapacityInWorker(input.paths, controller.signal)
    )
      .then((overview) => {
        if (closed || controller.signal.aborted) return;
        if (overview.totalBytes >= overview.softLimitBytes)
          input.logger.warn(
            "storage.capacity_cleanup_recommended",
            "Local storage is large. Use Settings to clean up storage; Missions remain available.",
            { ...overview },
          );
        else
          input.logger.info("storage.capacity_inspected", "Idle storage inspection completed", {
            ...overview,
          });
      })
      .catch((error: unknown) => {
        if (!closed && !controller.signal.aborted)
          input.logger.warn(
            "storage.capacity_inspection_failed",
            "Idle storage inspection failed; Missions remain available.",
            { error },
          );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (active === controller) active = undefined;
      });
  };
  return {
    start() {
      if (closed || timer !== undefined) return;
      nextAt = Date.now() + STARTUP_DELAY_MS;
      timer = setInterval(tick, CHECK_INTERVAL_MS);
      timer.unref();
    },
    cancel() {
      active?.abort();
    },
    close() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      active?.abort();
    },
  };
}
