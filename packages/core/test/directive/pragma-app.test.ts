import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createInMemoryMailbox,
  createLocalSandboxManager,
  createPragma,
  defineTask,
  defineFlow,
  ExpertAgent,
  createRuntimeRegistry,
  defineHumanTask,
  setDefaultRuntimeRegistryFactory,
} from "../../src/index.ts";
import type {
  Directive,
  RuntimeAdapter,
  RuntimeAgentSession,
  RuntimeCreateSessionRequest,
  RuntimeSessionInfo,
  RuntimeSubmitHandle,
  RuntimeSubmitRequest,
} from "../../src/index.ts";

describe("directive app", () => {
  it("runs code steps, reduces Directive State, and returns mapped output", async () => {
    const directive = defineFlow({
      id: "review-directive",
      input: z.object({
        decision: z.enum(["approved", "rejected"]),
      }),
      output: z.object({
        approved: z.boolean(),
      }),
      result: ({ state }) => ({
        approved: state.flags["reviewApproved"] ?? false,
      }),
    });

    const review = directive.use(
      "review",
      defineTask({
        id: "review-code",
        output: z.object({
          decision: z.enum(["approved", "rejected"]),
        }),
        handler: ({ input }) => {
          const payload = z
            .object({
              decision: z.enum(["approved", "rejected"]),
            })
            .parse(input);

          return {
            decision: payload.decision,
          };
        },
      }),
      {
        reduce: ({ state, output }) => {
          state.results["review"] = output;
          state.flags["reviewApproved"] = output.decision === "approved";
        },
      },
    );

    directive.compose(({ start, end }) => {
      start(review).next(end());
    });

    const result = await createPragma().run(directive, {
      input: {
        decision: "approved",
      },
    });

    expect(result.output).toEqual({
      approved: true,
    });
    expect(result.state.results["review"]).toEqual({
      decision: "approved",
    });
  });

  it("routes by structured step output", async () => {
    const directive = defineFlow({
      id: "route-directive",
      output: z.object({
        path: z.string(),
      }),
      result: ({ state }) => ({
        path: String(state.results["path"]),
      }),
    });

    const router = directive.use(
      "router",
      defineTask({
        id: "router-code",
        output: z.object({
          status: z.enum(["passed", "failed"]),
        }),
        handler: () => ({
          status: "failed" as const,
        }),
      }),
    );
    const passed = directive.use(
      "passed",
      defineTask({ id: "passed-code", handler: () => "passed" }),
      {
        reduce: ({ state, output }) => {
          state.results["path"] = output;
        },
      },
    );
    const failed = directive.use(
      "failed",
      defineTask({ id: "failed-code", handler: () => "failed" }),
      {
        reduce: ({ state, output }) => {
          state.results["path"] = output;
        },
      },
    );

    directive.compose(({ start, step, end }) => {
      start(router).route("status", {
        passed,
        failed,
      });
      step(passed).next(end());
      step(failed).next(end());
    });

    const result = await createPragma().run(directive, {
      input: {},
    });

    expect(result.output).toEqual({
      path: "failed",
    });
  });

  it("fails with a clear error when route output is missing the routed field", async () => {
    const directive = defineFlow({
      id: "missing-route-directive",
    });
    const router = directive.use("router", defineTask({ id: "router-code", handler: () => ({}) }));
    const target = directive.use(
      "target",
      defineTask({ id: "target-code", handler: () => "done" }),
    );

    directive.compose(({ start, step, end }) => {
      start(router).route("status", {
        done: target,
      });
      step(target).next(end());
    });

    await expect(
      createPragma().run(directive, {
        input: {},
      }),
    ).rejects.toThrow("Route router.status did not match because output field is missing.");
  });

  it("publishes mailbox events while executing tasks", async () => {
    const mailbox = createInMemoryMailbox();
    const seenTypes: string[] = [];
    await mailbox.subscribe({}, async (message) => {
      seenTypes.push(message.type);
    });

    const directive = defineFlow({
      id: "events-directive",
    });
    const task = directive.use("task", defineTask({ id: "task-code", handler: () => "done" }));
    directive.compose(({ start, end }) => {
      start(task).next(end());
    });

    await createPragma({
      mailbox,
    }).run(directive, {
      input: {},
    });

    expect(seenTypes).toEqual(
      expect.arrayContaining([
        "workflow.started",
        "task.dispatch",
        "task.leased",
        "sandbox.created",
        "sandbox.reused",
        "task.started",
        "task.heartbeat",
        "task.completed",
        "workflow.completed",
      ]),
    );
  });

  it("starts a directive run without waiting for completion and exposes run snapshots", async () => {
    const app = createPragma();
    const slowDirective = defineTask({
      id: "slow-directive",
      handler: async () => {
        await sleep(30);
        return "done";
      },
    });

    const handle = await app.start(slowDirective, {
      input: {},
    });
    const running = await app.runs.get(handle.workflowRunId);

    expect(running?.workflow.status).toBe("running");

    await expect(handle.result).resolves.toMatchObject({
      workflowRunId: handle.workflowRunId,
      output: "done",
    });

    const completed = await app.runs.get(handle.workflowRunId);
    expect(completed?.workflow.status).toBe("succeeded");
    expect(completed?.taskStatusCounts).toMatchObject({
      succeeded: 1,
    });
  });

  it("watches nested directive events recursively and exposes a run tree", async () => {
    const app = createPragma();
    const childDirective = defineFlow({
      id: "child-watch-directive",
    });
    const childTask = childDirective.use(
      "child-task",
      defineTask({
        id: "child-watch-task",
        handler: async ({ emitProgress }) => {
          await emitProgress(createProgressEvent("child-progress"));
          return "child";
        },
      }),
    );
    childDirective.compose(({ start, end }) => {
      start(childTask).next(end());
    });

    const parentDirective = defineFlow({
      id: "parent-watch-directive",
    });
    const gate = parentDirective.use(
      "gate",
      defineTask({
        id: "gate-watch-task",
        handler: async () => {
          await sleep(30);
          return "open";
        },
      }),
    );
    const child = parentDirective.use("child", childDirective);
    parentDirective.compose(({ start, end }) => {
      start(gate).next(child).next(end());
    });

    const handle = await app.start(parentDirective, {
      input: {},
    });
    const eventsPromise = collectEvents(
      app.runs.watch(handle.workflowRunId, {
        recursive: true,
      }),
    );

    await handle.result;
    const events = await eventsPromise;
    const childStarted = events.find(
      (event) =>
        event.type === "workflow.started" &&
        readPayloadField(event.payload, "directiveId") === "child-watch-directive",
    );
    const childCompleted = events.find(
      (event) =>
        event.type === "workflow.completed" && event.workflowRunId === childStarted?.workflowRunId,
    );

    expect(childStarted).toBeDefined();
    expect(childStarted?.parentWorkflowRunId).toBe(handle.workflowRunId);
    expect(childCompleted?.parentWorkflowRunId).toBe(handle.workflowRunId);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task.progress",
        workflowRunId: childStarted?.workflowRunId,
      }),
    );

    const tree = await app.runs.getTree(handle.workflowRunId);
    expect(tree?.children).toHaveLength(1);
    expect(tree?.children[0]?.workflow.id).toBe(childStarted?.workflowRunId);
  });

  it("reuses the workflow sandbox by default", async () => {
    const sandboxIds: string[] = [];
    const directive = defineFlow({
      id: "default-sandbox-directive",
    });
    const first = directive.use(
      "first",
      defineTask({
        id: "first-code",
        handler: ({ sandbox }) => {
          sandboxIds.push(sandbox.id);
          return "first";
        },
      }),
    );
    const second = directive.use(
      "second",
      defineTask({
        id: "second-code",
        handler: ({ sandbox }) => {
          sandboxIds.push(sandbox.id);
          return "second";
        },
      }),
    );

    directive.compose(({ start, end }) => {
      start(first).next(second).next(end());
    });

    await createPragma().run(directive, {
      input: {},
    });

    expect(sandboxIds).toHaveLength(2);
    expect(sandboxIds[1]).toBe(sandboxIds[0]);
  });

  it("creates a new sandbox for an ephemeral step", async () => {
    const sandboxIds: string[] = [];
    const directive = defineFlow({
      id: "ephemeral-sandbox-directive",
    });
    const first = directive.use(
      "first",
      defineTask({
        id: "first-code",
        handler: ({ sandbox }) => {
          sandboxIds.push(sandbox.id);
          return "first";
        },
      }),
    );
    const second = directive.use(
      "second",
      defineTask({
        id: "second-code",
        handler: ({ sandbox }) => {
          sandboxIds.push(sandbox.id);
          return "second";
        },
      }),
      {
        sandbox: {
          strategy: {
            mode: "ephemeral",
          },
        },
      },
    );

    directive.compose(({ start, end }) => {
      start(first).next(second).next(end());
    });

    await createPragma().run(directive, {
      input: {},
    });

    expect(sandboxIds).toHaveLength(2);
    expect(sandboxIds[1]).not.toBe(sandboxIds[0]);
  });

  it("inherits the parent sandbox for nested loops by default", async () => {
    const sandboxIds: string[] = [];
    const childDirective = defineFlow({
      id: "child-sandbox-directive",
    });
    const childTask = childDirective.use(
      "child-task",
      defineTask({
        id: "child-code",
        handler: ({ sandbox }) => {
          sandboxIds.push(sandbox.id);
          return "child";
        },
      }),
    );
    childDirective.compose(({ start, end }) => {
      start(childTask).next(end());
    });

    const parentDirective = defineFlow({
      id: "parent-sandbox-directive",
    });
    const parentTask = parentDirective.use(
      "parent-task",
      defineTask({
        id: "parent-code",
        handler: ({ sandbox }) => {
          sandboxIds.push(sandbox.id);
          return "parent";
        },
      }),
    );
    const child = parentDirective.use("child", childDirective);

    parentDirective.compose(({ start, end }) => {
      start(parentTask).next(child).next(end());
    });

    await createPragma().run(parentDirective, {
      input: {},
    });

    expect(sandboxIds).toHaveLength(2);
    expect(sandboxIds[1]).toBe(sandboxIds[0]);
  });

  it("rotates mailbox deliveries within a consumer group", async () => {
    const mailbox = createInMemoryMailbox();
    const deliveries: string[] = [];

    await mailbox.subscribe({ consumerGroup: "workers" }, async () => {
      deliveries.push("worker-a");
    });
    await mailbox.subscribe({ consumerGroup: "workers" }, async () => {
      deliveries.push("worker-b");
    });

    await mailbox.publish({
      id: "message-1",
      kind: "event",
      type: "workflow.started",
      workflowRunId: "workflow-1",
      payload: {},
      occurredAt: new Date().toISOString(),
      producer: {
        id: "test",
        kind: "external",
      },
    });
    await mailbox.publish({
      id: "message-2",
      kind: "event",
      type: "workflow.started",
      workflowRunId: "workflow-1",
      payload: {},
      occurredAt: new Date().toISOString(),
      producer: {
        id: "test",
        kind: "external",
      },
    });

    expect(deliveries).toEqual(["worker-a", "worker-b"]);
  });

  it("rejects workflow sandbox attach requests without a sandbox id", async () => {
    const sandboxManager = createLocalSandboxManager();

    await expect(
      sandboxManager.createWorkflowSandbox({
        workflowRunId: "workflow-missing-sandbox",
        directiveId: "directive",
        input: {},
        request: {
          strategy: {
            mode: "attach",
          },
        },
      }),
    ).rejects.toThrow("Workflow sandbox attach strategy requires sandboxId.");
  });

  it("skips recovered task leases when the directive definition was cleaned up", async () => {
    const app = createPragma();
    const workflow = await app.stateManager.createWorkflowRun({
      id: "workflow-orphaned-task",
      directiveId: "directive",
      input: {},
      state: {
        input: {},
        context: {},
        artifacts: {},
        results: {},
        flags: {},
        messages: [],
        metrics: {},
        private: {},
      },
      defaultSandbox: {
        id: "sandbox-default",
        kind: "local-workspace",
      },
      startStepId: "review",
    });
    const task = await app.stateManager.createTaskRun({
      workflowRunId: workflow.id,
      stepId: "review",
      visit: 1,
      runtimeId: "local",
      input: {},
    });
    await app.stateManager.markTaskLeased(task.id, "worker-1", 1);

    const recovered = await app.taskManager.recoverExpiredLeases(new Date(Date.now() + 20_000));

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe("dispatched");
  });

  it("registers any Directive implementation as a step", async () => {
    const directive = defineFlow({
      id: "custom-directive-composition",
      output: z.object({
        value: z.string(),
      }),
      result: ({ state }) => ({
        value: String(state.results["custom"]),
      }),
    });
    const customDirective: Directive<{ readonly value: string }, string> = {
      id: "custom",
      inputSchema: z.object({
        value: z.string(),
      }),
      outputSchema: z.string(),
      async run(request) {
        if (request.execution === undefined) {
          return await createPragma().run(this, request);
        }

        return {
          workflowRunId: request.execution.workflow.id,
          output: request.input.value.toUpperCase(),
          state: request.execution.state,
        };
      },
    };

    const custom = directive.use("custom", customDirective, {
      reduce: ({ state, output }) => {
        state.results["custom"] = output;
      },
    });
    directive.compose(({ start, end }) => {
      start(custom).next(end());
    });

    const result = await createPragma().run(directive, {
      input: {
        value: "ok",
      },
    });

    expect(result.output).toEqual({
      value: "OK",
    });
  });

  it("runs an ExpertAgent as a Directive", async () => {
    const agent = await ExpertAgent.create({
      id: "agent-directive",
      name: "Agent Directive",
      description: "Agent that implements the Directive interface.",
      tags: [],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/pragma-agent-directive-test",
    });
    const runtime = createFakeRuntime({
      id: "fake-runtime",
      output: {
        answer: "done",
      },
    });
    const outputSchema = z.object({
      answer: z.string(),
    });

    const result = await createPragma({
      runtimes: createRuntimeRegistry({
        defaultRuntime: "fake-runtime",
        runtimes: [runtime],
      }),
    }).run(agent, {
      input: {
        prompt: "finish",
      },
      output: outputSchema,
    });

    expect(result.output).toEqual({
      answer: "done",
    });
    expect(runtime.requests).toEqual([
      expect.objectContaining({
        agent,
        owner: {
          workflowRunId: result.workflowRunId,
          taskRunId: expect.any(String),
        },
      }),
    ]);
    expect(runtime.submissions).toEqual([
      expect.objectContaining({
        output: outputSchema,
      }),
    ]);
  });

  it("runs an ExpertAgent through the configured default runtime registry", async () => {
    const agent = await ExpertAgent.create({
      id: "agent-default-runtime-directive",
      name: "Agent Default Runtime Directive",
      description: "Agent that uses the process default runtime registry.",
      tags: [],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/pragma-agent-default-runtime-directive-test",
    });
    const runtime = createFakeRuntime({
      id: "configured-runtime",
      output: {
        answer: "done",
      },
    });
    const outputSchema = z.object({
      answer: z.string(),
    });

    setDefaultRuntimeRegistryFactory(() =>
      createRuntimeRegistry({
        defaultRuntime: "configured-runtime",
        runtimes: [runtime],
      }),
    );

    try {
      const result = await agent.run({
        input: {
          prompt: "finish",
        },
        output: outputSchema,
      });

      expect(result.output).toEqual({
        answer: "done",
      });
      expect(runtime.requests).toEqual([
        expect.objectContaining({
          agent,
        }),
      ]);
      expect(runtime.submissions).toEqual([
        expect.objectContaining({
          output: outputSchema,
        }),
      ]);
    } finally {
      setDefaultRuntimeRegistryFactory(undefined);
    }
  });

  it("aborts an ExpertAgent runtime session when execution fails", async () => {
    const agent = await ExpertAgent.create({
      id: "agent-failing-runtime-directive",
      name: "Agent Failing Runtime Directive",
      description: "Agent that exercises runtime cleanup on failure.",
      tags: [],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/pragma-agent-failing-runtime-directive-test",
    });
    let abortCount = 0;
    const runtime: RuntimeAdapter = {
      descriptor: {
        id: "failing-runtime",
        kind: "fake-runtime",
        displayName: "Failing Runtime",
        capabilities: {
          targets: ["agent"],
        },
      },
      canUse: () => ({ usable: true }),
      async createSession() {
        return {
          info: () => createFakeSessionInfo(),
          messages: () => [],
          submit<TSubmitOutput>(): RuntimeSubmitHandle<TSubmitOutput> {
            return {
              runId: "run-failing",
              events: createEmptyEvents(),
              result: Promise.reject(new Error("runtime failed")),
              cancel: async () => undefined,
            };
          },
          abort: async () => {
            abortCount += 1;
            throw new Error("abort cleanup failed");
          },
        };
      },
    };

    setDefaultRuntimeRegistryFactory(() =>
      createRuntimeRegistry({
        defaultRuntime: "failing-runtime",
        runtimes: [runtime],
      }),
    );

    try {
      await expect(
        agent.run({
          input: {
            prompt: "fail",
          },
        }),
      ).rejects.toThrow("runtime failed");
      expect(abortCount).toBe(1);
    } finally {
      setDefaultRuntimeRegistryFactory(undefined);
    }
  });

  it("waits for a human task response and resumes the workflow", async () => {
    const app = createPragma();
    const directive = defineFlow({
      id: "human-review-directive",
      output: z.object({
        decision: z.string(),
      }),
      result: ({ state }) => ({
        decision: String(state.results["decision"]),
      }),
    });
    const review = directive.use(
      "review",
      defineHumanTask({
        id: "human-review",
        output: z.object({
          decision: z.enum(["approved", "request_changes"]),
        }),
        request: {
          kind: "review_gate",
          title: "Review changes",
          prompt: "Approve this implementation?",
          options: [
            { label: "approved", description: "Continue" },
            { label: "request_changes", description: "Ask the coder to revise" },
          ],
        },
      }),
      {
        reduce: ({ state, output }) => {
          state.results["decision"] = output.decision;
        },
      },
    );
    directive.compose(({ start, end }) => {
      start(review).next(end());
    });

    const handle = await app.start(directive, {
      input: {},
    });
    const interaction = await waitForHumanInteraction(app, handle.workflowRunId);
    const waiting = await app.runs.get(handle.workflowRunId);

    expect(waiting?.workflow.status).toBe("waiting");
    expect(waiting?.tasks[0]?.status).toBe("waiting");

    await app.taskManager.respondToHumanInteraction({
      interactionId: interaction.id,
      response: {
        decision: "approved",
      },
      operator: {
        id: "user-1",
        kind: "user",
      },
    });

    await expect(handle.result).resolves.toMatchObject({
      output: {
        decision: "approved",
      },
    });

    const completed = await app.runs.get(handle.workflowRunId);
    expect(completed?.workflow.status).toBe("succeeded");
    expect(completed?.tasks[0]?.status).toBe("succeeded");
  });

  it("routes human review gate decisions through normal directive transitions", async () => {
    const app = createPragma();
    const directive = defineFlow({
      id: "human-review-route-directive",
      output: z.object({
        path: z.string(),
      }),
      result: ({ state }) => ({
        path: String(state.results["path"]),
      }),
    });
    const review = directive.use(
      "review",
      defineHumanTask({
        id: "human-review-route",
        output: z.object({
          decision: z.enum(["approved", "request_changes"]),
        }),
        request: {
          kind: "review_gate",
          title: "Review",
          options: [
            { label: "approved", description: "Continue" },
            { label: "request_changes", description: "Revise" },
          ],
        },
      }),
    );
    const revise = directive.use(
      "revise",
      defineTask({ id: "revise-code", handler: () => "revise" }),
      {
        reduce: ({ state, output }) => {
          state.results["path"] = output;
        },
      },
    );
    const ship = directive.use("ship", defineTask({ id: "ship-code", handler: () => "ship" }), {
      reduce: ({ state, output }) => {
        state.results["path"] = output;
      },
    });
    directive.compose(({ start, step, end }) => {
      start(review).route("decision", {
        approved: ship,
        request_changes: revise,
      });
      step(ship).next(end());
      step(revise).next(end());
    });

    const handle = await app.start(directive, {
      input: {},
    });
    const interaction = await waitForHumanInteraction(app, handle.workflowRunId);
    await app.taskManager.respondToHumanInteraction({
      interactionId: interaction.id,
      response: {
        decision: "request_changes",
      },
    });

    await expect(handle.result).resolves.toMatchObject({
      output: {
        path: "revise",
      },
    });
  });

  it("does not recover waiting human task leases", async () => {
    const app = createPragma();
    const human = defineHumanTask({
      id: "human-wait-recovery",
      request: {
        kind: "question",
        title: "Need input",
        questions: [
          {
            header: "Scope",
            question: "What should change?",
            kind: "text",
            options: [],
          },
        ],
      },
    });

    const handle = await app.start(human, {
      input: {},
    });
    const interaction = await waitForHumanInteraction(app, handle.workflowRunId);
    const recovered = await app.taskManager.recoverExpiredLeases(new Date(Date.now() + 20_000));

    expect(recovered).toHaveLength(0);

    await app.taskManager.respondToHumanInteraction({
      interactionId: interaction.id,
      response: {
        answers: {
          scope: "test",
        },
      },
    });
    await expect(handle.result).resolves.toMatchObject({
      output: {
        answers: {
          scope: "test",
        },
      },
    });
  });

  it("treats duplicate human responses as idempotent", async () => {
    const app = createPragma();
    const respondedEvents: string[] = [];
    await app.mailbox.subscribe({ types: ["human.responded"] }, async (message) => {
      respondedEvents.push(message.id);
    });
    const human = defineHumanTask({
      id: "human-idempotency",
      request: {
        kind: "approval",
        title: "Approve",
      },
    });

    const handle = await app.start(human, {
      input: {},
    });
    const interaction = await waitForHumanInteraction(app, handle.workflowRunId);
    await app.taskManager.respondToHumanInteraction({
      interactionId: interaction.id,
      response: {
        approved: true,
      },
    });
    await app.taskManager.respondToHumanInteraction({
      interactionId: interaction.id,
      response: {
        approved: false,
      },
    });
    await handle.result;

    expect(respondedEvents).toHaveLength(1);
    const stored = await app.stateManager.getHumanInteraction(interaction.id);
    expect(stored?.response).toEqual({
      approved: true,
    });
  });

  it("bridges Agent askUserQuestion requests through directive human interactions", async () => {
    const agent = await ExpertAgent.create({
      id: "agent-human-directive",
      name: "Agent Human Directive",
      description: "Agent that asks a user question.",
      tags: [],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/pragma-agent-human-directive-test",
    });
    const runtime = createHumanAskingRuntime({
      id: "fake-human-runtime",
    });
    const app = createPragma({
      runtimes: createRuntimeRegistry({
        defaultRuntime: "fake-human-runtime",
        runtimes: [runtime],
      }),
    });

    const handle = await app.start(agent, {
      input: {
        prompt: "clarify",
      },
      output: z.object({
        answer: z.string(),
      }),
    });
    const interaction = await waitForHumanInteraction(app, handle.workflowRunId);
    await app.taskManager.respondToHumanInteraction({
      interactionId: interaction.id,
      response: {
        answers: {
          answer: "Use OAuth",
        },
      },
    });

    await expect(handle.result).resolves.toMatchObject({
      output: {
        answer: "Use OAuth",
      },
    });
  });
});

