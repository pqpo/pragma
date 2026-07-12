import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createPragma, defineTask, patterns } from "../../src/index.ts";

describe("patterns directive api", () => {
  it("builds prompt chains with previous output as the next default input", async () => {
    const chain = patterns.promptChain({
      id: "prompt-chain",
      version: "1.0.0",
      output: z.string(),
      steps: [
        defineTask({
          id: "draft",
          version: "1.0.0",
          handler: ({ input }) => `${String(input)} draft`,
        }),
        defineTask({
          id: "polish",
          version: "1.0.0",
          handler: ({ input }) => `${String(input)} polished`,
        }),
      ],
    });

    const result = await createPragma({ storage: "memory" }).run(chain, {
      input: "brief",
    });

    expect(result.output).toBe("brief draft polished");
  });

  it("builds routing workflows around a classifier step", async () => {
    const routed = patterns.routing({
      id: "routing-workflow",
      version: "1.0.0",
      output: z.string(),
      router: {
        directive: defineTask({
          id: "classify",
          version: "1.0.0",
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
          directive: defineTask({
            id: "billing",
            version: "1.0.0",
            handler: ({ input }) => `billing:${String(input)}`,
          }),
        },
        support: {
          directive: defineTask({
            id: "support",
            version: "1.0.0",
            handler: ({ input }) => `support:${String(input)}`,
          }),
        },
      },
    });

    const result = await createPragma({ storage: "memory" }).run(routed, {
      input: "invoice question",
    });

    expect(result.output).toBe("billing:invoice question");
  });

  it("rejects routing workflows without route targets", () => {
    expect(() =>
      patterns.routing({
        id: "empty-routing-workflow",
        version: "1.0.0",
        router: defineTask({
          id: "classify-empty-routing",
          version: "1.0.0",
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
    const parallel = patterns.parallel({
      id: "parallel-workflow",
      version: "1.0.0",
      output: z.object({
        combined: z.string(),
      }),
      branches: {
        summary: defineTask({
          id: "summary",
          version: "1.0.0",
          handler: ({ input }) => `summary:${String(input)}`,
        }),
        risk: defineTask({
          id: "risk",
          version: "1.0.0",
          handler: ({ input }) => `risk:${String(input)}`,
        }),
      },
      merge: ({ outputs }) => ({
        combined: `${String(outputs["summary"])}|${String(outputs["risk"])}`,
      }),
    });

    const result = await createPragma({ storage: "memory" }).run(parallel, {
      input: "doc",
    });

    expect(result.output).toEqual({
      combined: "summary:doc|risk:doc",
    });
  });

  it("runs orchestrator-workers with dynamic worker inputs and synthesis", async () => {
    const orchestrated = patterns.orchestratorWorkers({
      id: "orchestrator-workers",
      version: "1.0.0",
      output: z.object({
        report: z.string(),
      }),
      orchestrator: {
        directive: defineTask({
          id: "orchestrator",
          version: "1.0.0",
          handler: () => ({
            tasks: ["intro", "details"],
          }),
        }),
      },
      worker: {
        directive: defineTask({
          id: "worker",
          version: "1.0.0",
          handler: ({ input }) => `section:${String(input)}`,
        }),
      },
      synthesize: ({ workerOutputs }) => ({
        report: workerOutputs.map((item) => item.output).join("\n"),
      }),
    });

    const result = await createPragma({ storage: "memory" }).run(orchestrated, {
      input: "write report",
    });

    expect(result.output).toEqual({
      report: "section:intro\nsection:details",
    });
  });

  it("runs evaluator-optimizer until the evaluator accepts an attempt", async () => {
    const optimized = patterns.evaluatorOptimizer({
      id: "evaluator-optimizer",
      version: "1.0.0",
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
        directive: defineTask({
          id: "optimizer",
          version: "1.0.0",
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
        directive: defineTask({
          id: "evaluator",
          version: "1.0.0",
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

    const result = await createPragma({ storage: "memory" }).run(optimized, {
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
