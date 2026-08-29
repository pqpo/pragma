import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileExecutionStore,
  createFileExpertSessionStore,
  createStaticRuntimeResolver,
  defineExpert,
  defineExpertTeam,
  defineFlow,
  encodePragmaPathSegment,
  PragmaPaths,
  type RuntimeAdapter,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import type { ExecutorDescriptor, WorkspaceSelection } from "@pragma/shared/integration";
import { afterEach, describe, expect, it } from "vitest";

import {
  createControllerRunMissionPort,
  createCoreRunExecutorPort,
  createLocalHostMissionBoardBindings,
  createLocalHostRunApplication,
  createMissionControllerStore,
  type LocalHostCoreExecutorDefinition,
  type LocalHostRunRequest,
} from "../src/index.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Core-backed Local Host run composition", { timeout: 10_000 }, () => {
  it("runs a stable Expert through the Mission vertical slice", async () => {
    const { home, run, sessions } = await createRunFixture();
    const expert = await run.start(createRequest(home, "expert", "a".repeat(16), "hello expert"));
    await expect(expert.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: "fixture-expert:hello expert",
    });
    expect((await sessions.get(expert.missionId))?.sessionId).toBe(expert.missionId);
  });

  it("releases terminal Expert runtime resources while retaining durable recovery state", async () => {
    const { home, run, sessions, runtimeState } = await createRunFixture();
    const expert = await run.start(createRequest(home, "expert", "a".repeat(16), "release me"));

    await expect(expert.outcome).resolves.toMatchObject({ status: "succeeded" });

    expect(runtimeState.closeCount).toBe(1);
    const session = await sessions.get(expert.missionId);
    expect(session).toMatchObject({ sessionId: expert.missionId, status: "open" });
    const rootContext = session?.contexts[session.rootContextId];
    expect(rootContext?.snapshot?.runtimeSession.id).toMatch(/^native-/);
    await expect(
      access(new PragmaPaths({ pragmaHome: home }).expertSessionLease(expert.missionId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists large Expert output in the Mission Board overflow target", async () => {
    const { home, run } = await createRunFixture();
    const large = await run.start(createRequest(home, "expert", "e".repeat(16), "large output"));
    const largeOutcome = await large.outcome;
    expect(largeOutcome).toMatchObject({ status: "succeeded", result: { type: "context" } });
    if (
      largeOutcome.status === "succeeded" &&
      typeof largeOutcome.result === "object" &&
      largeOutcome.result !== null &&
      !Array.isArray(largeOutcome.result) &&
      largeOutcome.result["type"] === "context"
    ) {
      const context = largeOutcome.result["contexts"];
      expect(Array.isArray(context)).toBe(true);
      const contextId = (context as Array<{ readonly id?: unknown }>)[0]?.id;
      expect(typeof contextId).toBe("string");
      await expect(
        readFile(
          join(
            home,
            "data",
            "missions",
            encodePragmaPathSegment(large.missionId),
            "board",
            "shared",
            contextId as string,
          ),
          "utf8",
        ),
      ).resolves.toHaveLength(40 * 1024);
    }
  });

  it("runs a stable Team through the Mission vertical slice", async () => {
    const { home, run, sessions } = await createRunFixture();
    const team = await run.start(createRequest(home, "team", "b".repeat(16), "hello team"));
    await expect(team.outcome).resolves.toMatchObject({
      status: "succeeded",
      result: "fixture-lead:hello team",
    });
    expect((await sessions.get(team.missionId))?.sessionId).toBe(team.missionId);
  });

  it("runs a stable Flow through the Mission vertical slice", async () => {
    const { home, run } = await createRunFixture();
    const flow = await run.start({
      ...createRequest(home, "flow", "c".repeat(16), undefined),
      input: { value: 7 },
    });
    await expect(flow.outcome).resolves.toMatchObject({
      status: "succeeded",
      executionId: flow.missionId,
      result: { value: 14 },
    });
  });

  it("checkpoints a Flow HumanTask without retaining the recovery claim", async () => {
    const { home, run, executions, controller } = await createRunFixture();
    const human = await run.start(createRequest(home, "flow", "d".repeat(16), undefined), {
      onHumanInteraction: async (request) => {
        expect(request.interaction.kind).toBe("manual_intervention");
        return { kind: "checkpoint" };
      },
    });
    await expect(human.outcome).resolves.toMatchObject({
      status: "input_required",
      executionId: human.missionId,
      interaction: { interaction: { kind: "manual_intervention" } },
    });
    await expect(executions.get(human.missionId)).resolves.toMatchObject({ status: "waiting" });

    const humanSnapshot = await controller.readSnapshot({ missionId: human.missionId });
    expect(humanSnapshot.events.map((event) => event.type)).toContain("run.input_required");
    expect(humanSnapshot.snapshot.lease).toBeUndefined();
  });
});

async function createRunFixture(): Promise<{
  readonly home: string;
  readonly executions: ReturnType<typeof createFileExecutionStore>;
  readonly sessions: ReturnType<typeof createFileExpertSessionStore>;
  readonly controller: ReturnType<typeof createMissionControllerStore>;
  readonly runtimeState: FixtureRuntimeState;
  readonly run: ReturnType<typeof createLocalHostRunApplication>;
}> {
  const home = await mkdtemp(join(tmpdir(), "pragma-core-run-"));
  tempDirectories.push(home);
  const runtimeState: FixtureRuntimeState = { closeCount: 0 };
  const runtime = createFixtureRuntime(runtimeState);
  const runtimes = createStaticRuntimeResolver({
    runtimes: [runtime],
    defaultRuntimeId: "fixture",
  });
  const executions = createFileExecutionStore({ pragmaHome: home });
  const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });
  const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
  const run = createLocalHostRunApplication({
    executors: createCoreRunExecutorPort({
      pragmaHome: home,
      runtimes,
      executions,
      sessions,
      createHostContextBindings: async ({ missionId }) =>
        await createLocalHostMissionBoardBindings({ pragmaHome: home, missionId }),
      executors: await createExecutorDefinitions(home),
    }),
    mission: createControllerRunMissionPort(controller),
  });
  return { home, executions, sessions, controller, runtimeState, run };
}

