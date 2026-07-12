import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { ExpertAgentManagedTool, ExpertAgentToolCallResult } from "@pragma/core";

import { renderExpertTurn } from "../../console/console-turn-renderer.ts";
import { createExampleApp, createExampleExpert } from "../../example-kit.ts";

const currentTimeTool: ExpertAgentManagedTool<"get_current_time", ExpertAgentToolCallResult> = {
  name: "get_current_time",
  description: "Return the current time as an ISO 8601 timestamp.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async call() {
    return { text: new Date().toISOString() };
  },
};

const expert = await createExampleExpert(
  "getting-started-chat",
  [
    "You are a concise and friendly general assistant.",
    "Answer in the same language as the user unless asked otherwise.",
    "Use earlier messages in this session when they are relevant.",
    "When the user asks for the current time, call get_current_time instead of guessing.",
  ].join("\n"),
  { tools: [currentTimeTool] },
);
const session = await createExampleApp().experts.createSession(expert);
const terminal = createInterface({ input: stdin, output: stdout });

console.log("Pragma Expert 已就绪。输入问题开始聊天，输入 /exit 退出。");
console.log(`Session: ${session.sessionId}`);

let turnNumber = 0;
terminal.setPrompt("你 > ");
terminal.prompt();

try {
  for await (const line of terminal) {
    const prompt = line.trim();
    if (prompt === "/exit") break;
    if (prompt === "") {
      terminal.prompt();
      continue;
    }

    turnNumber += 1;
    try {
      const turn = await session.prompt(prompt, { requestId: `console-${turnNumber}` });
      await renderExpertTurn(turn);
    } catch {
      // renderExpertTurn already displayed the failure with the streamed turn output.
    }
    terminal.prompt();
  }
} finally {
  terminal.close();
  await session.close("Console chat ended.");
}
