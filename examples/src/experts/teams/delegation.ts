import { defineExpertTeam } from "@pragma/core";

import {
  parseDelegationStreamMode,
  renderDelegationOutput,
} from "../../console/console-delegation-output.ts";
import { createExampleApp, createExampleExpert } from "../../support/example-kit.ts";

const streamMode = parseDelegationStreamMode(process.argv.slice(2));

const coordinator = await createExampleExpert(
  "lead",
  "Delegate research immediately, then synthesize the result without inspecting the workspace.",
);
const researcher = await createExampleExpert(
  "researcher",
  "Return concise conceptual findings without inspecting the workspace or calling tools.",
);
const team = defineExpertTeam({
  id: "research-team",
  version: "1.0.0",
  coordinator,
  members: [researcher],
  delegation: { allow: { lead: ["researcher"], researcher: [] }, context: "reuse" },
});
const session = await createExampleApp().experts.createSession(team);
const turn = await session.prompt("Give three concise benefits of delegated research.", {
  requestId: "team-1",
});
console.log(`Streaming ${JSON.stringify(streamMode)}:`);
await renderDelegationOutput(turn, { mode: streamMode });
console.dir(
  streamMode.kind === "executor"
    ? await session.getMessageHistory({ scope: streamMode })
    : await turn.getMessageHistory({ scope: streamMode }),
  { depth: null },
);
await session.close();
