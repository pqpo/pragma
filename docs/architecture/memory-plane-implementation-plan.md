# Memory Plane 落地计划

- Status: Active plan
- Last updated: 2026-08-03
- Decisions: [ADR 031](../adr/031-extensible-memory-plane.md)、[ADR 032](../adr/032-durable-canonical-event-feed.md)、[ADR 033](../adr/033-layered-episodic-memory.md)、[ADR 034](../adr/034-conservative-semantic-memory.md)、[ADR 035](../adr/035-agent-driven-memory-recall-and-governance.md)

## 最终链路

```text
Canonical Event Feed
        ↓
versioned Evidence
        ↓
Episodic / Semantic(Fact) / CodeGraph / future Memory Modules
        ↓
Knowledge Memory / Skill Memory Candidate
        ↓
Federated ContextStore + Agent-driven Recall + Host Governance
        ↓
Skill Candidate 经 Evaluation 升级为现有 Skill Capability
```

WorkingState、TODO List 和多人白板不在主链上；它们可以发布 Evidence，但 Agent 不使用白板也必须产生
Memory。Knowledge、CodeGraph 仍是 Memory type，不新增 KnowledgeBase/KnowledgeAsset/MemoryAsset 对象。

## 执行原则

- 阶段按依赖推进；接口、mock 或空 Store 不算完成。
- Memory Plane 是 Host 内置能力，不使用环境变量开关，不由 Expert plugin 安装。
- 新 Memory type 通过静态 Module 独立消费 Feed，不能修改 Core 的闭合 union。
- 新持久协议使用 Zod、schemaVersion、静态相邻迁移和真实历史 fixture。
- Desktop 先初始化最小存储根、IPC 和窗口，再启动 Memory 后台循环；不得启动时扫描所有 owner。
- 权限只能在蒸馏时保持或收紧，扩大分享必须显式批准。
- 召回相关性由 Agent 通过通用 ContextStore 自主判断；Host 不从 prompt 派生 query、不自动注入结果，
  也不增加专用 recall tool。
- 不建立长期 dual-write、旧字段兼容分支、第二套知识库对象或第二套 Skill authority。

## 阶段总览

| 阶段 | 状态      | 交付目标                                                     |
| ---- | --------- | ------------------------------------------------------------ |
| 1    | Completed | 内置 Plane、Canonical Event Bus、Module SPI、策略与设置入口  |
| 2    | Completed | 分层召回协议与 Episodic Memory：历史、结果、失败与恢复       |
| 3    | Completed | Semantic / Fact Memory：真值、冲突、时效和置信度             |
| 4    | Completed | Agent 驱动召回、完整 binding 治理、管理中心与 Mission 可见性 |
| 5    | Planned   | Knowledge Memory：多层提炼、稳定 revision 与团队分享         |
| 6    | Planned   | Skill Memory Candidate、Evaluation 与 Capability 升级        |
| 7    | Planned   | CodeGraph 独立 Module 扩展验收                               |
| 8    | Planned   | 旧 plugin owner-scoped 导入、compiler cutover 与删除         |

状态只使用 `Planned`、`In progress`、`Blocked`、`Completed`。

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
- `catalog.md` 暴露 Module 与健康；
- `list/read/search` 按 prefix 路由；
- `add/edit/delete` 返回 `permission_denied`；
- 不把各 Module 数据复制进统一物理 Store。

#### 5. 版本化策略

- Global：capture、recall、learning；
- Expert、ExpertTeam、Flow：inherit 或收紧；
- Mission 与实际 producer 可继续收紧；
- 生效规则是 `global ∩ root asset ∩ producers ∩ mission`；
- 默认 capture/recall enabled，learning local candidates；
- revision 使用 CAS 更新并保留 `effectiveFrom` 历史；
- 重放事件按 `occurredAt` 解析，不使用当前策略覆盖历史；
- 损坏/未来策略 schema fail closed。

策略属于 Host binding metadata，不写 portable DSL，不产生 Project Revision。

#### 6. Desktop 产品入口

- Memory Plane 总是装配，窗口与 IPC 就绪后启动后台循环；
- 设置页提供 Global capture/recall/learning 与 Plane health；
- Expert、ExpertTeam、Flow 编辑页提供继承/收紧策略；
- 不需要环境变量，不再对 legacy Memory plugin 做运行时二选一冲突判断；
- 旧 plugin 仅作为阶段 8 的历史数据迁移源，不能继续定义新架构。

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
  `pragma.memory-evidence/v1`、`pragma.memory-policy/v1`、
  `pragma.memory-consumer-state/v1`、`pragma.memory-derived-event-outbox/v1`、
  `pragma.memory-dead-letter/v1`
- Migration: 新 Store 从 v1 开始；Execution transaction 保持 v9；未改写既有状态
- Verification: `pnpm lint`、`pnpm typecheck`、Core/Memory/Desktop tests、`pnpm build`
- Known limitations: 尚无生产 Episodic/Semantic Module、Memory 管理中心、分享导出、
  Feed retention/replication 与 legacy importer；这些不能算作阶段 1 已提供的产品能力

