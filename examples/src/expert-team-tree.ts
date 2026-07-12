import { defineExpertTeam } from "@pragma/core";
import { createExampleApp, createExampleExpert } from "./example-kit.ts";

const lead = await createExampleExpert("tree-lead", "Delegate once, then combine the answer.");
const member = await createExampleExpert("tree-member", "Return one focused finding.");
const team = defineExpertTeam({
  id: "tree-team",
  version: "1.0.0",
  coordinator: lead,
  members: [member],
  delegation: { allow: { "tree-lead": ["tree-member"], "tree-member": [] } },
});
const turn = await (
  await createExampleApp().experts.createSession(team)
).prompt("Investigate trees.", {
  requestId: "tree",
});
await turn.result;
console.dir(await turn.getTree(), { depth: null });
