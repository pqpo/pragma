# Memory 使用指南

Pragma 的新 Memory Plane 是 Desktop 内置能力，随应用启动，不需要环境变量，也不需要给 Expert 安装
插件。架构决策见 [ADR 031](../adr/031-extensible-memory-plane.md)，分阶段范围见
[Memory Plane 落地计划](../architecture/memory-plane-implementation-plan.md)。

## 当前已经可用的能力

当前已完成 Memory Plane 基础设施、策略、Episodic Memory、Semantic Memory、Knowledge Memory 和治理管理中心：

- Execution 语义事件通过持久 Canonical Event Feed 交给 Memory Plane；
- Memory Evidence 自动记录 root Expert/ExpertTeam/Flow 与实际 producer Expert；
- 每个 Memory Module 可以独立消费、重试、保存 checkpoint 和发布派生事件；
- 联邦 `memory` ContextStore 可以按 Module prefix 路由只读内容；
- Desktop 设置页可以控制全局 capture、recall、learning，并查看 Feed 容量、安全 checkpoint、固定保留
  策略、Evidence 截断、dead letter 和提炼失败；
- Expert、ExpertTeam、Flow 编辑页可以继承或收紧全局策略。
- Execution 终态会创建持久提炼任务，由隐藏 Memory Curator 生成目标、尝试、失败、恢复和结果；
- 普通 Expert、ExpertTeam 和 Flow 内 Expert 会加载有界 Memory guide、类型摘要与热点索引；
- 独立 Expert 只能看到自己的 Episode；Team/Flow 内 Expert 看到当前 Team/Flow Episode 与自己的个人
  Episode，不会混入其他专家或其他团队资产；
- 模型通过 `memory/episodic/items/**` 按需读取详情，需要核验时再读取精确 Evidence 引用。
- 独立 Semantic Module 会提炼当前事实、偏好和约束；相同事实合并 Evidence，矛盾事实并存并标记，
  不会因为新事实置信度较高而自动覆盖；
- Semantic 默认召回排除过期、失效和 superseded 投影，验证、更正和失效通过 revision CAS 保存历史；
- Semantic subject 只来自可验证 allowlist：安装级 local User、Pragma Project、根资产和 producer Expert。
  当前不发现 Repository subject，普通 Agent 任务不依赖代码仓库。
- Agent 自己决定是否需要记忆，并通过通用 ContextStore 逐层 list/search/read；Host 不根据当前 prompt
  生成隐藏 query，不自动注入匹配项，也没有 `recall_memory` 专用工具；
- Desktop 一级 Memory 页面可以查看 Episode/Fact、来源、binding、冲突、历史、精确 Evidence 和 Module
  health，并执行收紧、修正、验证、失效或忘记；
- 提炼任务页同时展示 Episodic、Semantic 与 Knowledge job，并允许对 `needs_attention` Knowledge job 按
  revision 显式重试；
- Mission 的 Memory 页签显示每次 Execution 的 capture/recall 计数。搜索审计只保存 digest 和长度，
  不保存 query 原文。
- Knowledge Module 从有效 Episode 与已验证/无冲突 Fact 提炼本地候选；候选必须在 Memory 页面检查精确
  来源、逐项选择 recall/export binding 后才能发布，未发布候选不会进入 Agent Context；
- published Knowledge 通过 `memory/knowledge/items/<id>/<revision>.md` 读取，内容、权限收紧和撤回均保存
  不可变 revision；
- Bundle 默认不导出任何 Knowledge。导出时只能逐条选择当前 Project 明确允许 export 的修订；导入确认
  即发布为本地 Knowledge，重复导入幂等，丢弃 Bundle 安装不会删除已导入 Knowledge。

当前已实现独立的内置 Mission Board；尚未实现 Skill Candidate、CodeGraph Module、跨设备同步和 legacy
导入。旧 `@pragma/plugin-memory` 中的 Task Memory 只属于迁移源，不是新版
后续 Memory 阶段的完成实现。

Episodic 与 Semantic 的 data/job Store 当前为 user version 3。相邻 v2→v3 迁移将提炼生命周期
升级为 conversation、source Execution 和 input-watermark 模型，并对升级前数据创建备份；未来
版本仍 fail closed。

## 分层加载

Memory 不会把全部记录塞进模型上下文：

```text
memory/guide.md                         # 常驻使用规则
memory/overview.md                      # 预算内的各类型摘要与热点索引
memory/<type>/summary.md                # 类型摘要
memory/<type>/index.md                  # 可分段读取的完整索引
memory/<type>/items/<id>.md             # 按需详情
memory/<type>/evidence/<evidenceId>.md  # 按需核验证据
```

Knowledge 使用带修订的 `memory/knowledge/items/<id>/<revision>.md`，保证 Agent 读取和审计引用的是同一份
不可变发布快照。Knowledge Candidate 不属于这棵可召回 Context。

