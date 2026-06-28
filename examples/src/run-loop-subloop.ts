import { createLoopApp, defineLoop } from "@expertmesh/core";
import { z } from "zod";

const requirementLoop = defineLoop({
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

const summarize = requirementLoop.code("summarize", ({ input }) => {
  const payload = z
    .object({
      requirement: z.string(),
    })
    .parse(input);

  return `Plan for: ${payload.requirement}`;
}, {
  reduce: ({ state, output }) => {
    state.results["summary"] = output;
  },
});

requirementLoop.flow(({ start, end }) => {
  start(summarize).next(end());
});

const deliveryLoop = defineLoop({
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

const plan = deliveryLoop.subloop("plan", requirementLoop, {
  reduce: ({ state, output }) => {
    state.results["plan"] = output.summary;
  },
});

const verify = deliveryLoop.code("verify", () => "ready", {
  reduce: ({ state, output }) => {
    state.results["verification"] = output;
  },
});

deliveryLoop.flow(({ start, step, end }) => {
  start(plan).next(verify);
  step(verify).next(end());
});

const result = await createLoopApp().run(deliveryLoop, {
  input: {
    requirement: "Add GitHub login",
  },
});

console.log(result.output);
