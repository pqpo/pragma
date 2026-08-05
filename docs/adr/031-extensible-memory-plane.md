# ADR 031: Extensible Memory Plane

- Status: Accepted
- Date: 2026-08-01
- Supersedes: ADR 002 and ADR 003
- Implementation plan: [Memory Plane 落地计划](../architecture/memory-plane-implementation-plan.md)
- Durable delivery decision: [ADR 032](./032-durable-canonical-event-feed.md)
- Layered projection and Episodic decision: [ADR 033](./033-layered-episodic-memory.md)
- Semantic conflict and governance decision: [ADR 034](./034-conservative-semantic-memory.md)
- Short-term collaboration refinement: [ADR 037](./037-mission-board-context-store.md)
- Knowledge authority refinement: [ADR 039](./039-promoted-knowledge-stores-and-agent-revision.md)

> ADR 039 已替代本 ADR 中“published Knowledge 继续作为 Memory type 和 Memory Module authority”的
> 决策。Episodic、Semantic、Memory Evidence、Module SPI 与可选 CodeGraph 边界不受影响。

## Context

旧实现位于 `@pragma/plugin-memory`，把 Task、Experience、Fact、Skill 做成按 Agent 安装的四类文件
记录。它验证了 evidence、provenance 和 Context projection 的价值，但插件边界会遗漏未安装插件的
Agent 事件，也无法自然支持 ExpertTeam、Flow、Project、组织资产及 CodeGraph 等独立消费链路。

本 ADR 接受以下产品判断：

- Memory 是 Agent 的内置核心能力，不是 Expert 插件；
- 短期协作白板是可选能力，不是 Memory 的前置依赖；ADR 037 后续将其定名为
  Mission Board；
- Memory 是持续变化、可重算的解释；知识与技能是从 Memory 逐层蒸馏出的高价值形态；
- 不新增独立 `KnowledgeBase`、`KnowledgeAsset` 或 `MemoryAsset` 领域。知识仍是一种 Memory；
- 所有 Memory 类型最终通过 ContextStore 被模型读取，但不要求共享同一个物理数据库；
- 新类型通过独立 Module 消费同一消息流水，不能靠修改 Core 的闭合枚举扩展。

## Decision

Pragma 采用 Host-scoped、always-on 的 Memory Plane：

```text
Canonical sources
message / execution / tool / artifact / repository / import
                         │
                         ▼
Durable Canonical Event Feed
                         │
                         ▼
Typed Memory Evidence adapters
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     Episodic         Semantic       CodeGraph / future
      Module           Module           Module
          │              │              │
          └──────────────┼──────────────┘
                         ▼
        Knowledge Memory / Skill Memory Candidate
                         │
                         ▼
       Federated ContextStore + Retrieval + Governance
```

Desktop 启动后总是装配 Memory Plane，不使用环境变量，也不要求 Expert、ExpertTeam 或 Flow 安装
Memory plugin。用户可以在设置页关闭 capture、recall 或 learning，但不能卸载这条架构主链。

`@pragma/core` 只拥有 Memory-neutral 的 Canonical Event Feed、Execution durable handoff 和必要身份；
`@pragma/memory` 拥有 Evidence adapter、Memory Module SPI、独立消费状态、策略 Store、联邦 Context；
Desktop/Server Host 拥有装配、后台生命周期、IPC/API 和治理 UI。Core 不反向依赖 Memory。

## Memory 的对象模型

### Evidence

Evidence 是“实际发生了什么”的不可变或 append-only 依据，包括消息、语义执行事件、工具结果、
Artifact、Repository snapshot 和显式导入。Memory 可以被重算或否定，但不能替代 Evidence。

### Memory type 与 Memory revision

Memory type 由 Module 定义，不进入 Core 闭合 union。一个类型可以采用两种持久形态：

- `dynamic-projection`：当前解释，可合并、衰减、冲突、失效或重建；
- `immutable-revision`：经过提炼后相对稳定的 Memory revision；已发布 revision 不原地改写。

默认类型路线如下：

| 类型                   | 作用                                     | 默认形态                 |
| ---------------------- | ---------------------------------------- | ------------------------ |
| Episodic Memory        | 过去做了什么、结果与恢复过程             | dynamic projection       |
| Semantic / Fact Memory | 当前相信什么是真的，含冲突、时效和置信度 | dynamic projection       |
| Knowledge Memory       | 可供团队长期读取的高价值知识             | immutable revision       |
| Skill Memory Candidate | 从重复经验中提炼的工作范式，等待评测     | immutable candidate      |
| CodeGraph Memory       | Repository 的符号、关系与影响路径        | module-defined revisions |

Knowledge、CodeGraph 不是另一个“资产系统”。它们仍是 Memory type，仍由 Memory Module 管理，仍通过
ContextStore 暴露。所谓“记忆知识库”只是 ContextStore 中一类经过提炼的 Memory projection。

