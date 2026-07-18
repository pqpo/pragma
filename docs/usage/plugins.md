# Plugins 使用指南

本文说明 Pragma 插件的创建、加载和使用方式。插件用于给 `Expert` 扩展上下文、工具、模型配置、MCP、Skills 和生命周期 Hooks。

当前插件能力在：

```text
packages/core/src/plugins
```

关键 API：

```ts
import { definePluginEntry, readExpertAgentPluginManifest } from "@pragma/core";
```

## 插件能扩展什么

插件 `setup()` 可以返回：

- `mcp`
- `skills`
- `models`
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

构建后 `plugin.json` 的 `runtime.entry` 应指向可被 Node import 的 ESM 文件。Desktop 导入包必须把运行时依赖打入一个自包含 ESM entry。

## plugin.json

最小 manifest：

```json
{
  "schemaVersion": "pragma.plugin/v2",
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Adds custom context and tools.",
  "version": "0.0.0",
  "tags": ["context", "tools"],
  "runtime": {
    "type": "expert-agent-plugin",
    "entry": "./dist/index.js",
    "trust": "trusted-host"
  },
  "capabilities": [
    {
      "type": "context",
      "name": "my-plugin",
      "description": "Exposes plugin context."
    }
  ],
  "configuration": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "permissions": {
    "filesystem": [],
    "shell": [],
    "network": [],
    "environment": []
  }
}
```

支持字段：

- `schemaVersion`：当前为 `pragma.plugin/v2`。
- `id`：插件唯一 ID，也常作为 context namespace。
- `name`
- `description`
- `version`
- `tags`
- `runtime.type`
- `runtime.entry`
- `runtime.trust`：当前只能是 `trusted-host`，表示插件在宿主进程执行。
- `capabilities`
- `configuration`：JSON Schema 2020-12 对象 schema。
- `permissions`

`configuration.properties` 使用标准 JSON Schema 描述插件配置：

```json
{
  "type": "boolean",
  "description": "Enables plugin behavior.",
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
  createInMemoryContextStore,
  definePluginEntry,
  readExpertAgentPluginManifest,
} from "@pragma/core";

export default definePluginEntry({
  manifest: readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url)),
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

`definePluginEntry()` 要求显式传入已经校验的 manifest，不依赖调用栈或 bundle 位置猜测文件。

## setup 上下文

`setup(context)` 接收：

- `agent`：当前 Agent 的基本信息。
- `host`：宿主已经声明的 MCP、Skills、Models、Tools、Hooks 等。
- `contextSystem`：上下文系统，可注册插件 namespace。
- `workspaceRoot`：Agent workspace。
- `userConfig`：经过 manifest JSON Schema 校验的可序列化配置。
- `hostBindings`：宿主注入的 store、factory 等不可序列化依赖。
- `logger`：插件级 logger。

示例：读取配置并注册工具。

```ts
import { z } from "zod";
import { definePluginEntry, readExpertAgentPluginManifest } from "@pragma/core";

const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

