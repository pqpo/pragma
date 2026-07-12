import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createLocalSandboxManager,
  createPragma,
  createRuntimeRegistry,
  defineFlow,
  defineHumanTask,
  defineTask,
  ExpertAgent,
} from "../../src/index.ts";
import type {
  RunTree,
  RuntimeAgentSession,
  RuntimeDriverSessionRequest,
  RuntimeSubmitHandle,
} from "../../src/index.ts";
import { createTestRuntimeAdapter } from "../runtime-test-utils.ts";

describe("file Workflow storage", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all(
      roots
        .splice(0)
        .map((root) =>
          rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
        ),
    );
  });

  it("rebuilds get, result, and event replay in a new app instance", async () => {
    const pragmaHome = await createTempHome();
    const definition = defineTask({
      id: "persisted-task",
      version: "1.0.0",
      output: z.string(),
      handler: () => "persisted output",
    });
    const first = createPragma({ pragmaHome });
    const completed = await first.run(definition, { input: {} });

    const restarted = createPragma({ pragmaHome });
    const summary = await restarted.runs.get(completed.workflowRunId);
    const result = await restarted.runs.result(completed.workflowRunId, z.string());
    const events = [];
    for await (const event of restarted.runs.watch(completed.workflowRunId, {
      from: "beginning",
    })) {
      events.push(event);
    }

    expect(summary?.workflow.status).toBe("succeeded");
    expect(result.output).toBe("persisted output");
    expect(events.at(-1)?.type).toBe("workflow.completed");
    expect(events.map((event) => event.cursor.sequence)).toEqual(
      events.map((_event, index) => index + 1),
    );
    const replayed = [];
    const cursor = events[2]?.cursor;
    if (cursor === undefined) throw new Error("Expected a persisted cursor.");
    for await (const event of restarted.runs.watch(completed.workflowRunId, {
      from: { after: cursor },
    })) {
      replayed.push(event);
    }
    expect(replayed.map((event) => event.cursor.sequence)).toEqual(
      events.slice(3).map((event) => event.cursor.sequence),
    );
  });

  it("loads schema version 1 snapshots written before execution metadata was added", async () => {
    const pragmaHome = await createTempHome();
    const definition = defineTask({
      id: "legacy-persisted-task",
      version: "1.0.0",
      handler: () => "persisted output",
    });
    const completed = await createPragma({ pragmaHome }).run(definition, { input: {} });
    const workflowsRoot = join(pragmaHome, "state", "workflows");
    const [workflowDirectory] = await readdir(workflowsRoot);
    if (workflowDirectory === undefined)
      throw new Error("Expected a persisted Workflow directory.");
    const snapshotFile = join(workflowsRoot, workflowDirectory, "workflow.json");
    const snapshot = JSON.parse(await readFile(snapshotFile, "utf8")) as {
      workflow: { execution?: unknown };
      tasks: Array<{ status: string; transitionApplied?: boolean }>;
    };
    delete snapshot.workflow.execution;
    for (const task of snapshot.tasks) delete task.transitionApplied;
    await writeFile(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

    const summary = await createPragma({ pragmaHome }).runs.get(completed.workflowRunId);

    expect(summary?.workflow.execution).toEqual({});
    expect(summary?.tasks).toMatchObject([{ status: "succeeded", transitionApplied: true }]);
  });

  it("keeps Pragma state outside the Agent workspace", async () => {
    const pragmaHome = await createTempHome();
    const workspace = await mkdtemp(join(tmpdir(), "pragma-workspace-test-"));
    roots.push(workspace);
    const app = createPragma({
      pragmaHome,
      sandboxManager: createLocalSandboxManager({ workspaceRoot: workspace }),
    });
    await app.run(
      defineTask({ id: "workspace-isolation", version: "1.0.0", handler: () => "done" }),
      { input: {} },
    );

    await expect(access(join(workspace, ".pragma"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes a pending Human Interaction without the old Promise", async () => {
    const pragmaHome = await createTempHome();
    const definition = defineHumanTask({
      id: "durable-approval",
      version: "1.0.0",
      request: { kind: "approval", title: "Approve durable work" },
    });
    const first = createPragma({ pragmaHome });
    const original = await first.start(definition, { input: {} });
    const interaction = await waitForInteraction(first, original.workflowRunId);

    const restarted = createPragma({ pragmaHome });
    const resumed = await restarted.resume(definition, { workflowRunId: original.workflowRunId });
    await restarted.taskManager.respondToHumanInteraction({
      interactionId: interaction.id,
      response: { approved: true },
    });

    await expect(resumed.result).resolves.toMatchObject({
      workflowRunId: original.workflowRunId,
      output: { approved: true },
    });
    expect((await restarted.runs.get(original.workflowRunId))?.workflow.status).toBe("succeeded");
  });

  it("rejects a Root definition version mismatch before recovery", async () => {
    const pragmaHome = await createTempHome();
    const v1 = defineHumanTask({
      id: "versioned-human",
      version: "1.0.0",
      request: { kind: "approval", title: "Wait" },
    });
    const first = createPragma({ pragmaHome });
    const handle = await first.start(v1, { input: {} });
    await waitForInteraction(first, handle.workflowRunId);
    const v2 = defineHumanTask({
      id: "versioned-human",
      version: "2.0.0",
      request: { kind: "approval", title: "Wait" },
    });

    await expect(
      createPragma({ pragmaHome }).resume(v2, { workflowRunId: handle.workflowRunId }),
    ).rejects.toThrow("definition mismatch");
  });

  it("rebuilds a persisted child tree and rejects a child definition mismatch", async () => {
    const pragmaHome = await createTempHome();
    const original = createNestedDefinition("1.0.0");
    const completed = await createPragma({ pragmaHome }).run(original, { input: {} });
    const restarted = createPragma({ pragmaHome });

    expect((await restarted.runs.getTree(completed.workflowRunId))?.children).toHaveLength(1);
    await expect(
      restarted.resume(createNestedDefinition("2.0.0"), {
        workflowRunId: completed.workflowRunId,
      }),
    ).rejects.toThrow("definition mismatch");
  });

  it("reads a Child result and event stream independently after restart", async () => {
    const pragmaHome = await createTempHome();
    const completed = await createPragma({ pragmaHome }).run(createNestedDefinition("1.0.0"), {
      input: {},
    });
    const restarted = createPragma({ pragmaHome });
    const child = (await restarted.runs.getTree(completed.workflowRunId))?.children[0];
    if (child === undefined) throw new Error("Expected a persisted Child Workflow.");

    const result = await restarted.runs.result(child.workflow.id, z.unknown());
    const events = [];
    for await (const event of restarted.runs.watch(child.workflow.id, { from: "beginning" })) {
      events.push(event);
    }

    expect(result.workflowRunId).toBe(child.workflow.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.workflowRunId === child.workflow.id)).toBe(true);
    expect(events.at(-1)?.type).toBe("workflow.completed");
  });

  it("switches from replay to live events without gaps or duplicates", async () => {
    const pragmaHome = await createTempHome();
    const definition = defineHumanTask({
      id: "replay-live-human",
      version: "1.0.0",
      request: { kind: "approval", title: "Replay then continue" },
    });
    const first = createPragma({ pragmaHome });
    const handle = await first.start(definition, { input: {} });
    const interaction = await waitForInteraction(first, handle.workflowRunId);
    const restarted = createPragma({ pragmaHome });
    const resumed = await restarted.resume(definition, { workflowRunId: handle.workflowRunId });
    const collected = collectEvents(
      restarted.runs.watch(handle.workflowRunId, { from: "beginning" }),
    );

    await restarted.taskManager.respondToHumanInteraction({
      interactionId: interaction.id,
      response: { approved: true },
    });
    await resumed.result;
    const events = await collected;

    expect(events.at(-1)?.type).toBe("workflow.completed");
    expect(events.map((event) => event.cursor.sequence)).toEqual(
      events.map((_event, index) => index + 1),
    );
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });

  it("recovers a running Child before replaying its running Parent Task", async () => {
    const pragmaHome = await createTempHome();
    let childExecutions = 0;
    let parentReductions = 0;
    const child = defineFlow({ id: "running-child", version: "1.0.0" });
    const childTask = child.use(
      "work",
      defineTask({
        id: "recoverable-child-task",
        version: "1.0.0",
        handler: () => {
          childExecutions += 1;
          return childExecutions === 1 ? new Promise<string>(() => undefined) : "recovered";
        },
      }),
    );
    child.compose(({ start, end }) => start(childTask).next(end()));
    const root = defineFlow({ id: "running-root", version: "1.0.0" });
    const childStep = root.use("child", child, {
      reduce: ({ state, output }) => {
        parentReductions += 1;
        state.results["child"] = output;
      },
    });
    root.compose(({ start, end }) => start(childStep).next(end()));

    const original = await createPragma({ pragmaHome }).start(root, { input: {} });
    await waitForTreeState(pragmaHome, original.workflowRunId, (tree) =>
      Boolean(
        childExecutions === 1 &&
          tree?.workflow.status === "running" &&
          tree.children[0]?.workflow.status === "running" &&
          tree.children[0]?.tasks.some((task) => task.status === "running"),
      ),
    );
    const resumed = await createPragma({ pragmaHome }).resume(root, {
      workflowRunId: original.workflowRunId,
    });

    await expect(resumed.result).resolves.toMatchObject({
      workflowRunId: original.workflowRunId,
    });
    expect(childExecutions).toBe(2);
    expect(parentReductions).toBe(1);
  });

  it("reopens a Runtime Task with its original Workflow and Session identities", async () => {
    const pragmaHome = await createTempHome();
    const requests: RuntimeDriverSessionRequest[] = [];
    const runtime = createTestRuntimeAdapter({
      descriptor: {
        id: "resume-runtime",
        kind: "resume-runtime",
        displayName: "Resume Runtime",
        capabilities: { targets: ["agent"] },
      },
      async openSession(request) {
        requests.push(request);
        return createApprovalRuntimeSession(request);
      },
    });
    const runtimes = createRuntimeRegistry({
      defaultRuntime: runtime.descriptor.id,
      runtimes: [runtime],
    });
    const agent = await ExpertAgent.create({
      pragmaHome,
      id: "resumable-runtime-agent",
      version: "1.0.0",
      name: "Resumable Runtime Agent",
      description: "Tests durable Runtime identity.",
      tags: [],
      scope: "test",
      workspace: pragmaHome,
    });
    const first = createPragma({ pragmaHome, runtimes });
    const handle = await first.start(agent, { input: { prompt: "approve" } });
    const interaction = await waitForInteraction(first, handle.workflowRunId);
    const firstRequest = requests[0];
    if (firstRequest === undefined) throw new Error("Expected the initial Runtime request.");

    const restarted = createPragma({ pragmaHome, runtimes });
    const resumed = await restarted.resume(agent, { workflowRunId: handle.workflowRunId });
    await restarted.taskManager.respondToHumanInteraction({
      interactionId: interaction.id,
      response: { approved: true },
    });
    await resumed.result;

    const restoredRequest = requests[1];
    expect(restoredRequest).toMatchObject({
      systemSessionId: firstRequest.systemSessionId,
      runtimeSession: firstRequest.runtimeSession ?? {
        type: "resume-runtime",
        id: "native-session",
      },
      workflowExecution: {
        workflow: { id: handle.workflowRunId },
      },
    });
    expect(restoredRequest?.runtimeSessionOwnerTaskRunId).toBe(
      firstRequest.workflowExecution.task.id,
    );
  });

  async function createTempHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pragma-workflow-test-"));
    roots.push(root);
    return root;
  }
});

