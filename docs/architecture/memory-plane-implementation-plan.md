# Memory Plane 落地计划

- Status: Required phases completed; optional extension planned
- Last updated: 2026-08-06
- Decisions: [ADR 031](../adr/031-extensible-memory-plane.md)、[ADR 032](../adr/032-durable-canonical-event-feed.md)、[ADR 033](../adr/033-layered-episodic-memory.md)、[ADR 034](../adr/034-conservative-semantic-memory.md)、[ADR 035](../adr/035-agent-driven-memory-recall-and-governance.md)、[ADR 036](../adr/036-memory-storage-retention-and-recovery.md)、[ADR 037](../adr/037-mission-board-context-store.md)、[ADR 038](../adr/038-reviewed-knowledge-memory-and-bundle-sharing.md)、[ADR 039](../adr/039-promoted-knowledge-stores-and-agent-revision.md)

## 最终链路

```text
Canonical Event Feed
        ↓
versioned Evidence
        ↓
Episodic / Semantic(Fact) / future Memory Modules（可选 CodeGraph）
        ↓
Knowledge promotion / Skill Memory Candidate
        ↓
reviewed Studio Knowledge Store + Federated Memory ContextStore
        ↓
Store Revision Agent / Skill Candidate 经 Evaluation 升级为 Capability
```

Mission Board 不在 Memory 提炼主链上，但仍是 Host 内置的持久短期协作能力；其中的 TODO、plan、
handoff 等变化可以发布 Evidence，但 Agent 不使用白板也必须产生 Memory。可选的 CodeGraph 仍是
Memory type；经批准的 Knowledge 升级为“工作室 → 知识库”的托管 Context Store，之后不再依赖 Memory
或 Evidence。

## 执行原则

- 阶段按依赖推进；接口、mock 或空 Store 不算完成。
- Memory Plane 是 Host 内置能力，不使用环境变量开关，不由 Expert plugin 安装。
- 新 Memory type 通过静态 Module 独立消费 Feed，不能修改 Core 的闭合 union。
- 新持久协议使用 Zod、schemaVersion、静态相邻迁移和真实历史 fixture。
- Desktop 先初始化最小存储根、IPC 和窗口，再启动 Memory 后台循环；不得启动时扫描所有 owner。
- 权限只能在蒸馏时保持或收紧，扩大分享必须显式批准。
- 召回相关性由 Agent 通过通用 ContextStore 自主判断；Host 不从 prompt 派生 query、不自动注入结果，
  也不增加专用 recall tool。
- 不建立长期 dual-write、旧字段兼容分支或第二套 Skill authority；Studio 托管 Context Store 是 promoted
  Knowledge 的唯一 authority。
- Memory 只能通过通用 Store Revision 能力启动稀疏草稿，不能直接改写正式知识库；内置 Store Revision
  Agent 必须使用原生 Context 工具编辑草稿并提交审核，用户批准后才能激活新 Store revision。
- 普通 Expert 可显式挂载内置“Pragma 管理工具”Host Capability。该 Capability 是 Pragma 管理操作的长期
  工具容器，当前只提供知识库修订工具；后续任务创建、查询和管理能力继续加入同一容器。知识库工具可以
  列出全部知识库、草稿及其 Expert/ExpertTeam 挂载关系，并向任意知识库启动修订 Mission；启动 Mission
  默认需要用户审批，草稿写入和提交审核不发布正式内容。
- 阶段 9 的 CodeGraph 是可选扩展验收，不是 Memory 重构完成或旧插件切换的前置条件；没有明确产品需求时
  可以不实现。

## 阶段总览

| 阶段 | 状态      | 交付目标                                                     |
| ---- | --------- | ------------------------------------------------------------ |
| 1    | Completed | 内置 Plane、Canonical Event Bus、Module SPI、策略与设置入口  |
| 2    | Completed | 分层召回协议与 Episodic Memory：历史、结果、失败与恢复       |
| 3    | Completed | Semantic / Fact Memory：真值、冲突、时效和置信度             |
| 4    | Completed | Agent 驱动召回、完整 binding 治理、管理中心与 Mission 可见性 |
| 5    | Completed | Mission Board：持久通用白板、私有 Context 与跨专家协作       |
| 6    | Completed | Knowledge 升级至 Studio Store 与通用 Agent 修订闭环          |
| 7    | Completed | Skill Memory Candidate、Evaluation 与 Capability 升级        |
| 8    | Completed | 旧 plugin hard cut 与删除，不导入历史记忆                    |
| 9    | Planned   | 可选：CodeGraph 独立 Module 扩展验收                         |

状态只使用 `Planned`、`In progress`、`Blocked`、`Completed`。
“可选”是范围属性，不是状态；阶段 9 不阻塞必做阶段完成。

