import { defineFlow } from "@pragma/core";
import { createExampleApp } from "../support/example-kit.ts";

const flow = defineFlow({ id: "tree", version: "1.0.0" });
const first = flow.task({ id: "first", version: "1.0.0", handler: () => "one" });
const second = flow.task({ id: "second", version: "1.0.0", handler: () => "two" });
flow.compose(({ start, end }) => {
  start(first).next(second).next(end());
});
const execution = await createExampleApp().flows.start(flow, { input: {} });
await execution.result;
console.dir(await execution.getTree(), { depth: null });
for await (const event of execution.getAllOutput()) {
  console.log(event.invocationId, event.value ?? event.delta);
}
