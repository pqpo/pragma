import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ExecutionRecord, Invocation } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  createFileExecutionStore,
  ExecutionFinalStatusConflictError,
  getExecutionLiveBus,
  PragmaPaths,
  StoredExecutionView,
} from "../src/index.ts";

describe("Execution canonical event log", () => {
  it("uses one Execution sequence and projects durable message history", async () => {
    const { store } = await fixture();
    await store.appendEvent("execution", "root", "invocation.started", {});
    await store.appendEvent(
      "execution",
      "root",
      "invocation.message.appended",
      { message: { role: "user", content: "hello", timestamp: 1 } },
      "runtime-message",
    );
    await store.appendEvent(
      "execution",
      "root",
      "invocation.succeeded",
      { output: "hello" },
      "invocation-result",
    );

    const events = await store.readEvents("execution");
    expect(events.map((event) => event.cursor.sequence)).toEqual([1, 2, 3]);
    expect(events[1]).toMatchObject({
      eventId: "runtime-message",
      type: "invocation.message.appended",
      data: { message: { role: "user", content: "hello" } },
    });
    const view = new StoredExecutionView("execution", store, "session");
    await expect(view.getMessageHistory()).resolves.toMatchObject([
      { invocationId: "root", messages: [{ message: { role: "user", content: "hello" } }] },
    ]);
  });

  it("caches live event scope resolution instead of rereading all Invocations per event", async () => {
    const { store } = await fixture();
    let listCalls = 0;
    let getCalls = 0;
    const trackedStore = {
      ...store,
      async listInvocations(executionId: string) {
        listCalls += 1;
        return await store.listInvocations(executionId);
      },
      async getInvocation(executionId: string, invocationId: string) {
        getCalls += 1;
        return await store.getInvocation(executionId, invocationId);
      },
    };
    const view = new StoredExecutionView("execution", trackedStore);
    const subscription = await view.subscribeEvents({
      scope: { kind: "executor", executorId: "child" },
    });
    const now = new Date().toISOString();
    await store.putInvocation("execution", {
      invocationId: "child",
      rootInvocationId: "root",
      parentInvocationId: "root",
      contextId: "child-context",
      definition: { id: "child", version: "1.0.0", kind: "expert" },
      executorId: "child",
      status: "running",
      input: null,
      createdAt: now,
      updatedAt: now,
    });
    const bus = getExecutionLiveBus(trackedStore);
    for (const sequence of [1, 2]) {
      bus.publishEvent("execution", {
        schemaVersion: "pragma.execution-event/v4",
        eventId: `child-${sequence}`,
        cursor: { executionId: "execution", sequence },
        executionId: "execution",
        invocationId: "child",
        type: "invocation.progress",
        data: {},
        occurredAt: now,
      });
    }
    const iterator = subscription[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { eventId: "child-1" } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { eventId: "child-2" } });
    await subscription.close();

    expect(listCalls).toBe(1);
    expect(getCalls).toBe(1);
  });

  it("deduplicates producer events and rejects conflicting reuse", async () => {
    const { store } = await fixture();
    const first = await store.appendEvent(
      "execution",
      "root",
      "invocation.progress",
      { value: "hello" },
      "same-event",
    );
    const duplicate = await store.appendEvent(
      "execution",
      "root",
      "invocation.progress",
      { value: "hello" },
      "same-event",
    );

    expect(duplicate.cursor).toEqual(first.cursor);
    expect(await store.readEvents("execution")).toHaveLength(1);
    await expect(
      store.appendEvent(
        "execution",
        "root",
        "invocation.progress",
        { value: "different" },
        "same-event",
      ),
    ).rejects.toThrow("event idempotency conflict");
  });

  it("commits state, Invocation changes, and events atomically and idempotently", async () => {
    const { store } = await fixture();
    const request = {
      commitId: "finish-root",
      executionId: "execution",
      expectedVersion: 0,
      executionPatch: { status: "succeeded" as const, output: 42 },
      invocationPatches: [
        {
          invocationId: "root",
          patch: { status: "succeeded" as const, output: 42 },
        },
      ],
      events: [
        {
          eventId: "root-result",
          invocationId: "root",
          type: "invocation.succeeded",
          data: { output: 42 },
        },
      ],
    };

    const committed = await store.commit(request);
    const retried = await store.commit(request);
    expect(committed.execution).toMatchObject({ status: "succeeded", output: 42, version: 1 });
    expect(committed.invocations[0]).toMatchObject({ status: "succeeded", output: 42 });
    expect(committed.events[0]?.cursor.sequence).toBe(1);
    expect(retried.events[0]?.cursor.sequence).toBe(1);
    expect((await store.get("execution"))?.version).toBe(1);
    expect(await store.readEvents("execution")).toHaveLength(1);

    await expect(
      store.commit({ ...request, executionPatch: { status: "failed" } }),
    ).rejects.toThrow("commit idempotency conflict");
  });

  it("does not allow a finalized Execution or Invocation to be overwritten", async () => {
    const { store } = await fixture();
    await store.commit({
      commitId: "finish",
      executionId: "execution",
      executionPatch: { status: "succeeded", output: 42 },
      invocationPatches: [{ invocationId: "root", patch: { status: "succeeded", output: 42 } }],
    });

    await expect(
      store.commit({
        commitId: "late-cancellation",
        executionId: "execution",
        executionPatch: { status: "cancelled" },
        invocationPatches: [{ invocationId: "root", patch: { status: "cancelled" } }],
      }),
    ).rejects.toBeInstanceOf(ExecutionFinalStatusConflictError);
    await expect(store.get("execution")).resolves.toMatchObject({
      status: "succeeded",
      output: 42,
    });
    await expect(store.getInvocation("execution", "root")).resolves.toMatchObject({
      status: "succeeded",
      output: 42,
    });
  });

  it("keeps interrupted state resumable while protecting final outcomes", async () => {
    const { store } = await fixture();
    await store.commit({
      commitId: "interrupt",
      executionId: "execution",
      executionPatch: { status: "interrupted" },
      invocationPatches: [{ invocationId: "root", patch: { status: "interrupted" } }],
    });

    await expect(
      store.commit({
        commitId: "resume-without-claim",
        executionId: "execution",
        executionPatch: { status: "running" },
        invocationPatches: [{ invocationId: "root", patch: { status: "running" } }],
      }),
    ).rejects.toBeInstanceOf(ExecutionFinalStatusConflictError);

    await expect(store.claimRecovery("execution", "recovery-owner", 1_000)).resolves.toBe(true);
    await expect(
      store.commit({
        commitId: "resume",
        executionId: "execution",
        recoveryClaimId: "recovery-owner",
        executionPatch: { status: "running" },
        invocationPatches: [{ invocationId: "root", patch: { status: "running" } }],
      }),
    ).resolves.toMatchObject({
      execution: { status: "running" },
      invocations: [{ status: "running" }],
    });
  });

  it("rejects non-JSON-safe commit values before writing state", async () => {
    const { store } = await fixture();

    await expect(
      store.appendEvent("execution", "root", "custom", { createdAt: new Date() }),
    ).rejects.toThrow("must be JSON-safe");
    await expect(store.readEvents("execution")).resolves.toEqual([]);
    await expect(store.get("execution")).resolves.toMatchObject({ version: 0 });
  });

  it("recovers an interrupted File Store transaction journal", async () => {
    const { home, store } = await fixture();
    const paths = new PragmaPaths({ pragmaHome: home });
    const execution = (await store.get("execution"))!;
    const root = (await store.getInvocation("execution", "root"))!;
    const occurredAt = new Date().toISOString();
    const event = {
      schemaVersion: "pragma.execution-event/v4",
      eventId: "recovered-result",
      cursor: { executionId: "execution", sequence: 1 },
      executionId: "execution",
      invocationId: "root",
      type: "invocation.succeeded",
      data: { output: "recovered" },
      occurredAt,
    };
    await writeFile(
      paths.executionTransaction("execution"),
      `${JSON.stringify({
        schemaVersion: "pragma.execution-transaction/v4",
        commitId: "recovered-commit",
        signature: "a".repeat(64),
        execution: {
          ...execution,
          version: 1,
          status: "succeeded",
          output: "recovered",
          lastAppliedSequence: 1,
          updatedAt: occurredAt,
        },
        invocations: [{ ...root, status: "succeeded", output: "recovered", updatedAt: occurredAt }],
        agents: [],
        events: [event],
        eventIds: [event.eventId],
      })}\n`,
      "utf8",
    );

    await expect(store.get("execution")).resolves.toMatchObject({
      status: "succeeded",
      output: "recovered",
      lastAppliedSequence: 1,
    });
    await expect(store.readEvents("execution")).resolves.toMatchObject([
      { eventId: "recovered-result", cursor: { sequence: 1 } },
    ]);
  });

  it("rejects v1 Execution state instead of reading a compatibility format", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-execution-v1-"));
    const paths = new PragmaPaths({ pragmaHome: home });
    const statePath = paths.executionState("legacy");
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify({ schemaVersion: "pragma.execution/v1", executionId: "legacy" })}\n`,
      "utf8",
    );

    await expect(createFileExecutionStore({ pragmaHome: home }).get("legacy")).rejects.toThrow(
      "unsupported-state-version",
    );
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "pragma-event-log-"));
  const store = createFileExecutionStore({ pragmaHome: home });
  const timestamp = new Date().toISOString();
  const definition = { id: "flow", version: "1.0.0", kind: "flow" as const };
  const execution: ExecutionRecord = {
    schemaVersion: "pragma.execution/v4",
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
  return { home, store };
}
