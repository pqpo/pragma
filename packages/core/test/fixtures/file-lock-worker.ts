import { parentPort, workerData } from "node:worker_threads";

const { lockDir, clockOffsetMs } = workerData as { lockDir: string; clockOffsetMs: number };
const originalNow = Date.now;
// Separate isolates estimate process start independently. Make that uncertainty
// deterministic without changing PID, filesystem metadata or the lock owner.
Date.now = () => originalNow() + clockOffsetMs;
const { withFileLock } = await import("../../src/storage/file-lock.ts");
Date.now = originalNow;
await withFileLock(
  lockDir,
  async () => {
    parentPort!.postMessage("locked");
    await new Promise<void>((resolve) => parentPort!.once("message", () => resolve()));
  },
  { staleMs: 30 },
);
parentPort!.close();
