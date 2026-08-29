import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import { createMissionControllerStore, createMissionWatchApplication } from "../../src/index.ts";

const [missionsPath, role, missionId, ...arguments_] = process.argv.slice(2);

if (missionsPath === undefined || role === undefined || missionId === undefined) {
  throw new Error("Expected a missions path, role, and Mission ID.");
}

const store = createMissionControllerStore({ missionsPath });

if (role === "seed") {
  await seedMission(missionId);
} else if (role === "inbox-owner") {
  await runInboxOwner(missionId, arguments_);
} else if (role === "inbox-producer") {
  await runInboxProducer(missionId, arguments_);
} else if (role === "watcher") {
  await runWatcher(missionId, arguments_);
} else {
  throw new Error(`Unknown M10 performance fixture role: ${role}`);
}

async function seedMission(targetMissionId: string): Promise<void> {
  const guard = await store.claim({
    missionId: targetMissionId,
    claimId: randomUUID(),
    leaseMs: 10_000,
  });
  try {
    await store.write({
      missionId: targetMissionId,
      guard,
      operation: async ({ appendEvent }) =>
        await appendEvent("mission.created", { requestId: randomUUID(), source: "m10-benchmark" }),
    });
  } finally {
    await store.release({ missionId: targetMissionId, guard });
  }
}

async function runInboxOwner(targetMissionId: string, values: readonly string[]): Promise<void> {
  const leaseMs = parsePositiveInteger(values[0], "leaseMs");
  const initialDelayMs = parsePositiveInteger(values[1], "initialDelayMs");
  const maxDelayMs = parsePositiveInteger(values[2], "maxDelayMs");
  const renewEveryMs = parsePositiveInteger(values[3], "renewEveryMs");
  let guard = await store.claim({
    missionId: targetMissionId,
    claimId: randomUUID(),
    leaseMs,
  });
  let stopped = false;
  let poller: ReturnType<typeof store.startPolling> | undefined;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  let resolveStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line.trim() === "stop") resolveStop();
  });

  try {
    poller = store.startPolling({
      missionId: targetMissionId,
      guard: () => guard,
      initialDelayMs,
      maxDelayMs,
      onLeaseLost: async () => {
        stopped = true;
        process.stdout.write("OWNER_LEASE_LOST\n");
        resolveStop();
      },
      consumer: {
        apply: async ({ command }) => ({
          result: { commandId: command.commandId, requestId: command.request.requestId },
        }),
      },
    });
    renewTimer = setInterval(() => {
      void store
        .renew({ missionId: targetMissionId, guard, leaseMs })
        .then((renewed) => {
          guard = renewed;
          process.stdout.write(`OWNER_RENEWED ${renewed.renewedAt}\n`);
        })
        .catch(() => {
          stopped = true;
          resolveStop();
        });
    }, renewEveryMs);
    renewTimer.unref();
    process.stdout.write("OWNER_READY\n");
    await stopRequested;
  } finally {
    input.close();
    if (renewTimer !== undefined) clearInterval(renewTimer);
    await poller?.stop();
    if (!stopped) await store.release({ missionId: targetMissionId, guard });
    process.stdout.write("OWNER_DONE\n");
  }
}

async function runInboxProducer(targetMissionId: string, values: readonly string[]): Promise<void> {
  const count = parsePositiveInteger(values[0], "count");
  const delayMs = parseNonNegativeInteger(values[1] ?? "0", "producerDelayMs");
  const operationTimeoutMs = parsePositiveInteger(values[2] ?? "30_000", "operationTimeoutMs");
  const instanceId = randomUUID();
  const pending: Array<{
    readonly requestId: string;
    readonly commandId: string;
    readonly createdAt: string;
  }> = [];
  for (let index = 0; index < count; index += 1) {
    const requestId = randomUUID();
    const appended = await store.appendCommand({
      missionId: targetMissionId,
      kind: "send",
      request: {
        schemaVersion: "pragma.integration-request/v1",
        requestId,
        payloadHash: `sha256:${"b".repeat(64)}`,
        requestedAt: new Date().toISOString(),
        client: {
          surface: "cli",
          version: "m10-performance-fixture",
          instanceId,
        },
      },
      payload: { kind: "send", input: { prompt: "m10 benchmark" } },
    });
    pending.push({
      requestId,
      commandId: appended.command.commandId,
      createdAt: appended.operation.createdAt,
    });
    if (delayMs > 0) await delay(delayMs);
  }
  const records = await waitForOperations(targetMissionId, pending, operationTimeoutMs);
  for (const record of records) {
    process.stdout.write(`BENCH_RECORD ${JSON.stringify(record)}\n`);
  }
  process.stdout.write(`PRODUCER_DONE ${count}\n`);
}

