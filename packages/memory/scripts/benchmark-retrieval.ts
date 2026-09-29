import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createMemoryVectorIndex } from "../src/retrieval/vector-index.ts";

const root = await mkdtemp(join(tmpdir(), "pragma-retrieval-benchmark-"));
const dimensions = Number(process.argv[2] ?? 256);
if (!Number.isInteger(dimensions) || dimensions < 2 || dimensions > 16384)
  throw new Error("Invalid benchmark dimensions");
const profile = {
  fingerprint: "benchmark",
  providerId: "synthetic",
  modelId: "synthetic",
  baseUrl: "http://localhost/v1",
  maxInputTokens: 1024,
  maxBatchInputs: 32,
  maxBatchTokens: 32768,
  projectionVersion: 1 as const,
};
const results: unknown[] = [];
try {
  for (const count of [1_000, 10_000, 50_000]) {
    const path = join(root, `${count}.sqlite`);
    const setup = await createMemoryVectorIndex({ path });
    await setup.call("ensure", { profile });
    await setup.close();
    const db = new DatabaseSync(path);
    const insert = db.prepare("INSERT INTO segments VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    const vector = new Float32Array(dimensions);
    vector.fill(1 / Math.sqrt(dimensions));
    const blob = Buffer.from(vector.buffer);
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < count; i++)
      insert.run(
        "benchmark",
        "episodic",
        String(i),
        1,
        "overview",
        "overview",
        0,
        1,
        `hash-${i}`,
        blob,
        new Date(0).toISOString(),
      );
    db.prepare(
      "UPDATE generations SET dimensions=?,response_model=?,status='ready' WHERE id=?",
    ).run(dimensions, "synthetic", "benchmark");
    db.exec("INSERT INTO active VALUES(1,'benchmark');COMMIT");
    db.close();
    const index = await createMemoryVectorIndex({ path, readOnly: true });
    const allowed = Array.from({ length: count }, (_, i) => ({ id: String(i), revision: 1 }));
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const samples: number[] = [];
    try {
      for (let run = 0; run < 12; run++) {
        const start = performance.now();
        const hits = await index.search(
          { generation: "benchmark", module: "episodic", vector, allowed, limit: 30 },
          AbortSignal.timeout(10_000),
        );
        if (hits.length !== 30) throw new Error("benchmark_result_invalid");
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      results.push({
        memories: count,
        segments: count,
        dimensions,
        vectorMiB: (count * dimensions * 4) / 1024 / 1024,
        p50Ms: Math.round(samples[6]!),
        p95Ms: Math.round(samples[11]!),
        mainLoopMaxMs: Math.round(loop.max / 1e6),
        rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      });
    } finally {
      loop.disable();
      await index.close();
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        mode: "synthetic normalized vectors; real SQLite worker; authorization before top-K; 12 searches per scale",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
