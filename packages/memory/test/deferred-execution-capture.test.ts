import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createFileCanonicalEventFeed, PragmaPaths } from "@pragma/core";
import { CanonicalEventEnvelopeSchema } from "@pragma/shared";
import { afterEach, expect, it } from "vitest";
import { createDeferredExecutionCaptureStore } from "../src/evidence/deferred-execution-capture.ts";
import {
  createExecutionEvidenceAdapter,
  EXECUTION_EVIDENCE_ADAPTER_ID,
} from "../src/evidence/execution-evidence-adapter.ts";
import { createFileMemoryPipelineStateStore } from "../src/pipeline/pipeline-state-store.ts";
import { createFileMemoryPolicyStore } from "../src/policy/memory-policy-store.ts";
import {
  createMemoryEvidenceFeed,
  createMemoryEvidencePublisher,
} from "../src/evidence/evidence-feed.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), "pragma-deferred-capture-"));
  roots.push(root);
  return root;
}
function databasePath(root: string) {
  return join(
    new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot(EXECUTION_EVIDENCE_ADAPTER_ID),
    "capture-deferred-v1.sqlite",
  );
}

it("rotates durable replay pages without evicting unresolved sources", async () => {
  const pragmaHome = await home();
  const store = createDeferredExecutionCaptureStore({ pragmaHome });
  for (let sequence = 1; sequence <= 3; sequence++)
    await store.put({ eventId: `e${sequence}`, sequence });
  await expect(store.put({ eventId: "e1", sequence: 4 })).rejects.toThrow(
    "memory_execution_capture_source_changed",
  );
  expect(await store.next(2)).toEqual([
    { eventId: "e1", sequence: 1 },
    { eventId: "e2", sequence: 2 },
  ]);
  const reopened = createDeferredExecutionCaptureStore({ pragmaHome });
  expect(await reopened.next(2)).toEqual([{ eventId: "e3", sequence: 3 }]);
  expect(await reopened.next(2)).toHaveLength(2);
  expect(await reopened.inspect()).toEqual({ pending: 3, safeThrough: 0 });
  await reopened.remove("e1");
  expect(await reopened.inspect()).toEqual({ pending: 2, safeThrough: 1 });
});

it("rejects future storage versions and capacity overflow without losing pending references", async () => {
  const pragmaHome = await home();
  const store = createDeferredExecutionCaptureStore({ pragmaHome });
  await store.inspect();
  const path = databasePath(pragmaHome);
  let db = new DatabaseSync(path);
  db.exec("BEGIN");
  const insert = db.prepare("INSERT INTO pending VALUES(?, ?)");
  for (let sequence = 1; sequence <= 10_000; sequence++) insert.run(`e${sequence}`, sequence);
  db.exec("COMMIT");
  db.close();
  await expect(store.put({ eventId: "overflow", sequence: 10_001 })).rejects.toThrow(
    "memory_execution_capture_capacity",
  );
  expect(await store.inspect()).toEqual({ pending: 10_000, safeThrough: 0 });
  db = new DatabaseSync(path);
  db.exec("PRAGMA user_version=99");
  db.close();
  const before = await readFile(path);
  await expect(store.inspect()).rejects.toThrow("memory_execution_capture_version_unsupported");
  expect(await readFile(path)).toEqual(before);
});

async function captureFixture() {
  const pragmaHome = await home();
  const source = await createFileCanonicalEventFeed({ pragmaHome });
  const state = createFileMemoryPipelineStateStore({ pragmaHome });
  const deferred = createDeferredExecutionCaptureStore({ pragmaHome });
  const policies = createFileMemoryPolicyStore({ pragmaHome });
  await policies.updateGlobal({
    expectedRevision: 0,
    policy: {
      enabled: "enabled",
      capture: "enabled",
      recall: "enabled",
      learning: "local-candidates",
    },
  });
  const publisher = createMemoryEvidencePublisher(source);
  const event = (id: string) =>
    CanonicalEventEnvelopeSchema.parse({
      schemaVersion: "pragma.canonical-event/v1",
      eventId: id,
      topic: "pragma.execution.event.committed",
      schemaRef: "pragma.execution-event/v5",
      sourceRef: { type: "pragma.execution-event", id },
      relatedRefs: [
        { relation: "pragma.execution-root", ref: { type: "pragma.expert", id: "expert" } },
      ],
      correlationId: id,
      occurredAt: new Date().toISOString(),
      payload: {
        schemaVersion: "pragma.execution-event/v5",
        eventId: id,
        cursor: { executionId: id, sequence: 1 },
        executionId: id,
        invocationId: id,
        type: "invocation.message.appended",
        occurredAt: new Date().toISOString(),
        data: { message: { role: "user", content: id, timestamp: 1 } },
      },
    });
  return { pragmaHome, source, state, deferred, policies, publisher, event };
}

it("keeps processing beyond a full source page while an origin is missing, fences retention, and honors owner deletion", async () => {
  const f = await captureFixture();
  try {
    await f.source.append([
      f.event("blocked"),
      ...Array.from({ length: 104 }, (_, index) => f.event(`normal-${index}`)),
    ]);
    const adapter = createExecutionEvidenceAdapter({
      ...f,
      checkpoints: f.state,
      deadLetters: f.state,
      batchSize: 10,
      excludeExecution: async (event) => {
        if (event.correlationId === "blocked")
          throw new Error("memory_execution_origin_unavailable");
        return false;
      },
    });
    for (let page = 0; page < 25; page++) await adapter.runOnce();
    expect((await f.state.read(EXECUTION_EVIDENCE_ADAPTER_ID)).sequence).toBeGreaterThan(100);
    expect((await createMemoryEvidenceFeed(f.source).read({ limit: 1000 })).items).toHaveLength(
      104,
    );
    expect(await f.deferred.inspect()).toEqual({ pending: 1, safeThrough: 0 });
    await f.source.maintain({
      safeThrough: { sequence: (await f.deferred.inspect()).safeThrough },
      retainAfter: new Date(Date.now() + 60_000).toISOString(),
      targetBytes: 1,
    });
    expect((await f.source.read({ limit: 1 })).items[0]).toMatchObject({
      kind: "event",
      event: { eventId: "blocked" },
    });
    await f.source.forgetCorrelation("blocked");
    await adapter.runOnce();
    expect((await f.deferred.inspect()).pending).toBe(0);
  } finally {
    await f.source.close();
  }
});

it("replays after an uncertain publish without duplicating evidence or dropping the pending source", async () => {
  const f = await captureFixture();
  let ready = false;
  let failPublish = false;
  const adapter = () =>
    createExecutionEvidenceAdapter({
      ...f,
      checkpoints: f.state,
      deadLetters: f.state,
      excludeExecution: async () => {
        if (!ready) throw new Error("origin pending");
        return false;
      },
      publisher: {
        async publish(events) {
          await f.publisher.publish(events);
          if (failPublish) throw new Error("crash after publish");
        },
      },
    });
  try {
    await f.source.append([f.event("late")]);
    await expect(adapter().runOnce()).resolves.toEqual({ published: 0, skipped: 0, deferred: 1 });
    ready = true;
    failPublish = true;
    await expect(adapter().runOnce()).rejects.toThrow("crash after publish");
    expect((await f.deferred.inspect()).pending).toBe(1);
    failPublish = false;
    await adapter().runOnce();
    expect((await f.deferred.inspect()).pending).toBe(0);
    expect((await createMemoryEvidenceFeed(f.source).read({ limit: 100 })).items).toHaveLength(1);
  } finally {
    await f.source.close();
  }
});
