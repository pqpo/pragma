import { createAgentLauncher } from "@pragma/core";

import {
  parseDelegationStreamMode,
  renderDelegationOutput,
} from "../../console/console-delegation-output.ts";
import { createExampleApp, createExampleExpert } from "../../support/example-kit.ts";

const streamMode = parseDelegationStreamMode(process.argv.slice(2));

const researcher = await createExampleExpert(
  "subagent-researcher",
  [
    "Investigate the focused task and return concise conceptual findings.",
    "Do not inspect the workspace or call tools; answer directly from the delegated prompt.",
  ].join("\n"),
);
const launcher = createAgentLauncher({
  experts: [researcher],
  context: "reuse",
  maxConcurrency: 2,
  maxDepth: 1,
});
const coordinator = await createExampleExpert(
  "subagent-coordinator",
  [
    "Coordinate the answer.",
    "Call delegate_expert with expertId subagent-researcher before producing the final answer.",
    "Delegate immediately; do not inspect the workspace or call unrelated tools.",
  ].join("\n"),
  { tools: [launcher.tool] },
);

const session = await createExampleApp().experts.createSession(coordinator);
const turn = await session.prompt("Give three concise benefits of delegating focused research.", {
  requestId: "standalone-subagent-1",
});

console.log(`Streaming ${JSON.stringify(streamMode)}:`);
await renderDelegationOutput(turn, { mode: streamMode });
console.dir(
  streamMode.kind === "executor"
    ? await session.getMessageHistory({ scope: streamMode })
    : await turn.getMessageHistory({ scope: streamMode }),
  { depth: null },
);
console.dir(await turn.getTree(), { depth: null });
await session.close();
