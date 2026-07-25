import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import {
  ContextSystem,
  FileSystemContextStore,
  HOST_CONTEXT_NAMESPACE,
  defineExpert,
} from "@pragma/core";
import type { ExpertAgentRunContext } from "@pragma/core";

type ExampleRole = "member" | "admin";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const exampleRoot = join(repositoryRoot, "workspace", "context-example");
const contextDir = join(exampleRoot, "context");
await seedContextFiles(contextDir);

const store = new FileSystemContextStore({
  rootDir: contextDir,
  authorize: ({ operation, ids, context }) => {
    const role = readRole(context);
    const authorizedIds =
      role === "admin"
        ? ids
        : operation === "list" || operation === "read" || operation === "search"
          ? ids.filter((id) => id.startsWith("public/"))
          : [];

    console.log(
      `[授权] role=${role} operation=${operation} allowed=${JSON.stringify(authorizedIds)}`,
    );
    return authorizedIds;
  },
});

const contextSystem = new ContextSystem({
  roots: [
    {
      namespace: HOST_CONTEXT_NAMESPACE,
      load: {
        preloadPaths: ["public/AGENTS.md"],
        priorityRules: [{ pattern: "public/AGENTS.md", priority: "critical" }],
      },
    },
  ],
});
contextSystem.register({ namespace: HOST_CONTEXT_NAMESPACE, store, required: true });

const expert = await defineExpert({
  id: "context-example",
  name: "Context Example",
  description: "通过控制台学习 Context 加载、检索、写入和授权。",
  tags: ["example", "context", "authorization"],
  scope: "example",
  workspace: exampleRoot,
  contextSystem,
});

const terminal = createInterface({ input: stdin, output: stdout });
let role: ExampleRole = "member";

console.log(`Context 文件目录：${contextDir}`);
console.log("默认角色是 member，只能访问 public/；admin 可以读写全部 Context。");

try {
  while (true) {
    printMenu(role);
    const command = (await terminal.question("请选择操作> ")).trim();
    if (command === "0") break;

    switch (command) {
      case "1":
        await printAssembledContext();
        break;
      case "2":
        await callContextTool("list_expert_context", {});
        break;
      case "3":
        await readContext();
        break;
      case "4":
        await searchContext();
        break;
      case "5":
        await addContext();
        break;
      case "6":
        await editContext();
        break;
      case "7":
        await deleteContext();
        break;
      case "8":
        role = role === "member" ? "admin" : "member";
        console.log(`已切换为 ${role}。`);
        break;
      default:
        console.log("未知选项，请输入 0-8。");
    }
  }
} finally {
  terminal.close();
}

function printMenu(currentRole: ExampleRole): void {
  console.log(`\n=== Context 示例（当前角色：${currentRole}）===`);
  console.log("1. 构建启动 Context，查看 preload 与预算");
  console.log("2. 列出当前角色可见的 Context");
  console.log("3. 读取 Context");
  console.log("4. 搜索 Context");
  console.log("5. 新增 Context（需要 admin）");
  console.log("6. 编辑 Context（需要 admin）");
  console.log("7. 删除 Context（需要 admin）");
  console.log("8. 切换 member/admin 角色");
  console.log("0. 退出");
}

function createRunContext(): ExpertAgentRunContext {
  return {
    source: { type: "user", id: `${role}-example-user` },
    attributes: { role },
  };
}

async function printAssembledContext(): Promise<void> {
  const context = await expert.buildContext(createRunContext());
  console.log("\n已加载的 Context：");
  console.log(JSON.stringify(context.snapshot.loadedContexts ?? [], null, 2));
  console.log("Context 预算：");
  console.log(JSON.stringify(context.snapshot.budget, null, 2));
  console.log("启动消息：");
  console.log(context.startupMessages.map((message) => message.content).join("\n---\n"));
}

async function readContext(): Promise<void> {
  const id = (await terminal.question("Context ID [public/guide.md]> ")).trim();
  await callContextTool("read_expert_context", {
    namespace: HOST_CONTEXT_NAMESPACE,
    id: id || "public/guide.md",
  });
}

async function searchContext(): Promise<void> {
  const query = (await terminal.question("搜索文字 [Deployment]> ")).trim();
  await callContextTool("search_expert_context", {
    query: query || "Deployment",
    scope: "hybrid",
    contextLines: 1,
  });
}

async function addContext(): Promise<void> {
  const id = (await terminal.question("新 Context ID [notes/decision.md]> ")).trim();
  const content = (await terminal.question("内容 [Use RuntimeAdapter as boundary.]> ")).trim();
  await callContextTool("add_expert_context", {
    namespace: HOST_CONTEXT_NAMESPACE,
    id: id || "notes/decision.md",
    content: content || "Use RuntimeAdapter as boundary.",
    description: "由 Context 示例写入的决策记录。",
    trigger: "manual",
  });
}

async function editContext(): Promise<void> {
  const id = (await terminal.question("要编辑的 Context ID [notes/decision.md]> ")).trim();
  const content = (await terminal.question("替换后的完整内容> ")).trim();
  await callContextTool("edit_expert_context", {
    namespace: HOST_CONTEXT_NAMESPACE,
    id: id || "notes/decision.md",
    mode: "replace",
    content: content || "Use RuntimeAdapter as the stable execution boundary.",
  });
}

async function deleteContext(): Promise<void> {
  const id = (await terminal.question("要删除的 Context ID [notes/decision.md]> ")).trim();
  await callContextTool("delete_expert_context", {
    namespace: HOST_CONTEXT_NAMESPACE,
    id: id || "notes/decision.md",
  });
}

async function callContextTool(name: string, args: unknown): Promise<void> {
  const tools = expert.createDefaultTools({ getContext: createRunContext });
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Context Tool 不存在：${name}`);

  const result = await tool.call(args, undefined);
  console.log(`\n[${name}] ${result.isError === true ? "失败" : "成功"}`);
  console.log(result.text);
}

function readRole(context: ExpertAgentRunContext | undefined): ExampleRole | "anonymous" {
  const value = context?.attributes?.["role"];
  return value === "member" || value === "admin" ? value : "anonymous";
}

async function seedContextFiles(rootDir: string): Promise<void> {
  await Promise.all([
    mkdir(join(rootDir, "public"), { recursive: true }),
    mkdir(join(rootDir, "private"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(rootDir, "public", "AGENTS.md"),
      [
        "---",
        "description: 示例的常驻工程约束",
        "trigger: always_on",
        "trustLevel: workspace",
        "sensitivity: internal",
        "---",
        "# Example AGENTS.md",
        "",
        "所有跨 package 调用必须使用 @pragma/* package import。",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(rootDir, "public", "guide.md"),
      [
        "---",
        "description: 所有成员可见的部署指南",
        "trigger: model_decision",
        "---",
        "# Public guide",
        "",
        "Deployment documentation for every member.",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(rootDir, "private", "runbook.md"),
      [
        "---",
        "description: 仅管理员可见的恢复手册",
        "trigger: manual",
        "sensitivity: restricted",
        "---",
        "# Private runbook",
        "",
        "Deployment credentials and production recovery steps.",
      ].join("\n"),
      "utf8",
    ),
  ]);
}