## 阶段 1：内置 Plane、消息总线与策略

### 目标

建立后续所有 Memory 类型共享、可靠、可扩展的底座。阶段 1 不产出业务 Episodic/Semantic Memory，
但必须证明 canonical event 可持久交付、Module 可独立消费、崩溃可恢复、策略可按历史时刻解析，并由
Desktop 提供设置入口。

### 已完成范围

#### 1. Canonical Event Feed

- `@pragma/shared` 定义 `pragma.canonical-event/v1`、cursor、source 与 `relatedRefs`；
- `@pragma/core` 提供 append-only SQLite Feed、全局 sequence、event id 幂等；
- Execution 使用 `pragma.canonical-event-handoff/v1` 包装 transaction v9；
- 先持久 handoff，再应用 aggregate、追加 Feed、删除 handoff；
- 失败 handoff 有界重放，不启动扫描全部 Execution；
- 同一 Execution 严格按 source version 恢复，首次投递失败即停止后续事件；
- 不可解析、owner 不匹配或未来版本 handoff 原样隔离，并对所属 Execution fail closed；有效但应用失败的
  handoff 不得跳过，因为它已经是 durable commit point；
- `relatedRefs` 记录 `pragma.execution-root` 与 `pragma.event-producer`。

#### 2. Evidence adapter

- `@pragma/memory` 将 Execution canonical event 映射为 `pragma.memory-evidence/v1`；
- 覆盖 message、terminal outcome、tool semantic event、artifact created 与 handoff reference；
- Evidence 自动记录 root Expert/ExpertTeam/Flow、实际 producer Expert 及二者的策略 binding；
- Envelope 固化 sensitivity、visibility、provenance 与 `policySnapshot`；
- 未知/损坏 schema 进入 consumer dead letter，不阻断无关消费者。

#### 3. Memory Module SPI

- 静态 `MemoryModuleRegistry` 校验唯一 module id、version、Context prefix；
- 每个 Module 独立 checkpoint、retry、dead letter、health；
- mutation 以 message id 幂等；derived event 先写 durable outbox；
- `dynamic-projection` 与 `immutable-revision` 是存储模型，不是 Core Memory type union；
- Probe Module 证明新类型无需修改 Core 即可消费、派生和暴露 Context。

#### 4. Federated ContextStore 最小实现

- 稳定 `memory` namespace；
- `guide.md` 与事实优先的 `overview.md` 提供有界模型入口；Module 健康只在治理 UI 展示；
- `list/read/search` 按 prefix 路由；
- `add/edit/delete` 返回 `permission_denied`；
- 不把各 Module 数据复制进统一物理 Store。

#### 5. 版本化策略

- Global：enabled 总开关，以及 capture、recall、learning；
- Expert、ExpertTeam、Flow：inherit 或收紧；
- Mission 与实际 producer 可继续收紧；
- 生效规则是 `global ∩ root asset ∩ producers ∩ mission`；
- 默认记忆功能关闭；关闭时所有有效能力均停用且子设置隐藏；开启后保留已有 capture/recall/learning 选择；
- Global 策略从 v1 升级到 v2 时，在首次读取 owner 时执行带备份和 journal 的相邻迁移；
- revision 使用 CAS 更新并保留 `effectiveFrom` 历史；
- 重放事件按 `occurredAt` 解析，不使用当前策略覆盖历史；
- 损坏/未来策略 schema fail closed。

策略属于 Host binding metadata，不写 portable DSL，不产生 Project Revision。

#### 6. Desktop 产品入口

- Memory Plane 总是装配，窗口与 IPC 就绪后启动后台循环；
- 设置页提供 Global capture/recall/learning 与 Plane health；
- Expert、ExpertTeam、Flow 编辑页提供继承/收紧策略；
- 不需要环境变量，不再对 legacy Memory plugin 做运行时二选一冲突判断；
- 旧 plugin 已在阶段 8 直接删除，不读取或导入其历史数据。

### 持久路径

- Feed：`~/.pragma/data/event-bus/feed.sqlite`；
- policy：`~/.pragma/data/memory/policies/`；
- handoff：`~/.pragma/state/event-bus/handoffs/`；
- handoff quarantine：`~/.pragma/state/event-bus/handoff-quarantine/`；
- checkpoint/dead-letter/outbox：`~/.pragma/state/memory/`；
- 后续 Module 权威数据：`~/.pragma/data/memory/<module>/`；
- 可重建索引：`~/.pragma/cache/memory/<module>/`。

路径由 `PragmaPaths` 生成，Memory 不写 workspace。

### 阶段 1 验收证据

