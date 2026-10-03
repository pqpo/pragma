import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertExecutableDefinition,
  createFileExpertSessionStore,
  createNoopLoggerProvider,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  defineExpertTeam,
  defineFlow,
  fingerprintExpertExecutionDefinition,
  markStopOnlyDefinition,
  type RuntimeNativeSessionContext,
} from "../src/index.ts";
import { runExpertInvocation } from "../src/execution/expert-runner.ts";
import { FlowExecutionManager, runNestedFlowInvocation } from "../src/flow/flow-execution.ts";
import {
  createInMemoryExecutionStore,
  defineRuntimeTestDriver,
  openRuntimeSession,
} from "../src/testing/index.ts";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "pragma-stop-definition-"));
  homes.push(home);
  let holdTurns = false;
  const create = vi.fn((context: RuntimeNativeSessionContext) => ({
    id: `native-${context.systemSessionId}`,
  }));
  const restore = vi.fn((context: RuntimeNativeSessionContext) => ({
    id: context.request.runtimeSession!.id,
  }));
  const close = vi.fn(() => undefined);
  const start = vi.fn(async (_session: { id: string }, turn: { signal: AbortSignal }) => {
    if (holdTurns) {
      await new Promise<never>((_resolve, reject) => {
        if (turn.signal.aborted) reject(turn.signal.reason);
        else
          turn.signal.addEventListener("abort", () => reject(turn.signal.reason), { once: true });
      });
    }
    return { outputText: "done" };
  });
  const runtime = defineRuntimeTestDriver<never, { id: string }>({
    descriptor: { id: "stop-fixture", kind: "test", displayName: "Stop fixture" },
    createSession: create,
    restoreSession: restore,
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: start,
    mapEvent: () => ({ events: [] }),
    cancelTurn: () => undefined,
    closeSession: close,
  });
  const expert = await defineExpert({
    id: "st0pexpert0000001",
    name: "Stop fixture",
    description: "Stop fixture",
    scope: "test",
    tags: [],
    workspace: home,
    pragmaHome: home,
  });
  const executions = createInMemoryExecutionStore();
  const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });
  const runtimes = createStaticRuntimeResolver({
    runtimes: [runtime],
    defaultRuntimeId: "stop-fixture",
  });
  const app = createPragma({
    pragmaHome: home,
    executionStore: executions,
    expertSessionStore: sessions,
    loggerProvider: createNoopLoggerProvider(),
    runtimes,
  });
  return {
    home,
    expert,
    executions,
    sessions,
    runtimes,
    app,
    runtime,
    create,
    restore,
    start,
    close,
    hold: () => {
      holdTurns = true;
    },
  };
}

const rejected = { code: "STOP_ONLY_DEFINITION" };

