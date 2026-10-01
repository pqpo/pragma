import { afterEach, describe, expect, it, vi } from "vitest";
import { PragmaPaths, type PragmaLogger, type StorageOverview } from "@pragma/core";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  createStorageCapacityInspection,
  inspectCapacityInWorker,
} from "./storage-capacity-inspection.ts";

const SIX_HOURS = 6 * 60 * 60_000;
const overview: StorageOverview = {
  totalBytes: 100,
  dataBytes: 100,
  stateBytes: 0,
  archiveBytes: 0,
  cacheBytes: 0,
  temporaryBytes: 0,
  trashBytes: 0,
  softLimitBytes: 50,
  hardLimitBytes: 80,
};
const monitors: ReturnType<typeof createStorageCapacityInspection>[] = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.close();
  vi.useRealTimers();
});
function fixture(
  inspect: (signal: AbortSignal) => Promise<StorageOverview> = vi.fn(async () => overview),
) {
  vi.useFakeTimers();
  let idle = false;
  const warn = vi.fn();
  const monitor = createStorageCapacityInspection({
    paths: new PragmaPaths({ pragmaHome: "/unused" }),
    logger: { warn, info: vi.fn() } as unknown as PragmaLogger,
    isIdle: () => idle,
    inspect,
  });
  monitors.push(monitor);
  return {
    monitor,
    inspect,
    warn,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}
describe("idle storage capacity inspection", () => {
  it("reads real capacity through the compiled worker and cancels it safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-idle-capacity-"));
    const paths = new PragmaPaths({ pragmaHome: root });
    const workerUrl = pathToFileURL(resolve("out/main/storage-capacity-worker.js"));
    try {
      await mkdir(paths.dataRoot(), { recursive: true });
      await writeFile(join(paths.dataRoot(), "sample"), "12345");
      const result = await inspectCapacityInWorker(paths, new AbortController().signal, workerUrl);
      expect(result.dataBytes).toBe(5);
      const controller = new AbortController();
      controller.abort();
      await expect(inspectCapacityInWorker(paths, controller.signal, workerUrl)).rejects.toThrow(
        "cancelled",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does no scan at startup or while the user is active", async () => {
    const { monitor, inspect, setIdle } = fixture();
    monitor.start();
    monitor.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(inspect).not.toHaveBeenCalled();
    setIdle(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it("delays idle startup and warns about excess capacity without blocking work", async () => {
    const { monitor, inspect, warn, setIdle } = fixture();
    setIdle(true);
    monitor.start();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(inspect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "storage.capacity_cleanup_recommended",
      expect.any(String),
      expect.objectContaining({ totalBytes: 100 }),
    );
    await vi.advanceTimersByTimeAsync(SIX_HOURS - 60_000);
    expect(inspect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inspect).toHaveBeenCalledTimes(2);
  });
  it("cancels an in-flight scan on activity and does not restart it frequently", async () => {
    let signal!: AbortSignal;
    const inspect = vi.fn((value: AbortSignal) => {
      signal = value;
      return new Promise<StorageOverview>(() => {});
    });
    const f = fixture(inspect);
    f.setIdle(true);
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    f.setIdle(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal.aborted).toBe(true);
    f.setIdle(true);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it("backs off after failure and stops scheduling on close", async () => {
    const f = fixture(
      vi.fn(async () => {
        throw new Error("disk unavailable");
      }),
    );
    f.setIdle(true);
    f.monitor.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.warn).toHaveBeenCalledWith(
      "storage.capacity_inspection_failed",
      expect.any(String),
      expect.any(Object),
    );
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f.inspect).toHaveBeenCalledTimes(1);
    f.monitor.close();
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    expect(f.inspect).toHaveBeenCalledTimes(1);
  });
});
