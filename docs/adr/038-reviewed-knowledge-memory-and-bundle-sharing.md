# ADR 038: Reviewed Knowledge Memory and Explicit Bundle Sharing

- Status: Accepted
- Date: 2026-08-05
- Extends: [ADR 031](./031-extensible-memory-plane.md)、[ADR 034](./034-conservative-semantic-memory.md)

## Context

Episodic Memory 保存历史先例，Semantic Memory 保存当前事实投影；二者都不适合作为自动形成的长期操作
指引。可复用知识需要跨来源提炼、人工审阅、稳定修订和明确授权。它也需要随 Expert、ExpertTeam 或 Flow
分享，但不能退回到第二套 KnowledgeBase 对象，不能把原始 Evidence、Curator prompt 或本机路径装入
Bundle，也不能把模型输出直接提升为可召回指令。

## Decision

新增静态 learning Module `pragma.memory.knowledge`。它只通过只读 source port 读取 active、未过期、无冲突
的 Episodic/Semantic 精确修订，不写其他 Module Store。候选至少引用两个不同来源修订，或引用一条已验证
Semantic Fact，或引用一条 `valueScore >= 0.85` 的 Episode。提炼输入最多 100 个来源修订且不超过 78 KiB。

本地产物先保存为 `pending_review` Candidate。Candidate 不进入联邦召回，也不能导出；同一 root 下以
`normalizedKey` 去重，同一 source digest 被拒绝后不会重复生成，直到来源修订发生变化。待审候选固定为
最多 1,000 条或 64 MiB，超过上限进入 `needs_attention`，错误码为
`knowledge_candidate_capacity_exceeded`。

人工发布时必须逐项选择 Expert、ExpertTeam、Flow 或当前 Project binding，并至少允许一个 recall；export
默认 deny。公开可见性需要单独确认。发布、后继内容、权限收紧和撤回都生成同一 Knowledge id 的不可变
revision；扩大内容或权限必须重新进入 Candidate 审阅，不提供原地编辑。

Knowledge Context 使用 `memory/knowledge/summary.md`、`index.md` 和
`items/<id>/<revision>.md`。只有 active published revision 参与 list/search/read；历史精确 revision 仍按该
修订权限读取。Recall 同时匹配 root、当前 Expert 和 Host 注入的 Project principal。

Pragma Bundle 使用 required extension `pragma.memory.knowledge@v1`，不升级 Bundle 主协议。导出默认不选择
Knowledge，用户只能逐条选择精确 revision；Host 复查 active、export binding、root closure、sensitivity、
visibility 及所有 producer、binding 和 principal 映射。扩展只保存内容、权限、canonical JSON digest 和摘要化
provenance，不保存原始 Evidence。任一 binding 无法映射到 Bundle 资源闭包时整条 Knowledge 都不进入候选，
避免导出后静默扩大或改变授权语义。

导入 Bundle 的确认同时构成发布批准。导入项直接成为 active published revision，保留 recall/export 权限，
本地 id 由来源 Project fingerprint 与来源 Knowledge id 确定。相同来源 revision/digest 重试为 no-op；同一
revision 内容不一致 fail closed；更新的来源 revision 形成新的本地不可变 revision。导入 Knowledge 独立于
Bundle installation 生命周期：丢弃 Bundle 不删除它，UI 必须在确认前说明这一点。
同一批 Knowledge 导入、每条 revision 的 current 指针与治理事件写入一个 SQLite immediate transaction；
任一映射、digest 或写入失败都会回滚整批，重试继续由来源 identity/digest 保证幂等。

## Consequences

- 模型提炼不能绕过人工发布，本地 Candidate 与可召回 Knowledge 有明确安全边界；
- Knowledge 是 Memory Module，不产生 DSL KnowledgeBase/KnowledgeAsset，也不要求 Core 依赖 Memory；
- required extension 防止不理解 Knowledge 的旧 Host 静默忽略分享内容；
- Bundle 重试依靠来源 identity/digest 幂等恢复，整批导入失败不会留下无治理事件的部分 Knowledge，撤销
  Bundle 不被误解为删除长期知识；
- 阶段 7 的 Skill Candidate 可以读取 published Knowledge，但必须继续经过 Evaluation 与 Capability 升级。
