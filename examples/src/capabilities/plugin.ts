import learningPlugin from "../../plugins/learning-plugin/src/plugin.ts";
import { renderExpertTurn } from "../console/console-turn-renderer.ts";
import { createExampleApp, createExampleExpert } from "../support/example-kit.ts";

const expert = await createExampleExpert(
  "plugin-example",
  [
    "你是 Plugin 教学助手。",
    "用户要求问候时必须调用 create_team_greeting，不要自己编造问候语。",
    "回答团队问题时先读取 learning-plugin/team.md。",
  ].join("\n"),
  {
    plugins: [
      {
        entry: learningPlugin,
        config: {
          teamName: "Pragma Example Team",
          greetingPrefix: "欢迎",
        },
      },
    ],
  },
);

console.log(`已装配 Plugin：${learningPlugin.id}@${learningPlugin.version ?? "unknown"}`);
console.log(`Tools：${(expert.tools ?? []).map((tool) => tool.name).join(", ")}`);
const contextIndex = await expert.listContext();
if (!contextIndex.ok) throw new Error(contextIndex.error.message);
console.log(
  `Context namespaces：${[...new Set(contextIndex.value.items.map((item) => item.namespace))].join(", ")}`,
);
if ((expert.pluginLoadIssues?.length ?? 0) > 0) {
  throw new Error(`Plugin 加载失败：${JSON.stringify(expert.pluginLoadIssues)}`);
}

const prompt = process.argv.slice(2).join(" ").trim() || "请用插件欢迎小明，并告诉我当前团队名称。";
const session = await createExampleApp().experts.createSession(expert);

try {
  const turn = await session.prompt(prompt, { requestId: "plugin-example-1" });
  await renderExpertTurn(turn);
} finally {
  await session.close("Plugin example completed.");
}