async function waitForOperations(
  targetMissionId: string,
  pending: readonly {
    readonly requestId: string;
    readonly commandId: string;
    readonly createdAt: string;
  }[],
  timeoutMs: number,
): Promise<readonly Record<string, string>[]> {
  const byRequestId = new Map(pending.map((item) => [item.requestId, item]));
  const records = new Map<string, Record<string, string>>();
  const deadline = Date.now() + timeoutMs;
  while (records.size < pending.length) {
    for (const operation of await store.listOperations({ missionId: targetMissionId })) {
      const item = byRequestId.get(operation.requestId);
      if (item === undefined || records.has(operation.requestId)) continue;
      if (
        operation.state === "applied" ||
        operation.state === "rejected" ||
        operation.state === "expired" ||
        operation.state === "failed"
      ) {
        records.set(operation.requestId, {
          requestId: item.requestId,
          commandId: item.commandId,
          createdAt: item.createdAt,
          updatedAt: operation.updatedAt,
          state: operation.state,
        });
      }
    }
    if (records.size === pending.length) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Inbox operation acknowledgement timed out: ${pending.length - records.size} pending.`,
      );
    }
    await delay(Math.min(100, remainingMs));
  }
  return pending.map((item) => records.get(item.requestId)!);
}

async function runWatcher(targetMissionId: string, values: readonly string[]): Promise<void> {
  const sampleIntervalMs = parsePositiveInteger(values[0], "sampleIntervalMs");
  const abortController = new AbortController();
  let sampling: WatchSampling | undefined;
  let stopSamplingRequested = false;
  let resolveSamplingStarted!: () => void;
  let resolveSamplingStopped!: () => void;
  const samplingStarted = new Promise<void>((resolve) => {
    resolveSamplingStarted = resolve;
  });
  const samplingStopped = new Promise<void>((resolve) => {
    resolveSamplingStopped = resolve;
  });
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const command = line.trim();
    if (command === "start-sampling" && sampling === undefined) {
      sampling = createWatchSampling(sampleIntervalMs);
      process.stdout.write("WATCH_SAMPLING_STARTED\n");
      resolveSamplingStarted();
    } else if (command === "stop-sampling" && !stopSamplingRequested) {
      stopSamplingRequested = true;
      sampling?.stop();
      process.stdout.write(
        `WATCH_SAMPLING_STOPPED ${JSON.stringify(sampling?.snapshot() ?? [])}\n`,
      );
      resolveSamplingStopped();
    }
  });
  process.once("SIGINT", () => abortController.abort());

  const watchPromise = createMissionWatchApplication({
    controller: store,
    pollIntervalMs: 250,
  }).watch({
    missionId: targetMissionId,
    replay: 0,
    signal: abortController.signal,
    onEvent: (event) => {
      process.stdout.write(`WATCH_EVENT ${event.type}\n`);
      if (event.type === "watch.ready") {
        process.stdout.write("WATCH_READY\n");
      }
    },
  });

  await waitForLineCommand(samplingStarted);
  await waitForLineCommand(samplingStopped);
  const result = await watchPromise;
  input.close();
  process.stdout.write(
    `WATCH_DONE ${JSON.stringify({ result, samples: sampling?.snapshot() ?? [] })}\n`,
  );
}

interface WatchSample {
  readonly elapsedMs: number;
  readonly rssBytes: number;
  readonly cpuUserMicros: number;
  readonly cpuSystemMicros: number;
}

interface WatchSampling {
  stop(): void;
  snapshot(): readonly WatchSample[];
}

function createWatchSampling(intervalMs: number): WatchSampling {
  const startedAt = Date.now();
  const samples: WatchSample[] = [];
  let stopped = false;
  const sample = (): void => {
    if (stopped) return;
    const cpu = process.cpuUsage();
    samples.push({
      elapsedMs: Date.now() - startedAt,
      rssBytes: process.memoryUsage().rss,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
    });
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const cpu = process.cpuUsage();
      samples.push({
        elapsedMs: Date.now() - startedAt,
        rssBytes: process.memoryUsage().rss,
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
      });
    },
    snapshot: () => samples,
  };
}

async function waitForLineCommand(command: Promise<void>): Promise<void> {
  await command;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
