import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileExecutionStore,
  createFileExpertSessionStore,
  PragmaPaths,
  createLoggerProvider,
} from "../src/index.ts";
import type { ExecutionRecord, Invocation } from "@pragma/shared";

const samples = 20;
const percentile = (values: readonly number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const measurements: Record<string, unknown>[] = [];
const logger = createLoggerProvider({
  handler: {
    write: (record) => {
      if (record.event === "storage.operation_measured" && record.attributes !== undefined)
        measurements.push(record.attributes);
    },
  },
}).createLogger({ component: "storage-benchmark" });
const probe = async (action: () => Promise<unknown>) => {
  const previous = process.env["PRAGMA_STORAGE_DIAGNOSTICS"];
  measurements.length = 0;
  process.env["PRAGMA_STORAGE_DIAGNOSTICS"] = "1";
  try {
    await action();
    return measurements.map(
      ({ family, operation, reads, writes, readBytes, writtenBytes, parsedEntries }) => ({
        family,
        operation,
        reads,
        writes,
        readBytes,
        writtenBytes,
        parsedEntries,
      }),
    );
  } finally {
    if (previous === undefined) delete process.env["PRAGMA_STORAGE_DIAGNOSTICS"];
    else process.env["PRAGMA_STORAGE_DIAGNOSTICS"] = previous;
  }
};
const results = [];
const sessionResults = [];
for (const historySize of [100, 1_000]) {
  const home = await mkdtemp(join(tmpdir(), "pragma-storage-benchmark-"));
  try {
    const store = createFileExecutionStore({ pragmaHome: home, logger });
    const timestamp = new Date().toISOString();
    const definition = { id: "flow", kind: "flow" as const };
    const execution: ExecutionRecord = {
      schemaVersion: "pragma.execution/v12",
      executionId: "execution",
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
    };
    const root: Invocation = {
      invocationId: "root",
      rootInvocationId: "root",
      contextId: "context",
      definition,
      status: "running",
      pendingExpertMessages: [],
      input: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await store.create(execution, root);
    await store.commit({
      commitId: "history",
      executionId: "execution",
      events: Array.from({ length: historySize }, (_, index) => ({
        eventId: `history-${index}`,
        invocationId: "root",
        type: "invocation.started",
        data: {},
      })),
    });
    const commitTimes: number[] = [];
    const readTimes: number[] = [];
    for (let index = 0; index < samples + 5; index++) {
      const start = performance.now();
      await store.commit({
        commitId: `sample-${index}`,
        executionId: "execution",
        events: [
          {
            eventId: `sample-${index}`,
            invocationId: "root",
            type: "invocation.started",
            data: {},
          },
        ],
      });
      const committed = performance.now();
      await store.readEvents("execution", {
        executionId: "execution",
        sequence: historySize + index,
      });
      const read = performance.now();
      if (index >= 5) {
        commitTimes.push(committed - start);
        readTimes.push(read - committed);
      }
    }
    const io = await probe(() =>
      store.commit({
        commitId: "diagnostic-probe",
        executionId: "execution",
        events: [
          {
            eventId: "diagnostic-probe",
            invocationId: "root",
            type: "invocation.started",
            data: {},
          },
        ],
      }),
    );
    results.push({
      io,
      historySize,
      samples,
      commitP50Ms: percentile(commitTimes, 0.5),
      commitP95Ms: percentile(commitTimes, 0.95),
      readP50Ms: percentile(readTimes, 0.5),
      readP95Ms: percentile(readTimes, 0.95),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
const sessionHome = await mkdtemp(join(tmpdir(), "pragma-session-benchmark-"));
try {
  const paths = new PragmaPaths({ pragmaHome: sessionHome });
  const executions = createFileExecutionStore({ pragmaHome: sessionHome });
  const sessions = createFileExpertSessionStore({ pragmaHome: sessionHome, executions, logger });
  const sessionId = "queue-marker-session";
  await mkdir(paths.expertSessionRoot(sessionId), { recursive: true });
  await writeFile(
    paths.expertSessionTransaction(sessionId),
    await readFile(
      new URL(
        "../test/fixtures/expert-session-transaction-v9-queue-marker-4ddb0eba.json",
        import.meta.url,
      ),
    ),
  );
  await sessions.get(sessionId);
  await sessions.appendEvent(sessionId, {
    eventId: "fixture-event",
    type: "prompt.queue-paused",
    data: {},
  });
  const sourcePrompts = JSON.parse(
    await readFile(paths.expertSessionPrompts(sessionId), "utf8"),
  ) as Record<string, unknown>[];
  const sourceEvents = JSON.parse(
    await readFile(paths.expertSessionEvents(sessionId), "utf8"),
  ) as Record<string, unknown>[];
  for (const historySize of [100, 1_000]) {
    await writeFile(
      paths.expertSessionPrompts(sessionId),
      JSON.stringify(
        Array.from({ length: historySize }, (_, index) => ({
          ...sourcePrompts[0],
          requestId: `request-${index}`,
        })),
      ),
    );
    await writeFile(
      paths.expertSessionEvents(sessionId),
      JSON.stringify(
        Array.from({ length: historySize }, (_, index) => ({
          ...sourceEvents[0],
          eventId: `event-${index}`,
          cursor: { sessionId, sequence: index + 1 },
        })),
      ),
    );
    const durations = [];
    for (let index = 0; index < samples + 5; index++) {
      const start = performance.now();
      if (typeof sessions.readSnapshot === "function") await sessions.readSnapshot(sessionId);
      else
        await Promise.all([
          sessions.get(sessionId),
          sessions.listPrompts(sessionId),
          sessions.listEvents(sessionId),
        ]);
      if (index >= 5) durations.push(performance.now() - start);
    }
    const io = await probe(async () => {
      if (typeof sessions.readSnapshot === "function")
        return await sessions.readSnapshot(sessionId);
      return await Promise.all([
        sessions.get(sessionId),
        sessions.listPrompts(sessionId),
        sessions.listEvents(sessionId),
      ]);
    });
    sessionResults.push({
      io,
      historySize,
      samples,
      snapshotP50Ms: percentile(durations, 0.5),
      snapshotP95Ms: percentile(durations, 0.95),
    });
  }
} finally {
  await rm(sessionHome, { recursive: true, force: true });
}
process.stdout.write(
  `${JSON.stringify({ kind: "local-storage-only", node: process.version, results, sessionResults }, null, 2)}\n`,
);
