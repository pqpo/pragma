import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createInMemoryMailbox,
  createLoopApp,
  defineCodeLoop,
  defineLoop,
  ExpertAgent,
  createRuntimeRegistry,
} from "../../src/index.ts";
import type {
  Loop,
  RuntimeAdapter,
  RuntimeAgentSession,
  RuntimeCreateSessionRequest,
  RuntimeSessionInfo,
  RuntimeSubmitHandle,
  RuntimeSubmitRequest,
} from "../../src/index.ts";

describe("loop app", () => {
  it("runs code steps, reduces Loop State, and returns mapped output", async () => {
    const loop = defineLoop({
      id: "review-loop",
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

    const review = loop.use(
      "review",
      defineCodeLoop({
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

    loop.flow(({ start, end }) => {
      start(review).next(end());
    });

    const result = await createLoopApp().run(loop, {
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
    const loop = defineLoop({
      id: "route-loop",
      output: z.object({
        path: z.string(),
      }),
      result: ({ state }) => ({
        path: String(state.results["path"]),
      }),
    });

    const router = loop.use(
      "router",
      defineCodeLoop({
        id: "router-code",
        output: z.object({
          status: z.enum(["passed", "failed"]),
        }),
        handler: () => ({
          status: "failed" as const,
        }),
      }),
    );
    const passed = loop.use(
      "passed",
      defineCodeLoop({ id: "passed-code", handler: () => "passed" }),
      {
        reduce: ({ state, output }) => {
          state.results["path"] = output;
        },
      },
    );
    const failed = loop.use(
      "failed",
      defineCodeLoop({ id: "failed-code", handler: () => "failed" }),
      {
        reduce: ({ state, output }) => {
          state.results["path"] = output;
        },
      },
    );

    loop.flow(({ start, step, end }) => {
      start(router).route("status", {
        passed,
        failed,
      });
      step(passed).next(end());
      step(failed).next(end());
    });

    const result = await createLoopApp().run(loop, {
      input: {},
    });

    expect(result.output).toEqual({
      path: "failed",
    });
  });

  it("fails with a clear error when route output is missing the routed field", async () => {
    const loop = defineLoop({
      id: "missing-route-loop",
    });
    const router = loop.use("router", defineCodeLoop({ id: "router-code", handler: () => ({}) }));
    const target = loop.use("target", defineCodeLoop({ id: "target-code", handler: () => "done" }));

    loop.flow(({ start, step, end }) => {
      start(router).route("status", {
        done: target,
      });
      step(target).next(end());
    });

    await expect(
      createLoopApp().run(loop, {
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

    const loop = defineLoop({
      id: "events-loop",
    });
    const task = loop.use("task", defineCodeLoop({ id: "task-code", handler: () => "done" }));
    loop.flow(({ start, end }) => {
      start(task).next(end());
    });

    await createLoopApp({
      mailbox,
    }).run(loop, {
      input: {},
    });

    expect(seenTypes).toEqual(
      expect.arrayContaining([
        "workflow.started",
        "task.dispatch",
        "task.leased",
        "environment.attached",
        "task.started",
        "task.completed",
        "workflow.completed",
      ]),
    );
  });

  it("registers any Loop implementation as a step", async () => {
    const loop = defineLoop({
      id: "custom-loop-composition",
      output: z.object({
        value: z.string(),
      }),
      result: ({ state }) => ({
        value: String(state.results["custom"]),
      }),
    });
    const customLoop: Loop<{ readonly value: string }, string> = {
      id: "custom",
      inputSchema: z.object({
        value: z.string(),
      }),
      outputSchema: z.string(),
      async run(request) {
        if (request.execution === undefined) {
          return await createLoopApp().run(this, request);
        }

        return {
          workflowRunId: request.execution.workflow.id,
          output: request.input.value.toUpperCase(),
          state: request.execution.state,
        };
      },
    };

    const custom = loop.use("custom", customLoop, {
      reduce: ({ state, output }) => {
        state.results["custom"] = output;
      },
    });
    loop.flow(({ start, end }) => {
      start(custom).next(end());
    });

    const result = await createLoopApp().run(loop, {
      input: {
        value: "ok",
      },
    });

    expect(result.output).toEqual({
      value: "OK",
    });
  });

  it("runs an ExpertAgent as a Loop", async () => {
    const agent = await ExpertAgent.create({
      id: "agent-loop",
      name: "Agent Loop",
      description: "Agent that implements the Loop interface.",
      tags: [],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/expertmesh-agent-loop-test",
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

    const result = await createLoopApp({
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
      }),
    ]);
    expect(runtime.submissions).toEqual([
      expect.objectContaining({
        output: outputSchema,
      }),
    ]);
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

function createFakeSessionInfo(): RuntimeSessionInfo {
  return {
    systemSessionId: "system-session-1",
    runtimeSession: {
      type: "fake-runtime",
      id: "runtime-session-1",
    },
    agentId: "agent-loop",
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
