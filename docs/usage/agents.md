# Agent 使用指南

本文说明如何在当前 Pragma 代码中创建和使用 `ExpertAgent`，包括模型配置、MCP 配置、Skills 配置、Tool 配置、上下文配置和运行会话。

当前核心 API 来自：

```ts
import { ExpertAgent, defineAgent } from "@pragma/core";
```

`defineAgent()` 是 `ExpertAgent.create()` 的语法糖，二者都会返回 `Promise<ExpertAgent>`。

## 最小 Agent

```ts
import { defineAgent } from "@pragma/core";

const agent = await defineAgent({
  id: "coding-expert",
  name: "Coding Expert",
  description: "负责代码实现、测试和代码解释。",
  tags: ["coding", "typescript"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  instructions: `
你是一个资深 TypeScript 工程 Agent。
优先做小步、可验证、边界清晰的代码修改。
`,
});
```

必填字段：

- `id`：Agent 唯一标识。
- `name`：展示名。
- `description`：能力描述。
- `tags`：能力标签。
- `version`：Agent 版本。
- `scope`：能力边界描述。
- `workspace`：运行工作区。

常用可选字段：

- `schemaVersion`
- `instructions`
- `models`
- `mcp`
- `skills`
- `contextSystem`
- `tools`
- `hooks`
- `plugins`
- `loggerProvider`

## 记忆系统插件

`ExpertAgent.create()` / `defineAgent()` 不会默认加载记忆系统。需要记忆能力时，由宿主显式注入 `@pragma/plugin-memory`：

```ts
import memoryPlugin from "@pragma/plugin-memory";

const agent = await defineAgent({
  id: "memory-enabled-agent",
  name: "Memory Enabled Agent",
  description: "Uses the memory plugin.",
  tags: ["memory"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  plugins: [{ entry: memoryPlugin }],
});
```

如果只关闭其中一部分，把配置放在 plugin use 的 `config` 中：

```ts
import memoryPlugin from "@pragma/plugin-memory";

const agent = await defineAgent({
  id: "selective-memory-agent",
  name: "Selective Memory Agent",
  description: "Disables some memory categories.",
  tags: ["memory"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  plugins: [
    {
      entry: memoryPlugin,
      config: {
        experience: { enabled: false },
        fact: { enabled: false },
      },
    },
  ],
});
```

更多内容见 [Memory System 使用指南](./memory.md)。

## 创建会话并提交任务

当前实现中，Agent 运行通过 Runtime Session 完成。没有 `agent.run()` 这个稳定 API；请使用 `createSession()`。

```ts
const session = await agent.createSession();

try {
  const handle = session.submit({
    query: "解释当前仓库的核心模块。",
  });

  for await (const event of handle.events) {
    console.log(event);
  }

  const result = await handle.result;
  console.log(result.result.output);
} finally {
  await session.abort();
}
```

如果需要结构化输出，在 `submit()` 处传入 Zod schema：

```ts
import { z } from "zod";

const output = z.object({
  summary: z.string(),
  risks: z.array(z.string()),
  changedFiles: z.array(z.string()),
});

const handle = session.submit({
  query: "评审这次改动并返回结构化结果。",
  output,
});

const result = await handle.result;
console.log(result.result.output.summary);
```

输出 schema 属于具体调用，而不是必须固定在 Agent 声明上。同一个 Agent 可以在不同任务中返回不同结构。

## 模型配置

模型配置通过 `models` 字段传入：

```ts
const agent = await defineAgent({
  id: "research-expert",
  name: "Research Expert",
  description: "负责资料整理和分析。",
  tags: ["research"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  models: {
    defaultModelName: "openai/gpt-4o-mini",
    providers: [
      {
        provider: "openai",
        modelNames: ["gpt-4o-mini", "gpt-4.1"],
        baseApi: "https://api.openai.com/v1",
        key: process.env.OPENAI_API_KEY ?? "",
        api: "openai-responses",
      },
    ],
  },
});
```