guide 最多 2KB，overview 最多 6KB。普通搜索不会返回 Evidence；模型必须先找到详情中的稳定引用，再精确
读取证据。Episodic 是历史先例，不代表当前事实。

这套分层结构就是召回协议：Agent 读取 overview 后自行判断是否继续搜索或加载详情。Host 只执行 scope、
权限、预算和审计，不理解 prompt 的相关性，也不会在 Agent 不知情时附加检索结果。跨 Module search 使用
轮询合并，避免某个 Module 因注册顺序独占结果预算。

Semantic 是当前信念投影，也不是无条件真值。详情会展示 confidence、review/expiry、冲突和 Evidence；
发生冲突时必须读取双方详情与证据，不得根据索引顺序猜测胜者。

因此可以询问独立 Expert“你以前做过什么”：回答只依据该 Expert 作为根资产执行过的个人 Episode。
在 Team/Flow 中询问时，模型还可以使用当前 Team/Flow 的共同履历，但提示词和详情会明确区分
`current-asset` 与 `personal`；成员在团队执行中只是 producer，不会把团队 Episode 自动算成个人履历。

## 设置维度

### Global

设置 → Memory：

- Capture：是否允许 canonical execution event 进入 Memory pipeline；
- Recall：是否允许从 Memory Context 读取；
- Learning：是否生成本地 Knowledge/Skill 候选；候选不会自动发布；
- Health：Plane 状态、Feed logical/file bytes、安全 checkpoint、blocked bytes、Module Evidence 和
  dead letter 数量；
- Extraction model：继承系统默认模型，或固定 Memory Curator 使用的 Runtime 和模型。

默认 capture、recall 开启，learning 为 local candidates。

模型设置持久化为 `pragma.memory-extractor-profile/v1`，通过 revision CAS 更新，不使用环境变量。模型暂时
不可用时任务保留在 durable queue；配置错误或耗尽自动重试后进入 `needs_attention`。应用重启不会自动
唤醒这些任务：匹配的模型配置修复会唤醒 configuration failure，用户也可以在设置页按当前 revision
显式重试。失败 Evidence 只保留 30 天，随后任务变成不含原始内容的 `expired` 诊断。

## 存储治理与失败恢复

Memory 持续捕获，但不会无限积累原始上下文：

- Canonical Feed 的 payload 按 30 天、512 MiB 目标维护，删除边界是所有注册 consumer 的最小 durable
  checkpoint。consumer 落后时数据会被固定并显示 blocked bytes，不会静默越界删除；
- 每个 Module、每个 Execution 最多保留 2,000 条或 16 MiB 待提炼 Evidence；curator prompt 最多
  78 KiB。超出部分按确定性优先级省略，并显示 content-free topic 计数；
- Episode 和 Fact 只长期保存它们实际引用的 Evidence；完成的 job 与过期诊断保留 30 天；
- dead letter 每个 consumer 保留 30 天，并同时限制为最多 10,000 条、64 MiB；
- SQLite 升级在首次访问时按静态相邻迁移链执行，升级前备份保留 30 天；异常退出遗留的原子写临时文件
  最多保留一天；
- Mission 删除使用可重放 cleanup journal 清除该 Mission Execution 的 Feed、job、待提炼 Evidence 和
  subject context。已经生成的 Episode/Fact 不随 Mission 删除；需要删除长期 Memory 时应在 Memory
  管理中心执行独立的 invalidate/forget 治理；
- 隐藏 Memory Curator Mission 正常结束立即删除；崩溃遗留通过专用 registry 定向恢复，不扫描所有
  Mission。

这些值来自 `pragma.memory-storage-policy/v1` 固定策略，设置页只读展示，当前不提供用户自定义。

### Expert、ExpertTeam、Flow

编辑对应团队资产时，可以为 capture、recall、learning 选择继承或收紧。资产级设置不能突破 Global
关闭项。真正生效的策略还会与实际 producer Expert 和 Mission restriction 取交集：

```text
global ∩ root asset ∩ producer experts ∩ mission restriction
```

这些设置属于本机 Host binding metadata，不写入 Pragma DSL，不生成 Project Revision。

## 管理与忘记

Memory 管理中心的所有 mutation 都要求当前 revision 和变更原因。Binding 的 recall/export 与 visibility
只能保持或收紧；当前页面不会授予新的主体或重新开放已拒绝的权限。更正、验证、失效和权限变更会生成
新 revision，过期 revision 可在历史中核对。

“忘记”与“失效”不同：失效保留内容和历史但停止默认召回；忘记会删除当前内容、全部 revision history、
此前的 governance event 和不再被引用的 Evidence，只留下不含 Memory 内容和原始理由的 tombstone，以防
后台 Evidence 重放恢复同一稳定 identity。该操作不可撤销。

这里的“每个资产一个 Memory Store”是逻辑授权视图，不是每个 Expert/Team/Flow 创建一套 SQLite 或目录。
Episodic 与 Semantic Module 都使用各自的共享物理 Store，并在查询阶段按稳定 binding 与当前 Expert
过滤 list、search、detail 和 Evidence。

