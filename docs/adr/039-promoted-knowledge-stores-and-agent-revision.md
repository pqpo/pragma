# ADR 039: Promoted Knowledge Stores and Agent-driven Store Revision

- Status: Accepted
- Date: 2026-08-05
- Supersedes in part: [ADR 031](./031-extensible-memory-plane.md)、
  [ADR 038](./038-reviewed-knowledge-memory-and-bundle-sharing.md)
- Implementation status: Implemented

## Context

Episodic 与 Semantic Memory 是持续变化、可重新提炼的动态投影。经过用户批准的 Knowledge 则应成为
可直接管理、挂载和分享的长期知识库，而不是继续留在 Memory Plane 中依赖 Evidence、Memory policy、
Module checkpoint 或 Memory Context projection。

Desktop 已经在“工作室 → 知识库”提供托管 Markdown Context Store。继续让
`pragma.memory.knowledge` 作为另一套 published Knowledge authority，会形成重复的治理、分享、修订和
Context 暴露路径。另一方面，知识库会持续收到来自 Memory、用户、导入、评审或其他自动化的更新请求，
修订能力不应只为 Memory 定制。

## Decision

### 1. Knowledge 升级后切换权威边界

Memory Plane 可以从 Episode、Fact 或其他允许来源生成 Knowledge promotion Candidate。用户批准后，Host
将候选物化为 Desktop 托管 Context Store，并显示在“工作室 → 知识库”。从该事务完成开始：

- Context Store 是内容、结构、当前 revision、挂载和分享的唯一权威；
- Store 的读取、召回、导出和后续修订不查询 Memory、Evidence 或 Memory Module Store；
- Store 内容不保存 Memory Evidence、原始 Curator prompt 或 `sourceRefs`；
- Memory 侧可以保留不含正文和 Evidence 的稳定 promotion binding：`expertRef → storeId` 与最后一次
  `sourceDigest`，仅用于把后续变化路由成 Store revision request；
- 原 `pragma.memory.knowledge` published projection、Desktop Published Knowledge API/UI 与
  `pragma.memory.knowledge@v1` Bundle extension 已删除；旧目录不读取、不迁移，也不与 Studio Knowledge
  Store dual-write。

这不是新增第二种 KnowledgeBase 领域对象。“工作室 → 知识库”继续使用现有 Host-managed Context Store
产品与身份；变化的是 promoted Knowledge 的权威归属从 Memory Module 切换到该 Store。

### 2. 知识库必须结构化并渐进披露

每个 Expert 最多绑定一个 Memory Knowledge Store；ExpertTeam 与 Flow 的结果按实际 producer Expert
路由，不能把团队或流程聚合成第二个 Store。一个 Store 可以包含多份文件，但绝不能把所有历史 Memory
合并成巨型文档。由系统生成或修订的 Store 至少遵循以下分层语义：

```text
guide.md                         # 有界使用规则，不保存知识正文
overview.md 或 summary.md        # 有界主题概览与热点
index.md / indexes/**            # 有界或可分页的详情指针
items/**                         # 独立知识详情
```

`guide`、`overview`、`summary` 与 `index` 是可重建投影，不是内容 authority。Agent 先读取有界入口，再
搜索或精确读取 `items/**`。Store 增长不能让 always-on 或 model-decision 内容随详情数量无界增长；大型
索引必须分页或分片。

### 3. Store Revision 是通用 Host 能力

每个可修订的托管 Context Store 后续支持提交一段 revision prompt。Memory learning pipeline 只是 revision
prompt 的一种生产者；用户、导入、评审、自动化或其他 Host 功能可以使用同一入口。

Host 提供内置 Store Revision Agent。它只加载：

1. 目标 Store 的当前精确 revision；
2. 本次 revision prompt；
3. Store 修订所需的结构和权限规则。

它不自动获得 Memory Context 或原始 Evidence。Agent 输出带预期 Store revision 的受控 change set，包括
必要的 add、edit、rename 和 delete。change set 在用户批准前不得改变当前 Store；批准后 Host 以 CAS 和
原子事务激活新 Store revision，旧 revision 保持可恢复和可审计。拒绝、冲突或 Agent 失败不改变当前
Store。

### 4. Memory 驱动的后续更新

新的 Episode 或 Fact 使已升级主题发生变化时，Memory 侧根据稳定 promotion binding 定位目标 `storeId`，
只提交包含已提炼变化的 revision prompt。Store Revision Agent 读取当前 Store，决定需要修改哪些
`summary/index/items` 文件并产生提案。用户批准后更新当前 Store revision。

Semantic Fact 原位替换完成后必须重新按当前 source revisions 计算 digest 并持久调度 Knowledge learning；
已有 Store binding 继续走通用 revision request，而不是创建第二个初始化 Candidate。修订 Agent 必须按
稳定 normalized key 修改或删除旧值，不能把 replacement 当成一条无关知识追加。Evidence-only 合并且有效
语义未变化时不创建重复修订任务。

匹配不唯一时必须由用户选择目标 Store；不得依靠标题相似度自动改写多个知识库。Store 修订完成后仍不
保留对原 Memory 或 Evidence 的读取依赖。

## Implementation record

- Context Store schema v4 保存 aggregate `contentRevision`、snapshot hash、逐 revision snapshot/record；v3 在
  owner 首次读取时通过 backup、journal 和原子替换升级；
- 通用 Store revision request/job/profile/change-set 协议已落地；任务按 Store FIFO 调度，用户批准前只保存
  staged change set，批准时以 revision/hash 双 CAS 原子应用；过期批准会 supersede 并用原提示词自动重排；
- 内置 `expert:0000000000st0rev` 使用独立 Runtime/model profile，只挂载目标 Store 的只读 Context；所有
  Runtime 工具审批固定拒绝，Mission 不创建 Board、不挂载 Memory/Host Context，并通过有界 registry 清理
  崩溃遗留 Mission；
- Memory learning 首次生成可编辑的结构化初始化 Candidate；用户确认后原子创建普通 Context Store rev1、
  自动挂载并写入 content-free Expert binding。已有 binding 时提炼器只能提交 revision request；
- `guide.md`、`overview.md`、`index.md` 与 `indexes/**` 有硬预算，详情拆分到 `items/**`；Store 内容不保存
  Evidence、sourceRefs 或 Curator prompt；
- 修订任务只出现在“工作室 → 知识库 → 修订任务”，系统 Mission 不进入 Mission/Home 列表或 Memory feed；
- 旧 Memory Published Knowledge 协议、Desktop API/UI 与 Bundle extension 已 hard cut。旧数据目录被忽略，
  没有自动迁移或双写路径。

## Consequences

- Memory 负责发现值得沉淀或更新的内容，但不再长期托管已批准 Knowledge；
- Studio Knowledge Store 成为 Knowledge 唯一 authority，并复用现有 Context 挂载、编辑和 Bundle 能力；
- Knowledge 不再需要 Memory Evidence 才能读取、分享或修订；
- Store Revision Agent 成为可复用基础设施，而不是 Knowledge Module 私有 curator；
- 用户批准仍是发布和修订的安全边界，模型不能直接覆盖当前知识库；
- 阶段 6 的 Store promotion 与通用 revision 闭环已经完成。
