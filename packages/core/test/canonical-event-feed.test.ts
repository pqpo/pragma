import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ExecutionRecord, Invocation } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  createFileCanonicalEventFeed,
  createFileExecutionStore,
  PragmaPaths,
  type CanonicalEventFeed,
} from "../src/index.ts";

describe("Canonical Event Feed", () => {
  it("relays committed Execution events with stable idempotency", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-canonical-feed-"));
    const feed = await createFileCanonicalEventFeed({ pragmaHome: home });
    const store = createFileExecutionStore({ pragmaHome: home, canonicalEventFeed: feed });
    await createExecution(store);

    await store.appendEvent(
      "execution",
      "root",
      "invocation.message.appended",
      { message: { role: "user", content: "remember this", timestamp: 1 } },
      "message-one",
    );
    await store.appendEvent(
      "execution",
      "root",
      "invocation.message.appended",
      { message: { role: "user", content: "remember this", timestamp: 1 } },
      "message-one",
    );

    const page = await feed.read({ limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      kind: "event",
      event: {
        topic: "pragma.execution.event.committed",
        schemaRef: "pragma.execution-event/v5",
        payload: { eventId: "message-one" },
      },
    });
    feed.close();
  });

  it("keeps a durable handoff when delivery fails and recovers it without blocking source state", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-canonical-recovery-"));
    const durable = await createFileCanonicalEventFeed({ pragmaHome: home });
    let unavailable = true;
    const feed: CanonicalEventFeed = {
      ...durable,
      async append(events) {
        if (unavailable) throw new Error("feed unavailable");
        await durable.append(events);
      },
    };
    const store = createFileExecutionStore({ pragmaHome: home, canonicalEventFeed: feed });
    await createExecution(store);
    await expect(
      store.appendEvent("execution", "root", "invocation.progress", { value: 1 }, "event-one"),
    ).resolves.toMatchObject({ eventId: "event-one" });
    await store.appendEvent("execution", "root", "invocation.progress", { value: 2 }, "event-two");
    await expect(store.readEvents("execution")).resolves.toHaveLength(2);
    await expect(durable.inspect()).resolves.toEqual({ lastSequence: 0, eventCount: 0 });

    unavailable = false;
    await expect(store.recoverPendingCanonicalEvents()).resolves.toMatchObject({ failed: 0 });
    await expect(durable.inspect()).resolves.toEqual({ lastSequence: 2, eventCount: 2 });
    const page = await durable.read({ limit: 10 });
    expect(
      page.items.flatMap((item) =>
        item.kind === "event"
          ? [(item.event.payload as { cursor: { sequence: number } }).cursor.sequence]
          : [],
      ),
    ).toEqual([1, 2]);
    await store.recoverPendingCanonicalEvents();
    await expect(durable.inspect()).resolves.toEqual({ lastSequence: 2, eventCount: 2 });
    durable.close();
  });

  it("stops at the first delivery failure so one Execution is published in source order", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-canonical-ordered-recovery-"));
    const durable = await createFileCanonicalEventFeed({ pragmaHome: home });
    let unavailable = true;
    let failNextRecovery = false;
    const feed: CanonicalEventFeed = {
      ...durable,
      async append(events) {
        if (unavailable || failNextRecovery) {
          failNextRecovery = false;
          throw new Error("feed unavailable");
        }
        await durable.append(events);
      },
    };
    const store = createFileExecutionStore({ pragmaHome: home, canonicalEventFeed: feed });
    await createExecution(store);
    await store.appendEvent("execution", "root", "invocation.progress", { value: 1 }, "event-one");
    await store.appendEvent("execution", "root", "invocation.progress", { value: 2 }, "event-two");

    unavailable = false;
    failNextRecovery = true;
    await expect(store.recoverPendingCanonicalEvents()).resolves.toEqual({
      recovered: 0,
      pending: 2,
      failed: 1,
      quarantined: 0,
    });
    await expect(durable.inspect()).resolves.toEqual({ lastSequence: 0, eventCount: 0 });

    await expect(store.recoverPendingCanonicalEvents()).resolves.toEqual({
      recovered: 2,
      pending: 0,
      failed: 0,
      quarantined: 0,
    });
    const page = await durable.read({ limit: 10 });
    expect(
      page.items.flatMap((item) =>
        item.kind === "event"
          ? [(item.event.payload as { cursor: { sequence: number } }).cursor.sequence]
          : [],
      ),
    ).toEqual([1, 2]);
    durable.close();
  });

  it("fails closed on future Feed and handoff versions without deleting their data", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-canonical-future-"));
    const paths = new PragmaPaths({ pragmaHome: home });
    await mkdir(dirname(paths.canonicalEventFeed()), { recursive: true });
    const future = new DatabaseSync(paths.canonicalEventFeed());
    future.exec("PRAGMA user_version = 2;");
    future.close();
    await expect(createFileCanonicalEventFeed({ pragmaHome: home })).rejects.toThrow(
      "unsupported-state-version:pragma.canonical-event-feed/v2",
    );

    const otherHome = await mkdtemp(join(tmpdir(), "pragma-canonical-future-handoff-"));
    const otherPaths = new PragmaPaths({ pragmaHome: otherHome });
    const feed = await createFileCanonicalEventFeed({ pragmaHome: otherHome });
    const store = createFileExecutionStore({ pragmaHome: otherHome, canonicalEventFeed: feed });
    await createExecution(store);
    const handoffPath = otherPaths.canonicalEventHandoff("execution", "future");
    await mkdir(dirname(handoffPath), { recursive: true });
    await writeFile(
      handoffPath,
      JSON.stringify({ schemaVersion: "pragma.canonical-event-handoff/v2" }),
    );
    await expect(store.recoverPendingCanonicalEvents()).resolves.toEqual({
      recovered: 0,
      pending: 0,
      failed: 1,
      quarantined: 1,
    });
    const quarantined = await readdir(otherPaths.canonicalEventHandoffQuarantineRoot());
    expect(quarantined).toHaveLength(1);
    await expect(
      readFile(join(otherPaths.canonicalEventHandoffQuarantineRoot(), quarantined[0]!), "utf8"),
    ).resolves.toBe(JSON.stringify({ schemaVersion: "pragma.canonical-event-handoff/v2" }));
    await expect(store.get("execution")).rejects.toThrow(
      "unsupported-state-version:pragma.canonical-event-handoff-quarantined:execution",
    );
    feed.close();
  });

  it("deduplicates recovery after Feed append succeeds but handoff acknowledgement is interrupted", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-canonical-ack-recovery-"));
    const durable = await createFileCanonicalEventFeed({ pragmaHome: home });
    let interruptAcknowledgement = true;
    const feed: CanonicalEventFeed = {
      ...durable,
      async append(events) {
        await durable.append(events);
        if (interruptAcknowledgement) throw new Error("interrupted after append");
      },
    };
    const store = createFileExecutionStore({ pragmaHome: home, canonicalEventFeed: feed });
    await createExecution(store);
    await store.appendEvent("execution", "root", "invocation.progress", {}, "event-one");
    await expect(durable.inspect()).resolves.toEqual({ lastSequence: 1, eventCount: 1 });

    interruptAcknowledgement = false;
    await store.recoverPendingCanonicalEvents();
    await expect(durable.inspect()).resolves.toEqual({ lastSequence: 1, eventCount: 1 });
    durable.close();
  });
});

async function createExecution(store: ReturnType<typeof createFileExecutionStore>) {
  const timestamp = new Date().toISOString();
  const definition = { id: "flow", kind: "flow" as const };
  const execution: ExecutionRecord = {
    schemaVersion: "pragma.execution/v8",
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
    contextId: "root-context",
    definition,
    status: "running",
    input: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.create(execution, root);
}
