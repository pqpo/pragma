import { createInMemoryContextStore, definePluginEntry } from "@pragma/core";
import { z } from "zod";

/** Plugin config 在 setup 阶段解析，错误配置会让 Agent 创建立即失败。 */
const LearningPluginConfigSchema = z.object({
  teamName: z.string().min(1).default("Pragma Team"),
  greetingPrefix: z.string().min(1).default("你好"),
});

export default definePluginEntry({
  setup(context) {
    const config = LearningPluginConfigSchema.parse(context.config ?? {});

    // Plugin 使用独立 namespace，避免和 host 或其他 Plugin 的 Context ID 冲突。
    context.contextSystem.register({
      namespace: "learning-plugin",
      store: createInMemoryContextStore({
        context: [
          {
            id: "team.md",
            content: `# Team\n\n当前团队是 ${config.teamName}。`,
            metadata: {
              description: "由 Learning Plugin 提供的团队信息。",
              trigger: "model_decision",
              trustLevel: "workspace",
              sensitivity: "internal",
            },
          },
        ],
      }),
    });

    return {
      tools: [
        {
          name: "create_team_greeting",
          description: "使用 Plugin 配置生成团队问候语。",
          inputSchema: {
            type: "object",
            properties: {
              person: { type: "string", description: "被问候的人" },
            },
            required: ["person"],
            additionalProperties: false,
          },
          call: async (args: unknown) => {
            const person = readPerson(args);
            return {
              text: `${config.greetingPrefix}，${person}！欢迎加入 ${config.teamName}。`,
              details: { teamName: config.teamName },
            };
          },
        },
      ],
      // Hooks 由 Runtime 生命周期触发。这个示例打印顺序，方便观察 Plugin 如何包围一次 Agent Run。
      hooks: {
        beforeSessionCreate: ({ systemSessionId }) => {
          printHook("beforeSessionCreate", systemSessionId);
        },
        afterSessionCreate: ({ session }) => {
          printHook("afterSessionCreate", session.systemSessionId);
        },
        beforeTaskSubmit: ({ runId }) => {
          printHook("beforeTaskSubmit", runId);
        },
        afterTaskSubmit: ({ runId, error }) => {
          printHook("afterTaskSubmit", runId, error === undefined ? "success" : "error");
        },
        beforeToolCall: ({ toolName }) => {
          printHook("beforeToolCall", toolName);
        },
        afterToolCall: ({ toolName, durationMs }) => {
          printHook("afterToolCall", toolName, `${durationMs}ms`);
        },
        beforeSessionDestroy: ({ session }) => {
          printHook("beforeSessionDestroy", session.systemSessionId);
        },
        afterSessionDestroy: ({ session }) => {
          printHook("afterSessionDestroy", session.systemSessionId);
        },
      },
    };
  },
});

function readPerson(args: unknown): string {
  if (typeof args !== "object" || args === null || !("person" in args)) {
    throw new Error("create_team_greeting 缺少 person 参数。");
  }

  const person = (args as { person: unknown }).person;
  if (typeof person !== "string" || person.trim().length === 0) {
    throw new Error("person 必须是非空字符串。");
  }
  return person.trim();
}

function printHook(name: string, subject: string, detail?: string): void {
  console.log(`[Plugin Hook] ${name}: ${subject}${detail === undefined ? "" : ` (${detail})`}`);
}