Skill 是唯一特殊出口：Skill Memory Candidate 通过 Evaluation 和批准后，升级为现有 Skill
Capability revision；不保留第二套永久 Skill Memory 权威 Store。

### WorkingState（后由 ADR 037 定名为 Mission Board）

TaskMemory 原有语义本质是 TODO List Manager、handoff 区或多人白板，因此改称 WorkingState。Agent
可以完全不使用它。WorkingState 的已提交变化可以成为 Evidence，但 Memory 提炼始终基于 canonical
消息与执行事件，不依赖白板是否存在。

“不是 Memory 的前置依赖”不表示不提供该产品能力。WorkingState 作为 Host 内置、Mission/Execution
生命周期内的短期协作状态独立实现，支持团队共享条目和按 Runtime Context 隔离的私有条目；其协议、
权限、持久化、工具和 Desktop UI 由落地计划的独立阶段交付，而不作为 `@pragma/memory` Module。

ADR 037 保留了这些产品语义，但将实现收敛为 Mission-scoped 的 `mission-board` 与按稳定
Runtime `contextId` 隔离的 `mission-board-private` Context Store；不再定义 WorkingState 专用对象或
managed tool。

## Subject、生产者、绑定与团队资产

以下维度必须分开：

1. `subjectRefs`：内容描述谁或什么；
2. root asset：外部请求选择的 Expert、ExpertTeam 或 Flow；
3. producer Expert：真正产生该事件的 Expert；
4. visibility/ownership：谁控制和检查内容；
5. binding：哪些团队资产可以召回或随包分享该 Memory revision。

事实可以描述 User、Project、Repository 或其他对象，但这不意味着它只能是个人或 Project 记忆。
只要证据、权限和价值评估允许，同一事实可逐步提炼并绑定给 Expert、ExpertTeam 或 Flow，成为可演进、
可分享的团队能力。

Canonical Event 通过 `relatedRefs` 记录 root asset 与实际 producer。Evidence adapter 自动把两者加入
subject/binding，并保存事件发生时的策略快照。不能仅按根 Flow 归因，也不能把团队成员产生的所有内容
错误归给 coordinator。

Evidence binding 表示捕获时参与策略计算的主体，不等于派生 Memory 的 owner。派生 Module 必须显式定义
归属规则。Episodic Memory 以根 Execution asset 作为唯一 owner；producer Expert 只作 provenance，
Team/Flow Episode 不自动成为成员 Expert 的个人履历。召回时，当前 Expert 在 Team/Flow Execution 中可读
“根 Team/Flow + 自己的个人 Store”，但不能读取其他成员的个人 Store。该规则不要求按资产拆分物理数据库。

一个已发布或标记为 team/shareable 的 Memory revision，只要存在允许 export 的绑定，就可作为该绑定
Expert、ExpertTeam 或 Flow 的分享项。分享操作不会创建新的 KnowledgeBase 对象；它导出选中的 Memory
revision、provenance 摘要、binding 与权限版本。私有 Evidence 不会因自动蒸馏而扩大可见性。

## Memory policy

策略是 Host binding metadata，不写入 portable DSL，也不产生 Project Revision。第一阶段支持：

- Global：`capture`、`recall`、`learning`；
- Expert / ExpertTeam / Flow override：`inherit` 或收紧对应能力；
- Mission restriction：只允许进一步收紧；
- producer override：实际生产者也参与计算。

默认值为 capture enabled、recall enabled、learning local candidates。最终有效策略是：

```text
global ∩ root asset ∩ every producer ∩ mission restriction
```

任何一层都不能扩大上层权限。策略按 revision 和 `effectiveFrom` 保存；Evidence 必须使用事件发生时有效
的 revision，并把 `policySnapshot` 固化进 envelope，防止重放历史时使用今天的策略改写过去。

策略文件损坏、未来版本或缺失升级链时 fail closed。单一 asset 策略损坏只影响引用它的消费链，不应
阻断无关 asset 或 Desktop 窗口创建。

## Durable feed 与交付

Memory 消费持久 Feed，而不是同步 Agent hooks。ADR 032 定义 SQLite Canonical Event Feed 和
`pragma.canonical-event-handoff/v1`：Execution 先持久化 handoff，再应用 transaction、幂等追加 Feed，
最后删除 handoff。Desktop 创建窗口与 IPC 后启动有界后台恢复，不扫描所有 Execution。

Feed 采用 at-least-once delivery：

- message/event id 稳定；
- Module 独立 checkpoint、retry、dead letter 和 health；
- mutation 必须按 message id 幂等；
- derived event 先进入 durable outbox，再推进 checkpoint；
- 一个 Module 失败不阻断其他 Module 或 Mission 执行；
- 未知 schema fail closed，但不阻断无关订阅。

## Memory Module SPI

