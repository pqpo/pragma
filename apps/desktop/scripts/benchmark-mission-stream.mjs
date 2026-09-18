import { mkdtemp, rm } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { build } from "esbuild";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pragma-mission-stream-benchmark-"));

try {
  const bundlePath = join(temporaryRoot, "mission-conversation-model.mjs");
  await build({
    entryPoints: [
      resolve(desktopRoot, "src/renderer/src/pages/missions/mission-conversation-model.ts"),
    ],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "warning",
  });
  const { applyMissionChatUpdateBatch, materializeMissionChatSnapshot } = await import(
    pathToFileURL(bundlePath).href
  );
  const results = [100, 1_000, 5_000].map((entryCount) =>
    benchmarkEntryCount(entryCount, {
      applyMissionChatUpdateBatch,
      materializeMissionChatSnapshot,
    }),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        host: {
          platform: platform(),
          release: release(),
          arch: arch(),
          cpu: cpus()[0]?.model ?? "unknown",
          logicalCpus: cpus().length,
          memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
          node: process.version,
        },
        iterationsPerScenario: 1_000,
        results,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function benchmarkEntryCount(entryCount, model) {
  const baseline = runScenario(entryCount, model, "materialized");
  const incremental = runScenario(entryCount, model, "incremental");
  const firstToken = benchmarkFirstTokenLookup(entryCount);
  return {
    entryCount,
    materialized: baseline,
    incremental,
    firstTokenLookup: firstToken,
  };
}

function runScenario(entryCount, model, mode) {
  let snapshot = createSnapshot(entryCount);
  const liveEntries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const targetId = snapshot.entries.at(-1).id;
  let readCount = 0;
  let fullIndexBuilds = 0;
  let orderedArrayCopies = 0;
  const batchSamples = [];
  const publishSamples = [];
  for (let iteration = 0; iteration < 1_050; iteration += 1) {
    const update = {
      missionId: snapshot.missionId,
      streamId: "00000000-0000-4000-8000-000000000099",
      revision: snapshot.revision + 1,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: targetId, field: "content", delta: "x" }],
    };
    const batchStartedAt = performance.now();
    const previousEntries = snapshot.entries;
    const result = model.applyMissionChatUpdateBatch(
      snapshot,
      [update],
      mode === "incremental"
        ? {
            deferContentEntries: true,
            readEntry(entryId) {
              readCount += 1;
              return liveEntries.get(entryId);
            },
          }
        : undefined,
    );
    if (result.snapshot.entries !== previousEntries) {
      orderedArrayCopies += 1;
      if (mode === "materialized") fullIndexBuilds += 1;
    }
    const batchFinishedAt = performance.now();
    const publishStartedAt = performance.now();
    if (mode === "incremental") {
      for (const entry of result.changedEntries.values()) liveEntries.set(entry.id, entry);
    } else {
      for (const entry of result.snapshot.entries.filter((candidate) =>
        result.changedEntryIds.has(candidate.id),
      )) {
        liveEntries.set(entry.id, entry);
      }
    }
    const publishFinishedAt = performance.now();
    snapshot = result.snapshot;
    if (iteration >= 50) {
      batchSamples.push(batchFinishedAt - batchStartedAt);
      publishSamples.push(publishFinishedAt - publishStartedAt);
    }
  }
  const materialized = model.materializeMissionChatSnapshot(snapshot, (entryId) =>
    liveEntries.get(entryId),
  );
  if (materialized.entries !== snapshot.entries) orderedArrayCopies += 1;
  if (!materialized.entries.at(-1).content.endsWith("x")) {
    throw new Error(`${mode} benchmark lost the streamed content.`);
  }
  return {
    batchP50Ms: percentile(batchSamples, 0.5),
    batchP95Ms: percentile(batchSamples, 0.95),
    publishP50Ms: percentile(publishSamples, 0.5),
    publishP95Ms: percentile(publishSamples, 0.95),
    fullIndexBuilds,
    orderedArrayCopies,
    entryReads: mode === "incremental" ? readCount : undefined,
  };
}

function benchmarkFirstTokenLookup(entryCount) {
  const snapshot = createSnapshot(entryCount);
  const targetId = snapshot.entries.at(-1).id;
  const executionByEntryId = new Map(
    snapshot.entries.map((entry) => [entry.id, entry.executionId]),
  );
  const scanSamples = [];
  const indexedSamples = [];
  let lastScannedExecutionId;
  let lastIndexedExecutionId;
  for (let iteration = 0; iteration < 1_050; iteration += 1) {
    let startedAt = performance.now();
    lastScannedExecutionId = snapshot.entries.find((entry) => entry.id === targetId)?.executionId;
    let finishedAt = performance.now();
    if (iteration >= 50) scanSamples.push(finishedAt - startedAt);
    startedAt = performance.now();
    lastIndexedExecutionId = executionByEntryId.get(targetId);
    finishedAt = performance.now();
    if (iteration >= 50) indexedSamples.push(finishedAt - startedAt);
  }
  if (lastScannedExecutionId === undefined || lastIndexedExecutionId === undefined) {
    throw new Error("First-token lookup missed the target entry.");
  }
  return {
    scanP50Ms: percentile(scanSamples, 0.5),
    scanP95Ms: percentile(scanSamples, 0.95),
    indexedP50Ms: percentile(indexedSamples, 0.5),
    indexedP95Ms: percentile(indexedSamples, 0.95),
  };
}

function createSnapshot(entryCount) {
  return {
    missionId: "00000000-0000-4000-8000-000000000000",
    revision: 1,
    entries: Array.from({ length: entryCount }, (_, index) => ({
      id: `answer-${index}`,
      kind: "assistant",
      executionId: `execution-${index}`,
      content: "seed",
      streaming: true,
      createdAt: "2026-09-18T00:00:00.000Z",
    })),
    page: {},
    pendingInteractions: [],
  };
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(4));
}
