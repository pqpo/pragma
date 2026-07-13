import { renderExpertTurn } from "../console/console-turn-renderer.ts";
import { createExampleApp, createExampleExpert } from "../support/example-kit.ts";

const packageCatalog: Readonly<Record<string, string>> = {
  "@pragma/core": "定义 Expert、Context、Tool、Plugin、Runtime 边界和 Flow 编排。",
  "@pragma/shared": "保存跨端协议、Zod Schema、领域模型和值对象。",
  "@pragma/runtime-pi": "把 PI Coding Agent 适配为 Pragma Runtime。",
};

const expert = await createExampleExpert(
  "mcp-example",
  [
    "你是 Pragma 示例助手。",
    "用户询问 package 信息时必须调用 lookup_package，不要凭空回答。",
    "回答时说明信息来自 MCP Tool。",
  ].join("\n"),
  {
    mcp: {
      mcpServers: {
        catalog: {
          name: "Example Package Catalog",
          transport: "in-process",
          timeout: 5_000,
          allowTools: ["lookup_package"],
          disallowTools: ["internal_debug"],
          inProcess: {
            async listTools() {
              return [
                {
                  name: "lookup_package",
                  description: "按 package 名称查询 Pragma workspace package 的职责。",
                  inputSchema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                    additionalProperties: false,
                  },
                },
                {
                  name: "internal_debug",
                  description: "仅供 Server 调试，不应暴露给 Expert。",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
              ];
            },
            async callTool(name, args, signal) {
              signal?.throwIfAborted();
              if (name !== "lookup_package") throw new Error(`不允许调用 MCP Tool：${name}`);
              const packageName = readPackageName(args);
              return {
                content: [
                  {
                    type: "text",
                    text: `${packageName}: ${packageCatalog[packageName] ?? "示例目录中没有这个 package。"}`,
                  },
                ],
              };
            },
            async dispose() {
              console.log("[MCP Server] Session 资源已释放");
            },
          },
        },
      },
    },
  },
);

const prompt = process.argv.slice(2).join(" ").trim() || "@pragma/core 是做什么的？";
const session = await createExampleApp().experts.createSession(expert);

try {
  const turn = await session.prompt(prompt, { requestId: "mcp-example-1" });
  await renderExpertTurn(turn);
} finally {
  await session.close("MCP example completed.");
}

function readPackageName(args: unknown): string {
  if (typeof args !== "object" || args === null || !("name" in args)) {
    throw new Error("lookup_package 缺少 name 参数。");
  }
  const name = args.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("lookup_package.name 必须是非空字符串。");
  }
  return name.trim();
}