export default definePluginEntry({
  manifest: readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url)),
  setup: (context) => {
    const config = ConfigSchema.parse(context.userConfig);

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
          // Runtime-level session id; do not use it as executionId or memory lifecycle id.
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

如果宿主工具和插件都声明了审批策略，会通过 `mergeExpertToolApprovals()` 合并，取更严格的模式。

## 在 Agent 中使用插件

### 使用 inline entry

适合测试、开发和 monorepo 内直接引用：

```ts
import { defineExpert } from "@pragma/core";
import myPlugin from "../plugins/my-plugin/src/index.ts";

const agent = await defineExpert({
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
      userConfig: {
        enabled: true,
      },
    },
  ],
});
```

### 使用预构建插件目录

适合产品化加载：

```ts
const agent = await defineExpert({
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
      userConfig: {
        enabled: true,
      },
    },
  ],
});
```

Core loader 会：

1. 检查宿主已经验证并展开的预构建插件目录。
2. 读取 `plugin.json`。
3. 按插件 ID 和版本复制到 Agent 缓存 `~/.pragma/cache/agents/<encoded-agent-id>/plugins/<encoded-plugin-id>/<encoded-version>/`。
4. import `runtime.entry`。

Core 不解压 ZIP、不安装依赖，也不执行 build 或 lifecycle script。Desktop Studio 负责 ZIP 静态校验、信任确认和原子安装；ZIP 必须是预构建的自包含 ESM 包。

默认加载策略是 fail-closed，任一插件失败都会抛出 `ExpertAgentPluginLoadError`。只有诊断工具显式传入 `pluginFailurePolicy: "collect"` 时，问题才会记录到：

```ts
agent.pluginLoadIssues;
```

## 插件配置和宿主依赖

插件通过 `userConfig` 接收可序列化配置，通过 `hostBindings` 接收 store、factory 等不可序列化宿主依赖。Core 不从环境变量隐式覆盖插件配置。

推荐规则：

- 普通配置放 `userConfig`，并必须通过 manifest JSON Schema。
- Secret 由宿主解析命名 binding 后放入 `userConfig`；使用 `"x-pragma-secret": true` 标记。
- store 和 factory 放 `hostBindings`，不进入 DSL、日志或环境指纹明文。

Desktop 将每个插件版本的默认配置独立保存到
`~/.pragma/state/plugins/<encoded-plugin-ref>/config.json`。文件只包含普通配置、secret binding
和更新时间；secret 明文仍统一加密保存在 `~/.pragma/state/plugin-credentials.json`。旧的共享
`~/.pragma/state/plugins/catalog.json` 不再读取或迁移。

`beforeSessionCreate` 可以返回声明式 `processEnvironment` 补丁。Core 为每个 Runtime Session
从 Runtime Adapter 的基础环境创建独立快照，合并插件补丁后再启动 Runtime 子进程；插件不得修改
`process.env`。Codex、Claude Code 和 PI Bash 命令均使用该 Session 快照。两个贡献者对同一环境变量
声明不同值时，Session 创建会 fail-closed。

Repo Manager 只负责 Git CLI 检查、Session 级认证和 Git 环境初始化，不提供 repository 元数据，
也不读取任何隐藏的 repository 清单协议。repository 引用由知识库或其他 Context Provider 提供。
其 Session 配置会覆盖当前 checkout 中的 credential helper 和 HTTP authorization header；SSH 未配置
`knownHosts` 时使用 Session 临时 `known_hosts` 文件和 `accept-new`，不会修改用户的 Git/SSH 配置。

插件是受信代码：`permissions` 是强制声明的审计信息，不是沙箱，也不会限制恶意插件。导入和激活用户插件等同于信任其在 Desktop Node 进程执行任意代码。

## Pragma DSL

Expert 通过精确版本引用宿主已经安装的插件。普通覆盖保存在 `config`，secret 只保存命名 binding：

```yaml
plugins:
  - ref: plugin:repo-manager@0.0.0
    config:
      auth:
        strategy: token
    secretBindings:
      auth.token: binding:plugin-secret-repo-manager
```

Desktop 按 manifest 默认值、Desktop 默认值、Expert 覆盖的顺序合并配置。配置必须使用 manifest 声明的字段，点分属性在 YAML 中写成嵌套对象。插件包、Desktop 默认值、Expert 覆盖和凭据修订都会写入 environment fingerprint。

## 内置与示例能力

当前仓库有一个记忆插件和一个插件示例：

```text
plugins/memory
plugins/repo-manager
```

`@pragma/plugin-memory`：

- 入口是一个 memory plugin，内部注册 `task-memory`、`experience-memory`、`fact-memory` 和 `skill-memory` 四个子模块。
- `Expert` 不会默认加载 memory plugin；需要记忆能力时，宿主必须通过 `plugins: [{ entry: memoryPlugin }]` 显式注入。
- `task-memory` 负责在插件内部维护 `Task Memory` store，并通过插件注入 task memory 工具。
- `experience-memory` 负责记录历史经历、操作过程和带证据的执行总结，并注入 experience memory 工具。
- `fact-memory` 负责维护稳定事实、置信度、冲突和失效信息，并注入 fact memory 工具。
- `task-memory`、`experience-memory` 和 `fact-memory` 默认都会持久化到用户目录 `~/.pragma/memories/` 下，接口仍然保持可替换，也支持通过程序化 `hostBindings` 注入自定义 store 或 `storeFactory`。
- 统一的 `memory` namespace 审计上下文暴露 `summary.md`、`skills/*.md`、`tasks/**`；默认所有产物都写到 `~/.pragma/memories/<agentId>/`，其中 skill card 写到 `<agentId>/skill-memory/skills/`。
- `skill-memory` 使用 stream / task / session hooks 生成任务总结、execution 总结和技能卡；`MemorySystem` 再把 task / fact / skill / experience 的摘要统一装配到 `memory` namespace 下的 `summary.md` 供 always-on 透出和后续检索使用。
- memory plugin 默认包含一条 promotion pipeline：`task -> experience -> fact/skill`。

如果要启用记忆能力，建议先读 [Memory System 使用指南](./memory.md)。

`repo-manager`：

- 在 Agent runtime session 创建前检查 Git CLI，并准备隔离的 Git 配置和认证环境。
- 在 session 销毁后清理临时凭据与配置。
- 不修改宿主 `process.env`、用户 `~/.gitconfig` 或 `~/.ssh`；不同 Expert 并发时使用独立的
  Runtime Session 环境和临时认证文件。
- 不读取或暴露仓库参考信息；仓库知识由知识库等独立上下文来源提供。

## 插件设计建议

- 插件 ID 应稳定，避免和保留 namespace 冲突，例如 `host`。
- 插件不要绕过 `ContextSystem` 直接修改 Agent 内部状态。
- 插件提供工具时必须明确 `inputSchema`。
- 文件、网络、删除、shell 等敏感操作应提供 tool approval。
- Hooks 用于横切能力，例如审计、可选插件扩展、策略检查，不要把核心业务流程藏进 hook。
- 插件应明确长期数据和会话数据的落盘边界；当前 memory plugin 默认使用用户目录 `~/.pragma/memories/`，而不是 workspace。
- 插件加载失败必须阻断正常 Agent 创建；诊断调用可显式使用 collect 策略读取 `pluginLoadIssues`。
