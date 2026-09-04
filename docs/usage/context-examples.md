# Context 配置示例

本文提供当前 context 模型的可复制示例。

## 最小 In-Memory ContextSystem

```ts
import { ContextSystem, HOST_CONTEXT_NAMESPACE, createInMemoryContextStore } from "@pragma/core";

const contextSystem = new ContextSystem({
  store: createInMemoryContextStore({
    context: [
      {
        id: "project.md",
        content: "Pragma 是一个多专家 Agent 编排系统。",
        metadata: {
          description: "项目背景",
          trigger: "always_on",
          trustLevel: "workspace",
          sensitivity: "internal",
          priority: "high",
        },
      },
    ],
  }),
});
```

## 目录总览 + 专家画像

```ts
import { ContextSystem, HOST_CONTEXT_NAMESPACE, createInMemoryContextStore } from "@pragma/core";

const contextSystem = new ContextSystem({
  store: createInMemoryContextStore({
    context: [
      {
        id: "manuals/index.md",
        content: "这里是 manuals 的总览。",
        metadata: {
          trigger: "model_decision",
        },
      },
      {
        id: "manuals/profile.md",
        content: "专家画像。",
        metadata: {
          trigger: "manual",
        },
      },
      {
        id: "manuals/safety.md",
        content: "安全规则。",
        metadata: {
          trigger: "manual",
        },
      },
    ],
  }),
  roots: [
    {
      namespace: HOST_CONTEXT_NAMESPACE,
      path: "manuals",
      load: {
        preloadPaths: ["manuals/profile.md", "manuals/safety.md"],
        priorityRules: [{ pattern: "manuals/safety.md", priority: "critical" }],
      },
    },
  ],
});
```

这个例子的含义：

- `index.md` 默认只进入索引，不会自动预加载
- `profile.md` 和 `safety.md` 会因为 `preloadPaths` 被预加载

## 文件系统示例

假设目录结构：

```text
workspace/
  AGENTS.md
  context/
    order/
      index.md
      profile.md
      safety.md
      rules/refund.md
      archive/old.md
```

`context/order/index.md`：

```md
---
description: 订单知识目录
trigger: model_decision
---

- profile.md：专家画像
- safety.md：风险边界
- rules/refund.md：退款规则
```

`context/order/profile.md`：

```md
---
description: 订单专家画像
trigger: manual
---
```

代码：

```ts
import { ContextSystem, HOST_CONTEXT_NAMESPACE } from "@pragma/core";
import { FileSystemContextStore } from "@pragma/context-filesystem";

const contextSystem = new ContextSystem({
  store: new FileSystemContextStore({
    rootDir: "/path/to/workspace/context/order",
    include: ["*.md", "**/*.md", "*.txt"],
    exclude: ["archive/**"],
  }),
  roots: [
    {
      namespace: HOST_CONTEXT_NAMESPACE,
      path: "",
      load: {
        preloadPaths: ["profile.md", "safety.md"],
        forbiddenLoad: ["archive/**"],
        priorityRules: [{ pattern: "safety.md", priority: "critical" }],
      },
    },
  ],
});
```

## 插件注册独立 namespace

```ts
import { createInMemoryContextStore, definePluginEntry } from "@pragma/core";

export default definePluginEntry({
  setup: (context) => {
    context.contextSystem.register({
      namespace: "order-plugin",
      store: createInMemoryContextStore({
        context: [
          {
            id: "glossary.md",
            content: "订单领域术语表。",
            metadata: {
              trigger: "model_decision",
            },
          },
        ],
      }),
    });

    return {};
  },
});
```

## 搜索与读取示例

```ts
await agent.listContext();

await agent.readContext({
  namespace: "host",
  id: "manuals/index.md",
});

await agent.searchContext({
  query: "refund",
  scope: "content",
});

await agent.searchContext({
  query: "manuals/*.md",
  scope: "path",
  caseSensitive: false,
});
```

## 选型建议

- 想表达“默认怎么加载”：用 `trigger`
- 想表达“当前专家每次必须带上这些路径”：用 `preloadPaths`
- 想表达“这些路径不该进入默认装配”：用 `forbiddenLoad`
- 想表达“更靠前且更晚被预算截断”：用 `priority` 或 root `priorityRules`
- Context ID 不要求 `.md`；FileSystem Store 只访问显式 include 且未 exclude 的 UTF-8 文本
