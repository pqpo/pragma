# ADR 061: Memory 向量检索与任务 Attention

- Status: Accepted
- Date: 2026-09-29
- Related: [Issue #326](https://github.com/pqpo/pragma/issues/326)
- Supersedes in part: [ADR 058](./058-mission-memory-attention.md) 的候选检索、判断预算、Lens 内容和状态版本；其 Host、权限、提示及删除边界继续有效。

## Context

全文子串搜索容易遗漏中文、英文改写和历史处理过程。Attention 只给出标题与链接时，Agent 仍需重新发现具体历史；一次固定候选判断无法有界地核验细节和直接冲突。
记忆正文和访问策略是权威数据，Embedding 只能作为可重建候选索引，不能成为新的记忆来源或权限边界。

## Decision

模型协议以 `kind: generation | embedding` 区分能力。Embedding 不进入 Pi 生成模型目录；首版只支持 OpenAI-compatible `/embeddings`。
供应商页负责模型、输入限制、端点和凭据，Memory 页只选择已确认输入限制的 Embedding 模型并启停检索。
共享 provider reader、当前 Schema、相邻迁移和 SecretStore 凭据解析归 `local-host`；Desktop 保留变更、发现、验证及历史 v4 凭据迁移。CLI 的原生 Runtime 认证不变。

`memory` 拥有正文投影、HTTP Embedding adapter、SQLite cache worker、indexer 和 Attention。
Episodic `overview`、尝试过程、失败/恢复，以及 Semantic statement/predicate/value 分别完整投影；不向 Embedding 发送 Evidence 正文、原始 record JSON 或凭据。
所有切片、批次和请求预算使用 Core `RuntimeTokenCounter`，Unicode code point 边界不会被截断。片段记录字段路径、范围和脱敏文本 SHA-256。
供应商明确拒绝过长输入时按更小限制重新切片，不丢弃尾部正文；响应必须按 index 排序、维度一致、有限且非零，并归一化为 Float32。

权威 SQLite 的 INSERT/UPDATE/DELETE 与序列 outbox 在同一事务内发生。Outbox 按记忆 ID 合并，确认使用 ID + sequence CAS。
cache 位于 `cache/memory/retrieval/vectors.sqlite`，向量为 Float32 BLOB；精确 cosine 扫描在 worker 执行。
首次回填使用持久 keyset cursor；增量、失败记录及中断均可重放。未完成或含失败项的 generation 不激活。
只在同一 generation 内复用相同正文 hash；metadata 修订更新索引引用版本。忘记、限制访问、过期和删除移除向量。
新 generation 完整建成后原子切换 active binding，再清除旧 generation。

Desktop 在首个窗口创建后才消费回填/增量；CLI 只读已存在的 cache，不建库、不处理 outbox、不启动 daemon。
供应商或端点变化立即取消在途请求，回退文字检索。相同供应商/端点更换模型时，可继续用旧完整 generation 及其原模型查询，直到新 generation 激活；旧 generation 不嵌入新记录。
网络请求禁止 URL 内凭据、查询参数和 fragment；只允许 HTTPS 或 loopback HTTP，拒绝 redirect。

候选搜索先从 authority 获取授权 ID + revision，再进行 worker top-K；返回后重新校验当前记录、字段 hash、scope 与配置。
显式用户 search 以等权 RRF 合并文字与向量，返回 canonical Context 路径；不触发 Jev 扩展。
Attention 根据 currentGoal、meaningful taskVersion 和最新脱敏观察查询，每类约 15 条，总计最多 30 条。
Jev Score `/4` 为相关性，confidence 单独存储；Noul 判断新颖性/继续条件，Choice 仅选择 Host 生成的封闭 detail/expand action ID。
扩展 query 来自实际选中正文，关系限于授权的同 conversation/execution 或直接冲突；visited 集合防止反复扩展。

每个判断最多三轮、十二次详情/关系读取、八条最终记录、二十次 HTTP（含重试）、40k 输入 tokens、256 KiB 累计输入和二十秒。
Host 并发二；手动向量查询三秒。Query vector LRU 32 项；decision LRU 64 项、60 秒，仅内存保存，key 使用 digest。
未配置/暂不可用 Jev 时仅保留最多三条 similarity ≥ 0.8 的 `vector_unassessed` 条目，不扩展；该阈值是工程距离规则，不表示概率。
失败时保留仍有效的已有记录；诊断报告所属 Module 和稳定错误码，不持久化任务、query、凭据或上游错误正文。

Attention v2 保存 `decisionMode`、`pinned: false`、片段路径/范围/hash。Lens 最多 3000 tokens / 24 KiB，按完整条目裁剪。
Episodic 展示真实选中历史片段；Semantic 展示完整事实、来源置信度、时效及已授权的冲突引用。selection relevance 不替代来源 confidence。
Guide、overview、系统提示与一次性短提示机制保持原职责，正文仍由 Agent 按需读取。

## Upgrade boundary

| Owner                             | 旧版本 → 当前 | 机制                                                                                            |
| --------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| model-providers.json              | 5 → 6 → 7     | local-host 静态相邻注册、file lock、逐步备份、stable journal、原子替换；Desktop v4 凭据入口保留 |
| episodic episodes.sqlite          | 4 → 5         | 当前 owner 首次访问，已有数据库迁移锁/备份机制，事务安装 outbox                                 |
| semantic facts.sqlite             | 5 → 6         | 同上；jobs 数据库版本不变                                                                       |
| Attention Context state           | v1 → v2       | Context 首读 file lock、SHA-256 备份、stable journal、原子替换                                  |
| retrieval settings / vector cache | 新 v1         | 独立 family；未来版本拒绝，原文件保留，不自动清库                                               |

不适用无迁移例外。历史 fixture 由真实旧 writer 生成，见 [fixture provenance](../../packages/memory/test/fixtures/retrieval/README.md)。
迁移在最小 owner 访问时发生，不在应用启动时扫描所有 Mission 或数据库。

## Consequences

- Embedding 设置启用意味着许可内脱敏记忆投影及 query 会发给选定供应商；Jev 的独立启用仍表示摘要判断授权。
- cache 损坏或模型故障不阻断 Execution 和文字 search；认证/协议故障进入 degraded，显式 Retry 或 provider revision 变化唤醒失败项。
- Exact scan 便于审计和精确权限筛选；大库延迟、Float32 存储和 worker RSS 需要持续测量，未来 ANN 必须保留同样的授权和 revision 边界。
- 离线参考 encoder 只验证中英文检索链路；真实模型质量必须另运行显式凭据授权的 live evaluation，不能把 fixture 结果视为供应商效果。

验证和可复现实验见 [Issue #326 验证](../validation/issue-326-memory-retrieval.md)。
