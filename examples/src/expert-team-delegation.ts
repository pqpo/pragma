import { defineExpertTeam } from "@pragma/core";
import { createExampleApp, createExampleExpert } from "./example-kit.ts";

const coordinator = await createExampleExpert("lead", "Delegate research when useful.");
const researcher = await createExampleExpert("researcher", "Investigate the requested topic.");
const team = defineExpertTeam({
  id: "research-team",
  version: "1.0.0",
  coordinator,
  members: [researcher],
  delegation: { allow: { lead: ["researcher"], researcher: [] }, context: "reuse" },
});
const session = await createExampleApp().experts.createSession(team);
console.log(
  await (
    await session.prompt("Research Execution trees.", { requestId: "team-1" })
  ).result,
);
await session.close();
