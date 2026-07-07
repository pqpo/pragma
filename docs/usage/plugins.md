# Plugins 使用指南

本文说明 Pragma 插件的创建、加载和使用方式。插件用于给 `ExpertAgent` 扩展上下文、工具、模型配置、MCP、Skills、SubAgents 和生命周期 Hooks。

当前插件能力在：

```text
packages/core/src/plugins
```

关键 API：

```ts
import {
  definePluginEntry,
  createExpertAgentPluginConfigEnvName,
} from "@pragma/core";
```

## 插件能扩展什么

插件 `setup()` 可以返回：

- `mcp`
- `skills`
- `models`
- `subAgents`
- `tools`
- `toolApprovals`
- `hooks`

插件也可以通过 `context.contextSystem.register()` 注册自己的上下文 namespace。

## 插件目录结构

推荐插件结构：

```text
plugins/my-plugin/
  plugin.json
  package.json
  src/
    index.ts
    schema.ts
  tsconfig.json
```

构建后 `plugin.json` 的 `runtime.entry` 应指向可被 Node import 的 ESM 文件，通常是 `./dist/index.js`。

## plugin.json

最小 manifest：

```json
{
  "schemaVersion": "pragma.plugin/v1",
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Adds custom context and tools.",
  "version": "0.0.0",
  "tags": ["context", "tools"],
  "runtime": {
    "type": "expert-agent-plugin",
    "entry": "./dist/index.js"
  },
  "capabilities": [
    {
      "type": "context",
      "name": "my-plugin",
      "description": "Exposes plugin context."
    }
  ],
  "configuration": {
    "properties": []
  }
}
```

支持字段：

- `schemaVersion`：当前为 `pragma.plugin/v1`。
- `id`：插件唯一 ID，也常作为 context namespace。
- `name`
- `description`
- `version`
- `tags`
- `runtime.type`
- `runtime.entry`
- `capabilities`
- `configuration.properties`
- `required_config`

`configuration.properties` 用来描述插件配置：

```json
{
  "name": "enabled",
  "type": "boolean",
  "description": "Enables plugin behavior.",
  "required": false,
  "default": true
}
```

支持类型：

```text
string
number
boolean
object
array
```

## 定义插件入口

插件入口必须 default export `definePluginEntry(...)`。

```ts
import {
  definePluginEntry,
  createInMemoryContextStore,
} from "@pragma/core";

export default definePluginEntry({
  setup: (context) => {
    context.contextSystem.register({
      namespace: "my-plugin",
      store: createInMemoryContextStore({
        context: [
          {
            id: "intro.md",
            content: "Context from my plugin.",
            metadata: {
              description: "Plugin introduction.",
              trigger: "model_decision",
              trustLevel: "workspace",
              sensitivity: "internal",
            },
          },
        ],
      }),
    });

    return {};
  },
});
```

`definePluginEntry()` 会从调用方附近读取 `plugin.json`，并把 manifest 信息绑定到插件 entry。

## setup 上下文

`setup(context)` 接收：

- `agent`：当前 Agent 的基本信息。
- `host`：宿主已经声明的 MCP、Skills、Models、Tools、Hooks 等。
- `contextSystem`：上下文系统，可注册插件 namespace。
- `workspaceRoot`：Agent workspace。
- `env`：环境变量。
- `config`：插件配置。
- `logger`：插件级 logger。

示例：读取配置并注册工具。

```ts
import { z } from "zod";
import { definePluginEntry } from "@pragma/core";

const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

export default definePluginEntry({
  setup: (context) => {
    const config = ConfigSchema.parse(context.config ?? {});

    if (!config.enabled) {
      return {};
    }

    return {
      tools: [
        {
          name: "plugin_echo",
          description: "Echo input text.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
            additionalProperties: false,
          },
          call: async (args) => ({
            text: String((args as { text?: string }).text ?? ""),
          }),
        },
      ],
    };
  },
});
```

## 插件 Hooks

插件可以返回生命周期 hooks：

```ts
export default definePluginEntry({
  setup: () => ({
    hooks: {
      beforeSessionCreate: async (context) => {
        context.logger?.info("Before session create");
      },
      afterSessionCreate: async (context) => {
        context.logger?.info("After session create", {
          systemSessionId: context.session.systemSessionId,
        });
      },
      beforeTaskSubmit: async (context) => {
        context.logger?.info("Before task submit", {
          runId: context.runId,
        });
      },
      afterTaskSubmit: async (context) => {
        context.logger?.info("After task submit", {
          hasResult: context.result !== undefined,
          hasError: context.error !== undefined,
        });
      },
      beforeToolCall: async (context) => {
        context.logger?.info("Before tool call", {
          toolName: context.toolName,
        });
      },
      afterToolCall: async (context) => {
        context.logger?.info("After tool call", {
          toolName: context.toolName,
          durationMs: context.durationMs,
        });
      },
    },
  }),
});
```

当前 hook 类型：

