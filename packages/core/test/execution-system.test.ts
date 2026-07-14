import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createTeamDelegationTool,
  readAgentDelegationDefinition,
} from "../src/agent/agent-launcher.ts";

import {
  createAgentLauncher,
  createPragma,
  createFileExecutionStore,
  createFileExpertSessionStore,
  createRuntimeRegistry,
  defineExpert,
  defineExpertTeam,
  defineFlow,
  defineRuntimeDriver,
  PragmaPaths,
  type AgentMessageUsage,
  type RuntimeDriverSessionContext,
} from "../src/index.ts";

interface FakeSession {
  readonly context: RuntimeDriverSessionContext;
  readonly id: string;
}

interface FakeRuntimeStats {
  createSessionCalls: number;
  restoreSessionCalls: number;
  closeSessionCalls: number;
  cancelTurnCalls: number;
  executionIds: string[];
}

function createFakeRuntimeStats(): FakeRuntimeStats {
  return {
    createSessionCalls: 0,
    restoreSessionCalls: 0,
    closeSessionCalls: 0,
    cancelTurnCalls: 0,
    executionIds: [],
  };
}

interface FakeRuntimeOptions {
  readonly closeError?: string;
  readonly createDelayMs?: number;
  readonly delayMs?: number;
  readonly delegateContext?: "fresh" | "reuse";
  readonly delegateRuntime?: (query: string) => string | undefined;
  readonly delegationTargets?: Readonly<Record<string, string>>;
  readonly failQuery?: string;
  readonly onSteer?: () => void;
  readonly runtimeId?: string;
  readonly stats?: FakeRuntimeStats;
  readonly usage?: AgentMessageUsage;
}

