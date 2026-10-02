import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { acquireHostStoragePool } from "../dist/host-storage-pool.js";
process.env.PRAGMA_STORAGE_BENCHMARK = "1";
const pool = acquireHostStoragePool();
const executeFile = promisify(execFile);
const processIo = async () => {
  try {
    const { stdout } = await executeFile("python3", [
      fileURLToPath(new URL("./read-process-io.py", import.meta.url)),
      String(process.pid),
    ]);
    return JSON.parse(stdout);
  } catch (error) {
    return { unavailable: error.message };
  }
};
const storageMetrics = () =>
  Promise.all(pool.clients.map((client) => client.call("benchmark-metrics", "benchmark")));
import console from "node:console";
import { Buffer } from "node:buffer";
import { createSqliteExecutionStore } from "../dist/index.js";
import { PragmaPaths, createFileCanonicalEventFeed } from "@pragma/core";
const home = await mkdtemp(join(tmpdir(), "pragma-execution-benchmark-"));
let store;
let canonical;
const paths = new PragmaPaths({ pragmaHome: home });
const results = [];
const percentile = (values, fraction) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
try {
  for (const [engine, delivery] of [
    ["sqlite", false],
    ["sqlite", true],
  ]) {
    canonical = delivery ? await createFileCanonicalEventFeed({ pragmaHome: home }) : undefined;
    store = createSqliteExecutionStore({ pragmaHome: home, canonicalEventFeed: canonical });
    for (const [history, owners] of [
      [0, 1],
      [50, 1],
      [500, 1],
      [5000, 1],
      [5000, 4],
    ]) {
      const ids = Array.from(
        { length: owners },
        (_, index) => `${engine}-${delivery}-history-${history}-owners-${owners}-${index}`,
      );
      for (const id of ids) {
        const timestamp = new Date().toISOString();
        const definition = { kind: "flow", id: "benchmark" };
        await store.create(
          {
            schemaVersion: "pragma.execution/v12",
            executionId: id,
            version: 0,
            kind: "flow",
            definition,
            rootInvocationId: "root",
            status: "running",
            input: null,
            state: {},
            lastAppliedSequence: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          {
            invocationId: "root",
            rootInvocationId: "root",
            contextId: "context",
            definition,
            status: "running",
            pendingExpertMessages: [],
            input: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        );
        for (let offset = 0; offset < history; offset += 64)
          await store.commit({
            executionId: id,
            commitId: `seed-${offset}`,
            events: Array.from({ length: Math.min(64, history - offset) }, (_, index) => ({
              eventId: `seed-${offset + index}`,
              invocationId: "root",
              type: "progress",
              data: { value: "x".repeat(128) },
            })),
          });
      }
      await store.drainCanonicalEvents();
      const bytes = async (id) => {
        const files =
          engine === "sqlite"
            ? [paths.executionDatabase(id)]
            : [
                paths.executionState(id),
                paths.executionInvocations(id),
                paths.executionEvents(id),
                paths.executionCommits(id),
              ];
        return (
          await Promise.all(
            files.map(async (file) => (await stat(file).catch(() => ({ size: 0 }))).size),
          )
        ).reduce((sum, value) => sum + value, 0);
      };
      const before = await Promise.all(ids.map(bytes));
      await storageMetrics();
      const ioBefore = await processIo();
      const samples = [];
      const readSamples = [];
      let requestPayloadBytes = 0;
      let responsePayloadBytes = 0;
      for (let round = 0; round < 20; round++) {
        await Promise.all(
          ids.map(async (id) => {
            const request = {
              executionId: id,
              commitId: `sample-${round}`,
              events: [
                {
                  eventId: `sample-${round}`,
                  invocationId: "root",
                  type: "progress",
                  data: { value: "x".repeat(128) },
                },
              ],
            };
            requestPayloadBytes += Buffer.byteLength(JSON.stringify(request));
            const readStart = performance.now();
            await store.get(id);
            readSamples.push(performance.now() - readStart);
            const start = performance.now();
            const result = await store.commit(request);
            samples.push(performance.now() - start);
            responsePayloadBytes += Buffer.byteLength(JSON.stringify(result));
          }),
        );
      }
      await store.drainCanonicalEvents();
      const after = await Promise.all(ids.map(bytes));
      const ioAfter = await processIo();
      const workerMetrics = await storageMetrics();
      results.push({
        engine,
        canonicalDelivery: delivery,
        history,
        owners,
        samples: samples.length,
        commitLatencyMs: { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) },
        readLatencyMs: { p50: percentile(readSamples, 0.5), p95: percentile(readSamples, 0.95) },
        requestPayloadBytes,
        responsePayloadBytes,
        workerMetrics,
        processDiskIo:
          ioBefore.unavailable || ioAfter.unavailable
            ? { unavailable: ioBefore.unavailable ?? ioAfter.unavailable }
            : {
                readBytes: ioAfter.readBytes - ioBefore.readBytes,
                writeBytes: ioAfter.writeBytes - ioBefore.writeBytes,
                source: ioAfter.source,
                scope:
                  "Whole benchmark process including storage/canonical worker threads and background delivery; kernel counters may include delayed writes. Excludes seeding. Not per-transaction attribution.",
              },
        databaseGrowthBytes: after.reduce((sum, item, index) => sum + item - before[index], 0),
        note: "Payload bytes are worker boundary serialization, not physical disk I/O. Canonical feed enabled only where indicated; no UI or Memory/Usage consumer in this benchmark.",
      });
    }
    await store.close?.();
    store = undefined;
    await canonical?.close();
    canonical = undefined;
  }
  console.log(
    JSON.stringify(
      {
        schemaVersion: "pragma.execution-storage-benchmark/v1",
        timestamp: new Date().toISOString(),
        cpu: cpus()[0]?.model,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await store?.close?.();
  await canonical?.close();
  await pool.close();
  await rm(home, { recursive: true, force: true });
}
