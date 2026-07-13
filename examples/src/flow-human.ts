import { defineFlow } from "@pragma/core";
import { createExampleApp } from "./example-kit.ts";

const flow = defineFlow({ id: "human", version: "1.0.0" });
const approval = flow.humanTask({
  id: "approve",
  version: "1.0.0",
  request: { kind: "approval", title: "Approve deployment" },
});
flow.compose(({ start, end }) => {
  start(approval).next(end());
});
const execution = await createExampleApp().flows.start(flow, { input: {} });
for await (const event of execution.events()) {
  if (event.type === "human.requested") {
    const id = (event.data as { interactionId: string }).interactionId;
    await execution.respondToHumanInteraction(id, { approved: true }, { requestId: "approval" });
  }
}
console.log(await execution.result);
