import { createPragma, defineTask, defineFlow } from "@pragma/core";
import { z } from "zod";

const requirementDirective = defineFlow({
  id: "requirement-directive",
  version: "1.0.0",
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

const summarize = requirementDirective.use(
  "summarize",
  defineTask({
    id: "summarize-code",
    version: "1.0.0",
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

requirementDirective.compose(({ start, end }) => {
  start(summarize).next(end());
});

const deliveryDirective = defineFlow({
  id: "delivery-directive",
  version: "1.0.0",
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

const plan = deliveryDirective.use("plan", requirementDirective, {
  reduce: ({ state, output }) => {
    state.results["plan"] = output.summary;
  },
});

const verify = deliveryDirective.use(
  "verify",
  defineTask({ id: "verify-code", version: "1.0.0", handler: () => "ready" }),
  {
    reduce: ({ state, output }) => {
      state.results["verification"] = output;
    },
  },
);

deliveryDirective.compose(({ start, step, end }) => {
  start(plan).next(verify);
  step(verify).next(end());
});

const app = createPragma();
const result = await app.run(deliveryDirective, {
  input: {
    requirement: "Add GitHub login",
  },
});

console.log(result.output);
