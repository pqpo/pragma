# Context 使用指南

本文说明当前 Pragma `ContextSystem` 的核心模型，以及 `trigger`、`preloadPaths` 和 `forbiddenLoad` 的区别。

## 核心原则

当前 context 模型分成两层：

- 文档 metadata：描述“默认怎么加载”
- root 装配规则：描述“这个专家在这个 root 下额外怎么预加载或屏蔽路径”

推荐把它理解成：

- `trigger`：加载策略
- `preloadPaths`：root 级强制预加载覆盖
- `forbiddenLoad`：root 级禁止加载规则

## 文档 metadata

每份 context 文档都可以声明 metadata：

```yaml
---
description: 订单领域概览
trigger: model_decision
trustLevel: workspace
sensitivity: internal
---
```

当前支持的 `trigger`：

- `always_on`：每次运行都预加载
- `model_decision`：默认只进索引，是否读取正文由模型或后续显式读取决定
- `manual`：默认不自动加载，通常依赖人工或外部策略触发

- `trigger` 回答“怎么加载”

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
      },
    },
  ],
});
```

字段语义：

- `path`：限制这个 root 只包含某个目录下的文档
- `preloadPaths`：不看文档本身的 `trigger`，这些路径每次运行都要预加载
- `forbiddenLoad`：这些路径禁止被默认装配规则选中

优先级：

1. `forbiddenLoad`
2. `preloadPaths`
3. 文档自己的 `trigger`

## 什么时候用哪一个

### 用 `trigger`

当“是否默认加载”是文档自己的固有属性时，用 `trigger`。

典型场景：

- `AGENTS.md`
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
          "context/order-domain-expert/profile.md",
          "context/order-domain-expert/safety.md",
        ],
        forbiddenLoad: ["context/order-domain-expert/archive/**"],
      },
    },
  ],
});
```

运行效果：

- `AGENTS.md` 会按特殊规则视为 `always_on`
- `index.md` 只是普通 `model_decision` 文档，不会自动预加载
- `profile.md` 和 `safety.md` 会因为 `preloadPaths` 被预加载
- `archive/**` 会被排除

## 推荐约定

- 不要把“入口页”语义编码到 root 字段里
- 不要把所有重要文档都标成 `always_on`
- 优先让文档通过 `trigger` 表达默认行为，只有专家装配需要覆盖时才用 `preloadPaths`

## 相关文档

- [Context 配置示例](./context-examples.md)
- [Agent 使用指南](./agents.md)
- [专家 Agent 标准协议详细设计](../architecture/expert-agent-standard-protocol.md)