function createFakeRuntime(options: FakeRuntimeOptions = {}) {
  const stats = options.stats;
  return defineRuntimeDriver<never, FakeSession>({
    descriptor: {
      id: options.runtimeId ?? "fake",
      kind: "fake",
      displayName: options.runtimeId ?? "Fake",
    },
    createSession: async (context) => {
      if (stats !== undefined) stats.createSessionCalls += 1;
      if (options.createDelayMs !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.createDelayMs));
      }
      return { context, id: `native-${context.systemSessionId}` };
    },
    restoreSession: (context) => {
      if (stats !== undefined) stats.restoreSessionCalls += 1;
      return { context, id: context.request.runtimeSession!.id };
    },
    readSession: (session) => ({ runtimeSessionId: session.id }),
    async startTurn(session, turn) {
      const executionId = session.context.request.executionContext?.executionId;
      if (stats !== undefined && executionId !== undefined) stats.executionIds.push(executionId);
      if (options.delayMs !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (turn.rawQuery === options.failQuery) throw new Error("fake turn failed");
      const delegate = session.context.agent.tools?.find((tool) => tool.name === "delegate_expert");
      const delegationTarget =
        options.delegationTargets?.[session.context.agent.id] ??
        (session.context.agent.id === "lead" ? "member" : undefined);
      let output = `${session.context.agent.id}:${turn.rawQuery}`;
      if (delegate !== undefined && delegationTarget !== undefined) {
        const delegated = await delegate.call(
          {
            expertId: delegationTarget,
            prompt: "subtask",
            context: options.delegateContext ?? "reuse",
            runtime: options.delegateRuntime?.(turn.rawQuery),
          },
          turn.signal,
          { execution: session.context.request.executionContext },
        );
        output = `${session.context.agent.id}:${delegated.text}`;
      }
      turn.stream.write({
        runId: turn.runId,
        source: turn.source,
        type: "message.delta",
        payload: { role: "assistant", contentType: "text", delta: output },
      });
      return {
        outputText: output,
        runtimeSessionId: session.id,
        ...(options.usage === undefined ? {} : { usage: options.usage }),
      };
    },
    mapEvent: () => ({ events: [] }),
    cancelTurn: () => {
      if (stats !== undefined) stats.cancelTurnCalls += 1;
    },
    ...(options.onSteer === undefined
      ? {}
      : {
          steerTurn: () => {
            options.onSteer?.();
          },
        }),
    closeSession: () => {
      if (stats !== undefined) stats.closeSessionCalls += 1;
      if (options.closeError !== undefined) throw new Error(options.closeError);
    },
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

async function trackedFixture(options: Omit<FakeRuntimeOptions, "stats"> = {}) {
  const home = await mkdtemp(join(tmpdir(), "pragma-runtime-ownership-"));
  const stats = createFakeRuntimeStats();
  const runtime = createFakeRuntime({ ...options, stats });
  const app = createPragma({
    pragmaHome: home,
    runtimes: createRuntimeRegistry({ runtimes: [runtime], defaultRuntime: "fake" }),
  });
  const expert = await defineExpert({
    id: "tracked",
    name: "Tracked",
    description: "Tracked Runtime Expert",
    tags: [],
    version: "1.0.0",
    scope: "test",
    workspace: home,
  });
  return { home, app, expert, runtime, stats };
}

describe("ExpertSession", () => {
  it("streams only future events until terminal and exposes durable message history", async () => {
    const { app, expert } = await fixture(100);
    const session = await app.experts.createSession(expert);
    const turn = await session.prompt("hello", { requestId: "history" });
    const eventSubscription = await turn.subscribeEvents({ scope: { kind: "root" } });
    const outputSubscription = await turn.subscribeOutput({ scope: { kind: "root" } });
    const streamed = (async () => {
      const events = [];
      for await (const event of eventSubscription) events.push(event);
      return events;
    })();
    const outputs = (async () => {
      const items = [];
      for await (const item of outputSubscription) items.push(item);
      return items;
    })();

    await expect(turn.result).resolves.toBe("solo:hello");
    const events = await streamed;
    expect(events.some((event) => event.type === "invocation.succeeded")).toBe(true);
    expect(await turn.getMessageHistory()).toMatchObject([
      {
        messages: [
          { message: { role: "user", content: "hello" } },
          { message: { role: "assistant", content: [{ type: "text", text: "solo:hello" }] } },
        ],
      },
    ]);
    expect((await outputs).some((output) => output.channel === "message")).toBe(true);
    const sessionEvents = (await session.listEvents({ limit: 1_000 })).items;
    expect(sessionEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "session.created",
        "prompt.enqueued",
        "execution.attached",
        "invocation.message.appended",
        "invocation.succeeded",
      ]),
    );
    expect(sessionEvents.some((event) => event.type === "runtime.stream")).toBe(false);
    await Promise.all([eventSubscription.close(), outputSubscription.close()]);
    await session.close();
  });

  it("keeps one Runtime Session alive across prompts and closes it with the ExpertSession", async () => {
    const { home, app, expert, stats } = await trackedFixture();
    const session = await app.experts.createSession(expert);
    const first = await session.prompt("one", { requestId: "one" });
    await expect(first.result).resolves.toBe("tracked:one");
    const second = await session.prompt("two", { requestId: "two" });
    await expect(second.result).resolves.toBe("tracked:two");

    expect(stats.createSessionCalls).toBe(1);
    expect(stats.restoreSessionCalls).toBe(0);
    expect(stats.closeSessionCalls).toBe(0);
    expect(stats.executionIds).toEqual([first.executionId, second.executionId]);

    const competingApp = createPragma({
      pragmaHome: home,
      runtimes: createRuntimeRegistry({
        runtimes: [createFakeRuntime()],
        defaultRuntime: "fake",
      }),
    });
    await expect(
      competingApp.experts.resumeSession(expert, { sessionId: session.sessionId }),
    ).rejects.toThrow("active in another process");

    const closing = session.close();
    await expect(session.prompt("late", { requestId: "late" })).rejects.toThrow(
      "closing or closed",
    );
    await closing;
    await session.close();
    expect(stats.closeSessionCalls).toBe(1);
    await expect(
      app.experts.resumeSession(expert, { sessionId: session.sessionId }),
    ).rejects.toThrow("is closed");
  });

  it("persists turn usage and exposes a session total without consuming events", async () => {
    const perTurnUsage: AgentMessageUsage = {
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 5,
      totalTokens: 155,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.01, total: 0.34 },
    };
    const { app, expert } = await trackedFixture({ usage: perTurnUsage });
    const session = await app.experts.createSession(expert);
    const first = await session.prompt("one", { requestId: "usage-one" });
    await first.result;
    const second = await session.prompt("two", { requestId: "usage-two" });
    await second.result;

    await expect(first.usage).resolves.toEqual(perTurnUsage);
    await expect(second.usage).resolves.toEqual(perTurnUsage);
    expect(await session.getUsage()).toEqual({
      input: 200,
      output: 40,
      cacheRead: 60,
      cacheWrite: 10,
      totalTokens: 310,
      cost: { input: 0.2, output: 0.4, cacheRead: 0.06, cacheWrite: 0.02, total: 0.68 },
    });
    const historicalTurns = await session.listTurns();
    await expect(historicalTurns[0]?.usage).resolves.toEqual(perTurnUsage);
    expect((await first.getState()).usage).toEqual(perTurnUsage);
    await session.close();
  });

  it("releases the lease and leaves the session recoverable when Runtime cleanup fails", async () => {
    const { home, app, expert } = await trackedFixture({ closeError: "close failed" });
    const session = await app.experts.createSession(expert);
    await (
      await session.prompt("one", { requestId: "one" })
    ).result;

    await expect(session.close()).rejects.toThrow("close failed");
    expect((await session.getState()).status).toBe("open");

    const recoveryApp = createPragma({
      pragmaHome: home,
      runtimes: createRuntimeRegistry({
        runtimes: [createFakeRuntime()],
        defaultRuntime: "fake",
      }),
    });
    const recovered = await recoveryApp.experts.resumeSession(expert, {
      sessionId: session.sessionId,
    });
    await recovered.close();
  });

  it("allows another ExpertSession lease owner only after expiry", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-session-lease-"));
    const executions = createFileExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });
    const now = new Date().toISOString();
    await sessions.create({
      schemaVersion: "pragma.expert-session/v1",
      sessionId: "leased-session",
      expertId: "expert",
      expertVersion: "1.0.0",
      status: "open",
      queuedRequestIds: [],
      executionIds: [],
      contextIds: { root: "root" },
      runtimeContexts: {},
      createdAt: now,
      updatedAt: now,
    });

    await expect(sessions.claimLease("leased-session", "owner-a", 200)).resolves.toBe(true);
    await expect(sessions.claimLease("leased-session", "owner-b", 200)).resolves.toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 220));
    await expect(sessions.claimLease("leased-session", "owner-b", 200)).resolves.toBe(true);
    await sessions.releaseLease("leased-session", "owner-b");
  });

  it("reuses the Runtime Session after a failed prompt", async () => {
    const { app, expert, stats } = await trackedFixture({ failQuery: "fail" });
    const session = await app.experts.createSession(expert);
    const failed = await session.prompt("fail", { requestId: "fail" });
    await expect(failed.result).rejects.toThrow("fake turn failed");
    const recovered = await session.prompt("recover", { requestId: "recover" });
    await expect(recovered.result).resolves.toBe("tracked:recover");

    expect(stats.createSessionCalls).toBe(1);
    expect(stats.restoreSessionCalls).toBe(0);
    expect(stats.executionIds).toEqual([failed.executionId, recovered.executionId]);
    await session.close();
  });

  it("cancels only the active submission and reuses its Runtime Session", async () => {
    const { app, expert, stats } = await trackedFixture({ delayMs: 100 });
    const session = await app.experts.createSession(expert);
    const active = await session.prompt("slow", { requestId: "slow" });
    await waitUntil(async () => stats.executionIds.length === 1);
    const cancelled = expect(active.result).rejects.toThrow();
    await active.cancel("stop current turn");
    await cancelled;

    const next = await session.prompt("next", { requestId: "next" });
    await expect(next.result).resolves.toBe("tracked:next");
    expect(stats.createSessionCalls).toBe(1);
    expect(stats.cancelTurnCalls).toBeGreaterThan(0);
    expect(stats.executionIds).toEqual([active.executionId, next.executionId]);
    await session.close();
  });

  it("uses defineExpert as the only creation entry and makes requestId durable/idempotent", async () => {
    const { app, expert } = await fixture();
    expect("create" in expert).toBe(false);
    const session = await app.experts.createSession(expert);
    const first = await session.prompt("hello", { requestId: "same" });
    const duplicate = await session.prompt("hello", { requestId: "same" });
    expect(first.requestId).toBe("same");
    expect(duplicate.executionId).toBe(first.executionId);
    await expect(session.prompt("different", { requestId: "same" })).rejects.toThrow(
      "idempotency conflict",
    );
    await expect(first.result).resolves.toBe("solo:hello");

    const generated = await session.prompt("generated");
    expect(generated.requestId).not.toBe("");
    const generatedRetry = await session.prompt("generated", {
      requestId: generated.requestId,
    });
    expect(generatedRetry.executionId).toBe(generated.executionId);
    expect((await session.getPromptQueue()).at(-1)?.requestId).toBe(generated.requestId);
    expect((await session.listTurns()).at(-1)?.requestId).toBe(generated.requestId);
    await expect(generated.result).resolves.toBe("solo:generated");
    await session.close();
  });

  it("lets a standalone Expert delegate through an explicitly injected launcher", async () => {
    const { home, app } = await fixture();
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
    });
    const launcher = createAgentLauncher({
      experts: [member],
      context: "reuse",
      maxConcurrency: 2,
      maxDepth: 1,
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
      tools: [launcher.tool],
    });

    const session = await app.experts.createSession(lead);
    const turn = await session.prompt("coordinate", { requestId: "standalone-delegation" });

    await expect(turn.result).resolves.toBe("lead:member:subtask");
    const tree = await turn.getTree();
    expect(tree.invocation.definition.kind).toBe("expert");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.invocation.executorId).toBe("member");
    await session.close();
  });

  it("hands a concurrency permit to nested delegation when the tree limit is one", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-nested-delegation-"));
    const runtime = createFakeRuntime({
      delegationTargets: { lead: "member", member: "leaf" },
    });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createRuntimeRegistry({ runtimes: [runtime], defaultRuntime: "fake" }),
    });
    const leaf = await defineExpert({
      id: "leaf",
      name: "Leaf",
      description: "Leaf",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
      pragmaHome: home,
    });
    const memberLauncher = createAgentLauncher({ experts: [leaf] });
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
      pragmaHome: home,
      tools: [memberLauncher.tool],
    });
    const leadLauncher = createAgentLauncher({
      experts: [member],
      maxConcurrency: 1,
      maxDepth: 2,
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
      pragmaHome: home,
      tools: [leadLauncher.tool],
    });

    const session = await app.experts.createSession(lead);
    const turn = await session.prompt("coordinate", { requestId: "nested-delegation" });

    await expect(turn.result).resolves.toBe("lead:member:leaf:subtask");
    expect((await turn.getTree()).children[0]?.children[0]?.invocation.executorId).toBe("leaf");
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

  it("keeps reused team contexts alive and closes fresh contexts with the ExpertSession", async () => {
    const runTeam = async (context: "fresh" | "reuse") => {
      const { home, app, stats } = await trackedFixture({ delegateContext: context });
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
        id: `team-${context}`,
        version: "1.0.0",
        coordinator: lead,
        members: [member],
        delegation: { allow: { lead: ["member"], member: [] }, context },
      });
      const session = await app.experts.createSession(team);
      const first = await session.prompt("one", { requestId: "one" });
      await first.result;
      const second = await session.prompt("two", { requestId: "two" });
      await second.result;
      const opened = stats.createSessionCalls;
      const closedBeforeSession = stats.closeSessionCalls;
      const state = await session.getState();
      const childRuntimeContexts = (await Promise.all([first.getTree(), second.getTree()])).map(
        (tree) => tree.children[0]?.invocation.runtimeContext,
      );
      await session.close();
      return {
        opened,
        closedBeforeSession,
        closed: stats.closeSessionCalls,
        reusableMemberContext: state.contextIds["member"] !== undefined,
        childRuntimeContexts: childRuntimeContexts.every((snapshot) => snapshot !== undefined),
      };
    };

    await expect(runTeam("reuse")).resolves.toEqual({
      opened: 2,
      closedBeforeSession: 0,
      closed: 2,
      reusableMemberContext: true,
      childRuntimeContexts: false,
    });
    await expect(runTeam("fresh")).resolves.toEqual({
      opened: 3,
      closedBeforeSession: 2,
      closed: 3,
      reusableMemberContext: false,
      childRuntimeContexts: true,
    });
  });

  it("rejects switching Runtime inside a reused team context", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-runtime-identity-"));
    const runtimeA = createFakeRuntime({
      runtimeId: "fake-a",
      delegateRuntime: (query) => (query === "two" ? "fake-b" : "fake-a"),
    });
    const runtimeB = createFakeRuntime({ runtimeId: "fake-b" });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createRuntimeRegistry({
        runtimes: [runtimeA, runtimeB],
        defaultRuntime: "fake-a",
      }),
    });
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
      id: "runtime-switch-team",
      version: "1.0.0",
      coordinator: lead,
      members: [member],
      delegation: { allow: { lead: ["member"], member: [] }, context: "reuse" },
    });
    const session = await app.experts.createSession(team);
    await (
      await session.prompt("one", { requestId: "one" })
    ).result;
    await expect((await session.prompt("two", { requestId: "two" })).result).resolves.toContain(
      "cannot be reused",
    );
    await session.close();
  });

  it("claims concurrent steer requests once and checkpoints Runtime context before completion", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-steer-"));
    let steerCalls = 0;
    const stats = createFakeRuntimeStats();
    const runtime = createFakeRuntime({
      createDelayMs: 100,
      delayMs: 250,
      onSteer: () => (steerCalls += 1),
      stats,
    });
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
    const sessionCreated = (await session.listEvents()).items.find(
      (event) => event.type === "session.created",
    )!;
    const now = new Date().toISOString();
    const executionId = "journal-execution";
    const definition = { id: expert.id, version: expert.version, kind: "expert" as const };
    await writeFile(
      new PragmaPaths({ pragmaHome: home }).expertSessionTransaction(session.sessionId),
      `${JSON.stringify({
        schemaVersion: "pragma.expert-session-transaction/v2",
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
        events: [
          sessionCreated,
          {
            schemaVersion: "pragma.expert-session-event/v1",
            eventId: "prompt-enqueued:journal-request",
            cursor: { sessionId: session.sessionId, sequence: 2 },
            sessionId: session.sessionId,
            type: "prompt.enqueued",
            data: {
              requestId: "journal-request",
              executionId,
              content: "recover me",
            },
            occurredAt: now,
          },
        ],
        execution: {
          schemaVersion: "pragma.execution/v3",
          executionId,
          version: 0,
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
          contextId: "journal-context",
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
    expect((await session.listEvents()).items.map((event) => event.type)).toContain(
      "prompt.enqueued",
    );
    const recoveredTurn = (await session.listTurns())[0]!;
    const cancelled = expect(recoveredTurn.result).rejects.toThrow("cancelled");
    await session.close();
    await cancelled;
  });

  it("recovers Session state and semantic events from the same transaction journal", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-session-events-"));
    const executions = createFileExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });
    const now = new Date().toISOString();
    await sessions.create({
      schemaVersion: "pragma.expert-session/v1",
      sessionId: "atomic-session",
      expertId: "expert",
      expertVersion: "1.0.0",
      status: "open",
      queuedRequestIds: [],
      executionIds: [],
      contextIds: { root: "root-context" },
      runtimeContexts: {},
      createdAt: now,
      updatedAt: now,
    });
    const created = (await sessions.listEvents("atomic-session"))[0]!;
    const closedAt = new Date(Date.now() + 1).toISOString();
    await writeFile(
      new PragmaPaths({ pragmaHome: home }).expertSessionTransaction("atomic-session"),
      `${JSON.stringify({
        schemaVersion: "pragma.expert-session-transaction/v2",
        session: {
          ...(await sessions.get("atomic-session")),
          status: "closed",
          updatedAt: closedAt,
        },
        prompts: [],
        events: [
          created,
          {
            schemaVersion: "pragma.expert-session-event/v1",
            eventId: "session-closed",
            cursor: { sessionId: "atomic-session", sequence: 2 },
            sessionId: "atomic-session",
            type: "session.closed",
            data: {},
            occurredAt: closedAt,
          },
        ],
      })}\n`,
      "utf8",
    );

    await expect(sessions.get("atomic-session")).resolves.toMatchObject({ status: "closed" });
    await expect(sessions.listEvents("atomic-session")).resolves.toMatchObject([
      { type: "session.created" },
      { type: "session.closed" },
    ]);
  });
});

describe("FlowExecution", () => {
  it("keeps Runtime ownership scoped to the FlowExecution", async () => {
    const { app, expert, stats } = await trackedFixture();
    const flow = defineFlow({ id: "runtime-flow", version: "1.0.0" });
    const expertStep = flow.use("expert", expert);
    flow.compose(({ start, end }) => start(expertStep).next(end()));

    const execution = await app.flows.start(flow, { input: "flow prompt" });
    await expect(execution.result).resolves.toBeDefined();
    expect(stats.createSessionCalls).toBe(1);
    expect(stats.closeSessionCalls).toBe(1);
    expect((await execution.getTree()).children[0]?.invocation.runtimeContext).toBeDefined();
    expect((await execution.getState()).state).not.toHaveProperty("__runtimeContexts");
  });

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
      handler: async ({ input }) => {
        calls += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
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
    const subscription = await execution.subscribeEvents({ scope: { kind: "all" } });
    const streamed = (async () => {
      const events = [];
      for await (const event of subscription) events.push(event);
      return events;
    })();
    await expect(execution.result).resolves.toBe(42);
    expect((await streamed).at(-1)?.type).toBe("execution.succeeded");
    await subscription.close();
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
  it("reads events appended by another ExecutionStore instance", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-watch-"));
    const writer = createFileExecutionStore({ pragmaHome: home });
    const reader = createFileExecutionStore({ pragmaHome: home });
    const now = new Date().toISOString();
    await writer.create(
      {
        schemaVersion: "pragma.execution/v3",
        executionId: "cross-process",
        version: 0,
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
        contextId: "root-context",
        definition: { id: "flow", version: "1.0.0", kind: "flow" },
        status: "running",
        input: null,
        createdAt: now,
        updatedAt: now,
      },
    );
    await writer.appendEvent("cross-process", "root", "external.event", {});
    await expect(reader.readEvents("cross-process")).resolves.toMatchObject([
      { type: "external.event" },
    ]);
  });
});

describe("Expert delegation declarations", () => {
  it("validates standalone launcher targets and limits", async () => {
    const { expert } = await fixture();

    expect(() => createAgentLauncher({ experts: [] })).toThrow("at least one Expert");
    expect(() => createAgentLauncher({ experts: [expert, expert] })).toThrow("duplicate Expert");
    expect(() => createAgentLauncher({ experts: [expert], maxConcurrency: 0 })).toThrow(
      "maxConcurrency",
    );
    expect(() => createAgentLauncher({ experts: [expert], maxDepth: 0 })).toThrow("maxDepth");
    const launcher = createAgentLauncher({ experts: [expert] });
    expect(readAgentDelegationDefinition({ ...launcher.tool })?.experts).toEqual([expert]);
    expect(launcher.tool.description).toContain(
      `- ${expert.id}: ${expert.name}. ${expert.description}`,
    );
  });

  it("resolves ExpertTeam allowlists through the shared launcher definition", async () => {
    const { home, expert: lead } = await fixture();
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
    });
    const team = defineExpertTeam({
      id: "bidirectional-team",
      version: "1.0.0",
      coordinator: lead,
      members: [member],
      delegation: { allow: { solo: ["member"], member: ["solo"] } },
    });
    const leadTool = createTeamDelegationTool(team, "solo");
    const memberTool = createTeamDelegationTool(team, "member");

    expect(readAgentDelegationDefinition(leadTool!)?.experts).toEqual([member]);
    expect(readAgentDelegationDefinition(memberTool!)?.experts).toEqual([lead]);
    expect(leadTool?.description).toContain(
      `- ${member.id}: ${member.name}. ${member.description}`,
    );
    expect(memberTool?.description).toContain(`- ${lead.id}: ${lead.name}. ${lead.description}`);
  });

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
