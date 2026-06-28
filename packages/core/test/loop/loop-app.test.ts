import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createInMemoryMailbox, createLoopApp, defineLoop } from "../../src/index.ts";

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

    const review = loop.code(
      "review",
      ({ input }) => {
        const payload = z
          .object({
            decision: z.enum(["approved", "rejected"]),
          })
          .parse(input);

        return {
          decision: payload.decision,
        };
      },
      {
        output: z.object({
          decision: z.enum(["approved", "rejected"]),
        }),
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

    const router = loop.code(
      "router",
      () => ({
        status: "failed" as const,
      }),
      {
        output: z.object({
          status: z.enum(["passed", "failed"]),
        }),
      },
    );
    const passed = loop.code("passed", () => "passed", {
      reduce: ({ state, output }) => {
        state.results["path"] = output;
      },
    });
    const failed = loop.code("failed", () => "failed", {
      reduce: ({ state, output }) => {
        state.results["path"] = output;
      },
    });

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
    const router = loop.code("router", () => ({}));
    const target = loop.code("target", () => "done");

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
    const task = loop.code("task", () => "done");
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
});
