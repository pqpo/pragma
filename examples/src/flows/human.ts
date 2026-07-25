import { defineFlow } from "@pragma/core";
import { createExampleApp } from "../support/example-kit.ts";

const flow = defineFlow({ id: "human" });
const approval = flow.humanTask({
  id: "approve",
  request: { kind: "approval", title: "Approve deployment" },
});
flow.compose(({ start, end }) => {
  start(approval).next(end());
});
const execution = await createExampleApp().flows.start(flow, { input: {} });
const events = await execution.subscribeEvents({ scope: { kind: "all" } });
const handled = new Set<string>();
const respond = async (event: {
  readonly eventId: string;
  readonly type: string;
  data: unknown;
}) => {
  if (event.type !== "human.requested" || handled.has(event.eventId)) return;
  handled.add(event.eventId);
  const id = (event.data as { interactionId: string }).interactionId;
  await execution.respondToHumanInteraction(id, { approved: true }, { requestId: "approval" });
};
try {
  const history = await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 });
  for (const event of history.items) await respond(event);
  for await (const event of events) await respond(event);
} finally {
  await events.close();
}
console.log(await execution.result);