- 重放同一 envelope 不重复产生有效 mutation；
- outbox 前后、publication、checkpoint 故障点均可恢复；
- 一个 Module 持续失败不阻断另一个 Module；
- 策略默认值、CAS 冲突、历史解析、严格交集与未来 schema 拒绝有测试；
- canonical event 的 root/producer 自动归因进入 Evidence binding；
- capture disabled 时 cursor 推进但不发布 Evidence；
- Desktop renderer/node 严格类型检查通过，设置页有多语言文案。

### Implementation record

- Status: Completed
- Protocols: `pragma.canonical-event/v1`、`pragma.canonical-event-handoff/v1`、
  `pragma.memory-evidence/v1`、`pragma.memory-policy/v2`、
  `pragma.memory-consumer-state/v1`、`pragma.memory-derived-event-outbox/v1`、
  `pragma.memory-dead-letter/v1`
- Migration: Global memory policy 从 v1 相邻迁移到 v2，保留 v1 备份并支持 journal 重放；asset policy 仍为 v1；Execution transaction 保持 v9；
- Verification: `pnpm lint`、`pnpm typecheck`、Core/Memory/Desktop tests、`pnpm build`
- Known limitations: 阶段 1 完成时尚无生产 Episodic/Semantic Module、Memory 管理中心、分享导出与
  Feed retention/replication；这些不能算作阶段 1 已提供的产品能力

## 阶段 2：Episodic Memory

### 目标

回答“过去发生过什么”：目标、尝试、结果、失败和恢复。直接消费 Evidence，不依赖 Mission Board。

### 已完成范围

#### 2A. 通用分层召回协议

- 每个可召回 Module 强制声明 projection/learning purpose 与四层 Context manifest；
- `memory/guide.md` 常驻记忆使用规则，最大 2KB；
- `memory/overview.md` 在 4KB 内事实优先合成：Semantic 使用主要空间，Episodic 只保留最近三条；
- 每种类型保留 `<type>/summary.md`、`<type>/index.md`、`<type>/items/**`、
  `<type>/evidence/**`；
- `listContext` 只列目录入口，不展开全部详情；普通 search 不返回 Evidence，Evidence 只能通过详情中的
  精确引用读取；
- Core 原有 always-on budget、Context byte-range 和 snapshot 记录继续作为统一预算与审计边界。

#### 2B. Episodic Module

- `pragma.memory.episodic` 独立拥有 Episode/Job Zod Schema、SQLite Store 和四层 Context projection；
- 消费封闭的 `execution-message/v2`、`tool-event/v2` 与 terminal v2，thinking、签名、图片、工具参数、
  命令/输出和 Runtime 私有字段不会进入 extractor；
- feed consumer 只做安全聚合和终态入队，后台 worker 独立提炼，不因模型故障占住 checkpoint；
- 根 Execution 使用确定性 Episode/Job ID；子 Agent Evidence 汇总到同一 Episode，重复终态幂等，
  Episode 记录触发它的 terminal message，写 Episode 后、完成 Job 前崩溃也只补齐 Job；后续新终态增加
  原 Episode revision；
- pre-model 价值过滤与模型 retain 决策都不会保存被拒绝正文，只保存计数、原因和幂等身份；
- Evidence 引用必须属于当前 job allowlist；sensitivity 取最严格值；Episode binding 只保留经一致归因的
  root asset，producer refs 单独保存为 provenance；
- `pending/running/needs_attention/completed` 持久任务支持 lease、退避、配置变更唤醒和崩溃重放。

#### 2C. 资产级逻辑 Store 隔离

- Execution Runtime Context 始终携带稳定 root asset，并单独记录当前实际 Expert；子 Agent 不把 root
  改写为自己；
- `MemoryRecallScope` 是每个 Module Context provider 的必填输入，缺少或无效身份时 list 返回空，
  read/search fail closed；
- 独立 Expert 只读自己的 Episodic Store；Team/Flow 内 Expert 读取“根 Team/Flow + 当前 Expert 个人”
  两个逻辑 Store；
- Team/Flow Episode 只绑定根 Team/Flow，producer Expert 只作 provenance，不自动继承为个人履历；
- Store 在 SQL 查询阶段过滤 root scope，list/search/detail/Evidence 使用同一授权条件；猜测稳定 ID 不能
  越权读取；
- 各资产不建立独立物理数据库；隔离是 Module 共享 Store 上的授权逻辑视图。

#### 2D. Desktop Curator 与设置

- 隐藏系统 Expert `expert:0000000000mem0ry` 通过正常 Mission/ExpertSession/Runtime/Usage 链路执行；
- Mission 升级为 v6，显式记录 `origin: user | system-memory`；v5 首次读取相邻升级为 user；
- Curator Mission 从普通列表排除，Curator 无工具、无 Memory Context，Evidence adapter 硬性排除其事件；
- Memory Settings 保存 `pragma.memory-extractor-profile/v1`，支持继承默认或固定 Runtime/provider/model，
  revision CAS 更新，不读取环境变量；
