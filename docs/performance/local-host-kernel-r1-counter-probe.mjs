import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { cpus } from "node:os";

const sourcePath = process.argv[2];
const { createRuntimeTokenCounter } = await import(pathToFileURL(sourcePath));
const counter = createRuntimeTokenCounter();
await counter.load();
const ordinary = "Ordinary text with short words and Unicode whitespace.\u3000"
  .repeat(2500)
  .slice(0, 128000);
counter.countText(ordinary);
const ordinarySamples = [];
for (let sample = 0; sample < 20; sample++) {
  const start = performance.now();
  const result = counter.countText(ordinary);
  ordinarySamples.push({ elapsedMs: performance.now() - start, ...result });
}
const oversized = "x".repeat(200001);
const scheduledAt = performance.now();
let timerElapsedMs;
const timer = new Promise((resolve) =>
  setTimeout(() => {
    timerElapsedMs = performance.now() - scheduledAt;
    resolve();
  }, 0),
);
const start = performance.now();
const result = counter.countText(oversized);
const elapsedMs = performance.now() - start;
await timer;
counter.dispose();
console.log(
  JSON.stringify({
    capturedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpu: cpus()[0]?.model,
    sourcePath,
    sourceSha256: createHash("sha256")
      .update(await readFile(sourcePath))
      .digest("hex"),
    tokenizer: "gpt-tokenizer/encoding/o200k_base",
    tokenizerLoaded: true,
    ordinary: { characters: ordinary.length, samples: ordinarySamples },
    oversized: { characters: oversized.length, elapsedMs, timerElapsedMs, ...result },
  }),
);