function createNestedDefinition(childVersion: string) {
  const child = defineFlow({ id: "persisted-child", version: childVersion });
  const childTask = child.use(
    "child-task",
    defineTask({ id: "persisted-child-task", version: "1.0.0", handler: () => "done" }),
  );
  child.compose(({ start, end }) => start(childTask).next(end()));

  const root = defineFlow({ id: "persisted-root", version: "1.0.0" });
  const childStep = root.use("child", child);
  root.compose(({ start, end }) => start(childStep).next(end()));
  return root;
}

async function waitForInteraction(app: ReturnType<typeof createPragma>, workflowRunId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const interaction = (await app.stateManager.listHumanInteractions(workflowRunId))[0];
    const workflow = await app.stateManager.getWorkflowRun(workflowRunId);
    if (interaction !== undefined && workflow?.status === "waiting") return interaction;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Human Interaction.");
}

async function waitForTreeState(
  pragmaHome: string,
  workflowRunId: string,
  predicate: (tree: RunTree | undefined) => boolean,
) {
  const observer = createPragma({ pragmaHome });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate(await observer.runs.getTree(workflowRunId))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for persisted Workflow tree state.");
}

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function createApprovalRuntimeSession(
  request: RuntimeDriverSessionRequest,
): RuntimeAgentSession {
  const systemSessionId = request.systemSessionId ?? "system-session";
  const runtimeSession = request.runtimeSession ?? {
    type: "resume-runtime",
    id: "native-session",
  };
  return {
    info: () => ({
      systemSessionId,
      runtimeSession,
      agentId: request.agent.id,
      runtime: {
        id: "resume-runtime",
        kind: "resume-runtime",
        displayName: "Resume Runtime",
        capabilities: { targets: ["agent"] },
      },
      sessionState: "active",
      runState: undefined,
    }),
    messages: () => [],
    submit<TOutput>(): RuntimeSubmitHandle<TOutput> {
      return {
        runId: "approval-run",
        events: { async *[Symbol.asyncIterator]() {} },
        result: (async () => {
          const response = await request.humanInteractionHandler?.({
            kind: "tool_approval",
            toolName: "durableApproval",
            input: {},
          });
          const approved = response?.kind === "tool_approval" && response.approved;
          return {
            runId: "approval-run",
            result: { output: String(approved === true) as TOutput },
          };
        })(),
        cancel: async () => undefined,
      };
    },
    abort: async () => undefined,
  };
}
