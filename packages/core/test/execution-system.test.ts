import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  createTeamDelegationTools,
  readAgentDelegationDefinition,
} from "../src/agent/agent-launcher.ts";

import { ExecutionController } from "../src/execution/expert-runner.ts";
import {
  createAgentLauncher,
  createNoopLoggerProvider,
  createStaticRuntimeResolver,
  defineContextIdResolver,
  defineExpert,
  defineExpertTeam,
  defineFlow,
  defineRuntimeDriver,
  InMemoryContextStore,
  type AgentMessageUsage,
  type PragmaLoggerProvider,
  type RuntimeModelSelection,
  type RuntimeNativeSessionContext,
  type UsageSink,
} from "../src/index.ts";
import { createRuntimeTestFeatures } from "../src/testing/index.ts";

const temporaryHomes: string[] = [];

afterAll(async () => {
  await waitForTemporaryHomesToQuiesce();
  await Promise.all(
    temporaryHomes.splice(0).map(async (home) => {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }),
  );
});

async function createTemporaryHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  temporaryHomes.push(home);
  return home;
}

async function waitForTemporaryHomesToQuiesce(): Promise<void> {
  const deadline = Date.now() + 10_000;
  let quietSince: number | undefined;
  while (Date.now() < deadline) {
    let hasExecutionLock = false;
    for (const home of temporaryHomes) {
      try {
        const executions = await readdir(join(home, "state", "executions"), {
          withFileTypes: true,
        });
        for (const execution of executions) {
          if (!execution.isDirectory()) continue;
          const executionEntries = await readdir(
            join(home, "state", "executions", execution.name),
            { withFileTypes: true },
          );
          if (
            executionEntries.some(
              (entry) => entry.name === ".lock" || entry.name.startsWith(".lock.staging-"),
            )
          ) {
            hasExecutionLock = true;
            break;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (hasExecutionLock) break;
    }
    if (!hasExecutionLock) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 100) return;
    } else {
      quietSince = undefined;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for execution test resources to quiesce.");
}

interface FakeSession {
  readonly context: RuntimeNativeSessionContext;
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
  waitSteers: string[];
  sessionContexts: RuntimeNativeSessionContext[];
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
    waitSteers: [],
    sessionContexts: [],
  };
}

interface FakeRuntimeOptions {
  readonly cancelError?: string;
  readonly closeError?: string;
  readonly createDelayMs?: number;
  readonly concurrentToolNames?: readonly string[];
  readonly concurrentToolNamesByAgent?: Readonly<Record<string, readonly string[]>>;
  readonly delayMs?: number;
  readonly delayMsByAgent?: Readonly<Record<string, number>>;
  readonly delegationTargets?: Readonly<Record<string, string>>;
  readonly failSteer?: boolean;
  readonly failQuery?: string;
  readonly turnGate?: Promise<void>;
  readonly onSteer?: () => void;
  readonly reconcileSteer?: () => Promise<"delivered" | "not_dispatched" | "uncertain">;
  readonly onWait?: () => void;
  readonly runtimeId?: string;
  readonly stats?: FakeRuntimeStats;
  readonly usage?: AgentMessageUsage;
  readonly continueExisting?: boolean;
}

function createFakeRuntime(options: FakeRuntimeOptions = {}) {
  const stats = options.stats;
  return defineRuntimeDriver<AgentMessageUsage, FakeSession>({
    features: createRuntimeTestFeatures({
      enabled: [
        "cancellation",
        "close",
        ...(options.onSteer === undefined ? [] : (["steering"] as const)),
      ],
    }),
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
      if (turn.rawQuery === "active") await options.turnGate;
      const delayMs = options.delayMsByAgent?.[session.context.agent.id] ?? options.delayMs;
      if (delayMs !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      if (turn.rawQuery === options.failQuery) {
        if (options.usage !== undefined) turn.stream.writeNative(options.usage);
        throw new Error("fake turn failed");
      }
      const spawn = session.context.agent.tools?.find((tool) => tool.name === "spawn_expert");
      const continueTool = session.context.agent.tools?.find(
        (tool) => tool.name === "continue_expert",
      );
      const list = session.context.agent.tools?.find((tool) => tool.name === "list_agents");
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
        !turn.rawQuery.startsWith("[Pragma orchestration")
      ) {
        const listed =
          options.continueExisting === true && continueTool !== undefined && list !== undefined
            ? await list.call({ expertId: delegationTarget }, turn.signal, {
                execution: session.context.request.executionContext,
              })
            : undefined;
        const resumableContextId = (
          listed?.details as { contexts?: Array<{ contextId: string; status: string }> } | undefined
        )?.contexts?.find((context) => context.status === "resumable")?.contextId;
        const spawned =
          resumableContextId === undefined
            ? await spawn.call({ expertId: delegationTarget, task: "subtask" }, turn.signal, {
                execution: session.context.request.executionContext,
              })
            : await continueTool!.call(
                { contextId: resumableContextId, task: "subtask" },
                turn.signal,
                { execution: session.context.request.executionContext },
              );
        const invocationId = (spawned.details as { invocationId: string }).invocationId;
        const waiting = wait.call({ invocationIds: [invocationId] }, turn.signal, {
          execution: session.context.request.executionContext,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        options.onWait?.();
        const waited = await waiting;
        const waitSteer = (waited.details as { steer?: { content?: unknown } }).steer?.content;
        if (stats !== undefined && typeof waitSteer === "string") stats.waitSteers.push(waitSteer);
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
      if (options.cancelError !== undefined) throw new Error(options.cancelError);
    },
    ...(options.onSteer === undefined
      ? {}
      : {
          steerTurn: () => {
            options.onSteer?.();
            if (options.failSteer === true) throw new Error("fake steer failed");
          },
        }),
    ...(options.reconcileSteer === undefined ? {} : { reconcileSteer: options.reconcileSteer }),
    closeSession: () => {
      if (stats !== undefined) stats.closeSessionCalls += 1;
      if (options.closeError !== undefined) throw new Error(options.closeError);
    },
  });
}

async function fixture(delayMs?: number) {
  const home = await createTemporaryHome("pragma-execution-");
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
  loggerProvider?: PragmaLoggerProvider,
) {
  const home = await createTemporaryHome("pragma-runtime-ownership-");
  const stats = createFakeRuntimeStats();
  const runtime = createFakeRuntime({ ...options, stats });
  const app = createPragma({
    pragmaHome: home,
    runtimes: createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: runtime.descriptor.id,
    }),
    usageSink,
    loggerProvider,
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

import { createPragma as createCorePragma, type CreatePragmaOptions } from "../src/pragma-app.ts";
import { createInMemoryExecutionStore } from "../src/testing/index.ts";

const createPragma = (
  options: Omit<CreatePragmaOptions, "executionStore"> &
    Partial<Pick<CreatePragmaOptions, "executionStore">>,
) =>
  createCorePragma({
    ...options,
    executionStore: options.executionStore ?? createInMemoryExecutionStore(),
  });
describe("Core orchestration contracts", () => {
  it("unregisters a Runtime submission after batched event persistence fails", async () => {
    const { home, expert, runtime } = await trackedFixture();
    const executions = createInMemoryExecutionStore();
    const commit = executions.commit.bind(executions);
    let failBatch = true;
    executions.commit = async (input) => {
      if (failBatch && input.commitId.startsWith("runtime-events:")) {
        failBatch = false;
        throw new Error("event batch disk failure");
      }
      return await commit(input);
    };
    const app = createPragma({
      pragmaHome: home,
      executionStore: executions,
      loggerProvider: createNoopLoggerProvider(),
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });
    const unregister = vi.spyOn(ExecutionController.prototype, "unregisterRuntimeSubmission");
    const session = await app.experts.createSession(expert);
    try {
      const failed = await session.prompt("one", { requestId: "batch-failure" });
      await expect(failed.result).rejects.toThrow("event batch disk failure");
      await failed.settled;
      expect(unregister).toHaveBeenCalledOnce();
      const next = await session.prompt("two", { requestId: "after-batch-failure" });
      await expect(next.result).resolves.toBe("tracked:two");
      await next.settled;
      expect(unregister).toHaveBeenCalledTimes(2);
    } finally {
      unregister.mockRestore();
      await session.close();
    }
  });
  it("keeps ContextIdResolver policy on Flow while spawn and continue have fixed semantics", async () => {
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
    const launcher = createAgentLauncher({ experts: [member] });
    const team = defineExpertTeam({
      id: "shared-resolver-team",
      coordinator: lead,
      members: [member],
      delegation: {},
    });
    const flow = defineFlow({ id: "shared-resolver-flow" });
    const review = flow.use("review", team, { contextId: resolver });
    flow.compose(({ start, end }) => start(review).next(end()));

    expect(readAgentDelegationDefinition(launcher.tools[0]!)).not.toHaveProperty("contextId");
    expect(team.delegation).not.toHaveProperty("contextId");
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
      "continue_expert",
      "list_agents",
      "wait_experts",
      "steer_expert",
      "interrupt_expert",
    ]);
    const steer = launcher.tools.find((tool) => tool.name === "steer_expert");
    expect(steer?.inputSchema).toMatchObject({
      required: ["invocationId", "instruction", "delivery"],
      properties: {
        delivery: { enum: ["next_boundary", "after_current"] },
      },
    });
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
  it("resolves ExpertTeam permissions through the shared launcher definition", async () => {
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
        permissions: { spawn: { member: ["solo"] } },
        runtimeByExpert: { member: "fake-member", solo: "fake-lead" },
      },
    });
    const leadTools = createTeamDelegationTools(team, "solo");
    const memberTools = createTeamDelegationTools(team, "member");
    const leadTool = leadTools[0];
    const memberTool = memberTools[0];

    expect(readAgentDelegationDefinition(leadTool!)?.experts).toEqual([lead, member]);
    expect(readAgentDelegationDefinition(leadTool!)?.isCoordinator).toBe(true);
    expect(readAgentDelegationDefinition(leadTool!)?.spawnExpertIds).toEqual(new Set(["member"]));
    expect(readAgentDelegationDefinition(leadTool!)?.interactExpertIds).toEqual(
      new Set(["solo", "member"]),
    );
    expect(readAgentDelegationDefinition(memberTool!)?.experts).toEqual([lead, member]);
    expect(readAgentDelegationDefinition(memberTool!)?.isCoordinator).toBe(false);
    expect(readAgentDelegationDefinition(leadTool!)?.runtimeByExpert).toEqual(
      new Map([["member", "fake-member"]]),
    );
    expect(readAgentDelegationDefinition(memberTool!)?.runtimeByExpert).toEqual(
      new Map([["solo", "fake-lead"]]),
    );
    expect(leadTools).toHaveLength(6);
    expect(memberTools).toHaveLength(6);
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
    ).toEqual([lead, member]);
    expect(createTeamDelegationTools(team, "member").map((tool) => tool.name)).toEqual([
      "list_agents",
    ]);
    expect(team.delegation.maxConcurrency).toBe(4);
    expect(team.delegation.maxDepth).toBe(3);
    expect(team.delegation.runtimeByExpert).toEqual(new Map());
  });
});
