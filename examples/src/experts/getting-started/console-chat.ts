import type { ExpertAgentManagedTool, ExpertAgentToolCallResult, ExpertTurn } from "@pragma/core";

import { ExpertConsoleTui } from "../../console/expert-console-tui.ts";
import { createExampleApp, createExampleExpert } from "../../support/example-kit.ts";
import { readCurrentLocalTime } from "../../support/current-time.ts";

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  throw new Error("The Getting Started chat example requires an interactive TTY terminal.");
}

const currentTimeTool: ExpertAgentManagedTool<"get_current_time", ExpertAgentToolCallResult> = {
  name: "get_current_time",
  description: "Return the current local time with its UTC offset and IANA time zone.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async call() {
    return { text: JSON.stringify(readCurrentLocalTime()) };
  },
};

const expert = await createExampleExpert(
  "getting-started-chat",
  [
    "You are a concise and friendly general assistant.",
    "Answer in the same language as the user unless asked otherwise.",
    "Use earlier messages in this session when they are relevant.",
    "When the user asks for the current time, call get_current_time instead of guessing.",
    "Report the tool's timestamp as local time and preserve its UTC offset and time zone.",
    "When a useful answer requires a preference or missing detail from the user, call askUserQuestion instead of guessing.",
  ].join("\n"),
  { tools: [currentTimeTool] },
);
const session = await createExampleApp().experts.createSession(expert);
let activeTurn: ExpertTurn | undefined;
const consoleUi = new ExpertConsoleTui({
  title: "Pragma Getting Started",
  sessionId: session.sessionId,
  examplePrompt: "请先用 askUserQuestion 问我想聊哪个主题，再根据回答继续。",
  agents: [{ id: expert.id, name: expert.name, shortName: "Expert", primary: true }],
  async onPrompt(prompt, ui) {
    activeTurn = await session.prompt(prompt);
    try {
      await ui.followTurn(activeTurn);
    } finally {
      activeTurn = undefined;
    }
  },
  async onExit() {
    if (activeTurn !== undefined) await activeTurn.cancel("Getting Started console closed.");
  },
});

try {
  await consoleUi.run();
} finally {
  await session.close("Getting Started console chat ended.");
}
