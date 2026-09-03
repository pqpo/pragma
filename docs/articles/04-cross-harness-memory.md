# 让经验跨 Harness 流动：从执行事件到长期记忆的沉淀与提炼

> 《构建跨 Harness 的多 Agent 系统：Pragma 技术实践》第四篇

很多 Agent 产品把 Memory 实现成“每隔几轮总结一次聊天记录”。这种方案能够减少上下文长度，却很难回答三个问题：总结依据是什么，冲突信息如何处理，以及一条记忆为什么值得在未来继续影响 Agent。

对于跨 Harness 的系统，问题更复杂。Codex、Claude Code、PI 和其他 Runtime 拥有不同的消息、工具与 Session 协议。如果每个 Runtime 各自总结历史，最终得到的是几套彼此隔离、无法共同治理的记忆。

Pragma 的选择是先统一执行事实，再从事实中生产 Memory：

```text
Canonical Event Feed
        ↓
versioned Evidence
        ↓
Episodic / Semantic Memory
        ↓
Knowledge / Skill Candidate
        ↓
Review、Revision 与 Evaluation
        ↓
权威知识库或 Capability
```

Memory 因此不是聊天记录的压缩层，而是一条证据驱动的知识生产管线。

## 第一步不是总结，而是建立事实来源

不同 Runtime 的原生输出先被 Core 归一化，并进入 Execution 的 Canonical Event Log。只有已经发生、需要恢复和审计的语义事实才进入持久日志，例如：

- Invocation 的创建与状态变化；
- 完整的 Agent Message；
- 工具调用及其语义结果；
- 子 Agent 委派和生命周期；
- HumanTask 与最终结果。

高频 token delta 只服务实时界面，不作为持久恢复来源，也不会被 Memory 当作独立事实反复消费。

Execution 提交 aggregate、事件和 durable handoff 后，Canonical Event Feed 再以全局 sequence 发布这些事件。Feed 支持 event id 幂等、按 Execution 顺序恢复和失败隔离。Memory 不需要读取每种 Harness 的私有 Session 目录，只消费同一种规范事件。

这条边界让经验可以跨 Harness 流动：来源可能是 Codex，也可能是 Claude Code，但进入 Memory 前都已经变成 Pragma 能理解和治理的事实。

## Evidence 是 Memory 的证据，不是 Memory 本身

`@pragma/memory` 首先把 Canonical Event 适配成带版本的 Evidence。Evidence 保存来源身份、关联资源、权限与有界内容，为后续 Module 提供可追溯输入。

这里必须避免一个看似细小、实际很重要的概念偷换：

```text
Evidence captured ≠ Memory generated
```

捕获了 100 条 Evidence，不代表成功形成了 100 条记忆。Evidence 可能被策略跳过、等待提炼、合并进已有记忆、因为权限受限而隔离，或者进入 `needs_attention`。

因此计数器、日志和 UI 必须使用准确阶段名称。后台任务失败后，可重试 Evidence 仍然保留；修复模型配置或升级应用后可以直接唤醒任务，不要求用户重跑原 Mission。

## 每种 Memory 独立消费 Feed

Pragma 没有在 Core 中维护一个不断膨胀的 Memory 类型联合。Memory Plane 通过静态注册的 Module SPI 扩展，每个 Module 拥有：

- 唯一的 Module id、版本和 Context prefix；
- 独立 checkpoint；
- 独立的 pending、retry、dead-letter 和健康状态；
- 自己的 Schema、Store 和提炼规则。

当前主要有两类长期动态记忆。

### Episodic Memory：发生过什么

Episode 描述一次有意义的经历，包括任务背景、采用的方法、结果、失败和恢复。它适合回答：

- 以前是否处理过相似任务？
- 当时采取了什么步骤？
- 哪个方法失败了，后来怎样恢复？

Episodic summary 是有界的，只保留少量近期入口；详细 Episode 通过 index 和 item 按需读取。

### Semantic Memory：目前认为是真的什么

Semantic Memory 保存可验证的 Fact，而不是任务叙事。它需要处理：

- 相同事实的重复观察；
- 排他事实之间的冲突；
- 置信度和时效；
- correction、verification 与 invalidation；
- 来源 Evidence 和修订历史。

事实不是一次提炼后永久正确。新的 Evidence 可能增强、替换或否定旧结论，因此 Semantic Store 采用稳定身份和不可变修订历史，而不是把新文本一直追加到一个 Markdown 文档中。

## 召回应当由 Agent 看得见

Memory 最容易变成一个隐藏的第二决策者：Host 从用户 Prompt 派生 query，向量检索几条结果，然后悄悄塞进系统 Prompt。Agent 不知道搜索了什么，也不知道某条记忆为什么出现。

