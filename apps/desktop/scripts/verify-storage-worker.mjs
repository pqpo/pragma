import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "pragma-packaged-worker-"));
const worker = new Worker(new URL("../out/main/sqlite-execution-worker.js", import.meta.url));
try {
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Packaged storage worker did not reply.")),
      10_000,
    );
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("message", (message) => {
      clearTimeout(timer);
      if (!message.ok) reject(new Error(message.error?.message));
      else resolve(message.value);
    });
    worker.postMessage({
      requestId: 1,
      operation: "mission-receipt:open",
      executionId: join(home, "delivery.sqlite"),
      input: [],
    });
  });
  if (result?.value !== 0) throw new Error("Packaged worker returned an invalid receipt cursor.");
  console.log("Packaged Host storage worker starts and durably opens a receipt database.");
} finally {
  await worker.terminate();
  await rm(home, { recursive: true, force: true });
}
