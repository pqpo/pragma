import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import {
  ExpertAgentHumanRequestSchema,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
} from "@pragma/core";

import toolApprovalPolicy from "../../plugins/tool-approval-policy/src/plugin.ts";
import { ConsoleTurnRenderer } from "../console/console-turn-renderer.ts";
import { createExampleApp, createExampleExpert } from "../example-kit.ts";

const deleteNoteTool: ExpertAgentManagedTool<"delete_workspace_note", ExpertAgentToolCallResult> = {
  name: "delete_workspace_note",
  description: "删除 workspace 中的一份 Markdown 笔记。这个教学工具只返回模拟结果。",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  async call(args) {
    const path =
      typeof args === "object" && args !== null && "path" in args ? String(args.path) : "<unknown>";
    return { text: `已模拟删除：${path}`, details: { simulated: true } };
  },
};

const expert = await createExampleExpert(
  "tool-approval-example",
  [
    "你是 Tool 审批教学助手。",
    "按用户要求调用 delete_workspace_note，并如实报告批准或拒绝后的结果。",
  ].join("\n"),
  {
    tools: [deleteNoteTool],
    plugins: [{ entry: toolApprovalPolicy }],
  },
);

const prompt =
  process.argv.slice(2).join(" ").trim() ||
  "调用 delete_workspace_note 删除 notes/approval-example.md，并报告结果。";
const terminal = createInterface({ input: stdin, output: stdout });
const session = await createExampleApp().experts.createSession(expert);

try {
  const turn = await session.prompt(prompt, { requestId: "tool-approval-example-1" });
  const renderer = new ConsoleTurnRenderer();

  for await (const event of turn.events()) {
    renderer.render(event);
    if (event.type !== "human.requested") continue;

    const interaction = readInteraction(event.data);
    if (interaction.request.kind !== "tool_approval") {
      throw new Error(`不支持的 Human Interaction：${interaction.request.kind}`);
    }

    const answer = (
      await terminal.question(
        `\n批准 ${interaction.request.toolName}？${interaction.request.reason ?? ""} [y/N] `,
      )
    )
      .trim()
      .toLowerCase();
    const approved = answer === "y" || answer === "yes";
    await turn.respondToHumanInteraction(
      interaction.interactionId,
      {
        kind: "tool_approval",
        approved,
        reason: approved ? "用户批准。" : "用户拒绝。",
      },
      { requestId: `approval-response-${interaction.interactionId}` },
    );
  }

  renderer.complete(await turn.result);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  terminal.close();
  await session.close("Tool approval example completed.");
}

function readInteraction(payload: unknown): {
  readonly interactionId: string;
  readonly request: ReturnType<typeof ExpertAgentHumanRequestSchema.parse>;
} {
  if (typeof payload !== "object" || payload === null || !("interactionId" in payload)) {
    throw new Error("human.requested 事件缺少 interactionId。");
  }
  if (typeof payload.interactionId !== "string") {
    throw new Error("human.requested.interactionId 必须是字符串。");
  }
  if (!("request" in payload)) throw new Error("human.requested 事件缺少 request。");
  return {
    interactionId: payload.interactionId,
    request: ExpertAgentHumanRequestSchema.parse(payload.request),
  };
}
