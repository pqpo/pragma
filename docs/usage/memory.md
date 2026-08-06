# Memory 使用指南

Pragma 的新 Memory Plane 是 Desktop 内置能力，随应用启动，不需要环境变量，也不需要给 Expert 安装
插件。架构决策见 [ADR 031](../adr/031-extensible-memory-plane.md)，分阶段范围见
[Memory Plane 落地计划](../architecture/memory-plane-implementation-plan.md)。

> [ADR 039](../adr/039-promoted-knowledge-stores-and-agent-revision.md) 已调整并落实 Knowledge 最终边界：
> 用户批准升级后，Knowledge 进入“工作室 → 知识库”的托管 Context Store，并与 Memory/Evidence 解耦。

## 当前已经可用的能力

当前已完成 Memory Plane 基础设施、策略、Episodic Memory、Semantic Memory、治理管理中心、
Knowledge Store promotion/revision 与 Skill promotion/revision 闭环：

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
- 独立 Semantic Module 会提炼当前事实、偏好和约束；相同事实合并 Evidence。主体直接表达的独占事实
  变化会使用原 Fact id 创建新 revision，其他来源的矛盾事实仍并存并标记，不会仅凭置信度覆盖；
- Semantic 默认召回排除过期、失效和 superseded 投影，验证、更正和失效通过 revision CAS 保存历史；
- Semantic subject 只来自可验证 allowlist：安装级 local User、Pragma Project、根资产和 producer Expert。
  当前不发现 Repository subject，普通 Agent 任务不依赖代码仓库。
- Agent 自己决定是否需要记忆，并通过通用 ContextStore 逐层 list/search/read；Host 不根据当前 prompt
  生成隐藏 query，不自动注入匹配项，也没有 `recall_memory` 专用工具；
- Desktop 一级 Memory 页面可以查看 Episode/Fact、来源、binding、冲突、历史、精确 Evidence 和 Module
  health，并执行收紧、修正、验证、失效或忘记；
- 提炼任务页把 Episodic、Semantic 与 Knowledge job 按等待空闲、需要处理、处理中、已完成分列展示；
  支持按 revision 立即提炼、重试、删除失败输入，或中断运行任务并重新等待六小时；
- Mission 的 Memory 页签显示每次 Execution 的 capture/recall 计数。搜索审计只保存 digest 和长度，
  不保存 query 原文。
- Knowledge learning 从有效 Episode 与已验证/无冲突 Fact 提炼初始化 Candidate；每个 Expert 最多一个
  Memory Knowledge Store，ExpertTeam/Flow 按实际 producer Expert 路由；
- 首次 Candidate 在 Memory 页面预览和编辑；确认后原子创建普通 Studio Context Store rev1 并自动挂载；
- Store 已存在时，Memory 只能提交修订提示词。修订任务只在“工作室 → 知识库 → 修订任务”显示，由独立
  Store Revision Agent 生成 change set；用户批准前不改 Store，批准时以 revision/hash CAS 原子激活；
- Store 使用 `guide → overview → index/indexes → items` 渐进披露，不保存 Evidence、sourceRefs 或提炼提示词；
- 分享与导入只使用普通 Context Store Bundle 路径。旧 Published Knowledge API/UI 与
  `pragma.memory.knowledge@v1` extension 已删除，旧目录不迁移、不读取。
- Skill learning 只在同一 producer Expert 至少出现 3 条高价值独立 Episode、覆盖 2 个 conversation，且
  至少 2 条成功或成功恢复后运行；Memory Curator 仍必须确认它是完整、通用、可维护的工作流，而不是
  片段或一次性提示；
- 相似目标只匹配该 Expert 先前由 Memory 创建并绑定的 Skill；无匹配生成新建 Candidate，唯一匹配提交
  修订任务，多匹配时在 Memory 页面暂停并要求用户选择；
- 新 Skill Candidate 必须通过至少 3 次来源回放、1 次边界用例、静态检查与脚本测试，随后在 Memory 页面
  人工批准才会创建普通 Skill Capability 并绑定 Expert；
- 已有 Skill 由共用 Revision Agent 产生文件 diff，在独立 Evaluation Agent 评测通过后，仍需用户在
  “工作室 → 能力 → Skill 详情 → 技能修订”批准才发布新 revision；Memory 不直接改写 Skill；
- 生成脚本仅允许 Node 22 ESM，并在无网络、无子进程、无 Worker、无 native addon、只能访问临时技能包
  目录的 Permission Model 子进程中执行 `node:test` 覆盖。

当前已实现独立的内置 Mission Board；尚未实现跨设备同步。CodeGraph Module 是最后的可选扩展，
不作为 Memory 重构完成条件。旧插件与其 Task/Experience/Fact/Skill 数据已经 hard cut，不属于新版
Memory Plane，也不会被读取或导入。

Episodic 与 Semantic 的 data Store 当前为 user version 4，job Store 为 version 3。data v3→v4 增加
binding-scoped hot/archive 索引与召回统计；相邻 v2→v3 迁移将提炼生命周期
升级为 conversation、source Execution 和 input-watermark 模型，并对升级前数据创建备份；未来
版本仍 fail closed。