async function createExecutorDefinitions(
  home: string,
): Promise<readonly LocalHostCoreExecutorDefinition[]> {
  const expert = await defineExpert({
    id: "expert-definition",
    name: "Fixture Expert",
    description: "Fixture Expert",
    tags: [],
    scope: "test",
    workspace: home,
    pragmaHome: home,
  });
  const coordinator = await defineExpert({
    id: "lead-definition",
    name: "Fixture Lead",
    description: "Fixture Lead",
    tags: [],
    scope: "test",
    workspace: home,
    pragmaHome: home,
  });
  const largeExpert = await defineExpert({
    id: "large-definition",
    name: "Large Fixture Expert",
    description: "Large output fixture",
    tags: [],
    scope: "test",
    workspace: home,
    pragmaHome: home,
  });
  const team = defineExpertTeam({
    id: "team-definition",
    coordinator,
    members: [],
    delegation: {},
  });
  const flow = defineFlow<{ value: number }, { value: number }>({
    id: "flow-definition",
    result: ({ terminal }) => terminal.output as { value: number },
  });
  const double = flow.task({
    id: "double",
    handler: ({ input }) => ({ value: input.value * 2 }),
  });
  flow.compose(({ start, end }) => start(double).next(end()));

  const humanFlow = defineFlow({ id: "human-flow" });
  const gate = humanFlow.humanTask({
    id: "gate",
    request: { kind: "manual_intervention", title: "Review", prompt: "Review this run." },
  });
  humanFlow.compose(({ start, end }) => start(gate).next(end()));

  return [
    createExecutorDescriptor({ kind: "expert", id: "a".repeat(16) }, expert),
    createExecutorDescriptor({ kind: "expert", id: "e".repeat(16) }, largeExpert),
    createExecutorDescriptor({ kind: "team", id: "b".repeat(16) }, team),
    createExecutorDescriptor({ kind: "flow", id: "c".repeat(16) }, flow),
    createExecutorDescriptor({ kind: "flow", id: "d".repeat(16) }, humanFlow),
  ];
}

function createExecutorDescriptor(
  ref: ExecutorDescriptor["ref"],
  definition: LocalHostCoreExecutorDefinition["definition"],
): LocalHostCoreExecutorDefinition {
  return {
    descriptor: {
      schemaVersion: "pragma.integration-executor/v1",
      ref,
      name:
        ref.kind === "expert"
          ? "Fixture Expert"
          : ref.kind === "team"
            ? "Fixture Team"
            : "Fixture Flow",
      description: "Core vertical-slice fixture",
      source: "built_in",
      availability: { status: "ready", blockingCodes: [] },
      workspace: { required: true, allowNonGitDirectory: true },
      capabilities: {
        interactive: false,
        resumable: true,
        steerable: false,
        supportsQueue: false,
      },
    },
    definition,
  };
}

function createRequest(
  home: string,
  kind: "expert" | "team" | "flow",
  id: string,
  prompt: string | undefined,
): LocalHostRunRequest {
  return {
    requestId: randomUUID(),
    command: `${kind}.run`,
    executor: { kind, id },
    workspace: createWorkspace(home),
    ...(prompt === undefined ? {} : { prompt }),
    detach: false,
  };
}

function createWorkspace(home: string): WorkspaceSelection {
  return {
    schemaVersion: "pragma.integration-workspace/v1",
    requestedPath: home,
    canonicalPath: home,
    displayName: "fixture",
    identityHash: `sha256:${"d".repeat(64)}`,
    access: { exists: true, readable: true, writable: true },
    source: "explicit",
  };
}

interface FixtureRuntimeState {
  closeCount: number;
}

function createFixtureRuntime(state: FixtureRuntimeState): RuntimeAdapter {
  return defineRuntimeTestDriver<never, { readonly id: string; readonly agentId: string }>({
    descriptor: { id: "fixture", kind: "test", displayName: "Fixture Runtime" },
    createSession: ({ systemSessionId, agent }) => ({
      id: `native-${systemSessionId}`,
      agentId: agent.id,
    }),
    restoreSession: ({ runtimeSession, agent }) => ({ id: runtimeSession!.id, agentId: agent.id }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: async (session, turn) => ({
      outputText:
        session.agentId === "large-definition"
          ? "x".repeat(40 * 1024)
          : `fixture-${session.agentId === "lead-definition" ? "lead" : "expert"}:${turn.rawQuery}`,
      runtimeSessionId: session.id,
    }),
    mapEvent: () => ({ events: [] }),
    closeSession: () => {
      state.closeCount += 1;
    },
  });
}