## 类型边界

旧四类记忆不再作为目标架构的闭合枚举：

- 原 TaskMemory：改为可选 Mission Board 使用范式，不是 Memory 前置依赖；
- Experience：进入 Episodic Memory，记录过去做过什么；
- Fact：进入 Semantic/Fact Memory，记录当前相信什么是真的；
- Skill：先成为 Skill Memory Candidate，评测通过后升级为现有 Skill Capability。

Knowledge 与 CodeGraph 仍是 Memory type，不是独立 KnowledgeBase 或 MemoryAsset。它们由独立 Module 管理
自己的 Schema、Store 和 revision，最终通过同一个 `memory` ContextStore 被授权模型读取。

## 团队资产与分享

事实描述的 subject 和它绑定给谁是两个维度。当前自动 subject 支持 local User、Pragma Project、
Expert、ExpertTeam 与 Flow；Repository 等其他 subject 等有稳定 registry 后再接入。事实可以在权限允许、
经过提炼后绑定给 Expert、ExpertTeam 或 Flow，成为团队资产的一部分。

分享 Expert/ExpertTeam/Flow 时，可逐条选择一并导出绑定且允许 export 的 published Knowledge revision。
分享不会新建一个知识库对象，也不会导出私有原始 Evidence、Curator prompt 或本机路径。host-private、
restricted sensitivity 和存在不可映射受限主体的 Knowledge 会被拒绝导出。

## Legacy plugin

仓库中的 `@pragma/plugin-memory` 暂时只承担旧数据来源和兼容迁移窗口。新架构不再通过它启用 Plane，
也不继续扩展旧 Task/Experience/Fact/Skill 文件 Store。阶段 9 会提供 owner-scoped、带备份和 journal 的
导入，然后升级受影响的 DSL compiler 并删除旧插件。

## 当前持久路径

```text
~/.pragma/data/event-bus/feed.sqlite       # Canonical Event Feed
~/.pragma/data/memory/policies/            # Global/asset policy history
~/.pragma/data/memory/extractor-profile.json # Memory Curator Runtime/model profile
~/.pragma/data/memory/modules/<episodic>/episodes.sqlite # Episodic projection
~/.pragma/state/event-bus/handoffs/        # Execution durable handoff
~/.pragma/state/event-bus/handoff-quarantine/ # 原样保留的损坏/未来版本 handoff；所属 Execution fail closed
~/.pragma/state/memory/                     # checkpoint/dead-letter/outbox
~/.pragma/state/memory/modules/<consumer>/dead-letters.sqlite # 有界 dead letter
~/.pragma/state/memory/modules/<episodic>/jobs.sqlite # Evidence aggregation and durable jobs
~/.pragma/data/memory/modules/<semantic>/facts.sqlite # Semantic projection, revisions and audit
~/.pragma/state/memory/modules/<semantic>/jobs.sqlite # Semantic Evidence, subjects and durable jobs
~/.pragma/data/memory/modules/<knowledge>/knowledge.sqlite # Candidate、published revision、job 与治理
~/.pragma/state/memory/executions/<executionId>/activity.sqlite # capture/recall metadata audit
~/.pragma/state/memory/cleanup-journal/     # Mission/Execution transient cleanup journal
~/.pragma/state/memory/curator-missions.json # 有界隐藏 Curator Mission registry
~/.pragma/data/memory/subject-identity.json # Desktop installation-local User identity
~/.pragma/data/missions/<missionId>/board/shared/ # Mission 共享白板
~/.pragma/data/missions/<missionId>/board/private/<encodedContextId>/ # Runtime Context 私有白板
```

Memory 数据不写 Agent workspace。正常启动不会扫描全部 Mission、Execution 或 legacy memory 目录。

## 相关文档

- [ADR 031: Extensible Memory Plane](../adr/031-extensible-memory-plane.md)
- [ADR 032: Durable Canonical Event Feed](../adr/032-durable-canonical-event-feed.md)
- [ADR 033: Layered Episodic Memory](../adr/033-layered-episodic-memory.md)
- [ADR 034: Conservative Semantic Memory](../adr/034-conservative-semantic-memory.md)
- [ADR 035: Agent-driven Memory Recall and Host Governance](../adr/035-agent-driven-memory-recall-and-governance.md)
- [ADR 036: Memory Storage Retention and Recovery](../adr/036-memory-storage-retention-and-recovery.md)
- [ADR 037: Mission Board as a Host-bound Context Store](../adr/037-mission-board-context-store.md)
- [ADR 038: Reviewed Knowledge Memory and Explicit Bundle Sharing](../adr/038-reviewed-knowledge-memory-and-bundle-sharing.md)
- [Memory Plane 落地计划](../architecture/memory-plane-implementation-plan.md)
- [旧 Memory System ADR（已被替代）](../adr/002-memory-system.md)
