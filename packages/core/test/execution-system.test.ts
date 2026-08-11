import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createTeamDelegationTools,
  readAgentDelegationDefinition,
} from "../src/agent/agent-launcher.ts";

import {
  createAgentLauncher,
  createPragma,
  createFileExecutionStore,
  createFileExpertSessionStore,
  createRuntimeSessionRecord,
  createStaticRuntimeResolver,
  ContextSystem,
  InMemoryContextStore,
  defineExpert,
  defineExpertTeam,
  defineContextIdResolver,
  defineFlow,
  defineRuntimeDriver,
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_CONTEXT_ID_ATTR,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
  fingerprintExpertExecutionDefinition,
  PragmaPaths,
  readRuntimeSessionRecord,
  StaticContextStore,
  type AgentMessageUsage,
  type ExecutionEvent,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
  type FlowExecution,
  type RuntimeDriverSessionContext,
  type RuntimeModelSelection,
  type RuntimeUsageObservation,
  type UsageSink,
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
  sessionModelSelections: Array<RuntimeModelSelection | undefined>;
  turnModelSelections: Array<RuntimeModelSelection | undefined>;
  turnAttachmentPaths: string[][];
  sessionContexts: RuntimeDriverSessionContext[];
}

function createFakeRuntimeStats(): FakeRuntimeStats {
  return {
    createSessionCalls: 0,
    restoreSessionCalls: 0,
    closeSessionCalls: 0,
    cancelTurnCalls: 0,
    executionIds: [],
    sessionModelSelections: [],
    turnModelSelections: [],
    turnAttachmentPaths: [],
    sessionContexts: [],
  };
}

interface FakeRuntimeOptions {
  readonly closeError?: string;
  readonly createDelayMs?: number;
  readonly concurrentToolNames?: readonly string[];
  readonly concurrentToolNamesByAgent?: Readonly<Record<string, readonly string[]>>;
  readonly delayMs?: number;
  readonly delegationTargets?: Readonly<Record<string, string>>;
  readonly failQuery?: string;
  readonly onSteer?: () => void;
  readonly runtimeId?: string;
  readonly stats?: FakeRuntimeStats;
  readonly usage?: AgentMessageUsage;
}

