import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPragma,
  createFileExecutionStore,
  createFileExpertSessionStore,
  createRuntimeRegistry,
  defineExpert,
  defineExpertTeam,
  defineFlow,
  defineRuntimeDriver,
  PragmaPaths,
  type RuntimeDriverSessionContext,
} from "../src/index.ts";

interface FakeSession {
  readonly context: RuntimeDriverSessionContext;
  readonly id: string;
}

function createFakeRuntime(
  options: { readonly delayMs?: number; readonly onSteer?: () => void } = {},
) {
  return defineRuntimeDriver<never, FakeSession>({
    descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
    createSession: (context) => ({ context, id: `native-${context.systemSessionId}` }),
    restoreSession: (context) => ({ context, id: context.request.runtimeSession!.id }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    async startTurn(session, turn) {
      if (options.delayMs !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
      }
      const delegate = session.context.agent.tools?.find((tool) => tool.name === "delegate_expert");
      let output = `${session.context.agent.id}:${turn.rawQuery}`;
      if (delegate !== undefined && session.context.agent.id === "lead") {
        const delegated = await delegate.call(
          { expertId: "member", prompt: "subtask", context: "reuse" },
          turn.signal,
          { execution: session.context.request.executionContext },
        );
        output = `lead:${delegated.text}`;
      }
      turn.stream.write({
        runId: turn.runId,
        source: turn.source,
        type: "message.delta",
        payload: { role: "assistant", contentType: "text", delta: output },
      });
      return { outputText: output, runtimeSessionId: session.id };
    },
    mapEvent: () => ({ events: [] }),
    cancelTurn: () => undefined,
    ...(options.onSteer === undefined
      ? {}
      : {
          steerTurn: () => {
            options.onSteer?.();
          },
        }),
    closeSession: () => undefined,
  });
}

async function fixture(delayMs?: number) {
  const home = await mkdtemp(join(tmpdir(), "pragma-execution-"));
  const runtime = createFakeRuntime(delayMs === undefined ? {} : { delayMs });
  const app = createPragma({
    pragmaHome: home,
    runtimes: createRuntimeRegistry({ runtimes: [runtime], defaultRuntime: "fake" }),
  });
  const expert = await defineExpert({
    id: "solo",
    name: "Solo",
    description: "Test Expert",
    tags: [],
    version: "1.0.0",
    scope: "test",
    workspace: home,
  });
  return { home, app, expert };
}

describe("ExpertSession", () => {
  it("streams only future events until terminal and exposes durable message history", async () => {
    const { app, expert } = await fixture(100);
    const session = await app.experts.createSession(expert);
    const turn = await session.prompt("hello", { requestId: "history" });
    await waitUntil(async () => (await turn.getState()).lastAppliedSequence > 0);

    const streamed = (async () => {
      const events = [];
      for await (const event of turn.events()) events.push(event);
      return events;
    })();
    const invocationStreamed = (async () => {
      const events = [];
      for await (const event of turn.watchInvocation(turn.executionId)) events.push(event);
      return events;
    })();

    await expect(turn.result).resolves.toBe("solo:hello");
    const events = await streamed;
    expect(events.some((event) => event.type === "runtime.message.delta")).toBe(true);
    expect(events.some((event) => event.type === "invocation.started")).toBe(false);
    expect((await invocationStreamed).some((event) => event.type === "invocation.succeeded")).toBe(
      true,
    );
    expect("replayEvents" in turn).toBe(false);
    expect(await session.getMessageHistory()).toMatchObject([
      { role: "user", requestId: "history", content: "hello" },
      { role: "assistant", content: "solo:hello" },
    ]);
    await session.close();
  });

  it("uses defineExpert as the only creation entry and makes requestId durable/idempotent", async () => {
    const { app, expert } = await fixture();
    expect("create" in expert).toBe(false);
    const session = await app.experts.createSession(expert);
    const first = await session.prompt("hello", { requestId: "same" });
    const duplicate = await session.prompt("hello", { requestId: "same" });
    expect(duplicate.executionId).toBe(first.executionId);
    await expect(session.prompt("different", { requestId: "same" })).rejects.toThrow(
      "idempotency conflict",
    );
    await expect(first.result).resolves.toBe("solo:hello");
    await session.close();
  });

  it("queues prompts FIFO, rejects idle steer, and shares the API with ExpertTeam", async () => {
    const { home, app, expert } = await fixture(20);
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
    });
    const team = defineExpertTeam({
      id: "team",
      version: "1.0.0",
      coordinator: lead,
      members: [member],
      delegation: { allow: { lead: ["member"], member: [] }, context: "reuse" },
    });
    const session = await app.experts.createSession(expert);
    const one = await session.prompt("one", { requestId: "one" });
    const two = await session.prompt("two", { requestId: "two" });
    expect((await session.getPromptQueue()).map((request) => request.requestId)).toEqual([
      "one",
      "two",
    ]);
    await expect(one.result).resolves.toBe("solo:one");
    await expect(two.result).resolves.toBe("solo:two");
    await expect(session.prompt("late", { requestId: "steer", mode: "steer" })).rejects.toThrow(
      "active ExpertTurn",
    );

    const teamSession = await app.experts.createSession(team);
    const turn = await teamSession.prompt("coordinate", { requestId: "team" });
    await expect(turn.result).resolves.toBe("lead:member:subtask");
    const tree = await turn.getTree();
    expect(tree.invocation.definition.kind).toBe("expert-team");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.invocation.executorId).toBe("member");
    await session.close();
    await teamSession.close();
  }, 15_000);

  it("claims concurrent steer requests once and checkpoints Runtime context before completion", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-steer-"));
    let steerCalls = 0;
    const runtime = createFakeRuntime({ delayMs: 250, onSteer: () => (steerCalls += 1) });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createRuntimeRegistry({ runtimes: [runtime], defaultRuntime: "fake" }),
    });
    const expert = await defineExpert({
      id: "steerable",
      name: "Steerable",
      description: "Steerable",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
    });
    const session = await app.experts.createSession(expert);
    const turn = await session.prompt("slow", { requestId: "slow" });
    await waitUntil(
      async () => Object.keys((await session.getState()).runtimeContexts).length === 1,
    );
    const [first, duplicate] = await Promise.all([
      session.prompt("correction", { requestId: "steer-once", mode: "steer" }),
      session.prompt("correction", { requestId: "steer-once", mode: "steer" }),
    ]);
    expect(first.executionId).toBe(turn.executionId);
    expect(duplicate.executionId).toBe(turn.executionId);
    expect(steerCalls).toBe(1);
    await turn.result;
    await session.close();
  });

  it("recovers an enqueue transaction journal after a crash point", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-transaction-"));
    const executions = createFileExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });
    const app = createPragma({
      pragmaHome: home,
      executionStore: executions,
      expertSessionStore: sessions,
      runtimes: createRuntimeRegistry({
        runtimes: [createFakeRuntime()],
        defaultRuntime: "fake",
      }),
    });
    const expert = await defineExpert({
      id: "durable",
      name: "Durable",
      description: "Durable",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
    });
    const session = await app.experts.createSession(expert, { sessionId: "journal-session" });
    const current = await session.getState();
    const now = new Date().toISOString();
    const executionId = "journal-execution";
    const definition = { id: expert.id, version: expert.version, kind: "expert" as const };
    await writeFile(
      new PragmaPaths({ pragmaHome: home }).expertSessionTransaction(session.sessionId),
      `${JSON.stringify({
        schemaVersion: "pragma.expert-session-transaction/v1",
        session: {
          ...current,
          queuedRequestIds: ["journal-request"],
          executionIds: [executionId],
          updatedAt: now,
        },
        prompts: [
          {
            requestId: "journal-request",
            sessionId: session.sessionId,
            content: "recover me",
            mode: "enqueue",
            executionId,
            status: "queued",
            createdAt: now,
            updatedAt: now,
          },
        ],
        execution: {
          schemaVersion: "pragma.execution/v1",
          executionId,
          kind: "expert-turn",
          definition,
          rootInvocationId: executionId,
          status: "queued",
          input: "recover me",
          state: {},
          lastAppliedSequence: 0,
          createdAt: now,
          updatedAt: now,
        },
        rootInvocation: {
          invocationId: executionId,
          rootInvocationId: executionId,
          definition,
          executorId: expert.id,
          status: "queued",
          input: "recover me",
          createdAt: now,
          updatedAt: now,
        },
      })}\n`,
      "utf8",
    );
    expect((await session.getState()).executionIds).toContain(executionId);
    expect(await executions.get(executionId)).toBeDefined();
    expect((await session.getPromptQueue())[0]?.requestId).toBe("journal-request");
    await session.close();
  });
});