- 普通 Expert、ExpertTeam 与 Flow 内 Expert 由 Desktop Host 自动挂载只读 `memory` namespace；
- Plane health 展示 Episode、提炼中、needs-attention 和拒绝总数；Module 内部按 low-value、sensitive、
  insufficient-evidence 与 policy 保存拒绝原因计数；

### 退出门槛

- 未使用白板的 Mission 仍可形成 Episode；
- 相同 Evidence 重放不会重复；
- 每条结论可追溯 Evidence；
- 低价值和未授权内容不会进入 projection；
- Expert A 无法看到 Expert B 的个人 Episode；
- Team/Flow 内 Expert 只看到根资产 Episode 与自己的个人 Episode；
- Team/Flow Episode 不会混入 producer Expert 的个人履历，详情搜索和 Evidence ID 读取不能旁路授权。

### Implementation record

- Status: Completed
- Protocols: `pragma.memory.execution-message/v2`、`pragma.memory.tool-event/v2`、
  `pragma.memory.execution-terminal/v2`、`pragma.memory-episodic/v1`、
  `pragma.memory-extraction-job/v1`、`pragma.memory-extractor-profile/v1`、`pragma.mission/v6`
- Storage: `data/memory/modules/<episodic>/episodes.sqlite` 与
  `state/memory/modules/<episodic>/jobs.sqlite`
- Migration: 新 Episodic Store 从 v1 开始并拒绝未来版本；Mission v5→v6 相邻升级补充 user origin
- Verification: `pnpm check`、`pnpm build`，并覆盖 Expert/Team/Flow Runtime root identity、Desktop
  recall scope 解析、Memory Module 作用域契约和 Episodic list/search/detail/Evidence 越权测试
- Known limitations: 阶段 2 完成时仅有 Episodic 生产模块；Knowledge、Skill Candidate、管理中心、分享和
  跨设备同步仍属于后续阶段

## 阶段 3：Semantic / Fact Memory

### 目标

回答“当前相信什么是真的”。Subject Schema 保持可扩展；本阶段由 Desktop 登记 User、Project，并从
Evidence 使用 Expert、ExpertTeam、Flow 等运行归属，允许经治理绑定为团队资产。Repository 留待后续
具备明确发现和身份规则的阶段。

### 已完成范围

- `pragma.memory.semantic` 独立消费安全 execution Evidence，以 subject、predicate 和 normalized value
  归一化事实；相同观察合并 Evidence，exclusive 不同值双向标记冲突，不自动覆盖；
- Fact 保存 confidence、observed/verified/review/expires 时间、Evidence、冲突、失效、binding、权限和
  Curator provenance；验证只允许由治理 API 完成；
- Desktop 为普通 Mission Execution 幂等登记安装级 local User 和 Pragma Project subject，根资产与
  producer Expert 使用 Evidence attribution；Curator 只能选择 allowlist subject；
- Repository subject 不在本阶段发现或登记，非代码 Agent 任务不依赖仓库；
- 独立 facts/jobs SQLite、applied-job、lease、退避和 needs-attention 覆盖模型失败与提交后崩溃恢复；
- `memory/semantic/**` 提供 summary、index、item、Evidence 四层投影；expired、invalidated、superseded
  默认不召回，冲突事实全部保留并标记；
- Desktop preload/main 提供 list、search、detail、history、revise、verify、invalidate 类型化 IPC；
  mutation 使用 revision CAS，同 fact id 保存不可变 revision history 与原子治理审计；管理 UI 留在阶段 4。

### 退出门槛

- 新证据不静默覆盖冲突事实；
- 过期/失效事实不参与默认召回；
- user-private 事实不会因绑定自动变为 team-shareable；
- Expert/Team/Flow 的有效策略能阻止对应 capture 或 recall。

### Implementation record

- Status: Completed
- Protocols: `pragma.memory-semantic/v1`、`pragma.memory-semantic-job/v1`、
  `pragma.memory-semantic-extraction-input/v1`、
  `pragma.memory-semantic-execution-subject-context/v1`、
  `pragma.memory-semantic-governance-event/v1`
- Storage: `data/memory/modules/<semantic>/facts.sqlite` 与
  `state/memory/modules/<semantic>/jobs.sqlite`
- Migration: 新 Semantic Store 与 Desktop local User identity 从 v1 开始；未修改 Core Execution、Mission、
  Interpreter compiler 或 Episodic Store
- Verification: Memory/Shared/Desktop typecheck、Memory tests、Desktop Memory/Mission integration tests；
  完整 `pnpm check` 与 `pnpm build`
