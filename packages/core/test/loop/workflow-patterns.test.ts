import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createLoopApp, defineTask, workflow } from "../../src/index.ts";

describe("workflow pattern loop api", () => {
  it("builds prompt chains with previous output as the next default input", async () => {
    const chain = workflow.promptChain({
      id: "prompt-chain",
      output: z.string(),
      steps: [
        defineTask({
          id: "draft",
          handler: ({ input }) => `${String(input)} draft`,
        }),
        defineTask({
          id: "polish",
          handler: ({ input }) => `${String(input)} polished`,
        }),
      ],
    });

    const result = await createLoopApp().run(chain, {
      input: "brief",
    });

    expect(result.output).toBe("brief draft polished");
  });

  it("builds routing workflows around a classifier step", async () => {
    const routed = workflow.routing({
      id: "routing-workflow",
      output: z.string(),
      router: {
        loop: defineTask({
          id: "classify",
          output: z.object({
            route: z.enum(["billing", "support"]),
          }),
          handler: ({ input }) => ({
            route: String(input).includes("invoice") ? "billing" : "support",
          }),
        }),
      },
      field: "route",
      routes: {
        billing: {
          loop: defineTask({
            id: "billing",
            handler: ({ input }) => `billing:${String(input)}`,
          }),
        },
        support: {
          loop: defineTask({
            id: "support",
            handler: ({ input }) => `support:${String(input)}`,
          }),
        },
      },
    });

    const result = await createLoopApp().run(routed, {
      input: "invoice question",
    });

    expect(result.output).toBe("billing:invoice question");
  });

  it("rejects routing workflows without route targets", () => {
    expect(() =>
      workflow.routing({
        id: "empty-routing-workflow",
        router: defineTask({
          id: "classify-empty-routing",
          handler: () => ({
            route: "missing",
          }),
        }),
        field: "route",
        routes: {},
      }),
    ).toThrow("Routing workflow empty-routing-workflow must declare at least one route.");
  });

  it("runs parallel branches and merges branch outputs", async () => {
    const parallel = workflow.parallel({
      id: "parallel-workflow",
      output: z.object({
        combined: z.string(),
      }),
      branches: {
        summary: defineTask({
          id: "summary",
          handler: ({ input }) => `summary:${String(input)}`,
        }),
        risk: defineTask({
          id: "risk",
          handler: ({ input }) => `risk:${String(input)}`,
        }),
      },
      merge: ({ outputs }) => ({
        combined: `${String(outputs["summary"])}|${String(outputs["risk"])}`,
      }),
    });

    const result = await createLoopApp().run(parallel, {
      input: "doc",
    });

    expect(result.output).toEqual({
      combined: "summary:doc|risk:doc",
    });
  });

  it("runs orchestrator-workers with dynamic worker inputs and synthesis", async () => {
    const orchestrated = workflow.orchestratorWorkers({
      id: "orchestrator-workers",
      output: z.object({
        report: z.string(),
      }),
      orchestrator: {
        loop: defineTask({
          id: "orchestrator",
          handler: () => ({
            tasks: ["intro", "details"],
          }),
        }),
      },
      worker: {
        loop: defineTask({
          id: "worker",
          handler: ({ input }) => `section:${String(input)}`,
        }),
      },
      synthesize: ({ workerOutputs }) => ({
        report: workerOutputs.map((item) => item.output).join("\n"),
      }),
    });

    const result = await createLoopApp().run(orchestrated, {
      input: "write report",
    });

    expect(result.output).toEqual({
      report: "section:intro\nsection:details",
    });
  });

  it("runs evaluator-optimizer until the evaluator accepts an attempt", async () => {
    const optimized = workflow.evaluatorOptimizer({
      id: "evaluator-optimizer",
      output: z.object({
        accepted: z.boolean(),
        attempt: z.object({
          version: z.number(),
        }),
        evaluation: z.object({
          accepted: z.boolean(),
        }),
        iterations: z.number(),
      }),
      optimizer: {
        loop: defineTask({
          id: "optimizer",
          handler: ({ input }) => {
            if (typeof input === "object" && input !== null && "iteration" in input) {
              return {
                version: Number((input as { iteration: unknown }).iteration),
              };
            }

            return {
              version: 1,
            };
          },
        }),
      },
      evaluator: {
        loop: defineTask({
          id: "evaluator",
          handler: ({ input }) => ({
            accepted:
              typeof input === "object" &&
              input !== null &&
              "version" in input &&
              Number((input as { version: unknown }).version) >= 2,
          }),
        }),
      },
      maxIterations: 3,
    });

    const result = await createLoopApp().run(optimized, {
      input: {
        goal: "improve",
      },
    });

    expect(result.output).toEqual({
      accepted: true,
      attempt: {
        version: 2,
      },
      evaluation: {
        accepted: true,
      },
      iterations: 2,
    });
  });
});