describe("stop-only definition execution boundary", () => {
  it("marks frozen definitions without changing their identity or descriptor", async () => {
    const { expert } = await fixture();
    const keys = Reflect.ownKeys(expert);
    const before = fingerprintExpertExecutionDefinition(expert);
    expect(markStopOnlyDefinition(expert)).toBe(expert);
    expect(fingerprintExpertExecutionDefinition(expert)).toBe(before);
    expect(Reflect.ownKeys(expert)).toEqual(keys);
    expect(() => assertExecutableDefinition(expert)).toThrowError(
      expect.objectContaining(rejected),
    );
    const frozen = Object.freeze({ id: "frozen" });
    expect(markStopOnlyDefinition(frozen)).toBe(frozen);
    expect(() => assertExecutableDefinition({ id: "frozen" })).not.toThrow();
  });

  it.each(["expert", "team", "team member"] as const)(
    "rejects new %s Sessions before native or durable creation",
    async (kind) => {
      const { expert, home, app, executions, create } = await fixture();
      const coordinator =
        kind === "team member"
          ? await defineExpert({
              id: "st0pexpert0000002",
              name: "Coordinator",
              description: "Coordinator",
              tags: [],
              scope: "test",
              workspace: home,
              pragmaHome: home,
            })
          : expert;
      const target =
        kind === "expert"
          ? expert
          : defineExpertTeam({
              id: "st0pteam000000001",
              coordinator,
              members: kind === "team member" ? [expert] : [],
              delegation: {},
            });
      markStopOnlyDefinition(kind === "team member" ? expert : target);
      const persist = vi.spyOn(executions, "create");
      await expect(app.experts.createSession(target)).rejects.toMatchObject(rejected);
      expect(create).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it("rejects Flow start/recover and preserves the marker through FlowSpec compilation and nesting", async () => {
    const { app, expert, start } = await fixture();
    const handler = vi.fn(() => "done");
    const spec = defineFlow({ id: "st0pflow000000001" });
    spec.compose(({ start, end }) => start(spec.task({ id: "task", handler })).next(end()));
    markStopOnlyDefinition(spec);
    await expect(app.flows.start(spec, { input: null })).rejects.toMatchObject(rejected);
    const flow = spec.compile();
    await expect(app.flows.recover(flow, { executionId: "existing" })).rejects.toMatchObject(
      rejected,
    );
    const parent = defineFlow({ id: "st0pflow000000002" });
    const nested = parent.use("nested", spec);
    parent.compose(({ start, end }) => start(nested).next(end()));
    await expect(app.flows.start(parent, { input: null })).rejects.toMatchObject(rejected);
    const expertFlow = defineFlow({ id: "st0pflow000000003" });
    const step = expertFlow.use("expert", markStopOnlyDefinition(expert));
    expertFlow.compose(({ start, end }) => start(step).next(end()));
    await expect(app.flows.start(expertFlow, { input: null })).rejects.toMatchObject(rejected);
    expect(handler).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("allows Session recovery and native snapshot stop while fencing admission and queue pumping", async () => {
    const { app, expert, home, runtime, sessions, executions, start, restore, close } =
      await fixture();
    const original = await app.experts.createSession(expert);
    const first = await original.prompt("first");
    await first.result;
    await first.settled;
    const snapshot = (await original.getState()).contexts[
      (await original.getState()).rootContextId
    ]!.snapshot!;
    await original.releaseAfterTerminal();
    // Persist a real queued transaction before taking the cold recovery lease.
    const executionId = "persisted-stop-queue";
    const record = (await executions.get(first.executionId))!;
    const invocation = (await executions.getInvocation(first.executionId, first.executionId))!;
    const now = new Date().toISOString();
    await sessions.enqueue({
      execution: {
        ...record,
        executionId,
        rootInvocationId: executionId,
        status: "queued",
        version: 0,
        lastAppliedSequence: 0,
        state: {},
      },
      rootInvocation: {
        ...invocation,
        invocationId: executionId,
        rootInvocationId: executionId,
        status: "queued",
      },
      prompt: {
        requestId: "queued-stop",
        sessionId: original.sessionId,
        content: "queued",
        purpose: "user",
        mode: "enqueue",
        executionId,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      },
    });
    const recovered = await app.experts.resumeSession(markStopOnlyDefinition(expert), {
      sessionId: original.sessionId,
    });
    try {
      await expect(recovered.prompt("send")).rejects.toMatchObject(rejected);
      await expect(recovered.prompt("steer", { mode: "steer" })).rejects.toMatchObject(rejected);
      await expect(recovered.resumePromptQueue()).rejects.toMatchObject(rejected);
      await expect(recovered.attemptQueuedPromptSteer("queued-stop")).rejects.toMatchObject(
        rejected,
      );
      await expect(recovered.steerQueuedPrompt("queued-stop")).rejects.toMatchObject(rejected);
      await expect(recovered.compactRootContext()).rejects.toMatchObject(rejected);
      await recovered.abort("interrupt"); // This ordinarily unpauses the pump.
      await recovered.waitForPromptProcessing();
      expect(
        (await recovered.getPromptQueue()).find((prompt) => prompt.requestId === "queued-stop")
          ?.status,
      ).toBe("queued");
      expect(start).toHaveBeenCalledOnce();
      await recovered.stopForDeletion("stop recovered native");
      // Session recovery restores Native handles only when needed. Exercise the
      // actual owned snapshot boundary without dispatching any prompt.
      const native = await openRuntimeSession(runtime, {
        agent: expert,
        owner: {
          type: "expert-session",
          ownerId: recovered.sessionId,
          contextId: (await recovered.getState()).rootContextId,
        },
        pragmaHome: home,
        systemSessionId: snapshot.systemSessionId,
        runtimeSession: snapshot.runtimeSession,
      });
      await native.stopForDeletion?.();
      await native.close();
      expect(restore).toHaveBeenCalledOnce();
      expect(restore.mock.calls[0]![0].request).toMatchObject({
        systemSessionId: snapshot.systemSessionId,
        runtimeSession: snapshot.runtimeSession,
      });
      expect(close).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledOnce();
    } finally {
      await recovered.close();
    }
  });

  it("fences native submission even when a caller restores a Runtime directly", async () => {
    const { expert, home, runtime, start, close, create, restore } = await fixture();
    const owner = {
      type: "expert-session" as const,
      ownerId: "direct-stop",
      contextId: "direct-context",
    };
    const original = await openRuntimeSession(runtime, {
      agent: expert,
      owner,
      pragmaHome: home,
      systemSessionId: "direct-system-session",
    });
    const snapshot = original.info();
    await original.close();
    markStopOnlyDefinition(expert);
    await expect(
      openRuntimeSession(runtime, { agent: expert, owner, pragmaHome: home }),
    ).rejects.toMatchObject(rejected);
    expect(create).toHaveBeenCalledOnce();
    const native = await openRuntimeSession(runtime, {
      agent: expert,
      owner,
      pragmaHome: home,
      systemSessionId: snapshot.systemSessionId,
      runtimeSession: snapshot.runtimeSession,
    });
    try {
      expect(() => native.submit({ query: "execute", execution: {} })).toThrowError(
        expect.objectContaining(rejected),
      );
      expect(start).not.toHaveBeenCalled();
    } finally {
      await native.close();
    }
    expect(restore).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("rejects direct Invocation entry points before ownership, binding, or context access", async () => {
    const { expert } = await fixture();
    await expect(
      runExpertInvocation({ expert: markStopOnlyDefinition(expert) } as Parameters<
        typeof runExpertInvocation
      >[0]),
    ).rejects.toMatchObject(rejected);
    const spec = defineFlow({ id: "st0pflow000000004" });
    spec.compose(({ start, end }) =>
      start(spec.task({ id: "task", handler: () => "done" })).next(end()),
    );
    await expect(
      runNestedFlowInvocation({ flow: markStopOnlyDefinition(spec.compile()) } as Parameters<
        typeof runNestedFlowInvocation
      >[0]),
    ).rejects.toMatchObject(rejected);
  });

  it("stops a real cold Flow snapshot without dispatching another native turn", async () => {
    const { home, expert, executions, runtimes, hold, start, restore } = await fixture();
    hold();
    const spec = defineFlow({ id: "st0pflow000000005" });
    const step = spec.use("expert", expert);
    spec.compose(({ start, end }) => start(step).next(end()));
    const manager = new FlowExecutionManager(executions, runtimes, undefined, home);
    const live = await manager.start(spec, { input: null });
    void live.result.catch(() => undefined);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const record = (await executions.get(live.executionId))!;
    const invocations = await executions.listInvocations(live.executionId);
    const contexts = await executions.listContexts(live.executionId);
    expect(contexts[0]?.snapshot).toBeDefined();
    delete record.state["__recoveryClaim"];
    const cold = createInMemoryExecutionStore();
    await cold.create(
      record,
      invocations.find((invocation) => invocation.invocationId === record.rootInvocationId)!,
    );
    await cold.commit({
      commitId: "cold-snapshot",
      executionId: live.executionId,
      invocationPuts: invocations.filter(
        (invocation) => invocation.invocationId !== record.rootInvocationId,
      ),
      contextPuts: contexts,
      agentPuts: await executions.listAgents(live.executionId),
    });
    await live.cancel("simulated shutdown");
    await live.result.catch(() => undefined);
    markStopOnlyDefinition(expert);
    const stopFlow = markStopOnlyDefinition(spec.compile());
    const stopped = new FlowExecutionManager(cold, runtimes, undefined, home);
    await stopped.stop(stopFlow, { executionId: live.executionId });
    expect((await cold.get(live.executionId))?.status).toBe("cancelled");
    expect(start).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(restore.mock.calls[0]![0].request).toMatchObject({
      systemSessionId: contexts[0]!.snapshot!.systemSessionId,
      runtimeSession: contexts[0]!.snapshot!.runtimeSession,
    });
  });
});
