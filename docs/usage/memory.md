# Memory 使用指南

Pragma 的 Memory Plane 由 Desktop 与 CLI 共用。Desktop 启动后台提炼；CLI 捕获 Evidence、提交待提取任务并读取已有记忆，不需要给 Expert 安装插件。架构决策见 [ADR 031](../adr/031-extensible-memory-plane.md)。

> [ADR 039](../adr/039-promoted-knowledge-stores-and-agent-revision.md) 与
> [ADR 044](../adr/044-sparse-context-store-revision-drafts.md) 已调整并落实 Knowledge 最终边界：
> 用户批准升级后，Knowledge 进入“工作室 → 知识库”的托管 Context Store，并与 Memory/Evidence 解耦。

## 当前已经可用的能力

当前已完成 Memory Plane 基础设施、策略、Episodic Memory、Semantic Memory、治理管理中心、
Store/Skill Revision Agent 托管的 Knowledge 与 Skill 学习闭环：

- Execution 语义事件通过持久 Canonical Event Feed 交给 Memory Plane；
- Memory Evidence 自动记录 root Expert/ExpertTeam/Flow 与实际 producer Expert；
- 每个 Memory Module 可以独立消费、重试、保存 checkpoint 和发布派生事件；
- 联邦 `memory` ContextStore 可以按 Module prefix 路由只读内容；
- Desktop 设置页可以控制全局 capture、recall、learning，并查看 Feed 容量、安全 checkpoint、固定保留
  策略、Evidence 截断、dead letter 和提炼失败；
- Expert、ExpertTeam、Flow 编辑页可以继承或收紧全局策略。
- Execution 终态会创建持久提炼任务；Memory Curator 处理 Episode/Fact。Knowledge/Skill 独立调度，Revision Agent 在同一任务中查阅来源、优先修订已有资产并提交待审草稿，不再先运行独立规划器；
- 普通 Expert、ExpertTeam 和 Flow 内 Expert 会加载有界 Memory guide、类型摘要与热点索引；
- 独立 Expert 只能看到自己的 Episode；Team/Flow 内 Expert 看到当前 Team/Flow Episode 与自己的个人
  Episode，不会混入其他专家或其他团队资产；
- 模型通过 `memory/episodic/items/**` 按需读取详情，需要核验时再读取精确 Evidence 引用。
- 独立 Semantic Module 会提炼当前事实、偏好和约束；相同事实合并 Evidence。主体直接表达的独占事实
  变化会使用原 Fact id 创建新 revision，其他来源的矛盾事实仍并存并标记，不会仅凭置信度覆盖；
- Semantic 默认召回排除过期、失效和 superseded 投影，验证、更正和失效通过 revision CAS 保存历史；
- Semantic subject 只来自可验证 allowlist：安装级 local User、Pragma Project、根资产和 producer Expert。
  当前不发现 Repository subject，普通 Agent 任务不依赖代码仓库。
- Agent 通过通用 ContextStore 逐层 list/search/read；可选 Attention 为执行途中提供手动历史线索，不自动注入记忆正文，也没有 `recall_memory` 专用工具；
- Desktop 一级 Memory 页面可以查看 Episode/Fact、来源、binding、冲突、历史、精确 Evidence 和 Module
  health，并执行收紧、修正、验证、失效或忘记；
- 提炼任务页把 Episodic、Semantic 与 Knowledge job 按等待空闲、需要处理、处理中、已完成分列展示；
  支持按 revision 立即提炼、重试、删除失败输入，或中断运行任务并重新等待六小时；
- Mission 的 Memory 页签显示每次 Execution 的 capture/recall 计数。搜索审计只保存 digest 和长度，
  不保存 query 原文。
- Knowledge learning 从有效 Episode 与无冲突、未过期 Fact 选择来源；来源可靠性与沉淀价值分别判断。Agent 先检索已有知识库，优先补充或更正相关已挂载库，再考虑其他本地可编辑库；没有合适目标且主题成熟时才新建。零散内容暂不提炼并保留在 Memory，重复内容跳过；
- ExpertTeam/Flow 的来源按实际 producer Expert 路由，保持原根资产权限边界。一个 Expert 可维护多个主题库，多位 Expert 可向同一个库提出修订。正式 Store 不保存 Evidence、sourceRefs 或提炼提示词；
- Skill learning 允许从一次成功任务中提炼完整、经过验证的可复用工作流，也可归纳多次经验；不再要求先积累 3 条高分 Episode。评分不作为准入条件，恢复文字本身不能证明执行成功。每个提案必须引用至少一条成功 Episode，明确适用条件、输入、步骤和实际验证依据；优先选择少量高价值变化，已有相关 Skill 时优先修订；
- Skill 创建和修订均生成托管草稿，保留同步格式与安全验证，由用户审核后发布并绑定 Expert。Memory 不直接改写正式 Skill，不执行来源回放测评；
- 旧 Knowledge/Skill 候选审批页及二次 promotion 链路已移除。首次访问时先恢复旧版已批准但未完成的 promotion journal，再迁入已批准绑定；未审批候选连同旧状态按需归档，不进入新流程；
- 分享与导入使用普通 Context Store 和 Skill Bundle 路径。旧 Published Knowledge API/UI 与 `pragma.memory.knowledge@v1` extension 已删除。

