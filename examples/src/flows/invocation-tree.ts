import { defineFlow } from "@pragma/core";
import { createExampleApp } from "../support/example-kit.ts";

const flow = defineFlow({ id: "tree" });
const first = flow.task({ id: "first", handler: () => "one" });
const second = flow.task({ id: "second", handler: () => "two" });
flow.compose(({ start, end }) => {
  start(first).next(second).next(end());
});
const execution = await createExampleApp().flows.start(flow, { input: {} });
await execution.result;
console.dir(await execution.getTree(), { depth: null });
console.dir((await execution.listEvents({ scope: { kind: "all" } })).items, { depth: null });
