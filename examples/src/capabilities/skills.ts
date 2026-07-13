import { dirname, resolve } from "node:path";

import { renderExpertTurn } from "../console/console-turn-renderer.ts";
import { createExampleApp, createExampleExpert } from "../support/example-kit.ts";

const skillPath = resolve(import.meta.dirname, "../../skills/code-review/SKILL.md");
const expert = await createExampleExpert(
  "skills-example",
  [
    "你是代码审查教学助手。",
    "用户要求审查时，使用 pragma-code-review Skill 中定义的流程和输出格式。",
    "如果用户没有提供真实 diff，可以把输入当作待审查的伪代码。",
  ].join("\n"),
  {
    skills: {
      skills: [
        {
          type: "local",
          name: "pragma-code-review",
          description: "按正确性、架构边界、风险和验证四个维度审查代码。",
          path: skillPath,
          baseDir: dirname(skillPath),
        },
      ],
    },
  },
);

const prompt =
  process.argv.slice(2).join(" ").trim() || "审查这段代码：function divide(a, b) { return a / b }";
const session = await createExampleApp().experts.createSession(expert);

console.log(`当前 Skill：${skillPath}`);
try {
  const turn = await session.prompt(prompt, { requestId: "skills-example-1" });
  await renderExpertTurn(turn);
} finally {
  await session.close("Skills example completed.");
}