- Known limitations: 尚无 Repository subject、跨设备账户合并或分享导出

## 阶段 4：Agent 驱动召回、完整治理 UI 与可见性

### 目标

保持阶段 2 的分层 ContextStore，由 Agent 自己决定何时、用什么 query 召回；Host 负责 root/current
Expert/principal scope、binding/visibility、预算、审计和生命周期。补齐完整治理、产品管理和 Mission
可见性，不建立 Host prompt planner 或第二条召回旁路。

### 交付

- `memory/guide.md` 明确 Agent 决定是否召回；Host 不读取 prompt 派生 query、不自动注入、不提供
  `recall_memory`；
- 通用 `list/search/read` 复用 Module scope-bound 查询，先执行 policy、visibility 与 revision binding；
- 搜索在 Module 之间轮询合并，普通搜索排除 Evidence；详情只暴露精确 Evidence 引用；
- 每个 Execution 保存 capture/recall activity；search 只记录 query digest/length，不保存原文；
- Episodic v2 与 Semantic binding 包含 recall/export、permissionRevision；mutation 使用 CAS 且只能收紧；
- invalidate 保留历史；forget 清空内容、history 和孤立 Evidence，只保留 content-free tombstone 并阻止重放；
- Memory 管理中心展示来源、provenance、冲突、历史、Evidence、治理操作和 Module health；
- Mission 显示 capture/recall 摘要，Mission 删除级联回收 Execution activity。

### 退出门槛

- 未授权 Memory 无法从 list、search、detail 或精确 Evidence 读取旁路；
- 每次 recall 可解释操作、结果和拒绝原因，且原始搜索 query 不落盘；
- 单 Module 不可用时其他类型继续服务。

### Implementation record

- Status: Completed
- Protocols: `pragma.memory-episodic/v3`、`pragma.memory-extraction-job/v3`、
  `pragma.memory-semantic-job/v3`、`pragma.memory-episodic-extraction-input/v2`、
  `pragma.memory-semantic-extraction-input/v3`、`pragma.memory-capture-activity/v1`、
  `pragma.memory-recall-activity/v1`、`pragma.memory-execution-context/v1`、
  `pragma.memory-tombstone/v1`；Semantic 内容协议保持 `pragma.memory-semantic/v1`
- Storage: 每个 Execution 的 activity 位于 `state/memory/executions/<executionId>/activity.sqlite`；
  Episodic 与 Semantic data store 为 user version 4，job store 为 user version 3
- Migration: Episodic data v1→v2 完成 binding 转换，Semantic data v1→v2 增加 tombstone；
  data/job store 的 v2→v3 将单 Execution 身份升级为 conversation、source Execution 与 input-watermark
  生命周期，并将历史非法 `needs_attention` 任务恢复为可重试 pending；相邻迁移使用历史
  fixture、升级前备份且对未来版本 fail closed；data v3→v4 增加 binding-scoped hot/archive INDEX
  与召回统计
- Verification: Memory/Core/Desktop typecheck，Memory 与 Desktop tests，
  `packages/memory/test/memory-job-v3-migration.test.ts`，仓库 `pnpm check`、`pnpm build`
- Known limitations: 不提供跨设备账户合并、分享扩权审批、Knowledge/Skill/CodeGraph；
  不计划增加 Host prompt retrieval planner

## 已完成的跨阶段存储治理

存储治理不是新的 Memory 类型阶段，而是阶段 1–4 的横切完成项：

- Feed v2 使用独立 receipt 保留历史 event id 幂等性，只在所有注册消费者的最小 checkpoint 之前按
  30 天/512 MiB 目标清理 payload；落后消费者固定数据时报告 blocked bytes，不越过 checkpoint 删除；
- 每个 Module、每个 Execution 的待提炼 Evidence 固定为最多 2,000 条或 16 MiB，按终态、用户意图、
  最终回答、失败、artifact、summary 的确定性优先级保留；实际 curator prompt 再限制为 78 KiB；
- Episode/Fact 只长期保存被产物引用的 Evidence；遗漏只保留按 topic 统计的 content-free 诊断；
- configuration failure 与耗尽的 transient failure 进入 `needs_attention`，不因应用重启自动重试；配置
  修复或用户在设置页执行带 revision 的显式重试后才重新入队；
- 失败 payload 30 天后转为 `expired` 诊断并删除内容；completed/expired job、dead letter 和旧迁移备份均
  有固定期限，dead letter 另有 10,000 条/64 MiB 上限；
- Mission 删除通过稳定 cleanup journal 清除关联 Execution 的 Feed 与 transient extraction state，
  已完成的 Episode/Fact 继续作为独立治理的长期 Memory；删除标记阻止在途提炼或事件重放复活状态；