当前支持的 `api` 值：

```text
anthropic-messages
google-generative-ai
openai-completions
openai-responses
```

推荐做法：

- `key` 从环境变量读取，不要写死到源码。
- `defaultModelName` 使用 `{provider}/{modelName}` 格式。
- 一个 Agent 可以声明多个 provider，Runtime 根据具体适配实现选择使用。

## MCP 配置

MCP 配置通过 `mcp` 字段声明：

```ts
const agent = await defineAgent({
  id: "doc-expert",
  name: "Document Expert",
  description: "负责检索和总结文档。",
  tags: ["docs"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  mcp: {
    mcpServers: {
      "doc-search": {
        name: "doc-search",
        command: "node",
        args: ["./tools/doc-search-server.js"],
        env: {
          DOC_INDEX: "docs",
        },
        allowTools: ["searchDocs", "readDoc"],
        timeout: 30_000,
      },
      "remote-search": {
        name: "remote-search",
        url: "https://mcp.example.com",
        token: process.env.REMOTE_MCP_TOKEN,
        allowTools: ["search"],
      },
    },
  },
});
```

`IExpertAgentMcpServer` 支持：

- `name`
- `command`
- `args`
- `env`
- `url`
- `timeout`
- `token`
- `allowTools`
- `disallowTools`
- `inProcess`

本进程 MCP Server 可以使用 `inProcess`：

```ts
const agent = await defineAgent({
  id: "in-process-tool-agent",
  name: "In-process Tool Agent",
  description: "演示 in-process MCP。",
  tags: ["mcp"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  mcp: {
    mcpServers: {
      local: {
        name: "local",
        inProcess: {
          listTools: async () => [
            {
              name: "echo",
              description: "Return the input.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
                additionalProperties: false,
              },
            },
          ],
          callTool: async (_name, args) => args,
        },
      },
    },
  },
});
```

MCP 只声明可用工具来源。最终是否能调用、是否需要审批，仍应由 Runtime、Tool approval、插件策略或上层权限系统裁决。

## Skills 配置

Skills 配置通过 `skills` 字段声明：

```ts
const agent = await defineAgent({
  id: "architecture-expert",
  name: "Architecture Expert",
  description: "负责架构分析和方案设计。",
  tags: ["architecture"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  skills: {
    skills: [
      {
        type: "builtin",
        name: "code-review",
        description: "进行代码审查。",
      },
      {
        type: "local",
        name: "domain-analysis",
        description: "领域分析技能。",
        path: "./skills/domain-analysis/SKILL.md",
        baseDir: "/path/to/workspace",
      },
      {
        type: "registry",
        name: "requirements-breakdown",
        description: "需求拆解技能。",
        version: "1.2.0",
      },
    ],
  },
});
```

Skill 类型：

```text
builtin
registry
local
```

Skills 用于告诉 Runtime 和 Agent 可用的专业流程或能力包。具体加载方式由 Runtime 适配层决定。

## Tool 配置

自定义 Tool 通过 `tools` 字段声明：

```ts
const agent = await defineAgent({
  id: "workspace-agent",
  name: "Workspace Agent",
  description: "负责工作区操作。",
  tags: ["workspace"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  tools: [
    {
      name: "read_project_metadata",
      description: "读取项目元信息。",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string" },
        },
        required: ["file"],
        additionalProperties: false,
      },
      call: async (args) => {
        return {
          text: `metadata for ${(args as { file: string }).file}`,
          details: args,
        };
      },
    },
  ],
});
```

Tool 返回值建议使用：

```ts
{
  text: string;
  isError?: boolean;
  details?: unknown;
}
```

### Tool 审批

Tool 可以声明审批策略：

```ts
const agent = await defineAgent({
  id: "approval-agent",
  name: "Approval Agent",
  description: "演示工具审批。",
  tags: ["approval"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  tools: [
    {
      name: "delete_workspace_note",
      description: "删除工作区笔记。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      approval: {
        mode: "required",
        reason: "删除文件需要用户确认。",
      },
      call: async (args) => ({
        text: `Deleted ${(args as { path: string }).path}`,
      }),
    },
  ],
});
```

