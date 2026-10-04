import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createFileExpertSessionStore,
  createNoopLoggerProvider,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  defineFlow,
  PragmaPaths,
  type ExpertSession,
  type FlowExecution,
  type RuntimeNativeSessionContext,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalHostMissionCommandAdmission } from "../../src/mission-command-admission.ts";
import { createLocalHostRunMemory } from "../../src/run-memory.ts";
import { createSqliteExecutionStore } from "../../src/execution/sqlite-execution-store.ts";
import { MissionExecutionOwner } from "../../src/missions/execution-owner.ts";
import {
  createMissionExecutionKernel,
  type MissionExecutionSubject,
} from "../../src/missions/execution-kernel.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const session of f.openSessions)
      await session.releaseAfterTerminal({ waitForIdle: true }).catch(() => undefined);
    for (const flow of f.openFlows) await flow.releaseRuntimeResources().catch(() => undefined);
    await f.executions.close();
    await rm(f.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("shared Mission execution kernel with durable Core stores", { timeout: 15_000 }, () => {
  it.each(["missing-record", "missing-association"])(
    "rejects explicit Session recovery with %s before allocation or native dispatch",
    async (missing) => {
      const f = await fixture();
      let priorId = "owned-execution";
      if (missing === "missing-record") {
        const original = await f.app.experts.createSession(f.expert, {
          sessionId: "missing-session",
        });
        f.openSessions.push(original);
        const turn = await original.prompt("original side effect", {
          requestId: "original-request",
        });
        await turn.result;
        priorId = turn.executionId;
        await original.releaseAfterTerminal({ waitForIdle: true });
        await f.sessions.delete(original.sessionId);
        f.created.mockClear();
        f.dispatched.mockClear();
      }
      const priorRecord = await f.executions.get(priorId);
      const create = vi.spyOn(f.app.experts, "createSession");
      const resume = vi.spyOn(f.app.experts, "resumeSession");
      const subject: MissionExecutionSubject = {
        missionId: "mission",
        intent: "recover",
        priorExecution: {
          id: priorId,
          status: priorRecord?.status ?? "running",
          ...(missing === "missing-record" ? { sessionId: "missing-session" } : {}),
        },
        request: { requestId: "recover-request", prompt: "must not run again" },
      };
      await expect(
        f.kernel.start(subject, {
          kind: "session",
          app: f.app,
          definition: f.expert,
          createOptions: { sessionId: "accidental-new-session" },
        }),
      ).rejects.toMatchObject({
        code: "COMMAND_REJECTED",
        details: { reason: "session_not_found" },
      });
      expect(create).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(f.created).not.toHaveBeenCalled();
      expect(f.dispatched).not.toHaveBeenCalled();
      expect(await f.sessions.get("accidental-new-session")).toBeUndefined();
      expect(await f.executions.get(priorId)).toEqual(priorRecord);
    },
  );

  it.each([
    { input: "scalar" },
    { input: 37 },
    { input: false },
    { input: ["one", { two: 2 }] },
    { input: null },
    { input: undefined },
  ])(
    "preserves Flow input %j through Core and SQLite, defaulting only undefined",
    async ({ input }) => {
      const f = await fixture();
      const observed: unknown[] = [];
      const flow = defineFlow({ id: "input-preserving-flow" });
      const step = flow.task({
        id: "observe",
        handler: ({ input: actual }) => {
          observed.push(actual);
          return { accepted: true };
        },
      });
      flow.compose(({ start, end }) => start(step).next(end()));
      const started = await f.kernel.start(
        { missionId: "mission", intent: "start", request: { requestId: "flow-request", input } },
        { kind: "flow", app: f.app, definition: flow },
      );
      if (started.kind !== "native") throw new Error("Expected a fresh native execution");
      expect(started.owner.kind).toBe("flow");
      if (started.owner.kind !== "flow") throw new Error("Expected a Flow owner");
      const handle = started.owner.execution;
      f.openFlows.push(handle);
      await expect(handle.result).resolves.toEqual({ accepted: true });
      const expected = input === undefined ? {} : input;
      expect(observed).toEqual([expected]);
      expect(
        await f.executions.getInvocation(handle.executionId, handle.executionId),
      ).toMatchObject({
        input: expected,
      });
      expect((await f.executions.get(handle.executionId))?.status).toBe("succeeded");
      expect(f.dispatched).not.toHaveBeenCalled();
    },
  );

  it("reuses the actual persisted queued turn instead of issuing another prompt", async () => {
    let finishFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const f = await fixture(async (query) => {
      if (query === "first") await gate;
    });
    const session = await f.app.experts.createSession(f.expert, { sessionId: "original-session" });
    f.openSessions.push(session);
    try {
      const first = await session.prompt("first", { requestId: "first-request" });
      await vi.waitFor(() => expect(f.dispatched).toHaveBeenCalledTimes(1));
      const queued = await session.prompt("second", { requestId: "second-request" });
      const promptsBefore = await f.sessions.listPrompts(session.sessionId);
      expect(
        promptsBefore.find((prompt) => prompt.executionId === queued.executionId),
      ).toMatchObject({
        mode: "enqueue",
        status: "queued",
      });
      const prompt = vi.spyOn(session, "prompt");
      const opened = await f.kernel.start(
        {
          missionId: "mission",
          intent: "recover",
          priorExecution: {
            id: queued.executionId,
            status: "queued",
            sessionId: session.sessionId,
          },
          request: {
            requestId: "recovery-request",
            prompt: "this would duplicate the second turn",
          },
        },
        { kind: "session", app: f.app, definition: f.expert, existingSession: session },
      );
      if (opened.kind !== "native") throw new Error("Expected the original queued native turn");
      expect(opened.handle.executionId).toBe(queued.executionId);
      expect(opened.owner).toEqual({ kind: "session", session });
      expect(prompt).not.toHaveBeenCalled();
      expect(await f.sessions.listPrompts(session.sessionId)).toEqual(promptsBefore);
      expect(f.dispatched).toHaveBeenCalledTimes(1);
      finishFirst();
      await Promise.all([first.result, queued.result]);
      expect(f.dispatched.mock.calls.map(([query]) => query)).toEqual(["first", "second"]);
      expect((await f.sessions.get(session.sessionId))?.executionIds).toEqual([
        first.executionId,
        queued.executionId,
      ]);
      expect((await f.executions.get(queued.executionId))?.status).toBe("succeeded");
      const state = (await f.sessions.get(session.sessionId))!;
      const root = state.contexts[state.rootContextId]!;
      expect(root.owner).toEqual({ type: "expert-session", ownerId: session.sessionId });
      expect(
        await f.executions.getInvocation(queued.executionId, queued.executionId),
      ).toMatchObject({
        contextId: state.rootContextId,
      });
      expect(f.dispatched.mock.calls.map(([, nativeId]) => nativeId)).toEqual([
        root.snapshot!.systemSessionId,
        root.snapshot!.systemSessionId,
      ]);
      expect(root.snapshot?.runtimeSession.id).toBe(root.snapshot?.systemSessionId);
      expect(f.created).toHaveBeenCalledTimes(1);
    } finally {
      finishFirst();
    }
  });

  it("does not roll back optional admission after native acceptance when durable projection throws", async () => {
    const f = await fixture();
    const rollback = vi.fn(async () => undefined);
    const onPromptAdmitting = vi.fn(async () => rollback);
    let accepted!: Awaited<ReturnType<typeof f.kernel.start>>;
    await expect(
      f.kernel.admit(
        {
          missionId: "mission",
          intent: "start",
          request: { requestId: "accepted-request", prompt: "once" },
        },
        { onPromptAdmitting },
        async (admission) => {
          accepted = await f.kernel.start(
            {
              missionId: "mission",
              intent: "start",
              request: { requestId: "accepted-request", prompt: "once" },
            },
            {
              kind: "session",
              app: f.app,
              definition: f.expert,
              createOptions: { sessionId: "accepted-session" },
            },
          );
          if (accepted.kind !== "native") throw new Error("Expected native acceptance");
          if (accepted.owner.kind === "session") f.openSessions.push(accepted.owner.session);
          await admission.accepted(accepted.handle.executionId);
          throw new Error("Durable projection failed after native acceptance");
        },
      ),
    ).rejects.toThrow("Durable projection failed after native acceptance");
    if (accepted.kind !== "native") throw new Error("Expected native acceptance");
    await expect(accepted.handle.result).resolves.toBe("done");
    expect(onPromptAdmitting).toHaveBeenCalledExactlyOnceWith("mission", "accepted-request");
    expect(rollback).not.toHaveBeenCalled();
    expect(f.dispatched.mock.calls.map(([query]) => query)).toEqual(["once"]);
    expect((await f.sessions.get("accepted-session"))?.executionIds).toEqual([
      accepted.handle.executionId,
    ]);
    expect((await f.executions.get(accepted.handle.executionId))?.status).toBe("succeeded");
  });

  it("returns a terminal Flow receipt without replaying its Native side effect", async () => {
    const f = await fixture();
    const flow = defineFlow({ id: "receipt-flow" });
    const step = flow.use("once", f.expert);
    flow.compose(({ start, end }) => start(step).next(end()));
    const first = await f.kernel.start(
      { missionId: "mission", intent: "start", request: { requestId: "flow-once", input: {} } },
      { kind: "flow", app: f.app, definition: flow },
    );
    if (first.kind !== "native" || first.owner.kind !== "flow") throw new Error("Expected Flow");
    f.openFlows.push(first.owner.execution);
    await first.handle.result;
    await first.owner.execution.releaseRuntimeResources();
    const before = await f.executions.get(first.handle.executionId);
    const replay = await f.kernel.start(
      {
        missionId: "mission",
        intent: "recover",
        priorExecution: { id: first.handle.executionId, status: "succeeded" },
        request: { requestId: "flow-once", input: {} },
      },
      { kind: "flow", app: f.app, definition: flow },
    );
    expect(replay.acceptance).toBe("receipt");
    if (replay.kind !== "receipt") throw new Error("Expected a read-only durable receipt");
    expect(await replay.view.getState()).toEqual(before);
    expect(await f.executions.get(first.handle.executionId)).toEqual(before);
    expect(f.dispatched).toHaveBeenCalledOnce();
    expect(f.created).toHaveBeenCalledOnce();
    expect(
      await f.kernel.idleReady(
        {
          missionId: "mission",
          priorExecution: { id: first.handle.executionId, status: "succeeded" },
          request: { requestId: "idle" },
        },
        undefined,
        60_000,
      ),
    ).toMatchObject({ ready: false });
    expect(
      await f.kernel.idleReady(
        {
          missionId: "mission",
          priorExecution: { id: first.handle.executionId, status: "succeeded" },
          request: { requestId: "idle" },
        },
        undefined,
        0,
      ),
    ).toMatchObject({ ready: true });
  });

  it("repairs A's failed projection receipt while B remains the active Native and Memory owner", async () => {
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const f = await fixture(async (query) => {
      if (query === "B") await bGate;
    });
    const memoryClosed = vi.fn(async () => undefined);
    const memory = createLocalHostRunMemory({ pragmaHome: f.home, beforeFeedClose: memoryClosed });
    const session = await f.app.experts.createSession(f.expert, { sessionId: "receipt-session" });
    f.openSessions.push(session);
    const register = vi.spyOn(memory, "register");
    let currentExecution: string | undefined;
    let observerExecution: string | undefined;
    let projectionFails = true;
    const onNativeAccepted = vi.fn(async ({ turn }: { turn: { executionId: string } }) => {
      currentExecution = turn.executionId;
      observerExecution = turn.executionId;
      await memory.register({ missionId: "mission", executionId: turn.executionId });
    });
    const project = vi.fn(async ({ turn }: { turn: { executionId: string } }) => {
      if (projectionFails) throw new Error("Timeline failed after acceptance");
      return turn.executionId;
    });
    const admission = createLocalHostMissionCommandAdmission({
      executionKernel: f.kernel,
      getMission: async () => ({
        id: "mission",
        lifecycleStatus: "active",
        executor: { kind: "expert" },
        execution: true,
      }),
      admit: async (_id, operation) => await operation(),
      withController: async (_id, operation) => await operation(),
      settleTerminal: async () => false,
      contextBindingsChanging: () => false,
      successorRequired: () => false,
      hasActive: () => true,
      session: () => session,
      assertReady: async () => undefined,
      startInitialRun: async () => undefined,
      prepare: async (_mission, input) => ({
        session,
        subject: { missionId: input.id, request: { requestId: input.requestId } },
        definitionChanged: false,
        contextStoresChanged: false,
        rememberSession: () => undefined,
      }),
      forgetSession: () => undefined,
      onPromptAdmitting: (id, requestId) => memory.beginPrompt(id, requestId),
      onNativeAccepted,
      projectAccepted: project,
    });
    try {
      await memory.bindings({ missionId: "mission", goal: "A", bindingId: "stable" });
      await expect(
        admission({ id: "mission", content: "A", requestId: "A-request" }),
      ).rejects.toMatchObject({ name: "MissionSemanticWritePendingError" });
      const a = (await session.listTurns())[0]!;
      await a.result;
      await memory.complete("mission", a.executionId);
      projectionFails = false;
      const b = await admission({ id: "mission", content: "B", requestId: "B-request" });
      await vi.waitFor(() => expect(f.dispatched).toHaveBeenCalledTimes(2));
      expect(currentExecution).toBe(b);
      onNativeAccepted.mockClear();
      register.mockClear();
      const projectedBefore = project.mock.calls.length;
      expect(await admission({ id: "mission", content: "A", requestId: "A-request" })).toBe(
        a.executionId,
      );
      expect(project).toHaveBeenCalledTimes(projectedBefore + 1);
      expect(onNativeAccepted).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(currentExecution).toBe(b);
      expect(observerExecution).toBe(b);
      expect((await session.getState()).activeExecutionId).toBe(b);
      expect(await f.kernel.receiptStatus(b)).toBe("running");
      expect(f.dispatched.mock.calls.map(([query]) => query)).toEqual(["A", "B"]);
      await memory.complete("mission", a.executionId);
      await memory.close();
      expect(memoryClosed).not.toHaveBeenCalled();
      const stateDb = new DatabaseSync(
        join(
          new PragmaPaths({ pragmaHome: f.home }).memoryModuleStateRoot("pragma.memory.episodic"),
          "jobs.sqlite",
        ),
        { readOnly: true },
      );
      try {
        expect(
          stateDb
            .prepare("SELECT state FROM conversation_activity")
            .all()
            .map((row) => row["state"]),
        ).toEqual(["running"]);
      } finally {
        stateDb.close();
      }
      releaseB();
      await (await session.listTurns()).find((turn) => turn.executionId === b)!.result;
      await memory.complete("mission", b);
      await memory.close();
      expect(memoryClosed).toHaveBeenCalledOnce();
    } finally {
      releaseB();
      await memory.close();
    }
  });

  it("registers a running receipt in a reconstructed Host Memory scope without another Native dispatch", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = await fixture(async () => await gate);
    const session = await f.app.experts.createSession(f.expert, { sessionId: "running-receipt" });
    f.openSessions.push(session);
    const turn = await session.prompt("running", { requestId: "running-request" });
    await vi.waitFor(() => expect(f.dispatched).toHaveBeenCalledOnce());
    const before = await f.sessions.get(session.sessionId);
    // Reconstruct only Host resources: the same real Core owner remains running.
    const closed = vi.fn(async () => undefined);
    const memory = createLocalHostRunMemory({ pragmaHome: f.home, beforeFeedClose: closed });
    const register = vi.spyOn(memory, "register");
    const linked = vi.fn(async ({ turn: accepted }: { turn: { executionId: string } }) => {
      await memory.register({ missionId: "mission", executionId: accepted.executionId });
    });
    const admission = createLocalHostMissionCommandAdmission({
      executionKernel: f.kernel,
      getMission: async () => ({
        id: "mission",
        lifecycleStatus: "active",
        executor: { kind: "expert" },
        execution: true,
      }),
      admit: async (_id, operation) => await operation(),
      withController: async (_id, operation) => await operation(),
      settleTerminal: async () => false,
      contextBindingsChanging: () => false,
      successorRequired: () => false,
      hasActive: () => true,
      session: () => undefined,
      assertReady: async () => undefined,
      startInitialRun: async () => undefined,
      prepare: async (_mission, input) => ({
        subject: {
          missionId: input.id,
          intent: "recover" as const,
          priorExecution: { id: turn.executionId, status: "running", sessionId: session.sessionId },
          request: { requestId: input.requestId },
        },
        nativeResources: { kind: "session" as const, app: f.app, definition: f.expert },
        definitionChanged: false,
        contextStoresChanged: false,
        rememberSession: () => undefined,
      }),
      forgetSession: () => undefined,
      onPromptAdmitting: (id, requestId) => memory.beginPrompt(id, requestId),
      onNativeAccepted: linked,
      projectAccepted: async ({ turn: receipt }) => receipt.executionId,
    });
    try {
      expect(
        await admission({ id: "mission", requestId: "running-request", content: "running" }),
      ).toBe(turn.executionId);
      expect(register).toHaveBeenCalledExactlyOnceWith({
        missionId: "mission",
        executionId: turn.executionId,
      });
      expect(linked).toHaveBeenCalledOnce();
      expect(f.dispatched).toHaveBeenCalledOnce();
      expect(f.created).toHaveBeenCalledOnce();
      expect(await f.sessions.get(session.sessionId)).toEqual(before);
      await memory.close();
      expect(closed).not.toHaveBeenCalled();
      finish();
      await turn.result;
      await memory.complete("mission", turn.executionId);
      await memory.close();
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      finish();
      await turn.result.catch(() => undefined);
      await memory.complete("mission", turn.executionId);
      await memory.close();
    }
  });

  it("keeps a real human-checkpoint Session out of idle release without a warm owner", async () => {
    const f = await fixture(async (_query, context) => {
      await context.request.humanInteractionHandler!({
        kind: "user_question",
        toolName: "askUserQuestion",
        toolCallId: "waiting",
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            kind: "single_choice",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ],
      });
    });
    const session = await f.app.experts.createSession(f.expert, { sessionId: "waiting-session" });
    f.openSessions.push(session);
    const turn = await session.prompt("wait", { requestId: "waiting-request" });
    void turn.result.catch(() => undefined);
    await vi.waitFor(async () =>
      expect(
        (await f.executions.readEvents(turn.executionId)).some(
          (event) => event.type === "human.requested",
        ),
      ).toBe(true),
    );
    await session.checkpointWaitingHuman();
    await session.releaseAfterHumanCheckpoint();
    f.openSessions.splice(f.openSessions.indexOf(session), 1);
    const state = (await f.sessions.get(session.sessionId))!;
    expect(state.lastStatus).toBe("waiting");
    expect(state.activeExecutionId).toBeUndefined();
    expect(
      (await f.sessions.listPrompts(session.sessionId)).some(
        (prompt) => prompt.status === "running",
      ),
    ).toBe(false);
    expect(
      await f.kernel.idleReady(
        {
          missionId: "mission",
          sessionId: session.sessionId,
          priorExecution: { id: turn.executionId, status: "waiting", sessionId: session.sessionId },
          request: { requestId: "idle" },
        },
        undefined,
        0,
      ),
    ).toMatchObject({ ready: false, executionId: turn.executionId });
  });

  it("replays successor Session retirement when its Execution is terminal but the Session transaction fails", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = await fixture(async () => await pending);
    const session = await f.app.experts.createSession(f.expert, {
      sessionId: "partial-retirement",
    });
    f.openSessions.push(session);
    const turn = await session.prompt("original", { requestId: "partial-original" });
    await vi.waitFor(() => expect(f.dispatched).toHaveBeenCalledOnce());
    const snapshot = (await f.sessions.readSnapshot(session.sessionId))!;
    expect(snapshot.session.activeExecutionId).toBe(turn.executionId);
    // Preserve the real Session document written before Core's terminal
    // Execution commit to represent a crash before its following Session write.
    finish();
    await turn.result;
    await session.releaseAfterTerminal({ waitForIdle: true });
    await f.sessions.transact(session.sessionId, () => ({
      result: undefined,
      session: snapshot.session,
      prompts: snapshot.prompts,
    }));
    const committed = await f.executions.get(turn.executionId);
    expect(committed?.status).toBe("succeeded");
    const subject: MissionExecutionSubject = {
      missionId: "mission",
      sessionId: session.sessionId,
      request: { requestId: "successor" },
    };
    const transaction = vi
      .spyOn(f.sessions, "transact")
      .mockRejectedValueOnce(new Error("Session disk unavailable"));
    await expect(f.kernel.interruptSupersededSession(subject)).rejects.toThrow(
      "Session disk unavailable",
    );
    transaction.mockRestore();
    expect((await f.sessions.get(session.sessionId))?.activeExecutionId).toBe(turn.executionId);
    await f.kernel.interruptSupersededSession(subject);
    expect(await f.sessions.get(session.sessionId)).toMatchObject({ lastStatus: "interrupted" });
    expect((await f.sessions.get(session.sessionId))?.activeExecutionId).toBeUndefined();
    expect(
      (await f.sessions.listPrompts(session.sessionId)).find(
        (prompt) => prompt.executionId === turn.executionId,
      ),
    ).toMatchObject({ status: "interrupted" });
    expect(await f.executions.get(turn.executionId)).toEqual(committed);
    expect(f.dispatched).toHaveBeenCalledOnce();
    expect(f.created).toHaveBeenCalledOnce();
  });

  it.each(["preparation-failed", "noop"])(
    "rolls back optional admission on %s without allocating a Session or sending a turn",
    async (outcome) => {
      const f = await fixture();
      const rollback = vi.fn(async () => undefined);
      const onPromptAdmitting = vi.fn(async () => rollback);
      const subject: MissionExecutionSubject = {
        missionId: "mission",
        intent: "recover",
        sessionId: "missing-session",
        request: { requestId: "unaccepted-request", prompt: "must not be sent" },
      };
      const operation = f.kernel.admit(subject, { onPromptAdmitting }, async () => {
        if (outcome === "noop") return undefined;
        return await f.kernel.openOwner(subject, {
          kind: "session",
          app: f.app,
          definition: f.expert,
          createOptions: { sessionId: "must-not-create" },
        });
      });
      if (outcome === "noop") await expect(operation).resolves.toBeUndefined();
      else
        await expect(operation).rejects.toMatchObject({ details: { reason: "session_not_found" } });
      expect(rollback).toHaveBeenCalledOnce();
      expect(f.created).not.toHaveBeenCalled();
      expect(f.dispatched).not.toHaveBeenCalled();
      expect(await f.sessions.get("must-not-create")).toBeUndefined();
    },
  );
});

