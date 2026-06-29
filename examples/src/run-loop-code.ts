import { createLoopApp, defineCodeLoop, defineLoop } from "@expertmesh/core";
import { z } from "zod";

const loop = defineLoop({
  id: "hello-loop",
  input: z.object({
    name: z.string(),
  }),
  output: z.object({
    message: z.string(),
  }),
  result: ({ state }) => ({
    message: String(state.results["message"]),
  }),
});

const greet = loop.use(
  "greet",
  defineCodeLoop({
    id: "greet-code",
    handler: ({ input }) => {
      const payload = z
        .object({
          name: z.string(),
        })
        .parse(input);

      return `Hello, ${payload.name}.`;
    },
  }),
  {
    reduce: ({ state, output }) => {
      state.results["message"] = output;
    },
  },
);

loop.flow(({ start, end }) => {
  start(greet).next(end());
});

const result = await createLoopApp().run(loop, {
  input: {
    name: "ExpertMesh",
  },
});

console.log(result.output);