- 隐藏 Memory Curator Mission 正常结束立即删除；异常遗留只通过专用有界 registry 定向恢复，不扫描全部
  Mission。

具体不变量、时限和恢复语义见 [ADR 036](../adr/036-memory-storage-retention-and-recovery.md)。

## 阶段 5：Mission Board

### 目标

提供 Mission-scoped 持久通用白板。plan、TODO、progress、decision、handoff 和 process 都是白板使用
范式，不是独立协议或 managed tool。Mission Board 不是长期 Memory type，也不是 Episodic、Semantic
Memory 的前置条件；已提交变化可以作为后续提炼的可选 Evidence。

### 对象与权限边界

- `mission-board` 绑定 Mission，参与该 Mission 的 Expert 可协作读写；
- `mission-board-private` 绑定稳定 Runtime `contextId`，普通 Agent 只能由所属 Runtime Context 读取和修改，不能由团队成员、
  coordinator 或通过猜测 ID 旁路读取；Host 用户治理和审计使用独立显式权限；
- assignee 使用稳定 Expert/Context identity，不使用展示名称或数组顺序推导身份；
- visibility、owner、scope 和 permission revision 分离，私有内容不能因 handoff、提炼或导出自动扩大可见性；
- Mission Board 随 Mission owner 生命周期持久化和级联清理，不进入 Project Revision，也不写
  Agent workspace。

### 交付

- `@pragma/local-host` 提供可复用 Mission Board Context bindings；通用 binding 不依赖文件系统，Host composition 选择持久化 adapter；
- 复用 Context System 的 `list/read/search/add/edit/delete`，不新增 Mission Board CRUD 或 handoff 方法；
- `GUIDE.md` 说明 plan、TODO、progress、decision、handoff、process、大输出与 workspace 引用约定；
- 私有视图在 Store 路由层使用可信 Runtime `contextId` 隔离，list、read 和精确 ID 读取规则一致；
- Desktop 在 Host composition root 使用 `@pragma/context-filesystem` 持久化，退出重启后继续生效；
- Core 只消费 Host 注入的通用 Context binding 与 overflow target，不依赖 Mission Board 或文件系统实现；
- 提供不含正文的 mutation observation hook，Host 可据此发布 content-safe Canonical Event 或 Evidence；
  后续 adapter 必须保持或收紧原 visibility，不把私有正文暴露给其他 Agent；
- 旧 Task Memory 不导入 Mission Board 或 Evidence；阶段 5 不维持 dual-write。

### 退出门槛

- 不使用 Mission Board 的 Mission 仍能正常形成 Episodic/Semantic Memory；
- 同一 Team/Flow Execution 的授权参与者能协作维护共享 TODO 和 handoff；
- Agent A 无法从 list、read、精确 ID、Context 或 Evidence 读取 Agent B 的私有条目；
- 并发更新产生明确 CAS 冲突，不静默覆盖；崩溃恢复不重复应用 mutation；
- Mission 删除按 owner 图回收 Mission Board，且不影响长期 Memory 的独立生命周期；
- 私有条目发布 Evidence、提炼、导出时不会自动提升为 shared/team-shareable。

### Implementation record

- Status: Completed
- Protocols: 不新增持久或跨进程白板协议；Host-local mutation observation 形状为
  `pragma.mission-board-mutation/v1`，读写复用 Core Context Store 的 revision/etag CAS 和通用
  Context output reference，不新增白板专用 CRUD 协议
- Storage: Desktop 默认保存到
  `data/missions/<missionId>/board/shared/` 与
  `data/missions/<missionId>/board/private/<encodedContextId>/`；路径随 Mission owner 进入带 journal 的
  Trash 回收流程
- Migration: 新 Execution 从 legacy `pragma.handoff` Store 切换为通用 Context reference；旧
  handoff 只通过有界、Mission-authorized 的只读 Context adapter 保持可读，不保留旧写入或
  registration API
- Verification: Mission Board package tests，Core Context binding/output/execution tests，Desktop Mission
  restart、successor Session、大输出与 owner 删除测试，仓库 `pnpm check`、`pnpm build`
- Known limitations: mutation observation hook 只暴露不含正文的变更元数据；Desktop 尚未将
  Mission Board mutation 接入 Memory Evidence，它不影响 Episodic/Semantic 的默认提炼链路

## 阶段 6：Knowledge 升级与 Store Revision

### 目标

把多条动态 Memory 提炼为待审升级候选。用户批准后，将结构化 Knowledge 物化到“工作室 → 知识库”的
托管 Context Store。Store 从此成为唯一 authority，不再读取 Memory、Evidence 或 Memory policy。

### 处理链

```text
Episodic + Semantic + imports
        ↓
Knowledge promotion / revision Candidate
        ↓ verify / deduplicate / consolidate / review
        ↓
Studio managed Context Store revision
        ↓
Context binding + generic Store Revision Agent
```