async function fixture(
  beforeTurn?: (query: string, context: RuntimeNativeSessionContext) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "pragma-execution-kernel-"));
  const executions = createSqliteExecutionStore({ pragmaHome: home });
  const sessions = createFileExpertSessionStore({ pragmaHome: home, executions });
  const created = vi.fn();
  const dispatched = vi.fn<(query: string, nativeId: string) => Promise<void>>(
    async () => undefined,
  );
  const runtime = defineRuntimeTestDriver<
    never,
    { id: string; context: RuntimeNativeSessionContext }
  >({
    descriptor: { id: "fixture", kind: "fixture", displayName: "Kernel fixture" },
    createSession: (context) => {
      created(context.systemSessionId);
      return { id: context.systemSessionId, context };
    },
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: async (session, turn) => {
      await dispatched(turn.rawQuery, session.id);
      await beforeTurn?.(turn.rawQuery, session.context);
      return { outputText: "done" };
    },
    mapEvent: () => ({ events: [] }),
  });
  const runtimes = createStaticRuntimeResolver({
    runtimes: [runtime],
    defaultRuntimeId: "fixture",
  });
  const app = createPragma({
    pragmaHome: home,
    runtimes,
    executionStore: executions,
    expertSessionStore: sessions,
    loggerProvider: createNoopLoggerProvider(),
  });
  const expert = await defineExpert({
    id: "aaaaaaaaaaaaaaaa",
    name: "Kernel Expert",
    scope: "test",
    description: "",
    tags: [],
    workspace: home,
    pragmaHome: home,
  });
  const f = {
    home,
    app,
    expert,
    executions,
    sessions,
    created,
    dispatched,
    openSessions: [] as ExpertSession[],
    openFlows: [] as FlowExecution[],
    kernel: createMissionExecutionKernel({
      executions,
      sessions,
      owners: new MissionExecutionOwner(),
    }),
  };
  fixtures.push(f);
  return f;
}
