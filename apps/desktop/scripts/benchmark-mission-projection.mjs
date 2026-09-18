import { mkdtemp, rm, stat } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pragma-mission-projection-benchmark-"));

try {
  const bundlePath = join(temporaryRoot, "mission-execution-projection.mjs");
  await build({
    entryPoints: [
      resolve(desktopRoot, "src/main/features/missions/mission-execution-projection.ts"),
    ],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "warning",
  });
  const projection = await import(pathToFileURL(bundlePath).href);
  const scenarios = [
    {
      name: "short-ascii",
      entryCount: 100,
      content: (index) => `answer ${index}`,
    },
    {
      name: "many-multibyte",
      entryCount: 10_000,
      content: (index) => `第 ${index} 条消息 😀`,
    },
    {
      name: "legacy-many-multibyte",
      entryCount: 10_000,
      legacy: true,
      content: (index) => `旧投影第 ${index} 条消息 😀`,
    },
    {
      name: "long-multibyte",
      entryCount: 2_000,
      content: (index) => `${index}:${"中文😀".repeat(1_000)}`,
    },
    {
      name: "truncated-multibyte",
      entryCount: 200,
      content: (index) => `${index}:${"中文😀".repeat(20_000)}`,
    },
  ];
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, projection));
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        strategy: "budgeted-main-thread-slices",
        synchronousBudgetMs: 4,
        transferMs: null,
        transferNote: "No Worker or process transfer is used by this strategy.",
        host: {
          platform: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0]?.model ?? "unknown",
          logicalCpus: cpus().length,
          memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
          node: process.version,
        },
        results,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function runScenario(scenario, projection) {
  globalThis.gc?.();
  const executionId = `benchmark-${scenario.name}`;
  const entries = Array.from({ length: scenario.entryCount }, (_, index) => ({
    id: `${scenario.name}-${index}`,
    executionId,
    kind: "assistant",
    content: scenario.content(index),
    streaming: false,
    createdAt: "2026-09-18T00:00:00.000Z",
  }));
  const inputBytes = Buffer.byteLength(JSON.stringify(entries));
  const outputPath = join(temporaryRoot, `${scenario.name}.jsonl`);
  const memoryBefore = process.memoryUsage();
  let peakRss = memoryBefore.rss;
  let peakHeapUsed = memoryBefore.heapUsed;
  const memorySampler = setInterval(() => {
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed);
  }, 1);
  let eventLoopRunning = true;
  let previousTurn = performance.now();
  let maximumEventLoopDelayMs = 0;
  const sampleEventLoop = () => {
    const now = performance.now();
    maximumEventLoopDelayMs = Math.max(maximumEventLoopDelayMs, now - previousTurn);
    previousTurn = now;
    if (eventLoopRunning) setImmediate(sampleEventLoop);
  };
  setImmediate(sampleEventLoop);
  let metrics;
  const options = {
    onMetrics(value) {
      metrics = value;
    },
  };
  if (scenario.legacy === true) {
    const validated = await projection.migrateLegacyMissionExecutionProjection(
      outputPath,
      executionId,
      entries,
      options,
    );
    if (validated.length !== entries.length) {
      throw new Error(`Legacy benchmark lost entries for ${scenario.name}.`);
    }
  } else {
    await projection.writeMissionExecutionProjection(
      outputPath,
      executionId,
      entries,
      undefined,
      undefined,
      options,
    );
  }
  eventLoopRunning = false;
  await new Promise((resolve) => setImmediate(resolve));
  clearInterval(memorySampler);
  const output = await stat(outputPath);
  if (metrics === undefined) throw new Error(`Missing benchmark metrics for ${scenario.name}.`);

  return {
    name: scenario.name,
    inputEntries: scenario.entryCount,
    inputBytes,
    candidateEntries: metrics.candidateEntries,
    retainedEntries: metrics.retainedEntries,
    outputBytes: output.size,
    queueWaitMs: rounded(metrics.queueWaitMs),
    validationWallMs: rounded(metrics.validationMs),
    boundingAndEncodingWallMs: rounded(metrics.boundingAndEncodingMs),
    buildWallMs: rounded(metrics.buildWallMs),
    synchronousBuildMs: rounded(metrics.synchronousBuildMs),
    maximumSynchronousSliceMs: rounded(metrics.maximumSynchronousSliceMs),
    yieldCount: metrics.yieldCount,
    yieldWaitMs: rounded(metrics.yieldWaitMs),
    fileWriteMs: rounded(metrics.fileWriteMs),
    totalMs: rounded(metrics.totalMs),
    maximumEventLoopDelayMs: rounded(maximumEventLoopDelayMs),
    peakRssMiB: rounded(peakRss / 1024 ** 2),
    peakHeapUsedMiB: rounded(peakHeapUsed / 1024 ** 2),
    peakRssDeltaMiB: rounded((peakRss - memoryBefore.rss) / 1024 ** 2),
    peakHeapDeltaMiB: rounded((peakHeapUsed - memoryBefore.heapUsed) / 1024 ** 2),
  };
}

function rounded(value) {
  return Number(value.toFixed(3));
}
