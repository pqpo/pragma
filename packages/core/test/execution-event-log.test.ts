import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ExecutionRecord, ExpertAgentStreamEvent, Invocation } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  createFileExecutionStore,
  ExecutionFinalStatusConflictError,
  PragmaPaths,
  StoredExecutionView,
} from "../src/index.ts";

describe("Execution canonical event log", () => {
  it("uses one Execution sequence and derives Output items from source events", async () => {
    const { store } = await fixture();
    await store.appendEvent("execution", "root", "invocation.started", {});
    await store.appendEvent(
      "execution",
      "root",
      "runtime.stream",
      runtimeEvent("runtime-message", "hello"),
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
      type: "runtime.stream",
      data: { type: "message.delta", payload: { delta: "hello" } },
    });

    const outputs = await store.readOutputs("execution");
    expect(outputs).toMatchObject([
      {
        sourceEventId: "runtime-message",
        cursor: { executionId: "execution", sequence: 2 },
        channel: "message",
        delta: "hello",
      },
      {
        sourceEventId: "invocation-result",
        cursor: { executionId: "execution", sequence: 3 },
        channel: "result",
        value: "hello",
      },
    ]);
    await expect(
      store.readOutputs("execution", { executionId: "execution", sequence: 2 }),
    ).resolves.toMatchObject([{ sourceEventId: "invocation-result" }]);
  });

  it("deduplicates producer events and rejects conflicting reuse", async () => {
    const { store } = await fixture();
    const event = runtimeEvent("same-event", "hello");
    const first = await store.appendEvent(
      "execution",
      "root",
      "runtime.stream",
      event,
      event.eventId,
    );
    const duplicate = await store.appendEvent(
      "execution",
      "root",
      "runtime.stream",
      event,
      event.eventId,
    );

    expect(duplicate.cursor).toEqual(first.cursor);
    expect(await store.readEvents("execution")).toHaveLength(1);
    await expect(
      store.appendEvent(
        "execution",
        "root",
        "runtime.stream",
        runtimeEvent("same-event", "different"),
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

  it("drains output committed atomically with terminal state before ending a watcher", async () => {
    const { store } = await fixture();
    const originalGet = store.get.bind(store);
    let unblockStateRead: (() => void) | undefined;
    let reportStateRead: (() => void) | undefined;
    const stateRead = new Promise<void>((resolve) => {
      reportStateRead = resolve;
    });
    const stateReadBlocked = new Promise<void>((resolve) => {
      unblockStateRead = resolve;
    });
    let shouldBlock = true;
    store.get = async (executionId) => {
      if (shouldBlock) {
        shouldBlock = false;
        reportStateRead?.();
        await stateReadBlocked;
      }
      return await originalGet(executionId);
    };

    const iterator = store.watchOutputs("execution")[Symbol.asyncIterator]();
    const next = iterator.next();
    await stateRead;
    await store.commit({
      commitId: "terminal-output",
      executionId: "execution",
      executionPatch: { status: "succeeded", output: "done" },
      invocationPatches: [{ invocationId: "root", patch: { status: "succeeded", output: "done" } }],
      events: [
        {
          invocationId: "root",
          type: "invocation.succeeded",
          data: { output: "done" },
        },
      ],
    });
    unblockStateRead?.();

    await expect(next).resolves.toMatchObject({
      done: false,
      value: { channel: "result", value: "done" },
    });
    await iterator.return?.();
  });

  it("does not miss an Invocation result finalized while its watcher is starting", async () => {
    const { store } = await fixture();
    const originalGetInvocation = store.getInvocation.bind(store);
    let unblockInvocationRead: (() => void) | undefined;
    let reportInvocationRead: (() => void) | undefined;
    const invocationRead = new Promise<void>((resolve) => {
      reportInvocationRead = resolve;
    });
    const invocationReadBlocked = new Promise<void>((resolve) => {
      unblockInvocationRead = resolve;
    });
    let shouldBlock = true;
    store.getInvocation = async (executionId, invocationId) => {
      if (shouldBlock) {
        shouldBlock = false;
        reportInvocationRead?.();
        await invocationReadBlocked;
      }
      return await originalGetInvocation(executionId, invocationId);
    };

    const view = new StoredExecutionView("execution", store);
    const iterator = view.watchInvocationOutput("root")[Symbol.asyncIterator]();
    const next = iterator.next();
    await invocationRead;
    await store.commit({
      commitId: "invocation-terminal-output",
      executionId: "execution",
      invocationPatches: [{ invocationId: "root", patch: { status: "succeeded", output: "done" } }],
      events: [
        {
          invocationId: "root",
          type: "invocation.succeeded",
          data: { output: "done" },
        },
      ],
    });
    unblockInvocationRead?.();

    await expect(next).resolves.toMatchObject({
      done: false,
      value: { channel: "result", value: "done" },
    });
    await iterator.return?.();
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
      schemaVersion: "pragma.execution-event/v2",
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
        schemaVersion: "pragma.execution-transaction/v2",
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
    await expect(store.readOutputs("execution")).resolves.toMatchObject([
      { sourceEventId: "recovered-result", channel: "result", value: "recovered" },
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
    schemaVersion: "pragma.execution/v2",
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
    definition,
    status: "running",
    input: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.create(execution, root);
  return { home, store };
}

function runtimeEvent(eventId: string, delta: string): ExpertAgentStreamEvent {
  return {
    schemaVersion: "pragma.stream/v1",
    eventId,
    sequence: 0,
    runId: "root",
    emittedAt: new Date().toISOString(),
    source: { kind: "agent", runId: "root", path: [] },
    type: "message.delta",
    payload: { role: "assistant", contentType: "text", delta },
  };
}