### 退出门槛

- promotion 前的 Candidate 不能被默认 recall 当作已发布知识；
- promotion 后的 Store 不依赖 Memory Evidence、Memory Module Store 或 Memory Context；
- Store 使用 `guide → overview/summary → index → items` 渐进披露，任何入口和索引都有硬预算或分页，
  不产生巨型文档；
- 新 Memory 只通过稳定、无正文的 promotion binding 定位 Store 并提交 revision prompt；
- 内置 Store Revision Agent 只加载目标 Store、精确 revision 与 revision prompt，输出受控 change set；
- 用户批准前不改变当前 Store；批准后以 CAS 和原子事务激活新 revision，旧 revision 可恢复和审计；
- 分享与导入复用 Context Store/Bundle authority，不保留并行 Memory Knowledge 分享协议。

### 已完成范围

- Status: Completed
- Protocols: Context Store `v4`、snapshot/revision record/change set `v1`、Store revision
  request/job/profile `v1`、Memory Knowledge initialization Candidate 与 content-free Expert binding `v1`；
- Storage: Context Store 保存当前 manifest、逐 revision snapshot/record 与原子 change-set journal；修订任务、
  独立 Agent profile、Agent Mission registry、初始化 Candidate 与 promotion binding 分别保存在 Host state；
- Runtime: 稳定隐藏 Expert `expert:0000000000st0rev` 只读目标 Store，使用独立模型配置；系统 Mission 无
  Board、Memory、Host Context、工作区工具、网络或 secrets 权限，并从所有用户 Mission 入口排除；
- Product: 初始化 Candidate 留在 Memory 页面审阅；普通修订请求、内容预览、批准、拒绝、重试、删除与
  Agent 配置位于“工作室 → 知识库 → 修订任务”，不进入 Mission List；专家编辑器可挂载内置“Pragma
  管理工具”Capability，并通过当前的 `knowledge_revision_list_targets`、`knowledge_revision_start`
  查看全部知识库及其当前 Expert/ExpertTeam 挂载关系，并为任意知识库创建同一审核队列任务；提交工具
  默认要求用户审批，Mission 使用完全访问模式时由 Host 自动批准；
- Authority: 每个 Expert 最多一个 Memory Knowledge Store。首次批准创建并挂载普通 Store；后续 Memory
  或反思 Expert 只能提交修订提示词，只有 Store Revision Agent 能产生自动 change set，用户批准后
  才激活；反思提交按 Execution、Invocation、Expert 与目标 Store 记录 provenance 并幂等去重，Team
  Execution 额外记录 Team；
- Disclosure: `guide.md` ≤ 2 KiB、`overview.md` ≤ 6 KiB、`index.md` 与每个 `indexes/**` ≤ 8 KiB，详情放入
  `items/**`；Store 不保存 Evidence、sourceRefs 或提炼 prompt；
- Migration: Context Store v3→v4 与 Mission v6→v7 都在 owner 首次读取时升级并保留 backup/journal；旧
  `pragma.memory.knowledge` 目录不迁移、不读取，Published Knowledge API/UI 与 Bundle extension 已 hard cut；
- Verification: Desktop/Memory typecheck，Context Store migration/revision/CAS、Store revision queue/stale
  requeue、Memory initialization/routing/tombstone、Mission 隔离与 Bundle cutover 测试。

## 阶段 7：Skill Memory Candidate → Skill Capability

### 目标

从重复成功/失败模式提炼可执行范式，通过 Evaluation 与批准升级为现有 Skill Capability。

### 交付

- candidate 包含适用条件、步骤、失败模式、恢复方式、Evidence provenance；
- 去重和通用性评估，不把一次偶然成功直接升 Skill；
- `@pragma/evaluation` replay/run-dry/evaluator 端口；
- draft、evaluating、approved、rejected、promoted 状态与审计；
- promoted 后引用 Capability id/revision，不保留平行永久 Skill 内容 authority。

### 已完成范围

- Status: Completed
- Threshold: 只有同一 producer Expert 的至少 3 条独立高价值 Episode（`valueScore >= 0.85`）、覆盖至少
  2 个 conversation，且其中至少 2 条成功或成功恢复时才允许形成 Candidate；提炼器仍可因模式片段化、
  敏感或不具通用性拒绝，单次偶然解法不会生成 Skill；
- Module: 独立静态 `pragma.memory.skill-learning@1.0.0` Module 消费 Execution terminal Evidence，拥有
  自己的 checkpoint、SQLite job、重试、诊断和提炼输入上限；它只读取精确 Episodic/Semantic
  来源快照，不写其他 Module Store，也不提供可召回投影；
