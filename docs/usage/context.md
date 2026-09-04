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

- `always_on`：每次运行都进入不可省略的 Always-on Manifest；正文按预算完整、部分或延迟加载
- `model_decision`：Expert 启动时把 context ID 和 description 加入可用索引，但不加载正文
- `manual`：默认值；不向 system prompt 自动注入 ID、description 或正文

所有 Store 在没有声明 `trigger` 时都必须归一化为 `manual`。模型可以把
`list_expert_context` 当作 `ls` 发现 ID 和 description，也可以通过
`search_expert_context` 按路径或正文搜索；知道 ID 后使用 `read_expert_context` 读取正文。
`ContextSystem` 为 `always_on` context 注入包含加载状态和续读提示的 Manifest，并为
`model_decision` context 注入 ID 和 description 索引。

`list_expert_context` 默认每页 20 条，可通过 `limit` 调整到最多 50 条；返回 `nextCursor` 时使用该
`cursor` 继续下一页。Search 结果受数量和字节预算约束，结果被省略时应缩小 query；搜索片段被截断时，
使用结果中的 namespace 与 ID 调用 `read_expert_context`。Read 默认按 8KB 分段，返回
`nextStartOffset` 时用它作为下一次 `start` 继续读取。

`add_expert_context` 成功后返回的是写入回执，不会回显完整正文。回执包含创建状态、namespace、ID、可用时的
`revision` 和 `etag`，以及持久化后正文的 UTF-8 `sizeBytes` 与 `sha256`。需要核验正文时，使用
`read_expert_context(namespace, id, start, offset)` 按需读取。`sha256` 是正文 UTF-8 字节的 SHA-256；
`revision` 则是 Store 提供的版本/并发控制标识，可能包含 metadata 或采用其他生成策略，二者不能互相替代。

`edit_expert_context(mode="replace")` 只替换调用中明确提供的 `content` 或 metadata 字段；省略的
`content`、`description`、`trigger` 和 `priority` 均保留现值。并发编辑时，从最近一次
`list_expert_context`、`read_expert_context` 或写入回执中复制 `revision` 到 `expectedRevision`，或复制
`etag` 到 `expectedEtag`。两者同时提供时必须同时匹配；冲突后应重新读取并基于最新 token 重试。

> **兼容性说明**：此前 `add_expert_context` 的 `details.context` 返回完整正文；自本版本起仅返回回执。
> 依赖旧格式的客户端应改用 `read_expert_context(namespace, id)` 获取正文。

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
- root 只覆盖其 namespace/path 命中的文档；没有匹配 root 的已注册 Store 仍按文档自身 `trigger` 装配

## Store、预算与失败语义

- `ContextStore` 决定 ID 的实际含义和授权策略；数据库 Store 可以在查询或事务中使用 run context 做租户与权限裁决。
- `FileSystemContextStore` 默认发现 Markdown，可通过 `include` / `exclude` 显式开放其他 UTF-8 文本，并拒绝 root 外真实路径和 symlink 逃逸。
- 每个适用的 `always_on` context 都进入 Agent prompt 的 Manifest；`model_decision` context 进入 ID 和 description 索引；其他 context 通过 list/search 发现。
- `systemPromptCharacterBudget` 限制身份、Context System 使用规则和完整 Always-on Manifest；默认 16,000-byte 的 `preloadByteBudget` 只限制 preload 正文。
- Manifest 无法完整装入 system prompt 时装配显式失败；正文为 partial/deferred 时按其中的 `read_expert_context` 提示续读。
- required Store 索引失败或任何已选 preload 读取失败会终止 session 创建；optional Store 失败进入 Context Snapshot issues。
- Context 写工具默认需要显式人工审批，Store 授权仍是独立且不可替代的边界。

## 相关文档

- [Context 配置示例](./context-examples.md)
- [Agent 使用指南](./agents.md)
- [专家 Agent 标准协议详细设计](../architecture/expert-agent-standard-protocol.md)
