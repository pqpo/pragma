import { defineFlow } from "@pragma/core";
import { createExampleApp } from "./example-kit.ts";

const flow = defineFlow({ id: "basic", version: "1.0.0", result: ({ state }) => state["answer"] });
const task = flow.task({
  id: "double",
  version: "1.0.0",
  handler: ({ input }) => Number(input) * 2,
  reduce: ({ state, output }) => {
    state["answer"] = output;
  },
});
flow.compose(({ start, end }) => {
  start(task).next(end());
});
console.log(await (await createExampleApp().flows.start(flow, { input: 21 })).result);