## 分层加载

Memory 不会把全部记录塞进模型上下文：

```text
memory/guide.md                         # 常驻使用规则
memory/overview.md                      # 事实优先摘要；情景只保留最近三条
memory/<type>/summary.md                # 类型摘要
memory/<type>/index.md                  # 可分段读取的完整索引
memory/<type>/items/<id>.md             # 按需详情
memory/<type>/evidence/<evidenceId>.md  # 按需核验证据
```

Promoted Knowledge 由 Studio Context Store 以 `guide → overview/summary → index → items` 渐进披露；入口
保持有界，大型索引分页或分片，不能把全部内容合并成巨型文档。初始化 Candidate 不进入任何可召回
Context。

guide 最多 2KB，overview 最多 4KB，其中 Semantic Fact 使用主要空间，Episodic 只显示最近三条。
Summary/Index 只展示按价值、新近度和实际召回选出的 hot 记录，并使用内部链接指向详情；archived
记录不进入 summary/index/overview，但仍可通过 Search 或已知 id 的 Read 深度召回。List 只列入口，
不枚举全部详情。内容较多或目标未知时先 Search，再 Read 精确 Item。普通搜索不会返回 Evidence；模型必须
从详情中的链接精确读取证据。Memory 是只读 Context，直接 add/edit/delete 会被拒绝；Episodic 是历史先例，
不代表当前事实。

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

设置 → General：

- Knowledge and Skill revision Agent：Knowledge Store 和 Skill 修订共用的 Runtime/model profile；
- Skill Evaluation Agent：独立执行 Skill replay/boundary judge 的 Runtime/model profile。

默认 capture、recall 开启，learning 为 local candidates。

模型设置持久化为 `pragma.memory-extractor-profile/v1`，通过 revision CAS 更新，不使用环境变量。模型暂时
不可用时任务保留在 durable queue；配置错误或耗尽自动重试后进入 `needs_attention`。应用重启不会自动
唤醒这些任务：匹配的模型配置修复会唤醒 configuration failure，用户也可以在提炼任务页按当前
revision 显式重试或删除。失败 Evidence 只保留 30 天，随后任务变成不含原始内容的 `expired` 诊断。

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

这些值来自 `pragma.memory-storage-policy/v2` 固定策略，设置页只读展示，当前不提供用户自定义。Episodic
最多 10,000 条或 512 MiB，Semantic 最多 20,000 条或 512 MiB，每条最多保留最近 100 个完整 revision；
超限时先裁剪最低分 archived 内容并留下 content-free tombstone。

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

Knowledge promotion Candidate 来自 Memory，但用户批准后的 Knowledge 是 Studio 托管 Context Store，
不再是 Memory type，也不再依赖 Memory Evidence。可选 CodeGraph 仍可作为独立 Memory Module。

## 团队资产与分享

事实描述的 subject 和它绑定给谁是两个维度。当前自动 subject 支持 local User、Pragma Project、
Expert、ExpertTeam 与 Flow；Repository 等其他 subject 等有稳定 registry 后再接入。事实可以在权限允许、
经过提炼后绑定给 Expert、ExpertTeam 或 Flow，成为团队资产的一部分。

分享路径复用 Studio Context Store 的现有 Bundle authority，不导出私有 Memory Evidence、Curator prompt
或本机路径。旧 `pragma.memory.knowledge@v1` extension 不再接受。

## Legacy hard cut

仓库不再提供旧 Memory plugin，也不保留 direct-write Memory tools、兼容 adapter 或导入器。
`~/.pragma/memories/` 中已有数据不会被扫描、读取、迁移或自动删除；需要保留时应由用户自行归档。
通用 plugin DSL 仍然存在，但引用已删除 plugin 的 Project/Expert 会按缺失依赖 fail closed。

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
~/.pragma/data/memory/modules/<knowledge-learning>/knowledge.sqlite # Knowledge learning jobs；无 published authority
~/.pragma/data/memory/modules/<skill-learning>/skill-learning.sqlite # Skill learning jobs；无 published authority
~/.pragma/data/context-stores/<storeId>/                 # promoted Knowledge 内容与 revision history
~/.pragma/state/context-store-revisions/                 # 修订任务、Agent profile 与隐藏 Mission registry
~/.pragma/state/memory-knowledge-promotion/              # 初始化 Candidate 与 content-free Expert binding
~/.pragma/state/memory-skill-promotion/                  # Skill Candidate、content-free Expert binding 与 promotion journal
~/.pragma/state/skill-revisions/                         # Skill 修订任务与 change set
~/.pragma/state/skill-evaluation/profile.json             # 独立 Skill Evaluation Agent profile
~/.pragma/state/skill-agents/missions.json                # 隐藏 Skill Agent Mission 定向恢复 registry
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
- [ADR 039: Promoted Knowledge Stores and Agent-driven Store Revision](../adr/039-promoted-knowledge-stores-and-agent-revision.md)
- [Memory Plane 落地计划](../architecture/memory-plane-implementation-plan.md)
- [旧 Memory System ADR（已被替代）](../adr/002-memory-system.md)
