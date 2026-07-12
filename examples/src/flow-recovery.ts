import { defineFlow } from "@pragma/core";
import { createExampleApp } from "./example-kit.ts";

const flow = defineFlow({ id: "recoverable", version: "1.0.0" });
const task = flow.task({ id: "work", version: "1.0.0", handler: () => "done" });
flow.compose(({ start, end }) => {
  start(task).next(end());
});
const app = createExampleApp();
const execution = await app.flows.start(flow, { input: {} });
const opened = await app.flows.open({ executionId: execution.executionId });
console.log((await opened.getState()).status);
console.log(await execution.result);
