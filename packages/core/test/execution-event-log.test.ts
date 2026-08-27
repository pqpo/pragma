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
      pendingExpertMessages: [],
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

  it("aggregates materialized AgentInstances by Runtime Context across executions", async () => {
    const { store } = await fixture();
    const contextId = "shared-review-context";
    const sessionId = "expert-session";
    const runtime = {
      runtimeId: "fake",
      revision: 1,
      fingerprint: "a".repeat(64),
    };
    const timestamps = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:00.000Z",
      "2026-01-01T00:02:00.000Z",
      "2026-01-01T00:03:00.000Z",
    ] as const;

    const createTurn = async (input: {
      executionId: string;
      rootInvocationId: string;
      rootContextId: string;
      agentId: string;
      invocationId: string;
      prompt: string;
      output: string;
      createdAt: string;
      messageTimestamp: number;
    }) => {
      const rootDefinition = { id: "coordinator", kind: "expert" as const };
      await store.create(
        {
          schemaVersion: "pragma.execution/v10",
          executionId: input.executionId,
          version: 0,
          kind: "expert-turn",
          definition: rootDefinition,
          rootInvocationId: input.rootInvocationId,
          status: "running",
          input: null,
          state: {},
          lastAppliedSequence: 0,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
        {
          invocationId: input.rootInvocationId,
          rootInvocationId: input.rootInvocationId,
          definition: rootDefinition,
          executorId: rootDefinition.id,
          contextId: input.rootContextId,
          status: "running",
          pendingExpertMessages: [],
          input: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
      );
      await store.commit({
        commitId: `finish:${input.executionId}`,
        executionId: input.executionId,
        executionPatch: { status: "succeeded" },
        invocationPatches: [
          { invocationId: input.rootInvocationId, patch: { status: "succeeded" } },
        ],
        contextPuts: [
          {
            schemaVersion: "pragma.runtime-context/v5",
            contextId,
            owner: { type: "expert-session", ownerId: sessionId },
            origin: { type: "invocation", invocationId: "review-1" },
            expert: { id: "reviewer" },
            runtime,
            lifecycle: "open",
            createdAt: timestamps[0],
            updatedAt: input.createdAt,
          },
        ],
        agentPuts: [
          {
            schemaVersion: "pragma.agent-instance/v2",
            agentId: input.agentId,
            executionId: input.executionId,
            ownerContextId: input.rootContextId,
            createdByInvocationId: input.rootInvocationId,
            definition: { id: "reviewer", kind: "expert" },
            contextId,
            lifecycle: "open",
            nextTaskSequence: 1,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
        ],
        invocationPuts: [
          {
            invocationId: input.invocationId,
            rootInvocationId: input.rootInvocationId,
            parentInvocationId: input.rootInvocationId,
            definition: { id: "reviewer", kind: "expert" },
            executorId: "reviewer",
            agentId: input.agentId,
            agentTaskSequence: 0,
            contextId,
            status: "succeeded",
            pendingExpertMessages: [],
            input: input.prompt,
            output: input.output,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
        ],
        events: [
          {
            eventId: `message:${input.executionId}`,
            invocationId: input.invocationId,
            type: "invocation.message.appended",
            data: {
              message: {
                role: "assistant",
                content: [{ type: "text", text: input.output }],
                api: "test",
                provider: "test",
                model: "test",
                usage: {
                  measurement: "reported",
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: input.messageTimestamp,
              },
            },
          },
        ],
      });
    };

    await createTurn({
      executionId: "turn-1",
      rootInvocationId: "root-1",
      rootContextId: "root-context",
      agentId: "agent-1",
      invocationId: "review-1",
      prompt: "Review the first draft",
      output: "First review",
      createdAt: timestamps[1],
      messageTimestamp: Date.parse(timestamps[1]),
    });
    await createTurn({
      executionId: "turn-2",
      rootInvocationId: "root-2",
      rootContextId: "root-context",
      agentId: "agent-2",
      invocationId: "review-2",
      prompt: "Review the revised draft",
      output: "Second review",
      createdAt: timestamps[3],
      messageTimestamp: Date.parse(timestamps[3]),
    });

    const reader = new ExecutionWorkHistoryReader(store);
    const records = await reader.listRecords({
      executionIds: ["turn-1", "turn-2"],
      rootSessionId: sessionId,
    });
    const agents = records.filter((record) => record.kind === "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      recordId: `agent-context:${contextId}`,
      sessionId: contextId,
      contextId,
      executorId: "reviewer",
      parentRecordId: `root:${sessionId}`,
      status: "succeeded",
      tasks: [
        expect.objectContaining({
          executionId: "turn-1",
          invocationId: "review-1",
          input: "Review the first draft",
          output: "First review",
        }),
        expect.objectContaining({
          executionId: "turn-2",
          invocationId: "review-2",
          input: "Review the revised draft",
          output: "Second review",
        }),
      ],
    });
    await expect(
      reader.readOutput({ executionIds: ["turn-1", "turn-2"], record: agents[0]! }),
    ).resolves.toMatchObject([
      { executionId: "turn-1", message: { content: [{ text: "First review" }] } },
      { executionId: "turn-2", message: { content: [{ text: "Second review" }] } },
    ]);
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
    schemaVersion: "pragma.execution/v10",
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
    pendingExpertMessages: [],
    input: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.create(execution, root);
  return { home, store };
}
