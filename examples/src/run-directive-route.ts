import { createPragma, defineTask, defineFlow } from "@pragma/core";
import { z } from "zod";

const flow = defineFlow({
  id: "route-directive",
  version: "1.0.0",
  input: z.object({
    testsPassed: z.boolean(),
  }),
  output: z.object({
    nextAction: z.string(),
  }),
  result: ({ state }) => ({
    nextAction: String(state.results["nextAction"]),
  }),
});

const tester = flow.use(
  "tester",
  defineTask({
    id: "tester-code",
    version: "1.0.0",
    output: z.object({
      status: z.enum(["passed", "failed"]),
    }),
    handler: ({ input }) => {
      const payload = z
        .object({
          testsPassed: z.boolean(),
        })
        .parse(input);

      return {
        status: payload.testsPassed ? "passed" : "failed",
      };
    },
  }),
);

const ship = flow.use(
  "ship",
  defineTask({ id: "ship-code", version: "1.0.0", handler: () => "ship" }),
  {
    reduce: ({ state, output }) => {
      state.results["nextAction"] = output;
    },
  },
);

const fix = flow.use(
  "fix",
  defineTask({ id: "fix-code", version: "1.0.0", handler: () => "fix" }),
  {
    reduce: ({ state, output }) => {
      state.results["nextAction"] = output;
    },
  },
);

flow.compose(({ start, step, end }) => {
  start(tester).route("status", {
    passed: ship,
    failed: fix,
  });
  step(ship).next(end());
  step(fix).next(end());
});

const app = createPragma();
const result = await app.run(flow, {
  input: {
    testsPassed: false,
  },
});

console.log(result.output);