function createFakeRuntime(options: {
  readonly id: string;
  readonly output: unknown;
}): RuntimeAdapter & {
  readonly requests: RuntimeCreateSessionRequest[];
  readonly submissions: RuntimeSubmitRequest<unknown>[];
} {
  const requests: RuntimeCreateSessionRequest[] = [];
  const submissions: RuntimeSubmitRequest<unknown>[] = [];

  return {
    requests,
    submissions,
    descriptor: {
      id: options.id,
      kind: "fake-runtime",
      displayName: "Fake Runtime",
      capabilities: {
        targets: ["agent"],
      },
    },
    canUse: () => ({ usable: true }),
    async createSession(request) {
      requests.push(request);
      return createFakeSession(options.output, submissions);
    },
  };
}

function createFakeSession(
  output: unknown,
  submissions: RuntimeSubmitRequest<unknown>[],
): RuntimeAgentSession {
  return {
    info: () => createFakeSessionInfo(),
    messages: () => [],
    submit<TSubmitOutput>(
      submission: RuntimeSubmitRequest<TSubmitOutput>,
    ): RuntimeSubmitHandle<TSubmitOutput> {
      submissions.push(submission as RuntimeSubmitRequest<unknown>);
      return {
        runId: "run-1",
        events: createEmptyEvents(),
        result: Promise.resolve({
          runId: "run-1",
          result: {
            output: output as TSubmitOutput,
          },
        }),
        cancel: async () => undefined,
      };
    },
    abort: async () => undefined,
  };
}

