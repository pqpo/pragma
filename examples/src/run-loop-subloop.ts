import { createPragma, defineTask, defineFlow } from "@pragma/core";
import { z } from "zod";

const requirementLoop = defineFlow({
  id: "requirement-loop",
  input: z.object({
    requirement: z.string(),
  }),
  output: z.object({
    summary: z.string(),
  }),
  result: ({ state }) => ({
    summary: String(state.results["summary"]),
  }),
});

const summarize = requirementLoop.use(
  "summarize",
  defineTask({
    id: "summarize-code",
    handler: ({ input }) => {
      const payload = z
        .object({
          requirement: z.string(),
        })
        .parse(input);

      return `Plan for: ${payload.requirement}`;
    },
  }),
  {
    reduce: ({ state, output }) => {
      state.results["summary"] = output;
    },
  },
);

requirementLoop.compose(({ start, end }) => {
  start(summarize).next(end());
});

const deliveryLoop = defineFlow({
  id: "delivery-loop",
  input: z.object({
    requirement: z.string(),
  }),
  output: z.object({
    plan: z.string(),
    verification: z.string(),
  }),
  result: ({ state }) => ({
    plan: String(state.results["plan"]),
    verification: String(state.results["verification"]),
  }),
});

const plan = deliveryLoop.use("plan", requirementLoop, {
  reduce: ({ state, output }) => {
    state.results["plan"] = output.summary;
  },
});

const verify = deliveryLoop.use(
  "verify",
  defineTask({ id: "verify-code", handler: () => "ready" }),
  {
    reduce: ({ state, output }) => {
      state.results["verification"] = output;
    },
  },
);

deliveryLoop.compose(({ start, step, end }) => {
  start(plan).next(verify);
  step(verify).next(end());
});

const result = await createPragma().run(deliveryLoop, {
  input: {
    requirement: "Add GitHub login",
  },
});

console.log(result.output);
