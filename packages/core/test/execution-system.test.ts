import { mkdtemp, rm } from "node:fs/promises";
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
  createPragma,
  createStaticRuntimeResolver,
  defineContextIdResolver,
  defineExpert,
  defineExpertTeam,
  defineFlow,
  defineRuntimeDriver,
  type RuntimeNativeSessionContext,
} from "../src/index.ts";
import { createInMemoryExecutionStore, createRuntimeTestFeatures } from "../src/testing/index.ts";

const temporaryHomes: string[] = [];
afterAll(async () => {
  await Promise.all(temporaryHomes.map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(id = "solo") {
  const home = await mkdtemp(join(tmpdir(), "pragma-core-orchestration-"));
  temporaryHomes.push(home);
  const expert = await defineExpert({
    id,
    name: "Test Expert",
    description: "Test Expert",
    tags: [],
    scope: "test",
    workspace: home,
  });
  return { home, expert };
}

function createFakeRuntime() {
  return defineRuntimeDriver<void, { context: RuntimeNativeSessionContext; id: string }>({
    features: createRuntimeTestFeatures({ enabled: ["cancellation", "close"] }),
    descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
    createSession: (context) => ({ context, id: `native-${context.systemSessionId}` }),
    restoreSession: (context) => ({ context, id: context.request.runtimeSession!.id }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: (session, turn) => {
      const output = `${session.context.agent.id}:${turn.rawQuery}`;
      turn.stream.write({
        runId: turn.runId,
        source: turn.source,
        type: "message.delta",
        payload: { contentType: "text", delta: output },
      });
      return { outputText: output, runtimeSessionId: session.id };
    },
    mapEvent: () => ({ events: [] }),
    cancelTurn: () => undefined,
    closeSession: () => undefined,
  });
}

describe("Core orchestration contracts", () => {
  it("unregisters a Runtime submission after batched event persistence fails", async () => {
    const { home, expert } = await fixture("tracked");
    const runtime = createFakeRuntime();
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
