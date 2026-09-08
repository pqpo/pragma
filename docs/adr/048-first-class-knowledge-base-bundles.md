# ADR 048: 知识库成为一级 Bundle 资产

## 状态

Accepted

## 背景

托管 Markdown `ContextStore` 已经是工作室的核心资产，但旧 Bundle 只能以专家、专家团或流程为根；
Git Bundle Source 和广场也只有这三类。知识内容只能作为其他资源的可选依赖迁移，无法独立发布、
安装或版本化展示。

## 决策

Portable Bundle 协议升级到 `pragma.bundle/v2`，根引用只允许 `Expert`、`ExpertTeam`、`Flow` 和
`ContextStore`。保留真实 v1 Schema 和静态 v1→v2 读取迁移：先按原始 v1 manifest 验证文件索引和
fingerprint，再内存升级；未来版本继续拒绝。

知识库导出只包含 DSL `ContextStore` 和当前已发布托管快照。payload 使用版本化 descriptor 保存名称、
描述、snapshot hash、目录、Markdown 内容及文件元数据，不包含历史修订、草稿、修订任务或 Memory
Evidence。知识库作为根时内容强制包含。

无冲突导入创建新的托管 Store，快照成为 revision 1，author 为 `import`。冲突可追加或复制：追加
保留本地身份、名称及历史，内容相同不创建修订；复制生成新语义 ID 和 Store。检查记录目标 revision
和 snapshot hash，执行使用 Store revision lock 内的 CAS，目标变化时要求重新检查。

Bundle Source manifest 和 item 协议升级到 v2，新增 `knowledge-base` 类型和
`knowledge-bases/<category>/<item>/`。公开 CLI 新增显式且幂等的 `pragma source upgrade [directory]`，
通过备份、稳定 journal 和原子替换升级 v1；`source add` 不隐式升级。Desktop Source 快照作为缓存
直接升级版本并重建，用户配置的远端、ref、启用状态与顺序保持不变。

广场使用既有 `{sourceId, kind, itemId}` 身份模型展示知识库顶级分类、卡片、详情和版本安装，不新增
第二套 KnowledgeBase 领域对象。

## 后果

- 知识库可以独立导入、导出、Git 分发和从广场安装。
- Bundle 与 Source 的持久/跨进程协议同步升级，并保留受支持的相邻迁移。
- 历史与草稿不会随 Bundle 扩散；导入只建立目标 Host 的新修订历史。
- 追加导入是并发安全的显式操作，不能静默覆盖检查后发生的本地编辑。
