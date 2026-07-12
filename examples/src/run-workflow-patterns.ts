import { createPragma, defineTask, patterns } from "@pragma/core";
import { z } from "zod";

const app = createPragma();

const promptChain = patterns.promptChain({
  id: "example-prompt-chain",
  version: "1.0.0",
  output: z.string(),
  steps: [
    defineTask({
      id: "normalize-request",
      version: "1.0.0",
      output: z.object({
        text: z.string(),
      }),
      handler: ({ input }) => {
        const payload = z
          .object({
            text: z.string(),
          })
          .parse(input);

        return {
          text: payload.text.trim(),
        };
      },
    }),
    defineTask({
      id: "draft-reply",
      version: "1.0.0",
      output: z.object({
        draft: z.string(),
      }),
      handler: ({ input }) => {
        const payload = z
          .object({
            text: z.string(),
          })
          .parse(input);

        return {
          draft: `Thanks for the request: ${payload.text}.`,
        };
      },
    }),
    defineTask({
      id: "polish-reply",
      version: "1.0.0",
      output: z.string(),
      handler: ({ input }) => {
        const payload = z
          .object({
            draft: z.string(),
          })
          .parse(input);

        return `${payload.draft} We will follow up with a concrete next step.`;
      },
    }),
  ],
});

const routed = patterns.routing({
  id: "example-routing",
  version: "1.0.0",
  output: z.string(),
  field: "route",
  router: {
    directive: defineTask({
      id: "classify-ticket",
      version: "1.0.0",
      output: z.object({
        route: z.enum(["billing", "technical"]),
      }),
      handler: ({ input }) => {
        const payload = z
          .object({
            text: z.string(),
          })
          .parse(input);

        return {
          route: payload.text.includes("invoice") ? "billing" : "technical",
        };
      },
    }),
  },
  routes: {
    billing: {
      directive: defineTask({
        id: "billing-handler",
        version: "1.0.0",
        handler: ({ input }) => {
          const payload = z
            .object({
              text: z.string(),
            })
            .parse(input);

          return `Billing team handles: ${payload.text}`;
        },
      }),
    },
    technical: {
      directive: defineTask({
        id: "technical-handler",
        version: "1.0.0",
        handler: ({ input }) => {
          const payload = z
            .object({
              text: z.string(),
            })
            .parse(input);

          return `Technical team handles: ${payload.text}`;
        },
      }),
    },
  },
});

const parallelReview = patterns.parallel({
  id: "example-parallel",
  version: "1.0.0",
  output: z.object({
    summary: z.string(),
  }),
  branches: {
    correctness: defineTask({
      id: "correctness-reviewer",
      version: "1.0.0",
      handler: ({ input }) => `Correctness: ${String(input)} is internally consistent.`,
    }),
    risk: defineTask({
      id: "risk-reviewer",
      version: "1.0.0",
      handler: ({ input }) => `Risk: ${String(input)} needs rollout monitoring.`,
    }),
    userValue: defineTask({
      id: "user-value-reviewer",
      version: "1.0.0",
      handler: ({ input }) => `User value: ${String(input)} has a clear target user.`,
    }),
  },
  merge: ({ outputs }) => ({
    summary: [
      String(outputs["correctness"]),
      String(outputs["risk"]),
      String(outputs["userValue"]),
    ].join("\n"),
  }),
});

const reportBuilder = patterns.orchestratorWorkers({
  id: "example-orchestrator-workers",
  version: "1.0.0",
  output: z.object({
    markdown: z.string(),
  }),
  orchestrator: {
    directive: defineTask({
      id: "report-planner",
      version: "1.0.0",
      handler: () => ({
        tasks: [
          {
            heading: "Context",
            point: "Explain why the workflow exists.",
          },
          {
            heading: "Plan",
            point: "List the implementation steps.",
          },
        ],
      }),
    }),
  },
  worker: {
    directive: defineTask({
      id: "section-writer",
      version: "1.0.0",
      output: z.object({
        heading: z.string(),
        body: z.string(),
      }),
      handler: ({ input }) => {
        const payload = z
          .object({
            heading: z.string(),
            point: z.string(),
          })
          .parse(input);

        return {
          heading: payload.heading,
          body: payload.point,
        };
      },
    }),
  },
  synthesize: ({ workerOutputs }) => ({
    markdown: workerOutputs
      .map((item) => `## ${item.output.heading}\n${item.output.body}`)
      .join("\n\n"),
  }),
});

const refinedAnswer = patterns.evaluatorOptimizer({
  id: "example-evaluator-optimizer",
  version: "1.0.0",
  output: z.object({
    accepted: z.boolean(),
    attempt: z.object({
      revision: z.number(),
      answer: z.string(),
    }),
    evaluation: z.object({
      accepted: z.boolean(),
      feedback: z.string(),
    }),
    iterations: z.number(),
  }),
  optimizer: {
    directive: defineTask({
      id: "answer-optimizer",
      version: "1.0.0",
      output: z.object({
        revision: z.number(),
        answer: z.string(),
      }),
      handler: ({ input }) => {
        const iteration = readNumberField(input, "iteration") ?? 1;

        return {
          revision: iteration,
          answer:
            iteration === 1
              ? "Use workflow patterns."
              : "Use workflow patterns when the control flow is known, and use agents when the model must decide the next step.",
        };
      },
    }),
  },
  evaluator: {
    directive: defineTask({
      id: "answer-evaluator",
      version: "1.0.0",
      output: z.object({
        accepted: z.boolean(),
        feedback: z.string(),
      }),
      handler: ({ input }) => {
        const payload = z
          .object({
            answer: z.string(),
          })
          .parse(input);
        const accepted = payload.answer.includes("control flow is known");

        return {
          accepted,
          feedback: accepted ? "Specific enough." : "Explain when to use the pattern.",
        };
      },
    }),
  },
  maxIterations: 3,
});

console.log("promptChain");
console.log(
  await app.run(promptChain, {
    input: {
      text: "  Add invoice export support  ",
    },
  }),
);

console.log("routing");
console.log(
  await app.run(routed, {
    input: {
      text: "I need help with an invoice.",
    },
  }),
);

console.log("parallel");
console.log(
  await app.run(parallelReview, {
    input: "Add workspace-level approval gates",
  }),
);

console.log("orchestratorWorkers");
console.log(
  await app.run(reportBuilder, {
    input: {
      topic: "Workflow examples",
    },
  }),
);

console.log("evaluatorOptimizer");
console.log(
  await app.run(refinedAnswer, {
    input: {
      goal: "Explain workflow pattern usage.",
    },
  }),
);

function readNumberField(value: unknown, field: string): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "number" ? candidate : undefined;
}