Pragma 不采用这种隐藏注入。Host 把一个只读、联邦的 `memory` ContextStore 挂载给 Agent，Agent 先读取有界的 guide 和 overview，再根据任务使用通用的 `listContext`、`searchContext`、`readContext` 逐层进入 summary、index、item 和精确 Evidence。

Host 仍然控制：

- 当前 root asset、Expert 和 Execution principal；
- visibility、revision binding 与访问策略；
- 查询预算和跨 Module 配额；
- recall activity 审计。

但 Host 不替 Agent 判断相关性。搜索审计只保存 query 的 SHA-256 digest 和字符数，不保存可能敏感的原始 query。

## 权限只能保持或收紧

Memory 的提炼不能成为权限扩散通道。

如果 Evidence 只对某个 Expert 或某个受限范围可见，提炼出的 Episode、Fact 或候选知识不能自动获得更大的分享范围。普通治理操作只允许保持或收紧 binding/visibility；扩权必须经过独立批准。

Pragma 也区分 `invalidate` 和 `forget`：

- invalidate 保留历史，说明一条记忆当前不再有效；
- forget 删除正文、修订历史和孤立 Evidence，只保留不含内容的 tombstone，阻止同一稳定身份被后台重放重新生成。

这让“纠正一条记忆”和“真正遗忘一条记忆”成为两个不同的治理动作。

## Memory 不能直接修改权威知识库

动态 Memory 是可重新提炼的投影，不适合作为经过用户批准的长期知识权威。

当 Episode 或 Fact 值得升级为稳定知识时，Memory 只能产生 Knowledge Candidate。用户批准后，Host 将它物化为 Studio 托管的 Context Store。从这一刻开始：

```text
Memory 负责发现值得沉淀的变化
Context Store 负责权威内容和 Revision
Store Revision Agent 负责编辑并提交可审阅的稀疏草稿
用户批准负责激活新 Revision
```

知识库不会继续依赖原始 Evidence 才能读取，也不会与 Memory dual-write。后续新的记忆通过统一修订服务创建命名稀疏草稿，由内置 Store Revision Agent 使用原生 Context 工具修改 overlay；未修改内容仍路由到固定基线。批准时才生成最小 change set，并通过 revision 和 hash 双 CAS 原子应用；冲突不会静默覆盖现有知识。

知识库采用渐进披露结构：有界的 `guide.md`、`overview.md`、`index.md` 或分片索引负责导航，详细内容进入 `items/**`。系统不会把所有历史 Memory 合并成一个无限增长的巨型文档。

## Skill 的升级还需要 Evaluation

“知道一件事”和“掌握一种可复用能力”不是同一回事。Memory 可以发现重复出现的有效做法，并生成 Skill Candidate，但 Candidate 不能直接成为当前 Capability。

Pragma 把 Skill Revision 和 Skill Evaluation 建模为独立的内置 Agent 能力：

```text
Memory 提炼候选经验
        ↓
Skill Revision 生成候选变更
        ↓
Skill Evaluation 验证任务表现
        ↓
Host 审批并激活 Capability Revision
```

这形成了一个关键的治理原则：Agent 可以提出如何改进自己，但不能在没有验证和审批的情况下直接修改自己的生产能力。

## Mission Board 不是 Memory 的前置条件

Mission Board 中的 plan、decision 和 handoff 可以发布 Evidence，但 Memory 不能依赖 Agent 是否认真维护白板。

两者的职责不同：

- Mission Board 是当前 Mission 的短期协作权威；
- Memory 是从规范执行事实中产生的跨 Mission 动态投影；
- 经批准的 Knowledge Store 是长期知识权威；
- Capability Revision 是可运行 Skill 的权威。

清晰的权威切换比“所有东西都保存到记忆库”更重要。否则一个系统会同时存在聊天摘要、白板、向量库和知识文件四套彼此冲突的事实来源。

## 结语

跨 Harness Memory 的难点不在于选择哪一种向量数据库，而在于建立一条可信的知识生产链：

```text
事实是否可靠？
证据能否追溯？
不同类型的记忆如何独立演进？
冲突和遗忘如何治理？
权限是否被意外扩大？
动态经验何时转为权威知识或 Skill？
升级是否经过评测和审批？
```

当这些问题得到回答，Memory 才不只是节省上下文的缓存，而会成为工作方式不断积累和改进的基础设施。

## 延伸阅读

- [Memory 使用指南](../usage/memory.md)
- [ADR 索引](../adr/README.md)
- [可扩展 Memory Plane ADR](../adr/031-extensible-memory-plane.md)
- [Agent 驱动召回与治理 ADR](../adr/035-agent-driven-memory-recall-and-governance.md)
- [知识升级与 Store Revision ADR](../adr/039-promoted-knowledge-stores-and-agent-revision.md)