## 阶段 2：Episodic Memory

### 目标

回答“过去发生过什么”：目标、尝试、结果、失败和恢复。直接消费 Evidence，不依赖 WorkingState。

### 已完成范围

#### 2A. 通用分层召回协议

- 每个可召回 Module 强制声明 projection/learning purpose 与四层 Context manifest；
- `memory/guide.md` 常驻记忆使用规则，最大 2KB；
- `memory/overview.md` 在 6KB 内公平合成所有已绑定类型的摘要与热点索引；
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

- 隐藏系统 Expert `expert:0000000000memory` 通过正常 Mission/ExpertSession/Runtime/Usage 链路执行；
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
- Known limitations: 尚无 Repository subject、跨设备账户合并、分享导出或
  legacy Fact importer

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
- Protocols: `pragma.memory-episodic/v2`、`pragma.memory-capture-activity/v1`、
  `pragma.memory-recall-activity/v1`、`pragma.memory-execution-context/v1`、
  `pragma.memory-tombstone/v1`；Semantic 内容协议保持 `pragma.memory-semantic/v1`
- Storage: 每个 Execution 的 activity 位于 `state/memory/executions/<executionId>/activity.sqlite`；
  Episodic 与 Semantic data store 升级到 user version 2
- Migration: Episodic v1 使用历史 fixture 验证相邻 v1→v2 binding 转换；Semantic v1→v2 仅增加
  tombstone 表，不改写 fact 内容；未来版本 fail closed
- Verification: Memory/Core/Desktop typecheck，Memory 与 Desktop tests，仓库 `pnpm check`、`pnpm build`
- Known limitations: 不提供跨设备账户合并、分享扩权审批、Knowledge/Skill/CodeGraph、legacy importer；
  不计划增加 Host prompt retrieval planner

## 阶段 5：Knowledge Memory

### 目标

把多条动态 Memory 逐层提炼为相对稳定、可版本化、可绑定、可分享的 Knowledge Memory；不新增独立
KnowledgeBase 或 KnowledgeAsset。

### 处理链

```text
Episodic + Semantic + imports
        ↓
Knowledge Memory Candidate
        ↓ verify / deduplicate / consolidate / review
        ↓
published Knowledge Memory revision
        ↓
Context binding to Expert / ExpertTeam / Flow / Project
```

### 退出门槛

- published revision 不原地修改；
- 候选不能被默认 recall 当作已发布知识；
- 分享包只含显式选择且 export binding 允许的 revision；
- 导入分享包仍生成 Memory revision，不生成第二种知识库对象。

## 阶段 6：Skill Memory Candidate → Skill Capability

### 目标

从重复成功/失败模式提炼可执行范式，通过 Evaluation 与批准升级为现有 Skill Capability。

### 交付

- candidate 包含适用条件、步骤、失败模式、恢复方式、Evidence provenance；
- 去重和通用性评估，不把一次偶然成功直接升 Skill；
- `@pragma/evaluation` replay/run-dry/evaluator 端口；
- draft、evaluating、approved、rejected、promoted 状态与审计；
- promoted 后引用 Capability id/revision，不保留平行永久 Skill 内容 authority。

## 阶段 7：CodeGraph Module

### 目标

证明架构对未来类型完全开放。

### 交付与门槛

- 独立消费 repository snapshot/file-change Evidence；
- 独立 durable build job、Store、迁移、checkpoint 与 revision；
- Context 提供 catalog/symbol/impact 摘要，managed tool 提供图遍历；
- 可绑定 Expert/ExpertTeam/Flow；
- 实现不修改 Core Memory union、Episodic/Semantic Store 或联邦路由代码。

## 阶段 8：旧插件导入与切换

### 映射

| Legacy      | New plane                        |
| ----------- | -------------------------------- |
| Task Memory | WorkingState 或 archive Evidence |
| Experience  | Episodic import candidate        |
| Fact        | Semantic import candidate        |
| Skill card  | Skill Memory Candidate           |

### 要求

- owner 首次显式导入，先检查、备份，再 journaled import；
- 稳定 message id/provenance/owner mapping，可安全重试；
- 不启动扫描 `~/.pragma/memories/` 全树；
- `plugin:memory` 退出合法 DSL 时同步 compiler version、真实 fixture、相邻 migration 与 Host transaction；
- 完成支持窗口后删除 `@pragma/plugin-memory`、旧 direct-write tools、重复 Context 和并行 Skill Store。

## 跨阶段质量门

- capture、distillation、recall、Context read、managed tool、export 分别鉴权；
- Secret、credential、隐藏 reasoning、未授权文件不进入 Evidence；
- 只记录 identity、计数、耗时和错误码，不记录敏感 payload；
- checkpoint/outbox/journal 可恢复，多文件更新原子；
- 每条注入保留 Context revision、Memory revision 与 provenance；
- 每个阶段更新本文件的状态、协议、迁移、验证命令和已知限制。
