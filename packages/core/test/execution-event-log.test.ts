import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ExecutionRecord, ExpertAgentStreamEvent, Invocation } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  createFileExecutionStore,
  ExecutionWorkHistoryReader,
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
      definition: { id: "child", kind: "expert" },
      executorId: "child",
      status: "running",
      input: null,
      createdAt: now,
      updatedAt: now,
    });
    const bus = getExecutionLiveBus(trackedStore);
    for (const sequence of [1, 2]) {
      bus.publishEvent("execution", {
        schemaVersion: "pragma.execution-event/v5",
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

  it("replays active output published before a subscriber attaches", async () => {
    const { store } = await fixture();
    const bus = getExecutionLiveBus(store);
    const occurredAt = new Date().toISOString();
    bus.publish("execution", {
      sourceEventId: "early-output",
      executionId: "execution",
      invocationId: "root",
      contextId: "root-context",
      runId: "root-run",
      source: { kind: "agent", runId: "root-run", path: [] },
      channel: "message",
      delta: "already emitted",
      occurredAt,
    });

    const subscription = bus.subscribe("execution");
    await expect(subscription[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { sourceEventId: "early-output", delta: "already emitted" },
    });
    await subscription.close();
  });

  it("commits state, Invocation changes, and events atomically and idempotently", async () => {
    const { store } = await fixture();
    const request = {
      commitId: "finish-root",
      executionId: "execution",
      expectedVersion: 0,
      executionPatch: {
        status: "succeeded" as const,
        output: { type: "inline" as const, value: 42 },
      },
      invocationPatches: [
        {
          invocationId: "root",
          patch: { status: "succeeded" as const, output: { type: "inline", value: 42 } },
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
    expect(committed.execution).toMatchObject({
      status: "succeeded",
      output: { type: "inline", value: 42 },
      version: 1,
    });
    expect(committed.invocations[0]).toMatchObject({
      status: "succeeded",
      output: { type: "inline", value: 42 },
    });
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
      executionPatch: { status: "succeeded", output: { type: "inline", value: 42 } },
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
      output: { type: "inline", value: 42 },
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
      schemaVersion: "pragma.execution-event/v5",
      eventId: "recovered-result",
      cursor: { executionId: "execution", sequence: 1 },
      executionId: "execution",
      invocationId: "root",
      type: "invocation.succeeded",
      data: { output: { type: "inline", value: "recovered" } },
      occurredAt,
    };
    await writeFile(
      paths.executionTransaction("execution"),
      `${JSON.stringify({
        schemaVersion: "pragma.execution-transaction/v8",
        commitId: "recovered-commit",
        signature: "a".repeat(64),
        execution: {
          ...execution,
          schemaVersion: "pragma.execution/v7",
          version: 1,
          status: "succeeded",
          output: { type: "inline", value: "recovered" },
          lastAppliedSequence: 1,
          updatedAt: occurredAt,
        },
        invocations: [
          {
            ...root,
            status: "succeeded",
            output: { type: "inline", value: "recovered" },
            updatedAt: occurredAt,
          },
        ],
        agents: [],
        contexts: [],
        events: [event],
        eventIds: [event.eventId],
      })}\n`,
      "utf8",
    );

    await expect(store.get("execution")).resolves.toMatchObject({
      status: "succeeded",
      output: { type: "inline", value: "recovered" },
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

  it("groups runtime subagent turns by native session and isolates their output", async () => {
    const { store } = await fixture();
    const emittedAt = new Date().toISOString();
    await store.appendEvent(
      "execution",
      "root",
      "runtime.event",
      {
        schemaVersion: "pragma.stream/v1",
        eventId: "spawn-children",
        sequence: 0,
        runId: "root-run",
        emittedAt,
        source: {
          kind: "agent",
          runId: "root-run",
          sessionId: "root-thread",
          agentId: "root",
          agentType: "codex",
          path: [],
        },
        type: "agent.command",
        payload: {
          commandId: "spawn-children",
          action: "spawn",
          phase: "completed",
          senderSessionId: "root-thread",
          targetSessionIds: ["child-a", "child-b"],
          prompt: "Investigate in parallel",
          states: { "child-a": "pending", "child-b": "pending" },
        },
      },
      "spawn-children",
    );
    const source = (sessionId: string, runId: string, displayName?: string) => ({
      kind: "agent" as const,
      runId,
      parentRunId: "root-run",
      sessionId,
      parentSessionId: "root-thread",
      agentId: sessionId,
      agentType: "codex-subagent",
      ...(displayName === undefined ? {} : { displayName }),
      path: [],
    });
    const childRuns = [
      ["child-a", "turn-a-1"],
      ["child-a", "turn-a-2"],
      ["child-b", "turn-b-1"],
    ] as const;
    for (const [index, [sessionId, runId]] of childRuns.entries()) {
      await store.appendEvent(
        "execution",
        "root",
        "runtime.event",
        {
          schemaVersion: "pragma.stream/v1",
          eventId: `run-${index}`,
          sequence: index,
          runId,
          parentRunId: "root-run",
          emittedAt,
          source: source(sessionId, runId, index === 1 ? "Researcher" : undefined),
          type: "run.started",
          payload: { task: `task ${index}` },
        },
        `run-${index}`,
      );
    }
    const message = (text: string, timestamp: number) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: "codex",
      provider: "openai",
      model: "test",
      usage: {
        measurement: "reported" as const,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp,
    });
    await store.appendEvent("execution", "root", "invocation.message.appended", {
      runId: "turn-a-1",
      parentRunId: "root-run",
      source: source("child-a", "turn-a-1"),
      message: message("output-a", 1),
    });
    await store.appendEvent("execution", "root", "invocation.message.appended", {
      runId: "turn-b-1",
      parentRunId: "root-run",
      source: source("child-b", "turn-b-1"),
      message: message("output-b", 2),
    });

    const reader = new ExecutionWorkHistoryReader(store);
    const records = await reader.listRecords({ executionIds: ["execution"] });
    const childA = records.find((record) => record.recordId === "runtime-agent:child-a");
    expect(childA?.tasks).toHaveLength(2);
    expect(childA?.displayName).toBe("Researcher");
    expect(childA?.tasks.every((task) => task.taskId.includes("turn-a-"))).toBe(true);
    expect(records.filter((record) => record.kind === "runtime-agent")).toHaveLength(2);
    await expect(
      reader.readOutput({ executionIds: ["execution"], record: childA! }),
    ).resolves.toMatchObject([{ message: { content: [{ text: "output-a" }] } }]);
  });

  it("projects only real subagent runs and carries dispatch prompts across interruption", async () => {
    const { store } = await fixture();
    const source = (runId: string) => ({
      kind: "agent" as const,
      runId,
      parentRunId: "root-run",
      sessionId: "child-thread",
      parentSessionId: "root-thread",
      agentId: "child-thread",
      agentType: "codex-subagent",
      path: [],
    });
    let sequence = 0;
    const append = async <Event extends ExpertAgentStreamEvent>(
      event: Omit<Event, "schemaVersion" | "eventId" | "sequence" | "emittedAt">,
    ) => {
      sequence += 1;
      await store.appendEvent("execution", "root", "runtime.event", {
        schemaVersion: "pragma.stream/v1",
        eventId: `runtime-${sequence}`,
        sequence,
        emittedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
        ...event,
      });
    };
    const rootSource = {
      kind: "agent" as const,
      runId: "root-run",
      sessionId: "root-thread",
      agentId: "root-thread",
      path: [],
    };

    await append({
      runId: "root-run",
      source: rootSource,
      type: "agent.command",
      payload: {
        commandId: "spawn-command",
        action: "spawn",
        phase: "started",
        senderSessionId: "root-thread",
        targetSessionIds: [],
        prompt: "Inspect every relevant file and report the complete findings.",
      },
    });
    await append({
      runId: "child-run-1",
      parentRunId: "root-run",
      source: source("child-run-1"),
      type: "progress",
      payload: { stage: "thread/started" },
    });
    await append({
      runId: "root-run",
      source: rootSource,
      type: "agent.command",
      payload: {
        commandId: "spawn-command",
        action: "spawn",
        phase: "completed",
        senderSessionId: "root-thread",
        targetSessionIds: ["child-thread"],
        states: { "child-thread": { status: "running" } },
      },
    });
    await append({
      runId: "child-run-1",
      parentRunId: "root-run",
      source: source("child-run-1"),
      type: "run.started",
      payload: { task: "Truncated task summary" },
    });
    await append({
      runId: "root-run",
      source: rootSource,
      type: "agent.command",
      payload: {
        commandId: "wait-command",
        action: "wait",
        phase: "completed",
        targetSessionIds: ["child-thread"],
        states: { "child-thread": { status: "idle" } },
      },
    });
    await append({
      runId: "child-run-1",
      parentRunId: "root-run",
      source: source("child-run-1"),
      type: "run.completed",
      payload: {},
    });
    await append({
      runId: "root-run",
      source: rootSource,
      type: "agent.command",
      payload: {
        commandId: "list-command",
        action: "list",
        phase: "completed",
        targetSessionIds: ["child-thread"],
        states: { "child-thread": { status: "running" } },
      },
    });

    const reader = new ExecutionWorkHistoryReader(store);
    let child = (await reader.listRecords({ executionIds: ["execution"] })).find(
      (record) => record.sessionId === "child-thread",
    );
    expect(child).toMatchObject({
      status: "succeeded",
      tasks: [
        {
          runId: "child-run-1",
          status: "succeeded",
          input: "Inspect every relevant file and report the complete findings.",
        },
      ],
    });

    await append({
      runId: "child-run-2",
      parentRunId: "root-run",
      source: source("child-run-2"),
      type: "run.started",
      payload: { task: "An active turn that will be interrupted" },
    });
    await append({
      runId: "root-run",
      source: rootSource,
      type: "agent.command",
      payload: {
        commandId: "interrupt-command",
        action: "interrupt",
        phase: "completed",
        targetSessionIds: ["child-thread"],
      },
    });
    child = (await reader.listRecords({ executionIds: ["execution"] })).find(
      (record) => record.sessionId === "child-thread",
    );
    expect(child).toMatchObject({ status: "interrupted" });
    expect(child?.tasks).toHaveLength(2);

    await append({
      runId: "root-run",
      source: rootSource,
      type: "agent.command",
      payload: {
        commandId: "send-command",
        action: "send",
        phase: "completed",
        targetSessionIds: ["child-thread"],
        prompt: "Now verify the risky edge cases in full detail.",
        states: { "child-thread": { status: "notLoaded" } },
      },
    });
    child = (await reader.listRecords({ executionIds: ["execution"] })).find(
      (record) => record.sessionId === "child-thread",
    );
    expect(child).toMatchObject({ status: "interrupted" });
    expect(child?.tasks).toHaveLength(2);

    await append({
      runId: "child-run-3",
      parentRunId: "root-run",
      source: source("child-run-3"),
      type: "run.started",
      payload: { task: "Short follow-up" },
    });
    child = (await reader.listRecords({ executionIds: ["execution"] })).find(
      (record) => record.sessionId === "child-thread",
    );
    expect(child).toMatchObject({
      status: "running",
      tasks: [
        expect.objectContaining({ runId: "child-run-1" }),
        expect.objectContaining({ runId: "child-run-2" }),
        expect.objectContaining({
          runId: "child-run-3",
          input: "Now verify the risky edge cases in full detail.",
        }),
      ],
    });
    await append({
      runId: "child-run-3",
      parentRunId: "root-run",
      source: source("child-run-3"),
      type: "run.failed",
      payload: { message: "Verification failed" },
    });
    await append({
      runId: "child-run-3",
      parentRunId: "root-run",
      source: source("child-run-3"),
      type: "run.started",
      payload: { task: "A late duplicate start event" },
    });
    await append({
      runId: "child-run-3",
      parentRunId: "root-run",
      source: source("child-run-3"),
      type: "progress",
      payload: { stage: "thread/status/changed" },
    });
    child = (await reader.listRecords({ executionIds: ["execution"] })).find(
      (record) => record.sessionId === "child-thread",
    );
    expect(child).toMatchObject({
      status: "failed",
      tasks: [
        expect.objectContaining({ runId: "child-run-1" }),
        expect.objectContaining({ runId: "child-run-2" }),
        expect.objectContaining({
          runId: "child-run-3",
          status: "failed",
          input: "Now verify the risky edge cases in full detail.",
          error: "Verification failed",
        }),
      ],
    });
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "pragma-event-log-"));
  const store = createFileExecutionStore({ pragmaHome: home });
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
  return { home, store };
}
