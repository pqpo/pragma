import { defineExpertTeam, defineFlow } from "@pragma/core";
import { createExampleApp, createExampleExpert } from "../support/example-kit.ts";

const expert = await createExampleExpert("flow-expert", "Answer the Flow prompt.");
const coordinator = await createExampleExpert("flow-lead", "Coordinate the answer.");
const member = await createExampleExpert("flow-member", "Supply a supporting fact.");
const team = defineExpertTeam({
  id: "flow-team",
  coordinator,
  members: [member],
  delegation: { allow: { "flow-lead": ["flow-member"], "flow-member": [] } },
});
const flow = defineFlow({ id: "experts-flow" });
const one = flow.use("single", expert);
const two = flow.use("team", team, { input: "Review the prior answer." });
flow.compose(({ start, end }) => {
  start(one).next(two).next(end());
});
console.log(
  await (
    await createExampleApp().flows.start(flow, { input: "Explain InvocationTree." })
  ).result,
);