内置 Mission Board 提供 Mission-scoped 协作与大输出交接。CodeGraph 作为可选 Module
扩展接入同一 SPI。旧插件与其 Task/Experience/Fact/Skill 数据不属于当前 Memory Plane
的读取和导入协议。

Episodic 的 data Store 当前为 user version 6，Semantic 为 version 7；两者 job Store 均为 version 4。data v3→v4 增加
binding-scoped hot/archive 索引与召回统计；相邻 v2→v3 迁移将提炼生命周期
升级为 conversation、source Execution 和 input-watermark 模型，并对升级前数据创建备份；未来
版本仍 fail closed。

## 提炼任务的输入与工具

未完成的 Mission 在空闲 6 小时后进入提炼；点击完成后也不会立即调用模型，而是等待 10 分钟。
情景与事实使用相同的等待规则，两个时间阈值在代码策略中独立定义，当前不提供设置页配置。
重复完成通知和重启保留已有截止时间；重新开始对话恢复空闲等待。等待期间删除 Mission 会清除
待提炼任务与 Evidence，避免为即将删除的对话调用提炼模型；仍可在任务页手动提前提炼。

情景记忆由 Memory Curator 根据证据自行判断任务的实际复杂度：简单任务和琐碎对话跳过；相对复杂、
有实质工作过程和有意义结果的任务，可以保留简洁的任务经历，不要求必须提炼出通用经验，也不限于
故障恢复、关键决策或工作流等固定类别。推理、调查、协作、实现与验证只是综合判断的参考，不是
硬性清单；不能仅按任务名称、对话长度、工具调用次数或完成状态决定。简单工具冒烟测试通常跳过，
复杂测试任务仍可记录。事实与偏好独立判断；一次测试中的语言选择或回答不足以认定为长期偏好。
已有记忆不会被自动删除。

Memory Curator 的任务入口只显示提炼目标、主体别名和证据数量。短对话直接提供原文；长对话通过专用工具分页浏览和分段读取。事实候选和情景各部分分项提交，字段错误可在同一次执行中修正。提炼完成以 Host 保存的结果回执为准，聊天回复无需包含 JSON。

证据读取和已有事实查询沿用原任务的权限。达到预算仍有未处理内容时，任务进入“需要处理”，保留进度，不标为“没有值得记忆的内容”。可检查后手动重试。

“允许工具辅助提炼”控制后续采集的脱敏工具输入与结果正文。正文只对采集时允许且当前仍启用的 Module 可用；历史中未保存的工具正文无法补读。工具名称和状态继续保留，不能代替结果内容作为事实依据。

## 质量优先的沉淀与审核

Episode/Fact 的有效变化会唤醒知识与技能学习；Episode 提炼晚于 Execution 结束也不会遗漏。
学习按六小时空闲窗口合并，连续更新的 Skill 工作最多推迟到首次调度后二十四小时。
来源与目标目录可分页、关键词搜索，选中的来源和已有资产需完整读取；预算耗尽进入需要处理，不伪装成低价值跳过。

知识库的新建要求：没有匹配的已有库，主题边界和长期用途明确，内容可独立使用；并有至少两个
独立对话的来源支持，或一次成功任务形成了明确验证的完整成果。一条已验证 Fact 或两个
Execution 本身不再足以支持建库。相关旧库可接受少量有用增量，不以文件数量决定价值。

待审核资产也参与目标发现；相关主题等待已有修订结束，其他目标继续处理。同一有效来源和
目标状态不会反复启动模型；已提交或拒绝的相同建议不会因为无关新记忆而重复提出。新依据
或目标变化后重新比较，模型只提出实际新增、更正或有依据的失效内容修订。
任务卡片显示“暂不提炼，保留记忆”、没有增量、依据不足、新建或修订的判断及原因。
“暂不提炼，保留记忆”（accumulate）表示结束本次学习，底层 Episode/Fact 继续按现有保留与权限规则存在。
未来相关有效变化可能触发新旧来源再评估；这不保证下次提炼，不会自动定时复查或永久跟踪主题。

人工审批注意力比产出数量更稀缺。后台允许正常无草稿：一次性报告、零散建议、已有内容覆盖、仅改措辞或
格式、不确定结论均不值得增加审批。优先合并同一资产的一组相关改进；没有合适目标不代表必须新建。
Knowledge 应增加影响未来判断的稳定知识、约束或重要纠正，并说明适用范围；Skill 应提供完整可复用方法，
保留真实验证和失败处理或限制，不能把单条命令或未验证流程包装成技能。整体任务成功不代表每步或回滚均成功。
完整、经验证且具有清晰独立用途的新领域成果仍可新建资产。来源最低门槛不变，读取、权限、Runtime 或预算
失败仍进入失败处理，不能伪装成无价值。

