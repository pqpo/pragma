import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createTeamDelegationTools,
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
      const spawn = session.context.agent.tools?.find((tool) => tool.name === "spawn_expert");
      const wait = session.context.agent.tools?.find((tool) => tool.name === "wait_experts");
      const delegationTarget =
        options.delegationTargets?.[session.context.agent.id] ??
        (session.context.agent.id === "lead" ? "member" : undefined);
      let output = `${session.context.agent.id}:${turn.rawQuery}`;
      if (
        spawn !== undefined &&
        wait !== undefined &&
        delegationTarget !== undefined &&
        !turn.rawQuery.startsWith("[Pragma orchestration continuation]")
      ) {
        const spawned = await spawn.call(
          {
            expertId: delegationTarget,
            prompt: "subtask",
            runtime: options.delegateRuntime?.(turn.rawQuery),
          },
          turn.signal,
          { execution: session.context.request.executionContext },
        );
        const invocationId = (spawned.details as { invocationId: string }).invocationId;
        const waited = await wait.call({ invocationIds: [invocationId] }, turn.signal, {
          execution: session.context.request.executionContext,
        });
        const completed = (waited.details as { completed: Array<{ output?: unknown }> }).completed;
        output = `${session.context.agent.id}:${String(completed[0]?.output)}`;
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

type OrchestrationScenario =
  | "parallel"
  | "concurrency"
  | "barrier"
  | "usage"
  | "followup"
  | "interrupt"
  | "parent-failure";

function createOrchestrationRuntime(
  scenario: OrchestrationScenario,
  stats: { active: number; maxActive: number } = { active: 0, maxActive: 0 },
) {
  return defineRuntimeDriver<never, FakeSession>({
    descriptor: { id: `orchestration-${scenario}`, kind: "fake", displayName: "Orchestration" },
    createSession: (context) => ({ context, id: `native-${context.systemSessionId}` }),
    restoreSession: (context) => ({ context, id: context.request.runtimeSession!.id }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    async startTurn(session, turn) {
      stats.active += 1;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      try {
        const expertId = session.context.agent.id;
        if (expertId !== "lead") {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, scenario === "followup" ? 25 : 200),
          );
          return {
            outputText: `${expertId}:${turn.rawQuery}`,
            runtimeSessionId: session.id,
            ...(scenario === "usage" ? { usage: orchestrationUsage } : {}),
          };
        }
        if (turn.rawQuery.startsWith("[Pragma orchestration continuation]")) {
          return {
            outputText: "lead:synthesized",
            runtimeSessionId: session.id,
            ...(scenario === "usage" ? { usage: orchestrationUsage } : {}),
          };
        }
        const execution = session.context.request.executionContext;
        const tool = (name: string) => {
          const found = session.context.agent.tools?.find((candidate) => candidate.name === name);
          if (found === undefined) throw new Error(`Missing orchestration tool: ${name}`);
          return found;
        };
        const call = async (name: string, input: unknown) => {
          const result = await tool(name).call(input, turn.signal, { execution });
          if (result.isError === true) throw new Error(result.text);
          return result.details as Record<string, unknown>;
        };
        const spawn = async (expertId: string, prompt: string) =>
          await call("spawn_expert", { expertId, prompt });
        const wait = async (ids: readonly string[]) =>
          await call("wait_experts", { invocationIds: ids });

        if (scenario === "parallel" || scenario === "concurrency") {
          const first = await spawn("member-a", "a");
          const second = await spawn("member-b", "b");
          const third = scenario === "concurrency" ? await spawn("member-c", "c") : undefined;
          const result = await wait([
            first["invocationId"] as string,
            second["invocationId"] as string,
            ...(third === undefined ? [] : [third["invocationId"] as string]),
          ]);
          return {
            outputText: `lead:${JSON.stringify(result["completed"])}`,
            runtimeSessionId: session.id,
          };
        }

        const first = await spawn("member", "first");
        if (scenario === "parent-failure") throw new Error("lead failed after spawn");
        if (scenario === "barrier" || scenario === "usage") {
          return {
            outputText: "lead:premature",
            runtimeSessionId: session.id,
            ...(scenario === "usage" ? { usage: orchestrationUsage } : {}),
          };
        }
        const firstInvocationId = first["invocationId"] as string;
        const agentId = first["agentId"] as string;
        if (scenario === "followup") {
          await wait([firstInvocationId]);
          const second = await call("followup_expert", { agentId, prompt: "second" });
          const result = await wait([second["invocationId"] as string]);
          return {
            outputText: `lead:${JSON.stringify(result["completed"])}`,
            runtimeSessionId: session.id,
          };
        }

        const second = await call("followup_expert", { agentId, prompt: "second" });
        await call("interrupt_expert", {
          agentId,
          invocationId: firstInvocationId,
          reason: "test",
        });
        const result = await wait([firstInvocationId, second["invocationId"] as string]);
        return {
          outputText: `lead:${JSON.stringify(result["completed"])}`,
          runtimeSessionId: session.id,
        };
      } finally {
        stats.active -= 1;
      }
    },
    mapEvent: () => ({ events: [] }),
    closeSession: () => undefined,
  });
}

