# Memory System 使用指南

本文专门说明 Pragma 当前的 Memory System：四类记忆的定义、默认加载方式、关闭方式、工具入口，以及它们之间的演化关系。

当前记忆系统由 `@pragma/plugin-memory` 提供具体实现，但对使用者来说，`ExpertAgent` / `defineAgent()` 已经会在初始化时默认加载这套能力。

## 四类记忆

当前 Memory System 有四种一等类型：

1. `Task Memory`
2. `Experience Memory`
3. `Fact Memory`
4. `Skill Memory`

默认演化链路：

```text
Task Memory -> Experience Memory -> Fact Memory / Skill Memory
```

它们回答的问题不同：

- `Task Memory`：当前这轮任务里还要记住什么、谁在做什么、还有哪些待办。
- `Experience Memory`：过去发生过什么、做过什么、结果如何。
- `Fact Memory`：当前确认什么是真的。
- `Skill Memory`：下次遇到类似问题，推荐怎么做。

## 默认加载

现在 `ExpertAgent.create()` 和 `defineAgent()` 默认会加载四类记忆。

最小示例：

```ts
import { defineAgent } from "@pragma/core";

const agent = await defineAgent({
  id: "memory-enabled-agent",
  name: "Memory Enabled Agent",
  description: "Uses the default memory system.",
  tags: ["memory"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
});
```

默认加载后：

- `task-memory`、`experience-memory`、`fact-memory` 会注入工具。
- `skill-memory` 会注册统一的 `memory` 上下文 namespace。
- 任务归档和经历写入会触发默认晋升规则。
- 四类记忆默认都会持久化到用户目录下的 `~/.pragma/memories/`，不会直接写入 agent workspace。
- `task-memory` 虽然语义上仍然是 task / run / session 内的短期工作记忆，但默认也会落盘，以支持 session 恢复和跨进程恢复。

## 关闭全部记忆

如果不希望默认加载任何记忆类型：

```ts
const agent = await defineAgent({
  id: "stateless-agent",
  name: "Stateless Agent",
  description: "Runs without the default memory system.",
  tags: ["memory"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  memory: false,
});
```

这会关闭四类默认记忆，不注入相关工具，也不注册 `memory` 上下文。

## 按类别关闭

如果只想关闭其中一个或多个类别：

```ts
const agent = await defineAgent({
  id: "selective-memory-agent",
  name: "Selective Memory Agent",
  description: "Disables selected memory categories.",
  tags: ["memory"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  memory: {
    experience: false,
    fact: false,
  },
});
```

当前支持的字段：

- `memory.task`
- `memory.experience`
- `memory.fact`
- `memory.skill`

每项都可以写成：

```ts
memory: {
  fact: false,
}
```

或：

```ts
memory: {
  fact: {
    enabled: false,
  },
}
```

## 四类记忆的边界

### Task Memory

用于当前 task / run / session 内的短期工作记忆。

典型内容：

- handoff
- decision
- note
- todo
- progress
- question

### Experience Memory

用于记录“过去发生过什么”，强调经历和证据，而不是稳定真相。

典型内容：

- 历史任务
- 对话总结
- 工具使用过程
- 失败路径
- 恢复路径
- 某次代码搜索过程

### Fact Memory

用于记录“被确认的稳定信息”，强调真值、证据、时效和治理。

典型内容：

- 用户偏好
- 业务规则
- 系统架构归属
- 代码模块归属
- 某对象当前是什么

事实记忆必须带：

- `statement`
- `confidence`
- `observedAt`
- `provenance.evidence`

并支持：

- `verifiedAt`
- `reviewAt`
- `expiresAt`
- `invalidatedAt`
- `supersededBy`
- `conflictsWith`

### Skill Memory

用于沉淀从经历中提炼出的可复用方法。

典型内容：

- 推荐路径
- good practices
- anti-patterns
- failure modes
- recovery playbook

## “代码在哪个路径下”属于哪种记忆

这是 Memory System 里最容易混淆的一类边界。

- “我刚才搜索了 `packages/core/src/loop`”是 `Experience Memory`
- “搜索过程中试过这些路径，但其中两个是错的”是 `Experience Memory`
- “`@pragma/core` 的 loop 代码当前位于 `packages/core/src/loop`”是 `Fact Memory`
- “下次找 loop runtime，先看 `packages/core/src/loop`，再看 `docs/usage/loops.md`”是 `Skill Memory`

判断标准不是“内容里有没有路径”，而是它在回答哪个问题：

- 记录过程：`Experience`
- 确认真相：`Fact`
- 总结方法：`Skill`

## 默认工具

默认启用时，当前工具层大致包括：

### Task Memory Tools

- `list_task_memory`
- `get_task_memory`
- `append_task_memory`
- `patch_task_memory`

### Experience Memory Tools

- `list_experience_memory`
- `get_experience_memory`
- `append_experience_memory`

### Fact Memory Tools

- `list_fact_memory`
- `get_fact_memory`
- `write_fact_memory`
- `update_fact_memory`

Skill Memory 当前主要通过 `memory` namespace 上下文和 runtime hooks 体现，不以单独工具为主。

## Always-On Summary

`memory/summary.md` 现在由统一 `MemorySystem` 组装成一份给模型看的 memory guide，而不是把四类 memory 的 record 摘要平铺进上下文。

当前 always-on 文档重点包括：

1. `Current Task State`
2. `Active Constraints And Preferences`
3. `Skill Entry Points`
4. `Memory Search Guide`
5. `Searchable Domains`

其中：

- `Task Memory` 直接以内联状态快照方式暴露
- `Fact Memory` 只内联当前最重要、当前生效的事实与偏好
- `Skill Memory` 主要暴露 skill domain catalog 和少量高价值入口
- `Experience Memory` 主要暴露检索指南和极少量 recent entry points

`summary` 现在是 memory system 的内部派生字段，不再由外部 tool 调用方传入。系统会根据各类型的结构化字段 deterministic 生成它，并用于：

- runtime 检索
- promotion pipeline
- `memory/summary.md`

## 自动晋升

当前默认有一条 deterministic promotion pipeline：

1. 已归档或已解决的 `Task Memory` 会尝试晋升为 `Experience Memory`
2. `Experience Memory` 会根据规则尝试晋升为 `Fact Memory` 或 `Skill Memory`

当前规则重点是：

- 没有 evidence 的经历不会自动升 fact
- 明显时效性强的信息不会自动升 fact
- 带稳定结构结论的经历可以升 fact
- 带“推荐做法 / next time / recommended”信号的经历可以提炼成 skill

## 相关文件

- [Agent 使用指南](./agents.md)
- [Plugins 使用指南](./plugins.md)
- [Memory System ADR](../adr/002-memory-system.md)
- [Agent Core 架构说明](../architecture/agent-core-architecture.md)