describe("FlowExecution", () => {
  it("runs inline Task nodes and exposes a read-only open view", async () => {
    const { app } = await fixture();
    let calls = 0;
    const flow = defineFlow({
      id: "flow",
      version: "1.0.0",
      result: ({ state }) => state["answer"],
    });
    const task = flow.task({
      id: "task",
      version: "1.0.0",
      handler: ({ input }) => {
        calls += 1;
        return Number(input) * 2;
      },
      reduce: ({ state, output }) => {
        state["answer"] = output;
      },
    });
    flow.compose(({ start, end }) => {
      start(task).next(end());
    });
    const execution = await app.flows.start(flow, { input: 21 });
    const streamed = (async () => {
      const events = [];
      for await (const event of execution.events()) events.push(event);
      return events;
    })();
    await expect(execution.result).resolves.toBe(42);
    expect((await streamed).at(-1)?.type).toBe("execution.succeeded");
    const opened = await app.flows.open({ executionId: execution.executionId });
    expect((await opened.getState()).status).toBe("succeeded");
    expect("cancel" in opened).toBe(false);
    expect((await opened.getTree()).children).toHaveLength(1);
    expect(calls).toBe(1);
    await expect(app.flows.recover(flow, { executionId: execution.executionId })).rejects.toThrow(
      "terminal",
    );
  });

  it("marks a failing Task Invocation as failed", async () => {
    const { app } = await fixture();
    const flow = defineFlow({ id: "failing-flow", version: "1.0.0" });
    const task = flow.task({
      id: "fails",
      version: "1.0.0",
      handler: () => {
        throw new Error("task exploded");
      },
    });
    flow.compose(({ start, end }) => start(task).next(end()));
    const execution = await app.flows.start(flow, { input: null });
    await expect(execution.result).rejects.toThrow("task exploded");
    expect((await execution.getTree()).children[0]?.invocation.status).toBe("failed");
  });

  it("rejects recover when a nested definition version changes", async () => {
    const { home, app } = await fixture();
    const original = defineFlow({ id: "versioned-flow", version: "1.0.0" });
    const waiting = original.humanTask({
      id: "approval",
      version: "1.0.0",
      request: { kind: "approval", prompt: "Continue?" },
    });
    original.compose(({ start, end }) => start(waiting).next(end()));
    const execution = await app.flows.start(original, { input: null });
    await waitUntil(
      async () => (await execution.getTree()).children[0]?.invocation.status === "waiting",
    );

    const changed = defineFlow({ id: "versioned-flow", version: "1.0.0" });
    const changedWaiting = changed.humanTask({
      id: "approval",
      version: "2.0.0",
      request: { kind: "approval", prompt: "Continue?" },
    });
    changed.compose(({ start, end }) => start(changedWaiting).next(end()));
    const secondApp = createPragma({
      pragmaHome: home,
      runtimes: createRuntimeRegistry({
        runtimes: [createFakeRuntime()],
        defaultRuntime: "fake",
      }),
    });
    await expect(
      secondApp.flows.recover(changed, { executionId: execution.executionId }),
    ).rejects.toThrow("definition graph mismatch");
    const cancelled = expect(execution.result).rejects.toThrow("test complete");
    await execution.cancel("test complete");
    await cancelled;
  });
});