每个 Module 静态注册 namespaced id、version、唯一 Context prefix、订阅 topic/schema、storage model、
projection/learning purpose、四层 Context manifest、consumer 和 Context provider。Module 拥有自己的 Schema、迁移、Store、索引、压缩和渲染，不能写另一个
Module 的 Store；协作只能走版本化 derived event 或显式只读端口。

新 Module 不得要求修改 Core union。CodeGraph 是扩展性验收：它独立消费 repository Evidence、维护
适合图的 Store、发布自己的 Memory revision、通过 Context 投影和可选 managed tools 提供读取。

## Federated ContextStore 与 Retrieval

Host 注册一个稳定、只读的 `memory` Context namespace。联邦 Store 按 Module prefix 路由，不复制所有
Memory 到一个目录：

```text
memory/
  guide.md
  overview.md
  catalog.md
  episodic/summary.md
  episodic/index.md
  episodic/items/**
  episodic/evidence/**
  semantic/**
  knowledge/<memoryId>/<revision>/**
  skill-candidates/<memoryId>/<revision>/**
  code-graph/<memoryId>/<revision>/**
```

ContextStore 是统一读取协议，不是新的知识库对象或统一物理 Store。大型 CodeGraph 可以通过 Context
提供摘要和符号文档，同时用 companion tools 做图遍历。

管理修改必须走 Memory governance API；联邦 Context 的 `add/edit/delete` 一律拒绝。召回先校验有效
recall 策略、visibility 与 binding，再执行 Context budget。Agent 通过通用 ContextStore 自主决定何时
list/search/read；Host 不从 prompt 派生 query 或注入隐藏结果。该召回职责由
[ADR 035](./035-agent-driven-memory-recall-and-governance.md) 进一步明确。任何 Module 都不能绕过 Context
assembly 向 Runtime prompt 任意注入内容。

## Storage 与迁移

- Canonical Feed：`~/.pragma/data/event-bus/feed.sqlite`；
- Memory policy 与权威 Module 数据：`~/.pragma/data/memory/`；
- Execution handoff：`~/.pragma/state/event-bus/handoffs/`；
- checkpoint、dead letter、outbox：`~/.pragma/state/memory/`；
- 可重建索引：`~/.pragma/cache/memory/`。

路径统一由 `PragmaPaths` 生成。Memory 不写 Agent workspace。持久 Schema 升级遵守 ADR 019：历史
Schema、相邻迁移、真实 fixture、journal replay、当前 no-op 与未来版本拒绝必须在同一改动中完成。

## UI 与治理

第一阶段在 Desktop 设置页提供全局 Memory 策略和 Plane health；Expert、ExpertTeam、Flow 编辑页提供
继承/收紧策略。后续独立 Memory 管理中心负责 provenance、冲突、修正、失效、候选评审、发布、绑定、
分享与忘记。Mission 页面展示本次 capture、distillation 和 recall，不要求用户浏览文件系统。

## Package boundaries

```text
apps/desktop -> @pragma/memory -> @pragma/core -> @pragma/shared
apps/server  -> @pragma/memory -> @pragma/core -> @pragma/shared
memory-*     -> @pragma/memory -> @pragma/core -> @pragma/shared
```

`@pragma/memory` 不依赖 Desktop、Server、Interpreter、Runtime adapter 或 Expert plugin。需要模型推理、
Evaluation、权限或远端存储时，由 Host 注入窄端口。

## Migration from `@pragma/plugin-memory`

迁移按落地计划分阶段执行。旧四类数据的映射是：

| 旧类型            | 新归宿                                                       |
| ----------------- | ------------------------------------------------------------ |
| Task Memory       | 可选 Mission Board 导入或归档 Evidence，不是默认 Memory type |
| Experience Memory | Episodic import candidate                                    |
| Fact Memory       | Semantic/Fact import candidate，重新校验冲突与时效           |
| Skill Memory card | Skill Memory Candidate，不能直接成为 Capability              |

在 owner 首次显式导入时执行带备份、journal 和诊断的迁移；不在启动时全盘扫描。最终切换删除
`@pragma/plugin-memory`、旧工具和并行 Skill authority，并按仓库规则升级受影响的 Interpreter compiler。

## Consequences

- Memory 成为所有 Agent 与团队资产共享的基础设施，但每层策略仍可限制采集、召回和学习；
- Fact 的 subject 不再决定它只能归 Personal 或 Project，团队绑定成为独立治理动作；
- Knowledge、CodeGraph 继续是 Memory type，避免重复对象模型；
- Skill Candidate 与 Capability 有明确升级边界；
- 新类型获得独立 Schema/Store 的自由，同时统一进入 ContextStore；
- 第一阶段只有基础设施与策略，没有默认 Episodic/Semantic 业务 Module，不能把“流水线已运行”误认为
  “已经形成长期记忆”。