草稿使用既有提交摘要说明值得审批的原因：相对已有资产的实际变化、未来明确用途与避免的错误或重复工作、
证据支持范围与未验证限制；新建时还需说明已有资产为何不适合、为何值得独立存在。正式内容不复制原始
Evidence、内部来源 ID 或敏感路径。没有增量通过 finish_memory_learning 保存具体理由，不以聊天输出代替回执。

Memory 提出的草稿需人工审核，包括目标库开启自动批准时的 Memory 修订；审核通过后才发布并
新增挂载。普通用户发起的知识库修订继续遵守该库的批准设置。正式知识库不随原始 Memory
被忘记而自动删除。本次升级保留所有已有知识库，不自动合并、迁移内容或删除旧库。

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
保持有界，大型索引分页或分片，不能把全部内容合并成巨型文档。待审核草稿不进入任何可召回 Context。

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

- Memory feature：记忆功能总开关，默认关闭；关闭时不会采集、召回或学习，且其他记忆设置隐藏不可配置；再次开启时保留 Recall 与 Learning 的选择；
- Recall：是否允许从 Memory Context 读取；
- Learning：是否创建 Knowledge/Skill 修订草稿；草稿经人工批准后才发布；
- Health：Plane 状态、Feed logical/file bytes、安全 checkpoint、blocked bytes、Module Evidence 和
  dead letter 数量；
- Extraction model：继承系统默认模型，或固定 Memory Curator 提炼 Episode/Fact 使用的 Runtime 和模型。

设置 → General：

- Knowledge and Skill revision Agent：Knowledge Store 和 Skill 修订使用的 Runtime/model profile。

默认记忆功能关闭；关闭时所有有效记忆能力均停用。启用总开关后，系统保留此前的 capture、recall、learning 选择。

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
- 隐藏 Memory Curator 正常结束后清理；Revision 的已提交草稿保留原 Mission 供审批/返修，无草稿状态按现有维护规则清理；崩溃遗留通过定向 registry 恢复，不扫描所有 Mission。

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
- Skill：由 Skill Revision Agent 创建或修订托管草稿，人工批准后成为正式 Skill Capability。

Store Revision 与 Skill Revision 的 Runtime、模型和思考深度统一在「工作室 → 专家」的对应内置专家中配置。常规设置不再提供独立的技能修订 Agent 配置。旧版共享修订模型首次升级时会备份并迁入尚未自定义的内置专家；已有工作室配置优先，迁移完成后重置专家不会重新导入旧设置。

Knowledge 学习来源于 Memory，但用户批准后的 Knowledge 是 Studio 托管 Context Store，
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
~/.pragma/data/objects/sha256/                           # Context Store Revision 全局去重的文件与 Merkle tree 对象
~/.pragma/data/context-store-drafts/<draftId>/            # 稀疏草稿 overlay 与固定基线
~/.pragma/state/context-store-editor-drafts/<storeId>/    # Studio 未发布的可恢复稀疏编辑草稿
~/.pragma/state/context-store-revisions/                  # v2 修订任务与持久 Mission registry
~/.pragma/state/memory-learning-revisions/bindings.json # Knowledge/Skill 统一绑定与 Revision job identity
~/.pragma/state/memory-revision-planning/                # Revision 规划 Mission 定向恢复标记
~/.pragma/archives/memory-learning-v1/                   # 按需归档的旧 Candidate 与绑定原始数据
~/.pragma/state/skill-revisions/                         # Skill 修订任务与 change set
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
- [ADR 039: Promoted Knowledge Stores and Agent-driven Store Revision](../adr/039-promoted-knowledge-stores-and-agent-revision.md)
- [ADR 057: Unified Memory revision learning](../adr/057-unified-memory-revision-learning.md)
- [ADR 索引](../adr/README.md)

## 可选 Attention Memory

在“设置 → Memory”填写 Jev API Key，验证并保存后启用。任务增量与许可范围内的记忆摘要会经过脱敏和大小限制发送到 TypeSafe。未配置 Key 时不会发出判断请求；全局 Memory 关闭时暂停。

Agent 遇到新错误、观察或子任务结果后，Host 查询已有 Episodic/Semantic 记忆（包括可召回的归档 Episode），维护 `memory/mission-attention.md`。该文件按需读取；显著变化最多提示一次，不插入用户消息、不 steer、不改写系统提示词。

CLI 使用同一个 Pragma home 下的配置与记忆。CLI 完成运行会提交待提取任务，后续 Desktop 消费；CLI 本身不调用提炼模型。Key 只能在 Desktop 配置，移除后停止新的判断。认证错误显示 needs_attention；网络失败显示 degraded，保留有效历史线索并重试。

边界与预算见 [Memory Attention](../architecture/memory-attention.md)。