审批模式：

```text
none      不要求审批
ask       当审批策略适用时尽量询问；如果当前 Runtime 没有人类交互处理器，则继续执行
required  当审批策略适用时必须拿到明确批准；如果当前 Runtime 没有人类交互处理器，则拒绝执行
```

`approval.when` 用于判断审批策略是否适用于当前工具调用。未提供 `when` 时，`ask` 和
`required` 策略默认适用于每次调用。

创建 Runtime Session 时可以传入 `humanInteractionHandler`：

```ts
const session = await agent.createSession({
  humanInteractionHandler: async (request) => {
    if (request.kind === "tool_approval") {
      return {
        kind: "tool_approval",
        approved: true,
      };
    }

    return {
      kind: "user_question",
      answered: false,
      reason: "No interactive UI is available.",
    };
  },
});
```

### 默认上下文工具

`ExpertAgent.createDefaultTools()` 可以把上下文操作转换为工具：

```ts
const contextTools = agent.createDefaultTools({
  readByteBudget: 8_000,
});
```

默认包含：

- `askUserQuestion`
- `list_expert_context`
- `read_expert_context`
- `search_expert_context`
- `add_expert_context`
- `edit_expert_context`
- `delete_expert_context`

是否把这些工具注入 Agent，取决于创建 Agent 时的 `tools` 或插件贡献方式。

## 上下文配置

`ContextSystem` 可以注册多个 namespace，每个 namespace 对应一个 store。

更完整的字段语义和示例见：

- [Context 使用指南](./context.md)
- [Context 配置示例](./context-examples.md)

```ts
import {
  ContextSystem,
  HOST_CONTEXT_NAMESPACE,
  createInMemoryContextStore,
  defineAgent,
} from "@pragma/core";

const contextSystem = new ContextSystem();

contextSystem.register({
  namespace: HOST_CONTEXT_NAMESPACE,
  store: createInMemoryContextStore({
    context: [
      {
        id: "project.md",
        content: "Pragma 是多专家 Agent 编排系统。",
        metadata: {
          description: "项目背景",
          trigger: "always_on",
          trustLevel: "workspace",
          sensitivity: "internal",
        },
      },
    ],
  }),
});

const agent = await defineAgent({
  id: "context-agent",
  name: "Context Agent",
  description: "演示上下文系统。",
  tags: ["context"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  contextSystem,
});
```

常用操作：

```ts
await agent.listContext();
await agent.readContext({ namespace: "host", id: "project.md" });
await agent.searchContext({ query: "Agent" });
await agent.addContext({
  namespace: "host",
  id: "decision.md",
  content: "Use RuntimeAdapter as execution boundary.",
});
```

## 显式 Runtime 配置

默认情况下，导入 `@pragma/core` 会设置默认 Runtime Registry。需要自定义 Runtime 时：

```ts
import { createRuntimeRegistry } from "@pragma/core";

const runtimes = createRuntimeRegistry({
  runtimes: [customRuntime],
  defaultRuntime: "custom",
});

const session = await agent.createSession({
  runtime: "custom",
  runtimes,
});
```

Runtime 的稳定边界是 `RuntimeAdapter`。Agent 不应该直接依赖某个模型 SDK 或本地执行器。

## 推荐组织方式

一个完整 Agent 通常按以下顺序组装：

1. 创建 `ContextSystem`，注册 host context 和插件 context。
2. 准备模型配置。
3. 声明 MCP、Skills 和 Tools。
4. 通过 `defineAgent()` 或 `ExpertAgent.create()` 创建 Agent。
5. 创建 Runtime Session。
6. 调用 `session.submit()`，消费事件流和最终结果。
7. 在 `finally` 中调用 `session.abort()` 释放会话。