describe("Execution observation", () => {
  it("observes events appended by another ExecutionStore instance", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-watch-"));
    const writer = createFileExecutionStore({ pragmaHome: home });
    const reader = createFileExecutionStore({ pragmaHome: home });
    const now = new Date().toISOString();
    await writer.create(
      {
        schemaVersion: "pragma.execution/v1",
        executionId: "cross-process",
        kind: "flow",
        definition: { id: "flow", version: "1.0.0", kind: "flow" },
        rootInvocationId: "root",
        status: "running",
        input: null,
        state: {},
        lastAppliedSequence: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        invocationId: "root",
        rootInvocationId: "root",
        definition: { id: "flow", version: "1.0.0", kind: "flow" },
        status: "running",
        input: null,
        createdAt: now,
        updatedAt: now,
      },
    );
    const iterator = reader.watchEvents("cross-process")[Symbol.asyncIterator]();
    const next = iterator.next();
    await writer.appendEvent("cross-process", "root", "external.event", {});
    await expect(next).resolves.toMatchObject({ value: { type: "external.event" } });
    await iterator.return?.();
  });
});

describe("ExpertTeam declaration", () => {
  it("validates allowlists and limits", async () => {
    const { expert } = await fixture();
    expect(() =>
      defineExpertTeam({
        id: "invalid",
        version: "1.0.0",
        coordinator: expert,
        members: [],
        delegation: { allow: { solo: ["missing"] } },
      }),
    ).toThrow("unknown");
  });
});

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
