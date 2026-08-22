import { defineExpertTeam, type ExpertTurn } from "@pragma/core";

import { ExpertConsoleTui } from "../../console/expert-console-tui.ts";
import { createExampleApp, createExampleExpert } from "../../support/example-kit.ts";

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  throw new Error("The Expert Team example requires an interactive TTY terminal.");
}

const lead = await createExampleExpert(
  "engineering-lead",
  [
    "You lead a repository engineering review team and are responsible for the final answer.",
    "Answer in the same language as the user unless asked otherwise.",
    "Use the available team Experts when their descriptions match focused parts of the user's request.",
    "For broad reviews, call delegate_expert once for each independent investigation before calling wait_experts with all returned invocation ids.",
    "Give each Expert a self-contained task, compare their evidence, resolve disagreements, and synthesize an actionable conclusion.",
    "Handle simple questions yourself; users should not need to know team member ids or request delegation explicitly.",
  ].join("\n"),
  {
    name: "Engineering Lead",
    description:
      "Coordinates repository investigations, selects the right specialists, and synthesizes evidence into an engineering recommendation.",
  },
);

const implementationResearcher = await createExampleExpert(
  "implementation-researcher",
  [
    "You are the team's implementation researcher.",
    "Explore the workspace with read-only file and search tools to trace concrete implementation paths.",
    "Identify entry points, important types, control flow, state transitions, and relevant tests.",
    "Cite repository-relative paths and distinguish verified behavior from inference.",
    "Do not edit files or run commands that mutate the workspace.",
  ].join("\n"),
  {
    name: "Implementation Researcher",
    description: [
      "Traces how Pragma features are implemented across the repository.",
      "Use for code search, execution call paths, state flow, runtime behavior, and evidence from concrete source files.",
    ].join(" "),
  },
);

const architectureReviewer = await createExampleExpert(
  "architecture-reviewer",
  [
    "You are the team's architecture reviewer.",
    "Inspect implementation, architecture documents, ADRs, and module boundaries using read-only tools.",
    "Evaluate dependency direction, ownership, extensibility, failure isolation, and long-term maintainability.",
    "Support every finding with repository evidence, rank risks by impact, and avoid speculative redesign.",
    "Do not edit files or run commands that mutate the workspace.",
  ].join("\n"),
  {
    name: "Architecture Reviewer",
    description: [
      "Reviews Pragma designs against repository architecture and dependency boundaries.",
      "Use for architectural trade-offs, coupling risks, abstraction quality, governance, and long-term design recommendations.",
    ].join(" "),
  },
);

const testAnalyst = await createExampleExpert(
  "test-analyst",
  [
    "You are the team's test and reliability analyst.",
    "Use read-only repository tools to inspect tests, schemas, error paths, concurrency cases, and CI coverage.",
    "Map verified behavior to existing tests, identify meaningful gaps, and propose focused verification scenarios.",
    "Prioritize correctness and operational risks over superficial coverage counts.",
    "Do not edit files or run commands that mutate the workspace.",
  ].join("\n"),
  {
    name: "Test Analyst",
    description: [
      "Evaluates the verification and reliability of Pragma implementations.",
      "Use for test coverage, edge cases, concurrency and recovery risks, schema validation, and concrete test-plan recommendations.",
    ].join(" "),
  },
);

const team = defineExpertTeam({
  id: "pragma-engineering-review-team",
  name: "Pragma Engineering Review Team",
  description:
    "A repository review team combining implementation research, architecture analysis, and test reliability expertise.",
  coordinator: lead,
  members: [implementationResearcher, architectureReviewer, testAnalyst],
  delegation: {
    maxConcurrency: 3,
    maxDepth: 1,
  },
});

const session = await createExampleApp().experts.createSession(team);
let activeTurn: ExpertTurn | undefined;
const consoleUi = new ExpertConsoleTui({
  title: "Pragma Engineering Review Team",
  sessionId: session.sessionId,
  examplePrompt: "请评审 Pragma 的 delegation 实现，说明调用链、架构风险和测试缺口，并给出优先级。",
  agents: [
    { id: lead.id, name: lead.name, shortName: "Lead", primary: true },
    {
      id: implementationResearcher.id,
      name: implementationResearcher.name,
      shortName: "Implementation",
    },
    {
      id: architectureReviewer.id,
      name: architectureReviewer.name,
      shortName: "Architecture",
    },
    { id: testAnalyst.id, name: testAnalyst.name, shortName: "Tests" },
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
    if (activeTurn !== undefined) await activeTurn.cancel("Team console closed.");
  },
});

try {
  await consoleUi.run();
} finally {
  await session.close("Expert team console chat ended.");
}
