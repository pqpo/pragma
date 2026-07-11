# Context 使用指南

本文说明当前 Pragma `ContextSystem` 的核心模型，以及加载规则、通用优先级和 Store 边界。

## 核心原则

当前 context 模型分成两层：

- 文档 metadata：描述“默认怎么加载”
- root 装配规则：描述“这个专家在这个 root 下额外怎么预加载或屏蔽路径”

推荐把它理解成：

- `trigger`：加载策略
- `preloadPaths`：root 级强制预加载覆盖
- `forbiddenLoad`：root 级禁止加载规则
- `priority`：通用装配和预算保留优先级

## 文档 metadata

每份 context 文档都可以声明 metadata：

```yaml
---
description: 订单领域概览
trigger: model_decision
trustLevel: workspace
sensitivity: internal
priority: normal
---
```

当前支持的 `trigger`：

- `always_on`：每次运行都预加载正文
- `model_decision`：Expert 启动时把 context ID 和 description 加入可用索引，但不加载正文
- `manual`：默认值；不向 system prompt 自动注入 ID、description 或正文

所有 Store 在没有声明 `trigger` 时都必须归一化为 `manual`。模型可以把
`list_expert_context` 当作 `ls` 发现 ID 和 description，也可以通过
`search_expert_context` 按路径或正文搜索；知道 ID 后使用 `read_expert_context` 读取正文。
`ContextSystem` 只为 `model_decision` context 注入 ID 和 description 索引。

- `trigger` 回答“怎么加载”
- `priority` 支持 `critical`、`high`、`normal`、`low`；高优先级先装配，预算不足时最后截断

## Root 装配规则

`ContextSystem` 的 root 配置只保留路径级装配规则：

```ts
const contextSystem = new ContextSystem({
  store,
  roots: [
    {
      namespace: HOST_CONTEXT_NAMESPACE,
      path: "manuals",
      load: {
        preloadPaths: ["manuals/profile.md", "manuals/safety.md"],
        forbiddenLoad: ["manuals/archive/**"],
        priorityRules: [{ pattern: "manuals/safety.md", priority: "critical" }],
      },
    },
  ],
});
```

字段语义：

- `path`：限制这个 root 只包含某个目录下的文档
- `preloadPaths`：不看文档本身的 `trigger`，这些路径每次运行都要预加载
- `forbiddenLoad`：这些路径禁止被默认装配规则选中
- `priorityRules`：按路径覆盖文档的通用 priority

优先级：

1. `forbiddenLoad`
2. `preloadPaths`
3. 文档自己的 `trigger`

## 什么时候用哪一个

### 用 `trigger`

当“是否默认加载”是文档自己的固有属性时，用 `trigger`。

典型场景：

- 安全规则
- 全局约束
- 常驻专家画像

### 用 `preloadPaths`

当某个专家在某个 root 下需要额外强制带上几份文档时，用 `preloadPaths`。

典型场景：

- 订单专家每次都需要 `profile.md`
- 安全敏感专家每次都需要 `safety.md`
- 某些文档本身不是 `always_on`，但当前专家装配必须带上

## 一个完整示例

目录：

```text
context/order-domain-expert/
  AGENTS.md
  index.md
  profile.md
  safety.md
  rules/refund.md
  archive/old-decision.md
```

`index.md`：

```md
---
description: 订单知识目录总览
trigger: model_decision
---
```

`profile.md`：

```md
---
description: 订单专家画像
trigger: manual
---
```

root 配置：

```ts
const contextSystem = new ContextSystem({
  store,
  roots: [
    {
      namespace: HOST_CONTEXT_NAMESPACE,
      path: "context/order-domain-expert",
      load: {
        preloadPaths: [
          "context/order-domain-expert/AGENTS.md",
          "context/order-domain-expert/profile.md",
          "context/order-domain-expert/safety.md",
        ],
        forbiddenLoad: ["context/order-domain-expert/archive/**"],
        priorityRules: [
          { pattern: "context/order-domain-expert/AGENTS.md", priority: "critical" },
          { pattern: "context/order-domain-expert/safety.md", priority: "critical" },
        ],
      },
    },
  ],
});
```

运行效果：

- `AGENTS.md` 没有 ID 特判；这里因为 `preloadPaths` 和 `priorityRules` 被作为高优先级上下文装配
- `index.md` 是 `model_decision` 文档，启动时只暴露 ID 和 description，不自动预加载正文
- `profile.md` 和 `safety.md` 会因为 `preloadPaths` 被预加载
- `archive/**` 会被排除

## 推荐约定

- 不要把“入口页”语义编码到 root 字段里
- 不要把所有重要文档都标成 `always_on`
- 优先让文档通过 `trigger` 表达默认行为，只有专家装配需要覆盖时才用 `preloadPaths`
- `AGENTS.md`、安全规则等重要内容使用通用 preload 和 priority 配置，不依赖文件名隐式语义

## Store、预算与失败语义

- `ContextStore` 决定 ID 的实际含义和授权策略；数据库 Store 可以在查询或事务中使用 run context 做租户与权限裁决。
- `FileSystemContextStore` 默认发现 Markdown，可通过 `include` / `exclude` 显式开放其他 UTF-8 文本，并拒绝 root 外真实路径和 symlink 逃逸。
- 只有 `model_decision` context 的 ID 和 description 自动进入 Agent prompt；其他 context 通过 list/search 发现，通过 read 按 ID 读取。
- `systemPromptCharacterBudget` 限制身份和 Context System 使用规则；`preloadByteBudget` 限制全部 preload 正文的 UTF-8 字节总量。
- required Store 索引失败或任何已选 preload 读取失败会终止 session 创建；optional Store 失败进入 Context Snapshot issues。
- Context 写工具默认需要显式人工审批，Store 授权仍是独立且不可替代的边界。

## 相关文档

- [Context 配置示例](./context-examples.md)
- [Agent 使用指南](./agents.md)
- [专家 Agent 标准协议详细设计](../architecture/expert-agent-standard-protocol.md)
