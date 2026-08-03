# ADR 035: Agent-driven Memory Recall and Host Governance

- Status: Accepted
- Date: 2026-08-03
- Extends: [ADR 031](./031-extensible-memory-plane.md)、[ADR 033](./033-layered-episodic-memory.md)、[ADR 034](./034-conservative-semantic-memory.md)

## Context

Memory 已经是分层 ContextStore：`guide.md` 和 `overview.md` 提供有界导航，Module 再提供 summary、index、
item 和 Evidence。此前阶段 4 仍计划增加 Host 侧 `MemoryRetrievalPlanner`，根据当前 prompt 派生 query、
排序并注入结果。这会制造第二个召回决策者，也会让 Agent 看不见 Host 使用了什么 query、为什么加入某条
记忆，并与现有通用 ContextStore 的模型按需加载语义重复。

产品仍需要可靠的授权、预算、审计和治理，但这些职责不要求 Host 理解用户 prompt 或替 Agent 判断相关性。

## Decision

召回决策完全属于正在执行的 Agent。Host 只挂载只读 `memory` ContextStore；Agent 先读取有界 overview，
需要时使用通用 `listContext`、`searchContext`、`readContext` 逐层进入 summary/index、item 和精确
Evidence。Host 不从 prompt 派生检索 query，不自动排序或注入隐藏结果，也不新增 `recall_memory` 专用工具。

所有通用 ContextStore 操作继续经过同一个 scope-bound Module 查询路径。Host 在查询前解析 root asset、
current Expert 和 Execution principal，执行 policy、revision binding 与 visibility 交集；普通 search 不返回
Evidence。跨 Module 搜索按轮询合并，避免注册顺序靠前的 Module 吞掉全部结果预算，但轮询不是相关性
planner，也不改变各 Module 自己返回结果的语义。

每个 Execution 保存独立 Memory activity 账本：capture 只记录 source event identity、结果与原因；recall
记录 invocation、操作、目标、结果引用、结果和原因。搜索只保存 query 的 SHA-256 digest 与字符数，不保存
原文。该账本用于 Mission 可见性和诊断，不用于下一次召回排序，也不复制 Memory 内容。

Episodic 与 Semantic revision binding 统一包含 `recall`、`export` 和 `permissionRevision`。治理 mutation 使用
revision CAS，只允许保持或收紧 binding/visibility；扩权必须由未来独立批准流程实现。invalidate 保留历史，
forget 删除当前内容、revision history 和孤立 Evidence，只保留不含 Memory 内容和原始治理理由的 tombstone，
同时清除该对象此前可能包含明文理由的 governance event。tombstone 是 forget 的唯一权威审计记录，并阻止
相同稳定 identity 被后台重放重建。

Desktop 增加一级 Memory 管理中心，展示 Module health、来源、provenance、binding、冲突、历史、精确
Evidence 以及收紧、修正、验证、失效和忘记操作。Mission 增加 Memory activity 视图，只展示 capture/recall
计数。Mission 删除时，对应 Execution activity 与其他 owner 状态一起进入带 journal 的回收站。

## Consequences

- Agent 能看见并控制自己的分层召回过程，不存在 Host 隐藏检索分支；
- Host 仍然是 scope、权限、预算、审计和数据生命周期的唯一执行边界；
- recall 审计可解释“做了什么和返回什么”，但不会持久化可能敏感的原始 query；
- 单个 Module 查询失败不会阻断其他 Module，跨 Module 配额不会被首个 Module 独占；
- 阶段 4 不提供语义向量排名、prompt query expansion、自动注入或专用 recall managed tool；
- 后续 Knowledge、Skill Candidate 和 CodeGraph Module 必须复用同一 Agent-driven ContextStore 模式。
