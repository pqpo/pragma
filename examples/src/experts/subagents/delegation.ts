import { createAgentLauncher } from "@pragma/core";

import { createExampleApp, createExampleExpert } from "../../support/example-kit.ts";

const researcher = await createExampleExpert(
  "subagent-researcher",
  "Investigate the focused task and return concise findings.",
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
  ].join("\n"),
  { tools: [launcher.tool] },
);

const session = await createExampleApp().experts.createSession(coordinator);
const turn = await session.prompt("Explain how Expert delegation creates child Invocations.", {
  requestId: "standalone-subagent-1",
});

console.log(await turn.result);
console.dir(await turn.getTree(), { depth: null });
await session.close();