function createHumanAskingRuntime(options: { readonly id: string }): RuntimeAdapter {
  return {
    descriptor: {
      id: options.id,
      kind: "fake-runtime",
      displayName: "Fake Human Runtime",
      capabilities: {
        targets: ["agent"],
      },
    },
    canUse: () => ({ usable: true }),
    async createSession(request) {
      return {
        info: () => createFakeSessionInfo(),
        messages: () => [],
        submit<TSubmitOutput>(): RuntimeSubmitHandle<TSubmitOutput> {
          return {
            runId: "run-human",
            events: createEmptyEvents(),
            result: (async () => {
              const response = await request.humanInteractionHandler?.({
                kind: "user_question",
                toolName: "askUserQuestion",
                questions: [
                  {
                    header: "Requirement",
                    question: "What auth provider should be used?",
                    kind: "text",
                    options: [],
                  },
                ],
              });

              return {
                runId: "run-human",
                result: {
                  output: {
                    answer:
                      response?.kind === "user_question"
                        ? readNestedAnswer(response.answers)
                        : "missing",
                  } as TSubmitOutput,
                },
              };
            })(),
            cancel: async () => undefined,
          };
        },
        abort: async () => undefined,
      };
    },
  };
}

function createFakeSessionInfo(): RuntimeSessionInfo {
  return {
    systemSessionId: "system-session-1",
    runtimeSession: {
      type: "fake-runtime",
      id: "runtime-session-1",
    },
    agentId: "agent-directive",
    runtime: {
      id: "fake-runtime",
      kind: "fake-runtime",
      displayName: "Fake Runtime",
    },
    sessionState: "active",
    runState: undefined,
  };
}