const orchestrationUsage: AgentMessageUsage = {
  input: 10,
  output: 2,
  cacheRead: 1,
  cacheWrite: 0,
  totalTokens: 13,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
};

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
    expect(stats.cancelTurnCalls).toBe(1);
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
      tools: launcher.tools,
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
      tools: memberLauncher.tools,
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
      tools: leadLauncher.tools,
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
      delegation: { allow: { lead: ["member"], member: [] } },
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

  it("gives each spawned team agent a fresh Execution-scoped context", async () => {
    const { home, app, stats } = await trackedFixture();
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
      id: "team-fresh-agents",
      version: "1.0.0",
      coordinator: lead,
      members: [member],
      delegation: { allow: { lead: ["member"], member: [] } },
    });
    const session = await app.experts.createSession(team);
    const first = await session.prompt("one", { requestId: "one" });
    await first.result;
    const second = await session.prompt("two", { requestId: "two" });
    await second.result;
    const opened = stats.createSessionCalls;
    const closedBeforeSession = stats.closeSessionCalls;
    const childRuntimeContexts = (await Promise.all([first.getTree(), second.getTree()])).map(
      (tree) => tree.children[0]?.invocation.runtimeContext,
    );
    await session.close();
    expect({
      opened: 3,
      closedBeforeSession: 2,
      closed: 3,
      childRuntimeContexts: true,
    }).toEqual({
      opened,
      closedBeforeSession,
      closed: stats.closeSessionCalls,
      childRuntimeContexts: childRuntimeContexts.every((snapshot) => snapshot !== undefined),
    });
  });

  it("allows each newly spawned agent to select its own Runtime", async () => {
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
      delegation: { allow: { lead: ["member"], member: [] } },
    });
    const session = await app.experts.createSession(team);
    await (
      await session.prompt("one", { requestId: "one" })
    ).result;
    await expect((await session.prompt("two", { requestId: "two" })).result).resolves.toBe(
      "lead:member:subtask",
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
          schemaVersion: "pragma.execution/v4",
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

  it("persists each mapped step input and preserves structured HumanTask responses", async () => {
    const { app, expert } = await fixture();
    const team = defineExpertTeam({
      id: "review-team",
      version: "1.0.0",
      coordinator: expert,
      members: [],
      delegation: { allow: { [expert.id]: [] } },
    });
    const flow = defineFlow({
      id: "mapped-input-flow",
      version: "1.0.0",
      result: ({ state }) => state["outcome"],
    });
    const prepare = flow.task({
      id: "prepare",
      version: "1.0.0",
      input: { source: "root", stage: "prepare" },
      handler: ({ input }) => input,
      reduce: ({ state, output }) => {
        state["prepared"] = output;
      },
    });
    const expertStep = flow.use("expert", expert, {
      input: ({ state }) => `expert:${JSON.stringify(state["prepared"])}`,
      reduce: ({ state, output }) => {
        state["expert"] = output;
      },
    });
    const teamStep = flow.use("team", team, {
      input: ({ state }) => `team:${String(state["expert"])}`,
      reduce: ({ state, output }) => {
        state["team"] = output;
      },
    });
    const gate = flow.humanTask({
      id: "review",
      version: "1.0.0",
      input: ({ state }) => ({ report: state["team"] }),
      request: ({ input }) => ({
        kind: "review_gate",
        title: "Review proposal",
        prompt: JSON.stringify(input),
        questions: [
          {
            header: "Decision",
            question: "What should happen?",
            kind: "single_choice",
            options: [
              { label: "approve", description: "Approve" },
              { label: "revise", description: "Revise" },
              { label: "reject", description: "Reject" },
            ],
          },
          {
            header: "Notes",
            question: "Reviewer notes",
            kind: "text",
            options: [],
          },
        ],
      }),
    });
    const approved = flow.task({
      id: "approved",
      version: "1.0.0",
      handler: () => "approved",
      reduce: ({ state, output }) => {
        state["outcome"] = output;
      },
    });
    const revised = flow.task({
      id: "revised",
      version: "1.0.0",
      handler: () => "revised",
      reduce: ({ state, output }) => {
        state["outcome"] = output;
      },
    });
    const rejected = flow.task({
      id: "rejected",
      version: "1.0.0",
      handler: () => "rejected",
      reduce: ({ state, output }) => {
        state["outcome"] = output;
      },
    });
    flow.compose(({ start, step, end, fail }) => {
      start(prepare)
        .next(expertStep)
        .next(teamStep)
        .next(gate)
        .route(
          "decision",
          { approve: approved, revise: revised, reject: rejected },
          { fallback: fail("Unknown review decision") },
        );
      step(approved).next(end());
      step(revised).next(end());
      step(rejected).next(end());
    });

    const execution = await app.flows.start(flow, { input: { source: "root" } });
    await waitUntil(
      async () =>
        (await execution.getTree()).children.find((child) => child.invocation.nodeId === "review")
          ?.invocation.status === "waiting",
    );
    await waitUntil(async () =>
      (await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items.some(
        (event) => event.type === "human.requested",
      ),
    );
    const tree = await execution.getTree();
    const invocations = tree.children.map((child) => child.invocation);
    expect(invocations.find((invocation) => invocation.nodeId === "prepare")?.input).toEqual({
      source: "root",
      stage: "prepare",
    });
    expect(invocations.find((invocation) => invocation.nodeId === "expert")?.input).toContain(
      'expert:{"source":"root","stage":"prepare"}',
    );
    expect(invocations.find((invocation) => invocation.nodeId === "team")?.input).toContain(
      "team:solo:expert:",
    );
    expect(invocations.find((invocation) => invocation.nodeId === "review")?.input).toEqual({
      report: expect.stringContaining("solo:team:solo:expert:"),
    });
    const requested = (
      await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })
    ).items.find((event) => event.type === "human.requested")!;
    expect(requested.data).toMatchObject({
      request: {
        kind: "user_question",
        questions: [
          { question: "What should happen?", kind: "single_choice" },
          { question: "Reviewer notes", kind: "text" },
        ],
      },
    });
    const interactionId = (requested.data as { interactionId: string }).interactionId;
    await execution.respondToHumanInteraction(
      interactionId,
      {
        kind: "user_question",
        answered: true,
        answers: { "What should happen?": "revise", "Reviewer notes": "Tighten scope." },
      },
      { requestId: "review-response" },
    );

    await expect(execution.result).resolves.toBe("revised");
    const completed = await execution.getTree();
    expect(
      completed.children.find((child) => child.invocation.nodeId === "review")?.invocation.output,
    ).toEqual({
      decision: "revise",
      notes: "Tighten scope.",
      answers: { "What should happen?": "revise", "Reviewer notes": "Tighten scope." },
    });
    expect(completed.children.some((child) => child.invocation.nodeId === "revised")).toBe(true);
    expect(completed.children.some((child) => child.invocation.nodeId === "approved")).toBe(false);
    expect(completed.children.some((child) => child.invocation.nodeId === "rejected")).toBe(false);
  });

  it("maps approval HumanTasks to approved responses", async () => {
    const { app } = await fixture();
    const flow = defineFlow({ id: "approval-flow", version: "1.0.0" });
    const approval = flow.humanTask({
      id: "approval",
      version: "1.0.0",
      request: {
        kind: "approval",
        prompt: "Continue?",
        options: [
          { label: "Allow", description: "Continue the Flow" },
          { label: "Block", description: "Stop the Flow" },
        ],
      },
    });
    flow.compose(({ start, end }) => start(approval).next(end()));
    const execution = await app.flows.start(flow, { input: null });
    await waitUntil(
      async () => (await execution.getTree()).children[0]?.invocation.status === "waiting",
    );
    await waitUntil(async () =>
      (await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items.some(
        (event) => event.type === "human.requested",
      ),
    );
    const requested = (
      await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })
    ).items.find((event) => event.type === "human.requested")!;
    const interactionId = (requested.data as { interactionId: string }).interactionId;
    await execution.respondToHumanInteraction(
      interactionId,
      { kind: "user_question", answered: true, answers: { "Continue?": "Allow" } },
      { requestId: "approval-response" },
    );
    await execution.result;
    expect((await execution.getTree()).children[0]?.invocation.output).toEqual({
      approved: true,
      decision: "Allow",
      answers: { "Continue?": "Allow" },
    });
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

  it("marks a Step Invocation as failed when its input mapper throws", async () => {
    const { app } = await fixture();
    const flow = defineFlow({ id: "failing-input-flow", version: "1.0.0" });
    const task = flow.task({
      id: "fails-before-handler",
      version: "1.0.0",
      input: () => {
        throw new Error("input mapping exploded");
      },
      handler: () => "unreachable",
    });
    flow.compose(({ start, end }) => start(task).next(end()));
    const execution = await app.flows.start(flow, { input: { original: true } });
    await expect(execution.result).rejects.toThrow("input mapping exploded");
    expect((await execution.getTree()).children[0]?.invocation).toMatchObject({
      status: "failed",
      input: { original: true },
      error: { message: "input mapping exploded" },
    });
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
        schemaVersion: "pragma.execution/v4",
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

describe("Expert lifecycle orchestration", () => {
  async function runScenario(
    scenario: OrchestrationScenario,
    targets: readonly string[] = ["member"],
  ) {
    const home = await mkdtemp(join(tmpdir(), `pragma-${scenario}-`));
    const stats = { active: 0, maxActive: 0 };
    const runtime = createOrchestrationRuntime(scenario, stats);
    const app = createPragma({
      pragmaHome: home,
      runtimes: createRuntimeRegistry({
        runtimes: [runtime],
        defaultRuntime: runtime.descriptor.id,
      }),
    });
    const members = await Promise.all(
      targets.map(
        async (id) =>
          await defineExpert({
            id,
            name: id,
            description: id,
            tags: [],
            version: "1.0.0",
            scope: "test",
            workspace: home,
            pragmaHome: home,
          }),
      ),
    );
    const launcher = createAgentLauncher({
      experts: members,
      maxConcurrency: 2,
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
      tools: launcher.tools,
    });
    const session = await app.experts.createSession(lead);
    const turn = await session.prompt("coordinate", { requestId: scenario });
    const output = await turn.result;
    const tree = await turn.getTree();
    const events = await turn.listEvents({ limit: 1_000 });
    await session.close();
    return { output, tree, events: events.items, stats };
  }

  it("starts independent spawned Experts concurrently", async () => {
    const result = await runScenario("parallel", ["member-a", "member-b"]);
    expect(result.tree.children).toHaveLength(2);
    expect(result.tree.children.map((child) => child.invocation.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(result.stats.maxActive).toBeGreaterThanOrEqual(3);
  });

  it("never exceeds the configured child concurrency limit", async () => {
    const result = await runScenario("concurrency", ["member-a", "member-b", "member-c"]);
    expect(result.tree.children).toHaveLength(3);
    expect(result.stats.maxActive).toBe(3);
  });

  it("automatically joins forgotten waits and resumes the parent for synthesis", async () => {
    const result = await runScenario("barrier");
    expect(result.output).toBe("lead:synthesized");
    expect(result.tree.children[0]?.invocation.status).toBe("succeeded");
    expect(result.events.some((event) => event.type === "expert.children.waiting")).toBe(true);
    expect(result.events.some((event) => event.type === "expert.children.completed")).toBe(true);
  });

  it("persists aggregate usage across the original turn and orchestration continuation", async () => {
    const result = await runScenario("usage");
    expect(result.tree.invocation.usage).toEqual({
      input: 20,
      output: 4,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 26,
      cost: { input: 0.02, output: 0.04, cacheRead: 0.002, cacheWrite: 0, total: 0.062 },
    });
  });

  it("interrupts spawned descendants before a failed parent Execution settles", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-parent-failure-"));
    const runtime = createOrchestrationRuntime("parent-failure");
    const app = createPragma({
      pragmaHome: home,
      runtimes: createRuntimeRegistry({
        runtimes: [runtime],
        defaultRuntime: runtime.descriptor.id,
      }),
    });
    const member = await defineExpert({
      id: "member",
      name: "member",
      description: "member",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
      pragmaHome: home,
    });
    const launcher = createAgentLauncher({ experts: [member], maxConcurrency: 2, maxDepth: 2 });
    const lead = await defineExpert({
      id: "lead",
      name: "lead",
      description: "lead",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
      pragmaHome: home,
      tools: launcher.tools,
    });
    const session = await app.experts.createSession(lead);
    const turn = await session.prompt("coordinate", { requestId: "parent-failure" });

    await expect(turn.result).rejects.toThrow("lead failed after spawn");
    const tree = await turn.getTree();
    expect(tree.invocation.status).toBe("failed");
    expect(tree.children[0]?.invocation.status).toBe("interrupted");
    await session.close();
  });

  it("queues follow-ups FIFO on the same agent and context", async () => {
    const result = await runScenario("followup");
    expect(result.tree.children).toHaveLength(2);
    const [first, second] = result.tree.children.map((child) => child.invocation);
    expect(first?.agentId).toBe(second?.agentId);
    expect(first?.contextId).toBe(second?.contextId);
    expect([first?.agentTaskSequence, second?.agentTaskSequence]).toEqual([0, 1]);
    expect([first?.status, second?.status]).toEqual(["succeeded", "succeeded"]);
  });

  it("interrupts only the current task and preserves queued follow-ups", async () => {
    const result = await runScenario("interrupt");
    expect(result.tree.children).toHaveLength(2);
    expect(result.tree.children.map((child) => child.invocation.status)).toEqual([
      "interrupted",
      "succeeded",
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
    expect(launcher.tools.map((tool) => tool.name)).toEqual([
      "spawn_expert",
      "wait_experts",
      "list_experts",
      "followup_expert",
      "interrupt_expert",
    ]);
    expect(readAgentDelegationDefinition({ ...launcher.tools[0]! })?.experts).toEqual([expert]);
    expect(launcher.tools[0]?.description).toContain(
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
    const leadTools = createTeamDelegationTools(team, "solo");
    const memberTools = createTeamDelegationTools(team, "member");
    const leadTool = leadTools[0];
    const memberTool = memberTools[0];

    expect(readAgentDelegationDefinition(leadTool!)?.experts).toEqual([member]);
    expect(readAgentDelegationDefinition(memberTool!)?.experts).toEqual([lead]);
    expect(leadTools).toHaveLength(5);
    expect(memberTools).toHaveLength(5);
    expect(leadTool?.description).toContain(
      `- ${member.id}: ${member.name}. ${member.description}`,
    );
    expect(memberTool?.description).toContain(`- ${lead.id}: ${lead.name}. ${lead.description}`);
  });

  it("defaults ExpertTeam delegation to coordinator-to-members only", async () => {
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
      id: "default-delegation-team",
      version: "1.0.0",
      coordinator: lead,
      members: [member],
      delegation: {},
    });

    expect(
      readAgentDelegationDefinition(createTeamDelegationTools(team, "solo")[0]!)?.experts,
    ).toEqual([member]);
    expect(createTeamDelegationTools(team, "member")).toEqual([]);
    expect(team.delegation.maxConcurrency).toBe(4);
    expect(team.delegation.maxDepth).toBe(3);
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
