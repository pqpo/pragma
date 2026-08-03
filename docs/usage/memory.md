# Memory 使用指南

Pragma 的新 Memory Plane 是 Desktop 内置能力，随应用启动，不需要环境变量，也不需要给 Expert 安装
插件。架构决策见 [ADR 031](../adr/031-extensible-memory-plane.md)，分阶段范围见
[Memory Plane 落地计划](../architecture/memory-plane-implementation-plan.md)。

## 当前已经可用的能力

当前已完成 Memory Plane 基础设施、策略和 Episodic Memory：

- Execution 语义事件通过持久 Canonical Event Feed 交给 Memory Plane；
- Memory Evidence 自动记录 root Expert/ExpertTeam/Flow 与实际 producer Expert；
- 每个 Memory Module 可以独立消费、重试、保存 checkpoint 和发布派生事件；
- 联邦 `memory` ContextStore 可以按 Module prefix 路由只读内容；
- Desktop 设置页可以控制全局 capture、recall、learning 并查看 Plane health；
- Expert、ExpertTeam、Flow 编辑页可以继承或收紧全局策略。
- Execution 终态会创建持久提炼任务，由隐藏 Memory Curator 生成目标、尝试、失败、恢复和结果；
- 普通 Expert、ExpertTeam 和 Flow 内 Expert 会加载有界 Memory guide、类型摘要与热点索引；
- 独立 Expert 只能看到自己的 Episode；Team/Flow 内 Expert 看到当前 Team/Flow Episode 与自己的个人
  Episode，不会混入其他专家或其他团队资产；
- 模型通过 `memory/episodic/items/**` 按需读取详情，需要核验时再读取精确 Evidence 引用。

当前尚未实现生产级 Semantic/Fact、Knowledge、Skill Candidate 或 CodeGraph Module。查询相关的主动
召回排序、Memory 管理中心、候选评审和分享也在后续阶段。

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

guide 最多 2KB，overview 最多 6KB。普通搜索不会返回 Evidence；模型必须先找到详情中的稳定引用，再精确
读取证据。Episodic 是历史先例，不代表当前事实。

因此可以询问独立 Expert“你以前做过什么”：回答只依据该 Expert 作为根资产执行过的个人 Episode。
在 Team/Flow 中询问时，模型还可以使用当前 Team/Flow 的共同履历，但提示词和详情会明确区分
`current-asset` 与 `personal`；成员在团队执行中只是 producer，不会把团队 Episode 自动算成个人履历。

## 设置维度

### Global

设置 → Memory：

- Capture：是否允许 canonical execution event 进入 Memory pipeline；
- Recall：是否允许从 Memory Context 读取；
- Learning：是否生成本地 Knowledge/Skill 候选；候选不会自动发布；
- Health：Plane 状态、Feed event 数量和 Module 数量。
- Extraction model：继承系统默认模型，或固定 Memory Curator 使用的 Runtime 和模型。

默认 capture、recall 开启，learning 为 local candidates。

模型设置持久化为 `pragma.memory-extractor-profile/v1`，通过 revision CAS 更新，不使用环境变量。模型暂时
不可用时任务保留在 durable queue；连续结构错误进入 needs-attention，设置变化后自动唤醒。

### Expert、ExpertTeam、Flow

编辑对应团队资产时，可以为 capture、recall、learning 选择继承或收紧。资产级设置不能突破 Global
关闭项。真正生效的策略还会与实际 producer Expert 和 Mission restriction 取交集：

```text
global ∩ root asset ∩ producer experts ∩ mission restriction
```

这些设置属于本机 Host binding metadata，不写入 Pragma DSL，不生成 Project Revision。

这里的“每个资产一个 Memory Store”是逻辑授权视图，不是每个 Expert/Team/Flow 创建一套 SQLite 或目录。
Episodic Module 仍使用共享物理 Store，并在查询阶段按稳定 root asset 与当前 Expert 过滤 list、search、
detail 和 Evidence。

## 类型边界

旧四类记忆不再作为目标架构的闭合枚举：

- 原 TaskMemory：改为可选 WorkingState/TODO/白板，不是 Memory 前置依赖；
- Experience：进入 Episodic Memory，记录过去做过什么；
- Fact：进入 Semantic/Fact Memory，记录当前相信什么是真的；
- Skill：先成为 Skill Memory Candidate，评测通过后升级为现有 Skill Capability。

Knowledge 与 CodeGraph 仍是 Memory type，不是独立 KnowledgeBase 或 MemoryAsset。它们由独立 Module 管理
自己的 Schema、Store 和 revision，最终通过同一个 `memory` ContextStore 被授权模型读取。

## 团队资产与分享

事实描述的 subject 和它绑定给谁是两个维度。一个事实可以描述 User、Project 或 Repository，同时在权限
允许、经过提炼后绑定给 Expert、ExpertTeam 或 Flow，成为团队资产的一部分。

未来分享 Expert/ExpertTeam/Flow 时，可选择一并导出绑定且允许 export 的 published/team-shareable
Memory revision。分享不会新建一个知识库对象，也不会自动导出私有原始 Evidence。

## Legacy plugin

仓库中的 `@pragma/plugin-memory` 暂时只承担旧数据来源和兼容迁移窗口。新架构不再通过它启用 Plane，
也不继续扩展旧 Task/Experience/Fact/Skill 文件 Store。阶段 8 会提供 owner-scoped、带备份和 journal 的
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
~/.pragma/state/memory/modules/<episodic>/jobs.sqlite # Evidence aggregation and durable jobs
```

Memory 数据不写 Agent workspace。正常启动不会扫描全部 Mission、Execution 或 legacy memory 目录。

## 相关文档

- [ADR 031: Extensible Memory Plane](../adr/031-extensible-memory-plane.md)
- [ADR 032: Durable Canonical Event Feed](../adr/032-durable-canonical-event-feed.md)
- [Memory Plane 落地计划](../architecture/memory-plane-implementation-plan.md)
- [旧 Memory System ADR（已被替代）](../adr/002-memory-system.md)