function createEmptyEvents() {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ value: undefined, done: true }) as const,
      };
    },
  };
}

async function collectEvents<TEvent>(events: AsyncIterable<TEvent>): Promise<TEvent[]> {
  const collected: TEvent[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

async function waitForHumanInteraction(
  app: ReturnType<typeof createPragma>,
  workflowRunId: string,
) {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    const interactions = await app.stateManager.listHumanInteractions(workflowRunId);
    const interaction = interactions[0];

    if (interaction !== undefined) {
      return interaction;
    }

    await sleep(5);
  }

  throw new Error(`Timed out waiting for human interaction in ${workflowRunId}`);
}

function readNestedAnswer(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const answer = (value as Record<string, unknown>)["answer"];
  return typeof answer === "string" ? answer : undefined;
}

function createProgressEvent(stage: string) {
  return {
    schemaVersion: "pragma.stream/v1" as const,
    eventId: `event-${stage}`,
    sequence: 0,
    runId: "run-1",
    emittedAt: new Date().toISOString(),
    source: {
      kind: "runtime" as const,
      runId: "run-1",
      path: [],
    },
    type: "progress" as const,
    payload: {
      stage,
    },
  };
}

function readPayloadField(payload: unknown, field: string): unknown {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }

  return (payload as Record<string, unknown>)[field];
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
