import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import {
  ExpertAgentHumanRequestSchema,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
} from "@pragma/core";

import toolApprovalPolicy from "../../plugins/tool-approval-policy/src/plugin.ts";
import { ConsoleTurnRenderer } from "../console/console-turn-renderer.ts";
import { createExampleApp, createExampleExpert } from "../support/example-kit.ts";

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
  const events = await turn.subscribeEvents({ scope: { kind: "all" } });
  const output = await turn.subscribeOutput({ scope: { kind: "all" } });
  const handled = new Set<string>();
  const handleEvent = async (event: {
    readonly eventId: string;
    readonly type: string;
    readonly data: unknown;
  }) => {
    if (event.type !== "human.requested") return;
    if (handled.has(event.eventId)) return;
    handled.add(event.eventId);

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
  };

  try {
    const renderTask = (async () => {
      for await (const item of output) renderer.renderOutput(item);
    })();
    const history = await turn.listEvents({ scope: { kind: "all" }, limit: 1_000 });
    for (const event of history.items) await handleEvent(event);
    for await (const event of events) await handleEvent(event);
    await renderTask;
    renderer.complete(await turn.result);
  } finally {
    await Promise.all([events.close(), output.close()]);
  }
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
