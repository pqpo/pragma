# 002 - Memory System 分层与 Core 抽象

## 状态

Superseded by [ADR 031](./031-extensible-memory-plane.md).

本 ADR 保留为早期四类 Memory 语义模型的历史记录。ADR 031 删除 Task Memory 作为必需长期记忆类型，
将 Experience 与 Fact 重新定位为默认动态投影，并将 Knowledge、CodeGraph 定义为可扩展、版本化的
Memory type；Skill Candidate 经评测后升级为现有 Skill Capability。

## 背景

Pragma 当前已经有 `ContextSystem` 和内建 `skill-memory` 实现，但两者职责并不相同：

- `ContextSystem` 是通用 context substrate，按 namespace 暴露可读写上下文。
- `skill-memory` 是技能提炼与检索实现，产物是 skill card 和索引，不是统一记忆系统。

随着多 Agent 协作、任务状态同步、历史经验沉淀、稳定事实治理和技能积累需求出现，继续把所有记忆都塞进一个统一 context store 会带来几个问题：

- 不同记忆类型的生命周期和治理规则不同。
- 任务短期协作态和长期知识沉淀混在一起后，检索和清理策略会失控。
- 事实、经历、技能三类内容语义不同，后续冲突处理、晋升和失效规则无法清晰定义。
- 如果不把技能记忆提升为 core 内建子系统，默认加载和运行时检索边界会持续模糊。

## 决策

在 `ContextSystem` 之上引入新的 `Memory System` Core 抽象，并把记忆分为四种一等类型：

1. `Task Memory`
2. `Experience Memory`
3. `Fact Memory`
4. `Skill Memory`

`Memory System` 是 `@pragma/core` 的核心子系统，而不是仅靠插件约定存在的能力。

## 记忆类型定义

### Task Memory

用于单个 task / run / session 执行期内的短期工作记忆。

特点：

- 短期、高频读写。
- 支持 `shared` 和 `private` 两种可见性。
- `shared` 区域用于多 Agent 协作留言板、handoff、未决问题、进展同步。
- `private` 区域用于某个 Agent 的本地工作笔记。
- 任务结束后归档或晋升，不作为长期知识直接暴露。

### Experience Memory

用于记录“过去发生过什么”，是历史经历和证据的沉淀层。

特点：

- 来源真相以 runtime evidence 为主。
- 记录 run、session、对话、工具使用、失败路径、恢复路径和总结。
- 保留证据引用，不直接承担“稳定事实”或“推荐方法”的责任。
- 是事实记忆和技能记忆的主要上游。

### Fact Memory

用于保存经确认的稳定信息。

特点：

- 从第一版起就采用 evidence-based 治理。
- 每条 fact 必须带 provenance、confidence、observed/verified 时间和 freshness 元数据。
- 必须支持冲突、失效、supersede、review 语义。
- 回答“什么是真的”。

### Skill Memory

用于保存从经历中提炼出的可执行方法。

特点：

- 产物是可复用方法，而不是原始日志。
- 最低结构包括推荐路径、反模式、失败模式、恢复手册和证据引用。
- 回答“下次这种问题该怎么做”。

## 关系模型

四类记忆之间的默认演化链路为：

`Task Memory -> Experience Memory -> Fact Memory / Skill Memory`

说明：

- 任务期内的协作状态和笔记在归档后形成经历。
- 经历中的稳定结论可以晋升为事实。
- 经历中的可重复解法可以提炼为技能。
- 事实和技能都允许被新证据修订、降级或 supersede。

## 与现有系统的边界

### 与 ContextSystem 的边界

- `ContextSystem` 继续作为底层通用上下文 substrate。
- `Memory System` 是建立在其上的语义层和治理层。
- 不是所有 context 都是 memory，也不是所有 memory 都必须直接暴露为原始 context 文档。

### 与 ContextManager 的边界

- `ContextManager` 仍然负责最终 prompt 装配。
- `Memory System` 负责记忆检索、筛选和 runtime 注入候选。
- `ContextManager` 消费 `Memory System` 的 retrieval 结果，而不是自己推断所有记忆策略。

### 与 Directive Runtime 的边界

`Task Memory` 必须和现有协作运行时边界配合，但不吞并这些组件：

- `StateManager` 是状态事实源。
- `Mailbox` 是定向消息和事件通道。
- `Task Memory` 是共享/私有协作工作区。

这三者保持独立，但在协作运行时中被组合：

- 状态变化进入 `StateManager`
- 定向通知和命令进入 `Mailbox`
- 协作工作上下文进入 `Task Memory`

## 为什么不做成一个统一 record

不采用“一个通用 memory record + type 字段”的原因：

- 四类记忆在字段、治理、检索和生命周期上差异太大。
- 统一 record 会把高价值规则退化成弱约束注释。
- 后续事实冲突处理、技能提炼和任务归档流程会被迫挤进同一个抽象，边界变差。

因此采用：

- 统一的基础元数据模型
- 每类记忆独立 record schema
- 每类记忆独立 store interface
- 统一的 `MemorySystem` 作为聚合与检索入口

## 对 skill-memory 的影响

当前实现已经完成第一轮落位，`skill-memory` 作为 core 内建能力承担：

- 默认技能沉淀与检索。
- `skill-memory` namespace 的审计视图。
- 从 runtime evidence 提炼 skill card。

它仍然不是通用记忆系统，当前产出的 task/session summary 更适合作为 `Experience Memory` 的上游材料或 supporting evidence。

后续仍需补齐 `Task Memory`、`Experience Memory` 和 `Fact Memory`。

## 后果

正面影响：

- 记忆类型、生命周期和治理边界清晰。
- 后续实现任务记忆、经历记忆、事实记忆和技能记忆时，不需要依赖模糊插件约定。
- `skill-memory` 已经有稳定落点，后续其他记忆类型可以围绕同一套 `MemorySystem` 扩展。
- 多 Agent 协作的共享/私有短期记忆有稳定落点。

代价：

- `@pragma/core` 需要新增 memory 抽象和 runtime 集成点。
- 部分现有文档和上下文装配路径需要逐步更新。
- 后续具体实现仍需设计各类 memory store 的后端与 retention 策略。