function createFakeRuntime(options: FakeRuntimeOptions = {}) {
  const stats = options.stats;
  return defineRuntimeDriver<AgentMessageUsage, FakeSession>({
    descriptor: {
      id: options.runtimeId ?? "fake",
      kind: "fake",
      displayName: options.runtimeId ?? "Fake",
    },
    createSession: async (context) => {
      if (stats !== undefined) stats.createSessionCalls += 1;
      if (stats !== undefined) stats.sessionModelSelections.push(context.request.modelSelection);
      if (stats !== undefined) stats.sessionContexts.push(context);
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
      stats?.turnModelSelections.push(turn.modelSelection);
      stats?.turnAttachmentPaths.push(turn.attachments.map((attachment) => attachment.path));
      const executionId = session.context.request.executionContext?.executionId;
      if (stats !== undefined && executionId !== undefined) stats.executionIds.push(executionId);
      if (options.delayMs !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (turn.rawQuery === options.failQuery) {
        if (options.usage !== undefined) turn.stream.writeNative(options.usage);
        throw new Error("fake turn failed");
      }
      const spawn = session.context.agent.tools?.find((tool) => tool.name === "spawn_expert");
      const wait = session.context.agent.tools?.find((tool) => tool.name === "wait_experts");
      const delegationTarget =
        options.delegationTargets?.[session.context.agent.id] ??
        (session.context.agent.id === "lead" ? "member" : undefined);
      const concurrentToolNames =
        options.concurrentToolNamesByAgent?.[session.context.agent.id] ??
        options.concurrentToolNames;
      let output = `${session.context.agent.id}:${turn.rawQuery}`;
      if (concurrentToolNames !== undefined) {
        const execution = session.context.request.executionContext;
        const results = await Promise.all(
          concurrentToolNames.map(async (name) => {
            const tool = session.context.agent.tools?.find((candidate) => candidate.name === name);
            if (tool === undefined) throw new Error(`Missing concurrent test tool: ${name}`);
            const result = await tool.call({}, turn.signal, { execution });
            if (result.isError === true) throw new Error(result.text);
            return result.details;
          }),
        );
        output = JSON.stringify(results);
      } else if (
        spawn !== undefined &&
        wait !== undefined &&
        delegationTarget !== undefined &&
        !turn.rawQuery.startsWith("[Pragma orchestration continuation]")
      ) {
        const spawned = await spawn.call(
          {
            expertId: delegationTarget,
            prompt: "subtask",
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
    mapEvent: (usage) => ({ events: [], usage }),
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
  | "followup-older"
  | "reuse-spawn"
  | "interrupt"
  | "parent-failure";

interface OrchestrationRuntimeStats {
  active: number;
  maxActive: number;
  memberTurns: number;
}

function createOrchestrationRuntime(
  scenario: OrchestrationScenario,
  stats: OrchestrationRuntimeStats = { active: 0, maxActive: 0, memberTurns: 0 },
) {
  const firstChildWave = createBarrier(2, 5_000);
  let signalChildSessionOpening!: () => void;
  const childSessionOpening = new Promise<void>((resolve) => {
    signalChildSessionOpening = resolve;
  });
  return defineRuntimeDriver<never, FakeSession>({
    descriptor: { id: `orchestration-${scenario}`, kind: "fake", displayName: "Orchestration" },
    createSession: async (context) => {
      if (scenario === "parent-failure" && context.agent.id !== "lead") {
        signalChildSessionOpening();
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
      return { context, id: `native-${context.systemSessionId}` };
    },
    restoreSession: (context) => ({ context, id: context.request.runtimeSession!.id }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    async startTurn(session, turn) {
      stats.active += 1;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      try {
        const expertId = session.context.agent.id;
        if (expertId !== "lead") {
          stats.memberTurns += 1;
          if (scenario === "parallel" || scenario === "concurrency") {
            await firstChildWave.arriveAndWait();
          } else {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, scenario === "followup" ? 25 : 200),
            );
          }
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

        if (scenario === "reuse-spawn") {
          const [first, second] = await Promise.all([
            spawn("member", "first"),
            spawn("member", "second"),
          ]);
          const result = await wait([
            first["invocationId"] as string,
            second["invocationId"] as string,
          ]);
          return {
            outputText: `lead:${JSON.stringify(result["completed"])}`,
            runtimeSessionId: session.id,
          };
        }

        if (scenario === "followup-older") {
          const first = await spawn("member", "first");
          const second = await spawn("member", "second");
          await wait([first["invocationId"] as string, second["invocationId"] as string]);
          const followup = await call("followup_expert", {
            agentId: first["agentId"],
            prompt: "followup-first",
          });
          const result = await wait([followup["invocationId"] as string]);
          return {
            outputText: `lead:${JSON.stringify(result["completed"])}`,
            runtimeSessionId: session.id,
          };
        }

        const first = await spawn("member", "first");
        if (scenario === "parent-failure") {
          await childSessionOpening;
          throw new Error("lead failed after spawn");
        }
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
  measurement: "reported",
  input: 10,
  output: 2,
  cacheRead: 1,
  cacheWrite: 0,
  totalTokens: 13,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
};

function createBarrier(
  participants: number,
  timeoutMs: number,
): { arriveAndWait(): Promise<void> } {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async arriveAndWait() {
      arrived += 1;
      if (arrived >= participants) release();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(new Error(`Barrier timed out waiting for ${participants} participants.`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}

async function fixture(delayMs?: number) {
  const home = await mkdtemp(join(tmpdir(), "pragma-execution-"));
  const runtime = createFakeRuntime(delayMs === undefined ? {} : { delayMs });
  const board = new InMemoryContextStore();
  const app = createPragma({
    pragmaHome: home,
    runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    hostContextBindings: [
      {
        namespace: "mission-board",
        store: board,
        overflowTarget: true,
        mutationApproval: "none",
      },
    ],
  });
  const expert = await defineExpert({
    id: "solo",
    name: "Solo",
    description: "Test Expert",
    tags: [],
    scope: "test",
    workspace: home,
  });
  return { home, app, expert, board };
}

async function trackedFixture(
  options: Omit<FakeRuntimeOptions, "stats"> = {},
  usageSink?: UsageSink,
) {
  const home = await mkdtemp(join(tmpdir(), "pragma-runtime-ownership-"));
  const stats = createFakeRuntimeStats();
  const runtime = createFakeRuntime({ ...options, stats });
  const app = createPragma({
    pragmaHome: home,
    runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    usageSink,
  });
  const expert = await defineExpert({
    id: "tracked",
    name: "Tracked",
    description: "Tracked Runtime Expert",
    tags: [],
    scope: "test",
    workspace: home,
  });
  return { home, app, expert, runtime, stats };
}

describe("ExpertSession", () => {
  it("passes the Expert model selection to Runtime session creation and turns", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-runtime-model-selection-"));
    const stats = createFakeRuntimeStats();
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [createFakeRuntime({ stats })],
        defaultRuntimeId: "fake",
      }),
    });
    const expert = await defineExpert({
      id: "model-selection",
      name: "Model Selection",
      description: "Model selection test",
      tags: [],
      scope: "test",
      workspace: home,
      models: {
        default: {
          model: { providerId: "provider-a", modelId: "model-a" },
          thinkingLevel: "high",
        },
      },
    });

    const session = await app.experts.createSession(expert);
    await (
      await session.prompt("hello", { requestId: "model-selection" })
    ).result;

    const override = {
      model: { providerId: "provider-b", modelId: "model-b" },
      thinkingLevel: "low",
    };
    await (
      await session.prompt("follow up", {
        requestId: "model-selection-override",
        modelSelection: override,
      })
    ).result;

    const selection = {
      model: { providerId: "provider-a", modelId: "model-a" },
      thinkingLevel: "high",
    };
    expect(stats.sessionModelSelections).toEqual([selection]);
    expect(stats.sessionContexts[0]?.request.context).toEqual({
      source: { type: "pragma.expert", id: "model-selection" },
      attributes: {
        [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "model-selection",
        [EXECUTION_CONTEXT_ID_ATTR]: expect.any(String),
        [EXECUTION_ID_ATTR]: expect.any(String),
        [INVOCATION_ID_ATTR]: expect.any(String),
      },
    });
    expect(stats.turnModelSelections).toEqual([selection, override]);
    const state = await session.getState();
    expect(state.contexts[state.rootContextId]?.modelSelection).toEqual(override);
    await session.close();
  });

  it("keeps a resumed Runtime Session model when the Expert default changes", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-resumed-model-selection-"));
    const originalStats = createFakeRuntimeStats();
    const originalApp = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [
          createFakeRuntime({ stats: originalStats, closeError: "simulate process exit" }),
        ],
        defaultRuntimeId: "fake",
      }),
    });
    const expert = async (providerId: string, modelId: string) =>
      await defineExpert({
        id: "resumed-model-selection",
        name: "Resumed Model Selection",
        description: "Resumed model selection test",
        tags: [],
        scope: "test",
        workspace: home,
        models: { default: { model: { providerId, modelId } } },
      });
    const original = await expert("openai", "codex-model");
    const session = await originalApp.experts.createSession(original);
    await (
      await session.prompt("first", { requestId: "resumed-model-first" })
    ).result;
    const persisted = await session.getState();
    expect(persisted.contexts[persisted.rootContextId]?.snapshot).toBeDefined();
    await expect(session.close()).rejects.toThrow("simulate process exit");

    const recoveredStats = createFakeRuntimeStats();
    const recoveryApp = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [createFakeRuntime({ stats: recoveredStats })],
        defaultRuntimeId: "fake",
      }),
    });
    const changed = await expert("deepseek", "deepseek-v4-flash");
    const recovered = await recoveryApp.experts.resumeSession(changed, {
      sessionId: session.sessionId,
    });
    await (
      await recovered.prompt("second", { requestId: "resumed-model-second" })
    ).result;

    expect(recoveredStats.restoreSessionCalls).toBe(1);
    expect(recoveredStats.turnModelSelections).toEqual([
      { model: { providerId: "openai", modelId: "codex-model" } },
    ]);
    await recovered.close();
  });

  it("creates one durable root Context before the first prompt", async () => {
    const { app, expert } = await fixture();
    const first = await app.experts.createSession(expert);
    const firstState = await first.getState();
    const firstRoot = firstState.contexts[firstState.rootContextId];

    expect("runtimeId" in firstState).toBe(false);
    expect(firstRoot).toMatchObject({
      owner: { type: "expert-session", ownerId: first.sessionId },
      origin: { type: "expert-session", sessionId: first.sessionId },
      expert: { id: expert.id },
      runtime: { runtimeId: "fake", revision: 1 },
      lifecycle: "open",
    });
    expect((await first.listEvents()).items.map((event) => event.type)).toEqual([
      "session.created",
      "context.created",
    ]);

    const turn = await first.prompt("hello", { requestId: "root-binding" });
    await turn.result;
    expect((await turn.getTree()).invocation).toMatchObject({
      contextId: firstState.rootContextId,
    });
    expect((await turn.getTree()).invocation.contextResolution).toBeUndefined();

    const second = await app.experts.createSession(expert);
    expect((await second.getState()).rootContextId).not.toBe(firstState.rootContextId);
    await first.close();
    expect((await first.getState()).contexts[firstState.rootContextId]).toMatchObject({
      lifecycle: "closed",
    });
    expect((await first.listEvents()).items.map((event) => event.type)).toEqual(
      expect.arrayContaining(["context.closed", "session.closed"]),
    );
    await second.close();
  });

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
    expect(
      sessionEvents.some(
        (event) =>
          event.type === "runtime.event" &&
          (event.data as { type?: unknown }).type === "message.delta",
      ),
    ).toBe(false);
    await Promise.all([eventSubscription.close(), outputSubscription.close()]);
    await session.close();
  });

  it("externalizes a large Expert result through the Context overflow target", async () => {
    const { app, expert, board } = await fixture();
    const session = await app.experts.createSession(expert);
    const prompt = "x".repeat(40 * 1024);
    const turn = await session.prompt(prompt, { requestId: "large-handoff" });
    const result = await turn.result;

    expect(result).toMatchObject({
      type: "context",
      contexts: [{ namespace: "mission-board", mediaType: "text/plain" }],
    });
    if (
      typeof result !== "object" ||
      result === null ||
      !("type" in result) ||
      result.type !== "context" ||
      !("contexts" in result) ||
      !Array.isArray(result.contexts)
    ) {
      throw new Error("Expected a Context-backed output.");
    }
    const reference = result.contexts[0] as { id: string };
    const stored = await board.readContext({ id: reference.id });
    expect(stored.ok && stored.value.content).toBe(`solo:${prompt}`);
    await expect(turn.getState()).resolves.toMatchObject({
      output: { type: "context", contexts: [{ id: reference.id }] },
    });
    const history = await turn.getMessageHistory();
    const serializedHistory = JSON.stringify(history);
    expect(serializedHistory).toContain(reference.id);
    expect(serializedHistory).not.toContain(`solo:${prompt}`);
    await session.close();
  }, 40_000);

  it("reads an earlier Context-backed output through a reused Runtime Session", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-session-handoff-"));
    const board = new InMemoryContextStore();
    let createSessionCalls = 0;
    const runtime = defineRuntimeDriver<never, FakeSession>({
      descriptor: { id: "handoff-reader", kind: "fake", displayName: "Handoff Reader" },
      createSession: (context) => {
        createSessionCalls += 1;
        return { context, id: `native-${context.systemSessionId}` };
      },
      restoreSession: (context) => ({ context, id: context.request.runtimeSession!.id }),
      readSession: (nativeSession) => ({ runtimeSessionId: nativeSession.id }),
      async startTurn(nativeSession, turn) {
        let output: string;
        if (turn.rawQuery === "produce") {
          output = "historical output\n".repeat(4_000);
        } else if (turn.rawQuery.startsWith("read:")) {
          const id = turn.rawQuery.slice("read:".length);
          const read = nativeSession.context.agent
            .createDefaultTools()
            .find((tool) => tool.name === "read_expert_context");
          if (read === undefined) throw new Error("read_expert_context is missing.");
          const result = await read.call({ namespace: "mission-board", id }, turn.signal, {
            execution: nativeSession.context.request.executionContext,
          });
          output =
            result.isError === true || !result.text.includes("historical output")
              ? `read-failed:${result.text}`
              : "read-ok";
        } else {
          output = "unused";
        }
        return { outputText: output, runtimeSessionId: nativeSession.id };
      },
      mapEvent: () => ({ events: [] }),
    });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: "handoff-reader",
      }),
      hostContextBindings: [
        {
          namespace: "mission-board",
          store: board,
          overflowTarget: true,
          mutationApproval: "none",
        },
      ],
    });
    const expert = await defineExpert({
      id: "handoff-expert",
      name: "Handoff Expert",
      description: "Reads earlier handoffs",
      tags: [],
      scope: "test",
      workspace: home,
      pragmaHome: home,
    });
    const session = await app.experts.createSession(expert);
    const first = await (await session.prompt("produce", { requestId: "produce" })).result;
    if (
      typeof first !== "object" ||
      first === null ||
      !("type" in first) ||
      first.type !== "context" ||
      !("contexts" in first) ||
      !Array.isArray(first.contexts)
    ) {
      throw new Error("Expected the first turn to return a Context-backed output.");
    }
    const id = (first.contexts[0] as { id: string }).id;

    await expect((await session.prompt(`read:${id}`, { requestId: "read" })).result).resolves.toBe(
      "read-ok",
    );
    expect(createSessionCalls).toBe(1);
    await session.close();
  }, 30_000);

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
      runtimes: createStaticRuntimeResolver({
        runtimes: [createFakeRuntime()],
        defaultRuntimeId: "fake",
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

  it("keeps the Session-created root Context immutable under concurrent prompts", async () => {
    const { app, expert } = await trackedFixture({ delayMs: 25 });
    const session = await app.experts.createSession(expert);
    const [first, second] = await Promise.all([
      session.prompt("one", { requestId: "concurrent-one" }),
      session.prompt("two", { requestId: "concurrent-two" }),
    ]);
    const state = await session.getState();
    expect(Object.keys(state.contexts)).toEqual([state.rootContextId]);
    expect(state.contexts[state.rootContextId]?.origin).toEqual({
      type: "expert-session",
      sessionId: session.sessionId,
    });
    await Promise.all([first.result, second.result]);
    expect((await session.getState()).contexts[state.rootContextId]?.origin).toEqual({
      type: "expert-session",
      sessionId: session.sessionId,
    });
    await session.close();
  });

  it("reuses a Team member Context across ExpertSession restart and persists its snapshot", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-team-session-context-"));
    const stats = createFakeRuntimeStats();
    const runtime = createFakeRuntime({ stats, closeError: "simulated process cleanup failure" });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });
    const coordinator = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      scope: "test",
      workspace: home,
      pragmaHome: home,
    });
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      scope: "test",
      workspace: home,
      pragmaHome: home,
    });
    const team = defineExpertTeam({
      id: "persistent-team",
      coordinator,
      members: [member],
      delegation: {
        contextId: defineContextIdResolver({
          id: "test.persistent-team-member",
          version: "1.0.0",
          resolve: ({ ownerContextId, target }) => `${ownerContextId ?? "root"}:${target.expertId}`,
        }),
      },
    });
    const session = await app.experts.createSession(team);
    const first = await session.prompt("first", { requestId: "first" });
    await first.result;
    const firstMember = (await first.getTree()).children[0]?.invocation;
    expect(firstMember).toBeDefined();
    expect(stats.sessionContexts.map((context) => context.request.context?.source)).toEqual([
      { type: "pragma.expert-team", id: "persistent-team" },
      { type: "pragma.expert-team", id: "persistent-team" },
    ]);
    expect(
      stats.sessionContexts.map(
        (context) => context.request.context?.attributes?.[EXECUTION_CURRENT_EXPERT_ID_ATTR],
      ),
    ).toEqual(["lead", "member"]);

    await expect(session.close()).rejects.toThrow("Runtime Session pool cleanup failed");
    const recoveredStats = createFakeRuntimeStats();
    const recoveryApp = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [createFakeRuntime({ stats: recoveredStats })],
        defaultRuntimeId: "fake",
      }),
    });
    const recovered = await recoveryApp.experts.resumeSession(team, {
      sessionId: session.sessionId,
    });
    const second = await recovered.prompt("second", { requestId: "second" });
    await second.result;
    const secondMember = (await second.getTree()).children[0]?.invocation;
    expect(secondMember?.contextId).toBe(firstMember?.contextId);
    expect(secondMember?.contextResolution?.disposition).toBe("reused");

    const state = await recovered.getState();
    const memberContexts = Object.values(state.contexts).filter(
      (context) => context.expert.id === member.id,
    );
    expect(memberContexts).toHaveLength(1);
    expect(memberContexts[0]).toMatchObject({
      contextId: firstMember?.contextId,
      origin: { type: "invocation", invocationId: firstMember?.invocationId },
      runtime: { runtimeId: "fake", revision: 1 },
      snapshot: { systemSessionId: expect.any(String) },
    });
    expect(stats.createSessionCalls).toBe(2);
    expect(recoveredStats.createSessionCalls).toBe(0);
    expect(recoveredStats.restoreSessionCalls).toBe(2);
    await recovered.close();
  });

  it("persists turn usage and exposes a session total without consuming events", async () => {
    const perTurnUsage: AgentMessageUsage = {
      measurement: "reported",
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
      measurement: "reported",
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

  it("emits one Host usage observation per settled Runtime turn without coupling execution", async () => {
    const perTurnUsage: AgentMessageUsage = {
      measurement: "reported",
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 5,
      totalTokens: 155,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    };
    const observations: RuntimeUsageObservation[] = [];
    const previews: RuntimeUsageObservation[] = [];
    const clearedPreviews: string[] = [];
    const { app, expert } = await trackedFixture(
      { usage: perTurnUsage },
      {
        preview: (observation) => {
          previews.push(observation);
        },
        record: (observation) => {
          observations.push(observation);
        },
        clearPreview: (observationId) => {
          clearedPreviews.push(observationId);
        },
      },
    );
    const session = await app.experts.createSession(expert);
    const turn = await session.prompt("observe", { requestId: "usage-observation" });
    await turn.result;

    expect(observations).toHaveLength(1);
    expect(previews.length).toBeGreaterThanOrEqual(2);
    expect(previews[0]?.usage.measurement).toBe("estimated");
    expect(previews.at(-1)?.usage).toEqual(perTurnUsage);
    expect(clearedPreviews).toEqual([observations[0]!.observationId]);
    expect(observations[0]).toMatchObject({
      executionId: turn.executionId,
      invocationId: turn.executionId,
      runtimeId: "fake",
      executor: { id: "tracked", name: "Tracked" },
      usage: perTurnUsage,
    });

    const failing = await trackedFixture(
      { usage: perTurnUsage },
      {
        preview: () => {
          throw new Error("host preview unavailable");
        },
        record: () => {
          throw new Error("host unavailable");
        },
      },
    );
    const failingSession = await failing.app.experts.createSession(failing.expert);
    await expect(
      (
        await failingSession.prompt("still succeeds", {
          requestId: "usage-sink-failure",
        })
      ).result,
    ).resolves.toBeDefined();

    const failingClear = await trackedFixture(
      {},
      {
        record: () => undefined,
        clearPreview: () => {
          throw new Error("host clear unavailable");
        },
      },
    );
    const failingClearSession = await failingClear.app.experts.createSession(failingClear.expert);
    await expect(
      (
        await failingClearSession.prompt("still succeeds without final usage", {
          requestId: "usage-sink-clear-failure",
        })
      ).result,
    ).resolves.toBeDefined();

    const failingFinalClear = await trackedFixture(
      { usage: perTurnUsage },
      {
        record: () => undefined,
        clearPreview: () => {
          throw new Error("host final clear unavailable");
        },
      },
    );
    const failingFinalClearSession = await failingFinalClear.app.experts.createSession(
      failingFinalClear.expert,
    );
    await expect(
      (
        await failingFinalClearSession.prompt("still succeeds with final usage", {
          requestId: "usage-sink-final-clear-failure",
        })
      ).result,
    ).resolves.toBeDefined();

    const failedObservations: RuntimeUsageObservation[] = [];
    const failedRuntime = await trackedFixture(
      { failQuery: "fails after usage", usage: perTurnUsage },
      {
        record: (observation) => {
          failedObservations.push(observation);
        },
      },
    );
    const failedSession = await failedRuntime.app.experts.createSession(failedRuntime.expert);
    const failedTurn = await failedSession.prompt("fails after usage", {
      requestId: "failed-turn-usage",
    });
    await expect(failedTurn.result).rejects.toThrow("fake turn failed");
    expect(failedObservations).toHaveLength(1);
    expect(failedObservations[0]?.usage).toEqual(perTurnUsage);
    expect((await failedTurn.getState()).usage).toEqual(perTurnUsage);
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
      runtimes: createStaticRuntimeResolver({
        runtimes: [createFakeRuntime()],
        defaultRuntimeId: "fake",
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
      schemaVersion: "pragma.expert-session/v5",
      sessionId: "leased-session",
      expertId: "expert",
      definitionFingerprint: "a".repeat(64),
      status: "open",
      queuedRequestIds: [],
      executionIds: [],
      rootContextId: "root",
      contexts: {
        root: sessionRootContext("leased-session", "root", "expert", "fake", now),
      },
      createdAt: now,
      updatedAt: now,
    });

    await expect(sessions.claimLease("leased-session", "owner-a", 200)).resolves.toBe(true);
    await expect(sessions.claimLease("leased-session", "owner-b", 200)).resolves.toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 220));
    await expect(sessions.claimLease("leased-session", "owner-b", 200)).resolves.toBe(true);
    await sessions.releaseLease("leased-session", "owner-b");
  });

  it("rejects resume when its Team resolver descriptor changes", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-session-fingerprint-"));
    const executions = createFileExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [createFakeRuntime()],
        defaultRuntimeId: "fake",
      }),
    });
    const lead = await defineExpert({
      id: "fingerprint-lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const member = await defineExpert({
      id: "fingerprint-member",
      name: "Member",
      description: "Member",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const team = (resolverVersion: string) =>
      defineExpertTeam({
        id: "fingerprint-team",
        coordinator: lead,
        members: [member],
        delegation: {
          contextId: defineContextIdResolver({
            id: "test.team-context",
            version: resolverVersion,
            resolve: ({ freshContextId }) => freshContextId,
          }),
        },
      });
    const original = team("1.0.0");
    const now = new Date().toISOString();
    await sessions.create({
      schemaVersion: "pragma.expert-session/v5",
      sessionId: "fingerprint-session",
      expertId: original.id,
      definitionFingerprint: fingerprintExpertExecutionDefinition(original),
      status: "open",
      queuedRequestIds: [],
      executionIds: [],
      rootContextId: "root",
      contexts: {
        root: sessionRootContext("fingerprint-session", "root", lead.id, "fake", now),
      },
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      app.experts.resumeSession(team("2.0.0"), {
        sessionId: "fingerprint-session",
      }),
    ).rejects.toThrow("definition mismatch");
    expect((await sessions.get("fingerprint-session"))?.definitionFingerprint).toBe(
      fingerprintExpertExecutionDefinition(original),
    );
  });

  it("migrates an explicitly aliased persisted Expert definition on resume", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-definition-migration-"));
    const runtime = createFakeRuntime();
    const executions = createFileExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });
    const app = createPragma({
      pragmaHome: home,
      executionStore: executions,
      expertSessionStore: sessions,
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });
    const expert = await defineExpert({
      id: "canonical-expert",
      name: "Canonical Expert",
      description: "Canonical Expert",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const sessionId = "definition-migration-session";
    const contextId = "definition-migration-root";
    const systemSessionId = "definition-migration-runtime";
    const now = new Date().toISOString();
    await createRuntimeSessionRecord({
      paths: new PragmaPaths({ pragmaHome: home }),
      owner: { type: "expert-session", ownerId: sessionId, contextId },
      systemSessionId,
      agentId: "legacy-expert",
      runtime: { id: "fake", kind: "fake", displayName: "Fake" },
      workspace: home,
    });
    const rootContext = {
      ...sessionRootContext(sessionId, contextId, "legacy-expert", "fake", now),
      snapshot: {
        systemSessionId,
        runtimeSession: { type: "fake", id: "native-definition-migration-runtime" },
      },
    };
    await sessions.create({
      schemaVersion: "pragma.expert-session/v5",
      sessionId,
      expertId: "legacy-expert",
      definitionFingerprint: "b".repeat(64),
      status: "open",
      queuedRequestIds: [],
      executionIds: [],
      rootContextId: contextId,
      contexts: { [contextId]: rootContext },
      createdAt: now,
      updatedAt: now,
    });

    const resumed = await app.experts.resumeSession(expert, {
      sessionId,
      definitionMigration: {
        previousExpertId: "legacy-expert",
        reason: "test canonical Expert id migration",
      },
    });

    const migrated = await resumed.getState();
    expect(migrated.expertId).toBe(expert.id);
    expect(migrated.definitionFingerprint).toBe(fingerprintExpertExecutionDefinition(expert));
    expect(migrated.contexts[migrated.rootContextId]?.expert.id).toBe(expert.id);
    expect(
      (
        await readRuntimeSessionRecord(
          new PragmaPaths({ pragmaHome: home }),
          sessionId,
          systemSessionId,
        )
      ).expertId,
    ).toBe(expert.id);
    await resumed.close();
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

  it("does not emit an unhandled rejection for an unobserved historical turn result", async () => {
    const { app, expert } = await trackedFixture({ failQuery: "fail" });
    const session = await app.experts.createSession(expert);
    const failed = await session.prompt("fail", { requestId: "unobserved-history" });
    await expect(failed.result).rejects.toThrow("fake turn failed");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const historicalTurns = await session.listTurns();
      expect(historicalTurns).toHaveLength(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await session.close();
    }
  });

  it("cancels only the active submission and reuses its Runtime Session", async () => {
    const clearedPreviews: string[] = [];
    const { app, expert, stats } = await trackedFixture(
      { delayMs: 100 },
      {
        record: () => undefined,
        clearPreview: (observationId) => {
          clearedPreviews.push(observationId);
        },
      },
    );
    const session = await app.experts.createSession(expert);
    const active = await session.prompt("slow", { requestId: "slow" });
    await waitUntil(async () => stats.executionIds.length === 1);
    const cancelled = expect(active.result).rejects.toThrow();
    await active.cancel("stop current turn");
    await cancelled;
    await waitUntil(async () => clearedPreviews.length === 1);

    const next = await session.prompt("next", { requestId: "next" });
    await expect(next.result).resolves.toBe("tracked:next");
    await waitUntil(async () => clearedPreviews.length === 2);
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
    const home = await mkdtemp(join(tmpdir(), "pragma-attachment-delegation-"));
    const stats = createFakeRuntimeStats();
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [createFakeRuntime({ stats })],
        defaultRuntimeId: "fake",
      }),
    });
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
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
      scope: "test",
      workspace: home,
      tools: launcher.tools,
    });

    const session = await app.experts.createSession(lead);
    const attachmentPath = join(home, "context.md");
    const turn = await session.prompt("coordinate", {
      requestId: "standalone-delegation",
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          kind: "file",
          name: "context.md",
          path: attachmentPath,
        },
      ],
    });

    const result = await turn.result;
    expect(result).toContain(`lead:member:# Files mentioned by the user:`);
    expect(result).toContain(`## context.md: ${attachmentPath}`);
    expect(result).toContain("# My request\nsubtask");
    expect(stats.turnAttachmentPaths).toEqual([[attachmentPath], [attachmentPath]]);
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
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });
    const leaf = await defineExpert({
      id: "leaf",
      name: "Leaf",
      description: "Leaf",
      tags: [],
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
      scope: "test",
      workspace: home,
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const team = defineExpertTeam({
      id: "team",
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
      scope: "test",
      workspace: home,
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const team = defineExpertTeam({
      id: "team-fresh-agents",
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
      (tree) => tree.children[0]?.invocation.contextResolution,
    );
    await session.close();
    expect({
      opened: 3,
      closedBeforeSession: 0,
      closed: 3,
      childRuntimeContexts: true,
    }).toEqual({
      opened,
      closedBeforeSession,
      closed: stats.closeSessionCalls,
      childRuntimeContexts: childRuntimeContexts.every((snapshot) => snapshot !== undefined),
    });
  });

  it("routes ExpertTeam members through configured runtimes", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-team-runtime-routing-"));
    const statsA = createFakeRuntimeStats();
    const statsB = createFakeRuntimeStats();
    const runtimeA = createFakeRuntime({ runtimeId: "fake-a", stats: statsA });
    const runtimeB = createFakeRuntime({ runtimeId: "fake-b", stats: statsB });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtimeA, runtimeB],
        defaultRuntimeId: "fake-a",
      }),
    });
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      scope: "test",
      workspace: home,
      models: {
        default: {
          model: { providerId: "member-provider", modelId: "member-model" },
          thinkingLevel: "high",
        },
      },
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const team = defineExpertTeam({
      id: "runtime-routing-team",
      coordinator: lead,
      members: [member],
      delegation: {
        allow: { lead: ["member"], member: [] },
        runtimeByExpert: { member: "fake-b" },
      },
    });
    const session = await app.experts.createSession(team);
    await expect(
      (await session.prompt("coordinate", { requestId: "team-runtime-routing" })).result,
    ).resolves.toBe("lead:member:subtask");
    expect(statsA.createSessionCalls).toBe(1);
    expect(statsB.createSessionCalls).toBe(1);
    const memberModelSelection = {
      model: { providerId: "member-provider", modelId: "member-model" },
      thinkingLevel: "high",
    };
    expect(statsB.sessionModelSelections).toEqual([memberModelSelection]);
    expect(statsB.turnModelSelections).toEqual([memberModelSelection]);
    await session.close();
  });

  it("routes standalone SubAgents through launcher runtimeByExpert", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-launcher-runtime-routing-"));
    const statsA = createFakeRuntimeStats();
    const statsB = createFakeRuntimeStats();
    const runtimeA = createFakeRuntime({ runtimeId: "fake-a", stats: statsA });
    const runtimeB = createFakeRuntime({ runtimeId: "fake-b", stats: statsB });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtimeA, runtimeB],
        defaultRuntimeId: "fake-a",
      }),
    });
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      scope: "test",
      workspace: home,
      tools: createAgentLauncher({
        experts: [member],
        runtimeByExpert: { member: "fake-b" },
      }).tools,
    });
    const session = await app.experts.createSession(lead);
    await expect(
      (await session.prompt("coordinate", { requestId: "launcher-runtime-routing" })).result,
    ).resolves.toBe("lead:member:subtask");
    expect(statsA.createSessionCalls).toBe(1);
    expect(statsB.createSessionCalls).toBe(1);
    await session.close();
  });

  it("inherits the parent Runtime when runtimeByExpert is omitted", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-inherited-runtime-routing-"));
    const statsA = createFakeRuntimeStats();
    const statsB = createFakeRuntimeStats();
    const runtimeA = createFakeRuntime({ runtimeId: "fake-a", stats: statsA });
    const runtimeB = createFakeRuntime({ runtimeId: "fake-b", stats: statsB });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtimeA, runtimeB],
        defaultRuntimeId: "fake-a",
      }),
    });
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      scope: "test",
      workspace: home,
      tools: createAgentLauncher({ experts: [member] }).tools,
    });
    const session = await app.experts.createSession(lead, { runtime: "fake-b" });
    await expect(
      (await session.prompt("coordinate", { requestId: "inherited-runtime-routing" })).result,
    ).resolves.toBe("lead:member:subtask");
    expect(statsA.createSessionCalls).toBe(0);
    expect(statsB.createSessionCalls).toBe(2);
    await session.close();
  });

  it("uses a delegated Expert definition Runtime before the parent fallback", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-definition-runtime-routing-"));
    const statsA = createFakeRuntimeStats();
    const statsB = createFakeRuntimeStats();
    const runtimeA = createFakeRuntime({ runtimeId: "fake-a", stats: statsA });
    const runtimeB = createFakeRuntime({ runtimeId: "fake-b", stats: statsB });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtimeA, runtimeB],
        defaultRuntimeId: "fake-a",
      }),
    });
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      scope: "test",
      workspace: home,
      defaultRuntimeId: "fake-b",
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      scope: "test",
      workspace: home,
      tools: createAgentLauncher({ experts: [member] }).tools,
    });
    const session = await app.experts.createSession(lead);
    await (
      await session.prompt("coordinate", { requestId: "definition-runtime-routing" })
    ).result;
    expect(statsA.createSessionCalls).toBe(1);
    expect(statsB.createSessionCalls).toBe(1);
    await session.close();
  });

  it("uses an Expert definition Runtime for a root Session unless explicitly overridden", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-root-definition-runtime-"));
    const statsA = createFakeRuntimeStats();
    const statsB = createFakeRuntimeStats();
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [
          createFakeRuntime({ runtimeId: "fake-a", stats: statsA }),
          createFakeRuntime({ runtimeId: "fake-b", stats: statsB }),
        ],
        defaultRuntimeId: "fake-a",
      }),
    });
    const expert = await defineExpert({
      id: "root",
      name: "Root",
      description: "Root",
      tags: [],
      scope: "test",
      workspace: home,
      defaultRuntimeId: "fake-b",
    });
    const session = await app.experts.createSession(expert);
    await (
      await session.prompt("run", { requestId: "root-definition-runtime" })
    ).result;
    expect(statsA.createSessionCalls).toBe(0);
    expect(statsB.createSessionCalls).toBe(1);
    await session.close();
  });

  it("propagates an explicit nested Flow Runtime override above Expert defaults", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-nested-flow-runtime-routing-"));
    const statsA = createFakeRuntimeStats();
    const statsB = createFakeRuntimeStats();
    const statsC = createFakeRuntimeStats();
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [
          createFakeRuntime({ runtimeId: "fake-a", stats: statsA }),
          createFakeRuntime({ runtimeId: "fake-b", stats: statsB }),
          createFakeRuntime({ runtimeId: "fake-c", stats: statsC }),
        ],
        defaultRuntimeId: "fake-a",
      }),
    });
    const worker = await defineExpert({
      id: "worker",
      name: "Worker",
      description: "Worker",
      tags: [],
      scope: "test",
      workspace: home,
      defaultRuntimeId: "fake-b",
    });
    const nested = defineFlow({ id: "nested" });
    const work = nested.use("work", worker);
    nested.compose(({ start, end }) => start(work).next(end()));
    const outer = defineFlow({ id: "outer" });
    const callNested = outer.use("nested", nested, { runtime: "fake-c" });
    outer.compose(({ start, end }) => start(callNested).next(end()));

    await (
      await app.flows.start(outer, { input: "run" })
    ).result;
    expect(statsA.createSessionCalls).toBe(0);
    expect(statsB.createSessionCalls).toBe(0);
    expect(statsC.createSessionCalls).toBe(1);
  });

  it("lets Flow runtimeByExpert override ExpertTeam routing", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-flow-runtime-routing-"));
    const statsA = createFakeRuntimeStats();
    const statsB = createFakeRuntimeStats();
    const statsC = createFakeRuntimeStats();
    const runtimes = [
      createFakeRuntime({ runtimeId: "fake-a", stats: statsA }),
      createFakeRuntime({ runtimeId: "fake-b", stats: statsB }),
      createFakeRuntime({ runtimeId: "fake-c", stats: statsC }),
    ];
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({ runtimes, defaultRuntimeId: "fake-a" }),
    });
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const team = defineExpertTeam({
      id: "flow-runtime-routing-team",
      coordinator: lead,
      members: [member],
      delegation: { runtimeByExpert: { member: "fake-b" } },
    });
    const flow = defineFlow({
      id: "flow-runtime-routing",
      result: ({ state }) => state["review"],
    });
    const review = flow.use("review", team, {
      runtime: "fake-a",
      runtimeByExpert: { member: "fake-c" },
      reduce: ({ state, output }) => {
        state["review"] = output;
      },
    });
    flow.compose(({ start, end }) => start(review).next(end()));

    const execution = await app.flows.start(flow, { input: "coordinate" });
    await expect(execution.result).resolves.toBe("lead:member:subtask");
    expect(statsA.createSessionCalls).toBe(1);
    expect(statsB.createSessionCalls).toBe(0);
    expect(statsC.createSessionCalls).toBe(1);
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
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });
    const expert = await defineExpert({
      id: "steerable",
      name: "Steerable",
      description: "Steerable",
      tags: [],
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
      runtimes: createStaticRuntimeResolver({
        runtimes: [createFakeRuntime()],
        defaultRuntimeId: "fake",
      }),
    });
    const expert = await defineExpert({
      id: "durable",
      name: "Durable",
      description: "Durable",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const session = await app.experts.createSession(expert, { sessionId: "journal-session" });
    const current = await session.getState();
    const sessionCreated = (await session.listEvents()).items;
    const now = new Date().toISOString();
    const executionId = "journal-execution";
    const definition = { id: expert.id, kind: "expert" as const };
    await writeFile(
      new PragmaPaths({ pragmaHome: home }).expertSessionTransaction(session.sessionId),
      `${JSON.stringify({
        schemaVersion: "pragma.expert-session-transaction/v6",
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
          ...sessionCreated,
          {
            schemaVersion: "pragma.expert-session-event/v1",
            eventId: "prompt-enqueued:journal-request",
            cursor: { sessionId: session.sessionId, sequence: 3 },
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
          schemaVersion: "pragma.execution/v7",
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
          contextId: current.rootContextId,
          status: "queued",
          input: "recover me",
          createdAt: now,
          updatedAt: now,
        },
      })}\n`,
      "utf8",
    );
    expect((await session.getState()).executionIds).toContain(executionId);
    expect(await executions.get(executionId)).toMatchObject({
      schemaVersion: "pragma.execution/v9",
    });
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
      schemaVersion: "pragma.expert-session/v5",
      sessionId: "atomic-session",
      expertId: "expert",
      definitionFingerprint: "a".repeat(64),
      status: "open",
      queuedRequestIds: [],
      executionIds: [],
      rootContextId: "root-context",
      contexts: {
        "root-context": sessionRootContext("atomic-session", "root-context", "expert", "fake", now),
      },
      createdAt: now,
      updatedAt: now,
    });
    const created = await sessions.listEvents("atomic-session");
    const closedAt = new Date(Date.now() + 1).toISOString();
    const current = (await sessions.get("atomic-session"))!;
    const closedRoot = {
      ...current.contexts[current.rootContextId]!,
      lifecycle: "closed" as const,
      closedAt,
      updatedAt: closedAt,
    };
    await writeFile(
      new PragmaPaths({ pragmaHome: home }).expertSessionTransaction("atomic-session"),
      `${JSON.stringify({
        schemaVersion: "pragma.expert-session-transaction/v6",
        session: {
          ...current,
          status: "closed",
          contexts: { ...current.contexts, [current.rootContextId]: closedRoot },
          updatedAt: closedAt,
        },
        prompts: [],
        events: [
          ...created,
          {
            schemaVersion: "pragma.expert-session-event/v1",
            eventId: "context-closed:root-context",
            cursor: { sessionId: "atomic-session", sequence: 3 },
            sessionId: "atomic-session",
            type: "context.closed",
            data: { contextId: "root-context" },
            occurredAt: closedAt,
          },
          {
            schemaVersion: "pragma.expert-session-event/v1",
            eventId: "session-closed",
            cursor: { sessionId: "atomic-session", sequence: 4 },
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
      { type: "context.created" },
      { type: "context.closed" },
      { type: "session.closed" },
    ]);
  });
});

describe("FlowExecution", () => {
  it("rejects programmatic step IDs that the DSL cannot represent safely", () => {
    for (const id of ["constructor", "prototype", "__internal", `a${"b".repeat(100)}`]) {
      const flow = defineFlow({ id: `invalid-${id.slice(0, 12)}` });
      expect(() =>
        flow.task({
          id,
          handler: () => undefined,
        }),
      ).toThrow(`Invalid Flow step id: ${id}`);
    }
  });

  it("returns the actual terminal node result by default", async () => {
    const { app } = await fixture();
    const flow = defineFlow({ id: "canonical-results" });
    const prepare = flow.task({
      id: "prepare",
      handler: () => ({ score: 7 }),
    });
    const finish = flow.task({
      id: "finish",
      input: ({ state }) =>
        (state["nodes"] as { prepare: { result: { score: number } } }).prepare.result.score,
      handler: ({ input }) => input * 2,
    });
    flow.compose(({ start, end }) => start(prepare).next(finish).next(end()));

    await expect((await app.flows.start(flow, { input: null })).result).resolves.toBe(14);
  });

  it("returns the terminal result from the executed branch and exposes it to result mapping", async () => {
    const { app } = await fixture();
    const flow = defineFlow({
      id: "branch-result",
      output: z.object({ selected: z.string(), original: z.string() }),
      result: ({ input, terminal }) => ({
        selected: String(terminal.output),
        original: String(input),
      }),
    });
    const decide = flow.task({
      id: "decide",
      handler: ({ input }) => ({ branch: input }),
    });
    const yes = flow.task({ id: "yes", handler: () => "yes-result" });
    const no = flow.task({ id: "no", handler: () => "no-result" });
    flow.compose(({ start, step, end }) => {
      start(decide).route("branch", { yes, no });
      step(yes).next(end());
      step(no).next(end());
    });

    await expect((await app.flows.start(flow, { input: "no" })).result).resolves.toEqual({
      selected: "no-result",
      original: "no",
    });
  });

  it("persists a wall-clock timeout and aborts the active Task", async () => {
    const { app } = await fixture();
    let observedAbort = false;
    const flow = defineFlow({ id: "timeout-flow", timeoutMs: 1_000 });
    const task = flow.task({
      id: "wait",
      handler: async ({ signal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    flow.compose(({ start, end }) => start(task).next(end()));

    const execution = await app.flows.start(flow, { input: null });
    await expect(execution.result).rejects.toThrow("timed out");
    expect(observedAbort).toBe(true);
    expect((await execution.getState()).status).toBe("failed");
    expect((await execution.getTree()).children[0]?.invocation.status).toBe("failed");
  });

  it("pauses Flow timeout while a HumanTask is waiting", async () => {
    const { app } = await fixture();
    const flow = defineFlow({ id: "human-timeout-flow", timeoutMs: 250 });
    const gate = flow.humanTask({
      id: "approval",
      request: {
        kind: "approval",
        prompt: "Wait forever?",
        options: [
          { label: "Reject", description: "Stop." },
          { label: "Approve", description: "Continue." },
        ],
        approveOption: "Approve",
      },
    });
    flow.compose(({ start, end }) => start(gate).next(end()));

    const execution = await app.flows.start(flow, { input: null });
    const result = execution.result;
    void result.catch(() => undefined);
    await waitUntil(
      async () => (await execution.getTree()).children[0]?.invocation.status === "waiting",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await execution.getState()).status).toBe("running");
    const requested = (
      await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })
    ).items.find((event) => event.type === "human.requested")!;
    await execution.respondToHumanInteraction(
      (requested.data as { interactionId: string }).interactionId,
      { kind: "user_question", answered: true, answers: { "Wait forever?": "Approve" } },
      { requestId: "human-timeout-response" },
    );
    await expect(result).resolves.toMatchObject({
      approved: true,
      decision: "Approve",
    });
    expect((await execution.getState()).status).toBe("succeeded");
  });

  it("rejects Flow runtime routes hidden by ExpertTeam delegation", async () => {
    const { home } = await fixture();
    const hidden = await defineExpert({
      id: "hidden",
      name: "Hidden",
      description: "Only reachable from the standalone launcher",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Team member",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const coordinator = await defineExpert({
      id: "coordinator",
      name: "Coordinator",
      description: "Team coordinator",
      tags: [],
      scope: "test",
      workspace: home,
      tools: createAgentLauncher({ experts: [hidden] }).tools,
    });
    const team = defineExpertTeam({
      id: "governed-team",
      coordinator,
      members: [member],
      delegation: { allow: { coordinator: ["member"] } },
    });
    const flow = defineFlow({ id: "governed-team-flow" });

    expect(() => flow.use("team", team, { runtimeByExpert: { hidden: "fake" } })).toThrow(
      "runtimeByExpert target is unknown: hidden",
    );
  });

  it("keeps Runtime ownership scoped to the FlowExecution", async () => {
    const { home, app, expert, stats } = await trackedFixture();
    const flow = defineFlow({ id: "runtime-flow" });
    const expertStep = flow.use("expert", expert);
    flow.compose(({ start, end }) => start(expertStep).next(end()));

    const execution = await app.flows.start(flow, { input: "flow prompt" });
    const subscription = await execution.subscribeEvents({ scope: { kind: "all" } });
    const streamed = (async () => {
      const events = [];
      for await (const event of subscription) events.push(event);
      return events;
    })();
    await expect(execution.result).resolves.toBeDefined();
    expect(stats.createSessionCalls).toBe(1);
    expect(stats.sessionContexts[0]?.request.context).toEqual({
      source: { type: "pragma.flow", id: "runtime-flow" },
      attributes: {
        [EXECUTION_CURRENT_EXPERT_ID_ATTR]: expert.id,
        [EXECUTION_CONTEXT_ID_ATTR]: expect.any(String),
        [EXECUTION_ID_ATTR]: execution.executionId,
        [INVOCATION_ID_ATTR]: expect.any(String),
      },
    });
    expect(stats.closeSessionCalls).toBe(1);
    expect((await execution.getTree()).children[0]?.invocation.contextResolution).toBeDefined();
    const store = createFileExecutionStore({ pragmaHome: home });
    expect(await store.listContexts(execution.executionId)).toMatchObject([
      {
        lifecycle: "closed",
        runtime: { runtimeId: "fake", revision: 1 },
        snapshot: { systemSessionId: expect.any(String) },
      },
    ]);
    const eventTypes = (await streamed).map((event) => event.type);
    expect(eventTypes).toContain("context.closed");
    expect(eventTypes.indexOf("context.closed")).toBeLessThan(
      eventTypes.indexOf("execution.succeeded"),
    );
    await subscription.close();
  });

  it("atomically closes Runtime Contexts when a Flow is cancelled", async () => {
    const { home, app, expert } = await trackedFixture({ delayMs: 200 });
    const flow = defineFlow({ id: "cancel-context-flow" });
    const expertStep = flow.use("expert", expert);
    flow.compose(({ start, end }) => start(expertStep).next(end()));

    const execution = await app.flows.start(flow, { input: "cancel me" });
    const subscription = await execution.subscribeEvents({ scope: { kind: "all" } });
    const streamed = (async () => {
      const events = [];
      for await (const event of subscription) events.push(event);
      return events;
    })();
    const store = createFileExecutionStore({ pragmaHome: home });
    await waitUntil(async () => (await store.listContexts(execution.executionId)).length === 1);
    const result = expect(execution.result).rejects.toThrow("cancel context test");
    await execution.cancel("cancel context test");
    await result;
    expect(await store.listContexts(execution.executionId)).toMatchObject([
      { lifecycle: "closed" },
    ]);
    const eventTypes = (await streamed).map((event) => event.type);
    expect(eventTypes.indexOf("context.closed")).toBeLessThan(
      eventTypes.indexOf("execution.cancelled"),
    );
    await subscription.close();
  });

  it.each([
    { label: "fresh by default", expectedSessions: 2, reuses: false },
    { label: "reused when configured", expectedSessions: 1, reuses: true },
  ])("keeps repeated Expert Runtime Contexts $label", async (scenario) => {
    const { app, expert, stats } = await trackedFixture();
    const flow = defineFlow({ id: `context-${scenario.label}` });
    const expertStep = flow.use("expert", expert, {
      ...(scenario.reuses
        ? {
            contextId: defineContextIdResolver({
              id: "test.fixed-flow-context",
              version: "1.0.0",
              resolve: () => "fixed-flow-context",
            }),
          }
        : {}),
    });
    const review = flow.humanTask({
      id: "review",
      request: {
        kind: "review_gate",
        questions: [
          {
            header: "Decision",
            question: "Decision?",
            kind: "single_choice",
            options: [
              { label: "approve", description: "Approve" },
              { label: "revise", description: "Revise" },
              { label: "reject", description: "Reject" },
            ],
          },
        ],
      },
    });
    flow.compose(({ start, step, end, repeat }) => {
      start(expertStep)
        .next(review)
        .route("decision", {
          approve: end(),
          revise: repeat("revision", expertStep),
          reject: end(),
        });
      step(expertStep).next(review);
    });
    flow.loop({ id: "revision", entry: expertStep, steps: [expertStep, review], maxIterations: 2 });

    const execution = await app.flows.start(flow, { input: "initial" });
    const firstRequest = await waitForHumanRequest(execution, 0);
    await execution.respondToHumanInteraction(
      String((firstRequest.data as { interactionId: string }).interactionId),
      {
        kind: "user_question",
        answered: true,
        answers: { "Decision?": "revise" },
      },
      { requestId: `first-${scenario.label}` },
    );
    const secondRequest = await waitForHumanRequest(execution, 1);
    await execution.respondToHumanInteraction(
      String((secondRequest.data as { interactionId: string }).interactionId),
      {
        kind: "user_question",
        answered: true,
        answers: { "Decision?": "approve" },
      },
      { requestId: `second-${scenario.label}` },
    );
    await execution.result;

    const expertInvocations = (await execution.getTree()).children
      .map((child) => child.invocation)
      .filter((invocation) => invocation.nodeId === "expert");
    expect(expertInvocations).toHaveLength(2);
    expect(expertInvocations[0]?.contextId === expertInvocations[1]?.contextId).toBe(
      scenario.reuses,
    );
    expect(stats.createSessionCalls).toBe(scenario.expectedSessions);
  });

  it("runs inline Task nodes and exposes a read-only open view", async () => {
    const { app } = await fixture();
    let calls = 0;
    const flow = defineFlow({
      id: "flow",
      result: ({ state }) => state["answer"],
    });
    const task = flow.task({
      id: "task",
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

  it("preserves concurrent nested Flow reductions in one shared Execution", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-concurrent-nested-flows-"));
    const barrier = createBarrier(2, 5_000);
    const nested = (id: string, field: string) => {
      const flow = defineFlow({ id });
      const task = flow.task({
        id: "work",
        async handler({ state }) {
          expect(state["__pragma"]).toBeUndefined();
          await barrier.arriveAndWait();
          return field;
        },
        reduce: ({ state, output }) => {
          state[field] = output;
        },
      });
      flow.compose(({ start, end }) => start(task).next(end()));
      return flow.compile();
    };
    const firstFlow = nested("nested-a", "first");
    const secondFlow = nested("nested-b", "second");
    const resourceTool = (
      name: string,
      target: typeof firstFlow,
    ): ExpertAgentManagedTool<string, ExpertAgentToolCallResult> => ({
      name,
      description: `Invoke ${name}`,
      inputSchema: {},
      async call(input, signal, context) {
        const invoke = context?.execution?.invokeResource;
        if (invoke === undefined) return { text: "missing execution", isError: true as const };
        const output = await invoke({ target, input, signal });
        return { text: JSON.stringify(output), details: output };
      },
    });
    const runtime = createFakeRuntime({
      runtimeId: "fake",
      concurrentToolNames: ["call_first", "call_second"],
    });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });
    const expert = await defineExpert({
      id: "caller",
      name: "Caller",
      description: "Calls nested flows",
      tags: [],
      scope: "test",
      workspace: home,
      tools: [resourceTool("call_first", firstFlow), resourceTool("call_second", secondFlow)],
    });
    const session = await app.experts.createSession(expert);
    const turn = await session.prompt("run", { requestId: "concurrent-nested-flows" });
    await turn.result;
    expect((await turn.getState()).state).toMatchObject({ first: "first", second: "second" });
    await session.close();
  });

  it("returns an Expert resource call's small output without the inline handoff envelope", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-expert-resource-handoff-"));
    const runtime = createFakeRuntime({
      concurrentToolNamesByAgent: { caller: ["call_callee"] },
    });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: "fake",
      }),
    });
    const callee = await defineExpert({
      id: "callee",
      name: "Callee",
      description: "Returns a small result",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const callCallee: ExpertAgentManagedTool<string, ExpertAgentToolCallResult> = {
      name: "call_callee",
      description: "Call the callee",
      inputSchema: {},
      async call(_input, signal, context) {
        const invoke = context?.execution?.invokeResource;
        if (invoke === undefined) return { text: "missing execution", isError: true };
        const output = await invoke({
          target: callee,
          input: { prompt: "hello" },
          signal,
        });
        return { text: JSON.stringify(output), details: output };
      },
    };
    const caller = await defineExpert({
      id: "caller",
      name: "Caller",
      description: "Calls another Expert",
      tags: [],
      scope: "test",
      workspace: home,
      tools: [callCallee],
    });

    const session = await app.experts.createSession(caller);
    const turn = await session.prompt("run", { requestId: "expert-resource-handoff" });
    await expect(turn.result).resolves.toBe(JSON.stringify(["callee:hello"]));
    await session.close();
  });

  it("persists each mapped step input and preserves structured HumanTask responses", async () => {
    const { app, expert } = await fixture();
    const team = defineExpertTeam({
      id: "review-team",
      coordinator: expert,
      members: [],
      delegation: { allow: { [expert.id]: [] } },
    });
    const flow = defineFlow({
      id: "mapped-input-flow",
      result: ({ state }) => state["outcome"],
    });
    const prepare = flow.task({
      id: "prepare",
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
      handler: () => "approved",
      reduce: ({ state, output }) => {
        state["outcome"] = output;
      },
    });
    const revised = flow.task({
      id: "revised",
      handler: () => "revised",
      reduce: ({ state, output }) => {
        state["outcome"] = output;
      },
    });
    const rejected = flow.task({
      id: "rejected",
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
    const flow = defineFlow({ id: "approval-flow" });
    const approval = flow.humanTask({
      id: "approval",
      request: {
        kind: "approval",
        prompt: "Continue?",
        options: [
          { label: "Block", description: "Stop the Flow" },
          { label: "Allow", description: "Continue the Flow" },
        ],
        approveOption: "Allow",
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

  it("maps choice labels to stable selection values and applies the HumanTask output schema", async () => {
    const { app } = await fixture();
    const flow = defineFlow({ id: "choice-flow" });
    const choice = flow.humanTask({
      id: "choice",
      output: z.object({ selection: z.array(z.string()).min(1) }),
      request: {
        kind: "question",
        questions: [
          {
            header: "Release",
            question: "What should happen?",
            kind: "multiple_choice",
            options: [
              { value: "ship", label: "Ship now", description: "" },
              { value: "notify", label: "Notify users", description: "" },
              { value: "hold", label: "Hold", description: "" },
            ],
          },
        ],
      },
    });
    flow.compose(({ start, end }) => start(choice).next(end()));

    const execution = await app.flows.start(flow, { input: null });
    await waitUntil(
      async () => (await execution.getTree()).children[0]?.invocation.status === "waiting",
    );
    const requested = (
      await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })
    ).items.find((event) => event.type === "human.requested")!;
    await execution.respondToHumanInteraction(
      (requested.data as { interactionId: string }).interactionId,
      {
        kind: "user_question",
        answered: true,
        answers: { "What should happen?": ["Ship now", "Notify users"] },
      },
      { requestId: "choice-response" },
    );

    await expect(execution.result).resolves.toEqual({ selection: ["ship", "notify"] });
  });

  it("routes string arrays by ordered contains conditions", async () => {
    const { app } = await fixture();
    const flow = defineFlow({ id: "array-route-flow" });
    const source = flow.task({
      id: "source",
      handler: () => ({ selection: ["ship", "notify"] }),
    });
    const all = flow.task({ id: "all", handler: () => "all" });
    const any = flow.task({ id: "any", handler: () => "any" });
    const none = flow.task({ id: "none", handler: () => "none" });
    flow.compose(({ start, step, end }) => {
      start(source).routeArray("selection", [
        {
          id: "all_selected",
          operator: "contains_all",
          values: ["ship", "notify"],
          destination: all,
        },
        {
          id: "any_selected",
          operator: "contains_any",
          values: ["ship"],
          destination: any,
        },
        {
          id: "none_selected",
          operator: "contains_none",
          values: ["hold"],
          destination: none,
        },
      ]);
      step(all).next(end());
      step(any).next(end());
      step(none).next(end());
    });

    const execution = await app.flows.start(flow, { input: null });
    await expect(execution.result).resolves.toBe("all");
  });

  it("revisits Flow nodes until a terminal route is selected", async () => {
    const { app } = await fixture();
    const flow = defineFlow({
      id: "revision-loop-flow",
      result: ({ state }) => state["outcome"],
    });
    const review = flow.humanTask({
      id: "review",
      request: {
        kind: "review_gate",
        questions: [
          {
            header: "Decision",
            question: "Decision?",
            kind: "single_choice",
            options: [
              { label: "approve", description: "Approve" },
              { label: "revise", description: "Revise" },
              { label: "reject", description: "Reject" },
            ],
          },
        ],
      },
    });
    const approve = flow.task({
      id: "approve",
      handler: () => "approved",
      reduce: ({ state, output }) => {
        state["outcome"] = output;
      },
    });
    const reject = flow.task({
      id: "reject",
      handler: () => "rejected",
      reduce: ({ state, output }) => {
        state["outcome"] = output;
      },
    });
    flow.compose(({ start, step, end, repeat }) => {
      start(review).route("decision", { approve, revise: repeat("revision", review), reject });
      step(approve).next(end());
      step(reject).next(end());
    });
    flow.loop({
      id: "revision",
      entry: review,
      steps: [review],
      maxIterations: 3,
    });

    const execution = await app.flows.start(flow, { input: null });
    const firstRequest = await waitForHumanRequest(execution, 0);
    await execution.respondToHumanInteraction(
      String((firstRequest.data as { interactionId: string }).interactionId),
      {
        kind: "user_question",
        answered: true,
        answers: { "Decision?": "revise" },
      },
      { requestId: "revise-once" },
    );
    const secondRequest = await waitForHumanRequest(execution, 1);
    await execution.respondToHumanInteraction(
      String((secondRequest.data as { interactionId: string }).interactionId),
      {
        kind: "user_question",
        answered: true,
        answers: { "Decision?": "approve" },
      },
      { requestId: "approve-after-revision" },
    );

    await expect(execution.result).resolves.toBe("approved");
    const invocations = (await execution.getTree()).children.map((child) => child.invocation);
    expect(invocations.filter((invocation) => invocation.nodeId === "review")).toHaveLength(2);
    expect(invocations.filter((invocation) => invocation.nodeId === "approve")).toHaveLength(1);
    expect(invocations.filter((invocation) => invocation.nodeId === "reject")).toHaveLength(0);
    expect(
      (await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items.map(
        (event) => event.type,
      ),
    ).toContain("flow.loop.repeated");
  });

  it("marks a failing Task Invocation as failed", async () => {
    const { app } = await fixture();
    const flow = defineFlow({ id: "failing-flow" });
    const task = flow.task({
      id: "fails",
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
    const flow = defineFlow({ id: "failing-input-flow" });
    const task = flow.task({
      id: "fails-before-handler",
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

  it("rejects recover when a nested definition changes", async () => {
    const { home, app } = await fixture();
    const original = defineFlow({ id: "versioned-flow" });
    const waiting = original.humanTask({
      id: "approval",
      request: { kind: "approval", prompt: "Continue?" },
    });
    original.compose(({ start, end }) => start(waiting).next(end()));
    const execution = await app.flows.start(original, { input: null });
    await waitUntil(
      async () => (await execution.getTree()).children[0]?.invocation.status === "waiting",
    );

    const changed = defineFlow({ id: "versioned-flow" });
    const changedWaiting = changed.humanTask({
      id: "changed-approval",
      request: { kind: "approval", prompt: "Continue with the changed definition?" },
    });
    changed.compose(({ start, end }) => start(changedWaiting).next(end()));
    const secondApp = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [createFakeRuntime()],
        defaultRuntimeId: "fake",
      }),
    });
    await expect(
      secondApp.flows.recover(changed, { executionId: execution.executionId }),
    ).rejects.toThrow("definition graph mismatch");
    const cancelled = expect(execution.result).rejects.toThrow("test complete");
    await execution.cancel("test complete");
    await cancelled;
  });

  it("recovers a waiting HumanTask in a new app without rerunning completed steps", async () => {
    const { home, app } = await fixture();
    let prepareCalls = 0;
    const flow = defineFlow({ id: "human-recovery-flow", timeoutMs: 5_000 });
    const prepare = flow.task({
      id: "prepare",
      handler: () => {
        prepareCalls += 1;
        return "prepared";
      },
    });
    const approval = flow.humanTask({
      id: "approval",
      request: {
        kind: "approval",
        prompt: "Ship?",
        options: [
          { label: "Ship", description: "Continue." },
          { label: "Hold", description: "Stop." },
        ],
        approveOption: "Ship",
      },
    });
    const revise = flow.task({
      id: "revise",
      handler: () => "revised",
    });
    flow.compose(({ start, step, end }) => {
      start(prepare).next(approval).route("decision", { Ship: end(), Hold: revise });
      step(revise).repeat("approval-loop", approval);
    });
    flow.loop({
      id: "approval-loop",
      entry: approval,
      steps: [approval, revise],
      maxIterations: 2,
    });
    const execution = await app.flows.start(flow, { input: null });
    await waitUntil(
      async () =>
        (await execution.getTree()).children.find((child) => child.invocation.nodeId === "approval")
          ?.invocation.status === "waiting",
    );
    expect((await execution.getState()).status).toBe("running");

    const store = createFileExecutionStore({ pragmaHome: home });
    const stored = (await store.get(execution.executionId))!;
    const internal = stored.state["__pragma"] as { readonly deadlines?: Record<string, unknown> };
    await store.update(execution.executionId, {
      state: {
        ...stored.state,
        __pragma: {
          ...internal,
          deadlines: {
            ...(internal.deadlines ?? {}),
            [execution.executionId]: Date.now() - 1_000,
          },
        },
        __recoveryClaim: {
          claimId: "exited-process",
          processId: 2_147_483_647,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
      },
    });
    const restarted = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [createFakeRuntime()],
        defaultRuntimeId: "fake",
      }),
    });
    const recovered = await restarted.flows.recover(flow, { executionId: execution.executionId });
    const requested = (
      await recovered.listEvents({ scope: { kind: "all" }, limit: 1_000 })
    ).items.find((event) => event.type === "human.requested")!;
    const interactionId = String(
      (requested.data as { readonly interactionId: unknown }).interactionId,
    );
    await recovered.respondToHumanInteraction(
      interactionId,
      { kind: "user_question", answered: true, answers: { "Ship?": "Ship" } },
      { requestId: "answer-after-restart" },
    );
    await expect(recovered.result).resolves.toEqual({
      answers: { "Ship?": "Ship" },
      approved: true,
      decision: "Ship",
    });
    expect(prepareCalls).toBe(1);
    expect(
      (await recovered.getTree()).children.find((child) => child.invocation.nodeId === "approval")
        ?.invocation.output,
    ).toMatchObject({ approved: true, decision: "Ship" });
  });

  it("unwraps a completed Expert step before replaying its reduction during Flow recovery", async () => {
    const { home, app, expert } = await fixture();
    const flow = defineFlow({
      id: "expert-output-recovery-flow",
      result: ({ state }) => state["expertOutput"],
    });
    const work = flow.use("expert", expert, {
      input: () => "work",
      reduce: ({ state, output }) => {
        state["expertOutput"] = output;
      },
    });
    const approval = flow.humanTask({
      id: "approval",
      request: { kind: "approval", prompt: "Continue?" },
    });
    flow.compose(({ start, end }) => start(work).next(approval).next(end()));
    const compiled = flow.compile();

    const execution = await app.flows.start(compiled, { input: null });
    await waitUntil(
      async () =>
        (await execution.getTree()).children.find((child) => child.invocation.nodeId === "approval")
          ?.invocation.status === "waiting",
    );
    const store = createFileExecutionStore({ pragmaHome: home });
    const tree = await execution.getTree();
    const expertInvocation = tree.children.find(
      (child) => child.invocation.nodeId === "expert",
    )!.invocation;
    const stored = (await store.get(execution.executionId))!;
    const internal = structuredClone(stored.state["__pragma"]) as {
      reductions: Record<string, boolean>;
      flowControl: { transitions: Record<string, unknown> };
    };
    delete internal.reductions[expertInvocation.invocationId];
    delete internal.flowControl.transitions[expertInvocation.invocationId];
    const stateWithoutReduction = { ...stored.state };
    delete stateWithoutReduction["expertOutput"];
    await store.update(execution.executionId, {
      state: {
        ...stateWithoutReduction,
        __pragma: internal,
        __recoveryClaim: {
          claimId: "exited-process",
          processId: 2_147_483_647,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
      },
    });

    const restarted = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [createFakeRuntime()],
        defaultRuntimeId: "fake",
      }),
    });
    const recovered = await restarted.flows.recover(compiled, {
      executionId: execution.executionId,
    });
    const requested = (
      await recovered.listEvents({ scope: { kind: "all" }, limit: 1_000 })
    ).items.find((event) => event.type === "human.requested")!;
    await recovered.respondToHumanInteraction(
      String((requested.data as { interactionId: unknown }).interactionId),
      {
        kind: "user_question",
        answered: true,
        answers: { "Continue?": "approve" },
      },
      { requestId: "expert-output-recovery-approval" },
    );

    await expect(recovered.result).resolves.toBe("solo:work");
  });

  it("rejects recovery when only the Flow start step changes", async () => {
    const { app } = await fixture();
    const build = (startAtSecond: boolean) => {
      const flow = defineFlow({ id: "start-fingerprint" });
      const one = flow.humanTask({
        id: "one",
        request: { kind: "question", prompt: "One?" },
      });
      const two = flow.humanTask({
        id: "two",
        request: { kind: "question", prompt: "Two?" },
      });
      flow.compose(({ start, step }) => {
        if (startAtSecond) start(two).repeat("cycle", one);
        else start(one).next(two);
        if (startAtSecond) step(one).next(two);
        else step(two).repeat("cycle", one);
      });
      flow.loop({ id: "cycle", entry: one, steps: [one, two], maxIterations: 2 });
      return flow;
    };
    const execution = await app.flows.start(build(false), { input: null });
    await waitUntil(async () => (await execution.getTree()).children.length > 0);
    await expect(
      app.flows.recover(build(true), { executionId: execution.executionId }),
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
        schemaVersion: "pragma.execution/v9",
        executionId: "cross-process",
        version: 0,
        kind: "flow",
        definition: { id: "flow", kind: "flow" },
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
        definition: { id: "flow", kind: "flow" },
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
    const stats = { active: 0, maxActive: 0, memberTurns: 0 };
    const runtime = createOrchestrationRuntime(scenario, stats);
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: runtime.descriptor.id,
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
      ...(scenario === "reuse-spawn"
        ? {
            contextId: defineContextIdResolver({
              id: "test.reused-sub-agent",
              version: "1.0.0",
              resolve: ({ ownerContextId, target }) =>
                `${ownerContextId ?? "root"}:${target.expertId}`,
            }),
          }
        : {}),
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      scope: "test",
      workspace: home,
      pragmaHome: home,
      tools: launcher.tools,
    });
    const session = await app.experts.createSession(lead);
    const turn = await session.prompt("coordinate", { requestId: scenario });
    const output = await turn.result;
    const tree = await turn.getTree();
    const events = await turn.listEvents({ scope: { kind: "all" }, limit: 1_000 });
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
      measurement: "reported",
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
    const stats = { active: 0, maxActive: 0, memberTurns: 0 };
    const runtime = createOrchestrationRuntime("parent-failure", stats);
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: runtime.descriptor.id,
      }),
    });
    const member = await defineExpert({
      id: "member",
      name: "member",
      description: "member",
      tags: [],
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
    expect(stats.memberTurns).toBe(0);
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

  it("targets the requested older Agent when one Expert has multiple fresh Contexts", async () => {
    const result = await runScenario("followup-older");
    expect(result.tree.children).toHaveLength(3);
    const [first, second, followup] = result.tree.children.map((child) => child.invocation);
    expect(followup?.agentId).toBe(first?.agentId);
    expect(followup?.contextId).toBe(first?.contextId);
    expect(followup?.agentTaskSequence).toBe(1);
    expect(second?.agentId).not.toBe(first?.agentId);
    expect(second?.contextId).not.toBe(first?.contextId);
  });

  it("atomically folds concurrent dispatches for one Context into one Agent FIFO", async () => {
    const result = await runScenario("reuse-spawn");
    expect(result.tree.children).toHaveLength(2);
    const [first, second] = result.tree.children
      .map((child) => child.invocation)
      .sort((left, right) => (left.agentTaskSequence ?? 0) - (right.agentTaskSequence ?? 0));
    expect(first?.agentId).toBe(second?.agentId);
    expect(first?.contextId).toBe(second?.contextId);
    expect([first?.agentTaskSequence, second?.agentTaskSequence]).toEqual([0, 1]);
    expect(result.events.some((event) => event.type === "agent.reused")).toBe(true);
    expect(result.stats.maxActive).toBe(2);
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
  it("uses the same ContextIdResolver abstraction for launcher, team, and Flow", async () => {
    const { home, expert: lead } = await fixture();
    const member = await defineExpert({
      id: "shared-resolver-member",
      name: "Member",
      description: "Member",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const resolver = defineContextIdResolver({
      id: "test.shared-context-resolver",
      version: "1.0.0",
      resolve: ({ freshContextId }) => freshContextId,
    });
    const launcher = createAgentLauncher({ experts: [member], contextId: resolver });
    const team = defineExpertTeam({
      id: "shared-resolver-team",
      coordinator: lead,
      members: [member],
      delegation: { contextId: resolver },
    });
    const flow = defineFlow({ id: "shared-resolver-flow" });
    const review = flow.use("review", team, { contextId: resolver });
    flow.compose(({ start, end }) => start(review).next(end()));

    expect(readAgentDelegationDefinition(launcher.tools[0]!)?.contextId).toBe(resolver);
    expect(team.delegation.contextId).toBe(resolver);
    expect((flow.compile().steps.get("review")?.options as { contextId?: unknown }).contextId).toBe(
      resolver,
    );
  });

  it("validates standalone launcher targets and limits", async () => {
    const { expert } = await fixture();

    expect(() => createAgentLauncher({ experts: [] })).toThrow("at least one Expert");
    expect(() => createAgentLauncher({ experts: [expert, expert] })).toThrow("duplicate Expert");
    expect(() => createAgentLauncher({ experts: [expert], maxConcurrency: 0 })).toThrow(
      "maxConcurrency",
    );
    expect(() => createAgentLauncher({ experts: [expert], maxDepth: 0 })).toThrow("maxDepth");
    const launcher = createAgentLauncher({
      experts: [expert],
      runtimeByExpert: { [expert.id]: "fake" },
    });
    expect(launcher.tools.map((tool) => tool.name)).toEqual([
      "spawn_expert",
      "wait_experts",
      "list_experts",
      "followup_expert",
      "interrupt_expert",
    ]);
    expect(readAgentDelegationDefinition({ ...launcher.tools[0]! })?.experts).toEqual([expert]);
    expect(readAgentDelegationDefinition(launcher.tools[0]!)?.runtimeByExpert).toEqual(
      new Map([[expert.id, "fake"]]),
    );
    expect(
      (launcher.tools[0]?.inputSchema as { properties: Record<string, unknown> }).properties,
    ).not.toHaveProperty("runtime");
    expect(() =>
      createAgentLauncher({ experts: [expert], runtimeByExpert: { missing: "fake" } }),
    ).toThrow("runtimeByExpert target is unknown");
    expect(launcher.tools[0]?.description).toContain(
      `- ${expert.id}: ${expert.name}. ${expert.description}`,
    );
  });

  it("bounds Expert waits and applies the 10-minute default", async () => {
    const { expert } = await fixture();
    const launcher = createAgentLauncher({ experts: [expert] });
    const wait = launcher.tools.find((tool) => tool.name === "wait_experts");
    if (wait === undefined) throw new Error("wait_experts tool is missing.");

    expect(
      (wait.inputSchema as { properties: Record<string, unknown> }).properties["timeoutMs"],
    ).toEqual({
      type: "integer",
      minimum: 30_000,
      maximum: 3_600_000,
      default: 600_000,
    });

    let receivedTimeoutMs: number | undefined;
    const context = {
      execution: {
        executionId: "wait-timeout-test",
        invocationId: "wait-timeout-root",
        depth: 0,
        waitExperts: async (request: { readonly timeoutMs?: number | undefined }) => {
          receivedTimeoutMs = request.timeoutMs;
          return {};
        },
      },
    };

    await wait.call({ invocationIds: ["child"] }, undefined, context);
    expect(receivedTimeoutMs).toBe(600_000);

    await wait.call({ invocationIds: ["child"], timeoutMs: 30_000 }, undefined, context);
    expect(receivedTimeoutMs).toBe(30_000);

    await wait.call({ invocationIds: ["child"], timeoutMs: 3_600_000 }, undefined, context);
    expect(receivedTimeoutMs).toBe(3_600_000);

    await expect(
      wait.call({ invocationIds: ["child"], timeoutMs: 29_999 }, undefined, context),
    ).rejects.toThrow("timeoutMs must be an integer between 30000 and 3600000");
    await expect(
      wait.call({ invocationIds: ["child"], timeoutMs: 3_600_001 }, undefined, context),
    ).rejects.toThrow("timeoutMs must be an integer between 30000 and 3600000");
  });

  it("resolves ExpertTeam allowlists through the shared launcher definition", async () => {
    const { home, expert: lead } = await fixture();
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      scope: "test",
      workspace: home,
    });
    const team = defineExpertTeam({
      id: "bidirectional-team",
      coordinator: lead,
      members: [member],
      delegation: {
        allow: { solo: ["member"], member: ["solo"] },
        runtimeByExpert: { member: "fake-member", solo: "fake-lead" },
      },
    });
    const leadTools = createTeamDelegationTools(team, "solo");
    const memberTools = createTeamDelegationTools(team, "member");
    const leadTool = leadTools[0];
    const memberTool = memberTools[0];

    expect(readAgentDelegationDefinition(leadTool!)?.experts).toEqual([member]);
    expect(readAgentDelegationDefinition(memberTool!)?.experts).toEqual([lead]);
    expect(readAgentDelegationDefinition(leadTool!)?.runtimeByExpert).toEqual(
      new Map([["member", "fake-member"]]),
    );
    expect(readAgentDelegationDefinition(memberTool!)?.runtimeByExpert).toEqual(
      new Map([["solo", "fake-lead"]]),
    );
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
      scope: "test",
      workspace: home,
    });
    const team = defineExpertTeam({
      id: "default-delegation-team",
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
    expect(team.delegation.runtimeByExpert).toEqual(new Map());
  });

  it("loads optional Team instructions into every participant without mutating Experts", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-team-instructions-"));
    const stats = createFakeRuntimeStats();
    const runtime = createFakeRuntime({ stats });
    const app = createPragma({
      pragmaHome: home,
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });
    const projectContext = new ContextSystem({
      stores: {
        project: new StaticContextStore([
          {
            id: "PROJECT.md",
            content: "Existing project context.",
            metadata: { trigger: "always_on" },
          },
        ]),
      },
      roots: [{ namespace: "project" }],
    });
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Coordinates work",
      tags: [],
      scope: "test",
      workspace: home,
      pragmaHome: home,
      contextSystem: projectContext,
    });
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Completes delegated work",
      tags: [],
      scope: "test",
      workspace: home,
      pragmaHome: home,
      contextSystem: projectContext,
    });
    const instructions = "Surface uncertainty early and verify every deliverable.";
    const team = defineExpertTeam({
      id: "quality_team",
      instructions,
      coordinator: lead,
      members: [member],
      contextStores: [
        {
          namespace: "team_knowledge",
          store: new StaticContextStore([
            {
              id: "HANDBOOK.md",
              content: "Private team handbook.",
              metadata: { trigger: "always_on" },
            },
          ]),
          visibility: { mode: "whitelist", expertIds: ["member"] },
        },
      ],
      delegation: {},
    });

    const teamSession = await app.experts.createSession(team);
    await (
      await teamSession.prompt("deliver", { requestId: "team-instructions" })
    ).result;
    await teamSession.close();

    const teamContexts = stats.sessionContexts.filter((context) =>
      ["lead", "member"].includes(context.agent.id),
    );
    expect(teamContexts).toHaveLength(2);
    for (const context of teamContexts) {
      expect(context.agentContext.startupMessages).toEqual([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining(instructions),
        }),
      ]);
      expect(context.agentContext.startupMessages[0]?.content).toContain("id: TEAM.md");
      expect(context.agentContext.startupMessages[0]?.content).toContain(
        "namespace: expert-team:quality_team",
      );
      expect(context.agentContext.startupMessages[0]?.content).toContain(
        "Existing project context.",
      );
      expect(context.agentContext.startupMessages[0]?.content).toContain(
        "do not include this block in the generated summary",
      );
      expect(context.agentContext.startupMessages[0]?.content).toContain(
        "supersedes any summary, paraphrase, or older copy",
      );
      expect(context.agentContext.systemPrompt).toContain(
        "use read_expert_context to reload the relevant context id",
      );
      if (context.agent.id === "member") {
        expect(context.agentContext.startupMessages[0]?.content).toContain(
          "Private team handbook.",
        );
      } else {
        expect(context.agentContext.startupMessages[0]?.content).not.toContain(
          "Private team handbook.",
        );
      }
    }

    stats.sessionContexts.length = 0;
    const standalone = await app.experts.createSession(lead);
    await (
      await standalone.prompt("work alone", { requestId: "standalone" })
    ).result;
    await standalone.close();
    expect(stats.sessionContexts[0]?.agentContext.startupMessages[0]?.content).toContain(
      "Existing project context.",
    );
    expect(stats.sessionContexts[0]?.agentContext.startupMessages[0]?.content).not.toContain(
      instructions,
    );
    expect(stats.sessionContexts[0]?.agentContext.startupMessages[0]?.content).not.toContain(
      "Private team handbook.",
    );
  });

  it("validates allowlists and limits", async () => {
    const { expert } = await fixture();
    expect(() =>
      defineExpertTeam({
        id: "invalid",
        coordinator: expert,
        members: [],
        delegation: { allow: { solo: ["missing"] } },
      }),
    ).toThrow("unknown");
    expect(() =>
      defineExpertTeam({
        id: "invalid-runtime-route",
        coordinator: expert,
        members: [],
        delegation: { runtimeByExpert: { missing: "fake" } },
      }),
    ).toThrow("runtimeByExpert target is unknown");
  });
});

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function sessionRootContext(
  sessionId: string,
  contextId: string,
  expertId: string,
  runtimeId: string,
  now: string,
) {
  return {
    schemaVersion: "pragma.runtime-context/v5" as const,
    contextId,
    owner: { type: "expert-session" as const, ownerId: sessionId },
    origin: { type: "expert-session" as const, sessionId },
    expert: { id: expertId },
    runtime: { runtimeId, revision: 1, fingerprint: "a".repeat(64) },
    lifecycle: "open" as const,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitForHumanRequest(
  execution: FlowExecution,
  index: number,
): Promise<ExecutionEvent> {
  let requested: ExecutionEvent | undefined;
  await waitUntil(async () => {
    requested = (await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items.filter(
      (event) => event.type === "human.requested",
    )[index];
    return requested !== undefined;
  });
  return requested!;
}