- Routing: 相似目标只在该 producer Expert 过去由 Memory 创建并绑定的 Skill 中匹配；无相似目标时生成
  初始化 Candidate，一个明确目标时提交 Skill revision，多目标歧义时暂停并由用户选择修订对象或创建新
  Skill；ExpertTeam/Flow 按实际 producer Expert 路由；
- Evaluation: `@pragma/evaluation` 提供 3 条以上来源回放与至少 1 条边界用例的 subject/judge 端口；所有
  case 断言、静态校验和脚本测试均通过后才进入 `pending_review`。生成脚本只允许 Node 22 ESM、受控
  built-in/相对 import 和 `node:test` 覆盖，并在 Node Permission Model 子进程中禁止网络、子进程、Worker、
  native addon 与沙箱外文件访问；
- Authority: 新 Skill 必须在 Memory 页面经用户批准，随后通过普通 Capability revision publisher 创建并
  原子绑定 Expert；已有 Skill 只能向通用 Skill Revision Agent 提交提示词，由 Agent 产生文件 change set，
  独立评测通过且用户在 Studio 批准后才以 revision/content-hash CAS 发布；旧 revision 可审计，Memory 不
  保存第二份长期 Skill authority；
- Product: Memory 页面提供目标消歧、包文件编辑、评测断言、重试、拒绝与批准；Studio Skill 详情提供用户
  和 Memory 来源的修订任务、diff、评测、批准/拒绝/重试/删除；General Settings 的 Store/Skill Revision
  Agent 共用既有 profile，Skill Evaluation Agent 使用单独 profile；系统 Mission 不进入用户 Mission、
  Memory、Board、workspace 或工具审批路径；
- Recovery: Candidate、Memory→Skill binding、promotion journal、revision job 与 Evaluation profile 均由
  Host 持久化；promotion journal 可定向重放，revision 基线冲突会 supersede 并创建新任务，不改写已批准
  的旧 change set；删除 Expert/Capability 会清除对应 content-free binding；
- Verification: Shared/Memory/Evaluation/Desktop strict typecheck，来源门槛、三次回放与边界失败、Node ESM
  沙箱、Extraction board 与设置页回归测试；全仓 `pnpm check` 与 `pnpm build` 是本阶段最终合入门。

## 阶段 8：旧插件 hard cut

### 已完成范围

- Status: Completed
- 删除 `@pragma/plugin-memory` 与 `@pragma/plugin-repo-manager` 的源码、manifest、测试、workspace 依赖和
  Desktop 内置分发产物；仓库当前不附带内置 Expert plugin；
- 不读取、导入、迁移或自动删除 `~/.pragma/memories/` 中的旧 Task、Experience、Fact、Skill 数据；
- 删除旧 direct-write Memory tools、重复 Context projection 与并行 Skill Store，不保留兼容 adapter、
  feature flag 或迁移期分支；
- 保留通用 plugin DSL、Interpreter resolver、Desktop catalog 和用户 ZIP plugin 能力。旧 Project/Expert
  对已删除 plugin 的精确引用按既有缺失依赖诊断 fail closed；
- 通用 DSL Schema 没有变化，因此不升级 compiler version，也不伪造协议迁移；
- Desktop 内置 plugin 打包在仓库没有 `plugins/` 目录时仍生成空资源，保证开发与发布构建可重复。

### Verification

- 锁文件和 workspace graph 不再包含两个已删除 package；
- 当前代码和示例不再把旧 plugin id 当作内置能力；
- `pnpm check`、`pnpm build` 与 Desktop 空 plugin 打包通过。

## 阶段 9（可选）：CodeGraph Module

### 定位

CodeGraph 用于在出现明确 Repository 图谱需求时，进一步验证架构对未来 Memory 类型完全开放。它不是
Memory 重构完成、legacy cutover 或删除旧插件的前置条件；没有足够产品价值时可以跳过。

### 可选交付与门槛

- 独立消费 repository snapshot/file-change Evidence；
- 独立 durable build job、Store、迁移、checkpoint 与 revision；
- Context 提供 catalog/symbol/impact 摘要，managed tool 提供图遍历；
- 可绑定 Expert/ExpertTeam/Flow；
- 实现不修改 Core Memory union、Episodic/Semantic Store 或联邦路由代码。

## 跨阶段质量门

- capture、distillation、recall、Context read、managed tool、export 分别鉴权；
- Secret、credential、隐藏 reasoning、未授权文件不进入 Evidence；
- 只记录 identity、计数、耗时和错误码，不记录敏感 payload；
- checkpoint/outbox/journal 可恢复，多文件更新原子；
- 每条注入保留 Context revision、Memory revision 与 provenance；
- 每个阶段更新本文件的状态、协议、迁移、验证命令和已知限制。
