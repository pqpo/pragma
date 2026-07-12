import { createPragma, defineTask, defineFlow } from "@pragma/core";
import { z } from "zod";

const flow = defineFlow({
  id: "hello-directive",
  version: "1.0.0",
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

const greet = flow.use(
  "greet",
  defineTask({
    id: "greet-code",
    version: "1.0.0",
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

flow.compose(({ start, end }) => {
  start(greet).next(end());
});

const app = createPragma();
const result = await app.run(flow, {
  input: {
    name: "Pragma",
  },
});

console.log(result.output);
