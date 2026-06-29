import { createLoopApp, defineCodeLoop, defineLoop } from "@expertmesh/core";
import { z } from "zod";

const loop = defineLoop({
  id: "route-loop",
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

const tester = loop.use(
  "tester",
  defineCodeLoop({
    id: "tester-code",
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

const ship = loop.use("ship", defineCodeLoop({ id: "ship-code", handler: () => "ship" }), {
  reduce: ({ state, output }) => {
    state.results["nextAction"] = output;
  },
});

const fix = loop.use("fix", defineCodeLoop({ id: "fix-code", handler: () => "fix" }), {
  reduce: ({ state, output }) => {
    state.results["nextAction"] = output;
  },
});

loop.flow(({ start, step, end }) => {
  start(tester).route("status", {
    passed: ship,
    failed: fix,
  });
  step(ship).next(end());
  step(fix).next(end());
});

const result = await createLoopApp().run(loop, {
  input: {
    testsPassed: false,
  },
});

console.log(result.output);