- `beforeSessionCreate`
- `afterSessionCreate`
- `beforeTaskSubmit`
- `afterTaskSubmit`
- `beforeSessionDestroy`
- `afterSessionDestroy`
- `beforeToolCall`
- `afterToolCall`

## 插件贡献 Tool Approval

插件可以给宿主已有工具追加审批策略：

```ts
export default definePluginEntry({
  setup: () => ({
    toolApprovals: [
      {
        toolName: "delete_workspace_note",
        approval: {
          mode: "required",
          reason: "Plugin policy requires approval before deletion.",
        },
      },
    ],
  }),
});
```

如果宿主工具和插件都声明了审批策略，会通过 `mergeExpertAgentToolApprovals()` 合并，取更严格的模式。

## 在 Agent 中使用插件

### 使用 inline entry

适合测试、开发和 monorepo 内直接引用：

```ts
import { defineAgent } from "@pragma/core";
import myPlugin from "../plugins/my-plugin/src/index.ts";

const agent = await defineAgent({
  id: "plugin-agent",
  name: "Plugin Agent",
  description: "Uses inline plugin entry.",
  tags: ["plugin"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  plugins: [
    {
      entry: myPlugin,
      config: {
        enabled: true,
      },
    },
  ],
});
```

### 使用插件目录或 zip

适合产品化加载：

```ts
const agent = await defineAgent({
  id: "installed-plugin-agent",
  name: "Installed Plugin Agent",
  description: "Loads plugin from source path.",
  tags: ["plugin"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  plugins: [
    {
      source: "/path/to/plugins/my-plugin",
      config: {
        enabled: true,
      },
    },
  ],
});
```

插件 loader 会：

1. 检查插件目录或 zip。
2. 读取 `plugin.json`。
3. 复制到 workspace 下的 `.pragma/agent/plugins/{pluginId}`。
4. 安装插件依赖。
5. 如果插件有 `build` script，则执行 build。
6. import `runtime.entry`。

加载问题会记录到：

```ts
agent.pluginLoadIssues
```

## 插件配置和环境变量

插件可以通过 `config` 直接接收配置，也可以使用环境变量。

环境变量名可以通过工具函数生成：

```ts
const envName = createExpertAgentPluginConfigEnvName({
  pluginId: "my-plugin",
  name: "apiKey",
});

// PRAGMA_PLUGIN_MY_PLUGIN_API_KEY
```

推荐规则：

- 普通配置放 `config`。
- Secret 从 `env` 读取。
- `plugin.json` 中把 secret 配置标记为 `"secret": true`。

## 内置与示例能力

当前仓库有一个记忆插件和一个插件示例：

```text
plugins/memory
plugins/code-repository-manager
```

`@pragma/plugin-memory`：

- 入口是一个 memory plugin，内部注册 `task-memory`、`experience-memory`、`fact-memory` 和 `skill-memory` 四个子模块。
- `ExpertAgent` 默认会加载这四类记忆；只有在需要覆盖默认行为时，才需要显式传 memory 配置或自定义 plugin use。
- `task-memory` 负责在插件内部维护 `Task Memory` store，并通过插件注入 task memory 工具。
- `experience-memory` 负责记录历史经历、操作过程和带证据的执行总结，并注入 experience memory 工具。
- `fact-memory` 负责维护稳定事实、置信度、冲突和失效信息，并注入 fact memory 工具。
- `task-memory`、`experience-memory` 和 `fact-memory` 默认都会持久化到用户目录 `~/.pragma/memories/` 下，接口仍然保持可替换，也支持在程序化 plugin config 中注入自定义 store 或 `storeFactory`。
- `skill-memory` 负责注册 `skill-memory` namespace 的审计上下文：`summary.md`、`skills/*.md`、`tasks/**`。
- `skill-memory` 使用 stream / task / session hooks 生成任务总结、session 总结和技能卡，并注册到插件内部的 memory system 供后续检索使用。
- memory plugin 默认包含一条 promotion pipeline：`task -> experience -> fact/skill`。

如果只是使用默认 Agent 能力，建议先读 [Memory System 使用指南](./memory.md)。

`code-repository-manager`：

- 暴露仓库元数据上下文。
- 提供仓库管理相关能力。
- 可作为代码仓库上下文插件参考。

## 插件设计建议

- 插件 ID 应稳定，避免和保留 namespace 冲突，例如 `host`。
- 插件不要绕过 `ContextSystem` 直接修改 Agent 内部状态。
- 插件提供工具时必须明确 `inputSchema`。
- 文件、网络、删除、shell 等敏感操作应提供 tool approval。
- Hooks 用于横切能力，例如审计、可选插件扩展、策略检查，不要把核心业务流程藏进 hook。
- 插件应明确长期数据和会话数据的落盘边界；当前 memory plugin 默认使用用户目录 `~/.pragma/memories/`，而不是 workspace。
- 插件加载失败不应该让 Agent 创建过程不可解释，错误应进入 `pluginLoadIssues`。
