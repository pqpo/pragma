import { createAgentLauncher, type ExpertTurn } from "@pragma/core";

import { DelegationConsoleTui } from "../../console/delegation-console-tui.ts";
import { createExampleApp, createExampleExpert } from "../../support/example-kit.ts";

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  throw new Error("The Subagent delegation example requires an interactive TTY terminal.");
}

const researcher = await createExampleExpert(
  "research-agent",
  [
    "You are a repository research specialist.",
    "Explore the workspace with read-only file and search tools to answer delegated questions about Pragma's implementation.",
    "Trace important entry points, call paths, types, and tests before drawing conclusions.",
    "Cite relevant repository-relative file paths and clearly separate evidence from inference.",
    "Do not edit files or run commands that mutate the workspace.",
  ].join("\n"),
  {
    name: "Research Agent",
    description: [
      "Investigates how Pragma is implemented by exploring the repository.",
      "Use for architecture questions, implementation tracing, code search, and evidence-backed explanations that require reading multiple files.",
    ].join(" "),
  },
);
const launcher = createAgentLauncher({
  experts: [researcher],
  context: "reuse",
  maxConcurrency: 2,
  maxDepth: 1,
});
const mainAgent = await createExampleExpert(
  "main-agent",
  [
    "You are the primary assistant responsible for understanding the user's goal and delivering the final answer.",
    "Answer in the same language as the user unless asked otherwise.",
    "When an available Expert is a better match for a focused subtask, use delegate_expert based on the Expert descriptions exposed by that tool.",
    "Give the delegated Expert a self-contained research question, then synthesize its evidence instead of merely forwarding its response.",
    "Handle simple conversational questions yourself; users should not need to know Expert ids or request delegation explicitly.",
  ].join("\n"),
  {
    name: "Main Agent",
    description:
      "Primary conversational Agent that routes focused work and synthesizes the final answer.",
    tools: [launcher.tool],
  },
);

const session = await createExampleApp().experts.createSession(mainAgent);
let activeTurn: ExpertTurn | undefined;
const consoleUi = new DelegationConsoleTui({
  title: "Pragma Main + Research Agent",
  sessionId: session.sessionId,
  examplePrompt: "请查看 Pragma 的实现原理，并说明一次 Expert 调用是如何执行的。",
  agents: [
    { id: mainAgent.id, name: mainAgent.name, shortName: "Main", primary: true },
    { id: researcher.id, name: researcher.name, shortName: "Research" },
  ],
  async onPrompt(prompt, ui) {
    activeTurn = await session.prompt(prompt);
    try {
      await ui.followTurn(activeTurn);
    } finally {
      activeTurn = undefined;
    }
  },
  async onExit() {
    if (activeTurn !== undefined) await activeTurn.cancel("Subagent console closed.");
  },
});

try {
  await consoleUi.run();
} finally {
  await session.close("Subagent console chat ended.");
}
