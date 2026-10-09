# Agent 分页游标

模型可见的分页结果应返回不超过 64 个 URL 安全字符的游标。游标是不透明的续页位置；调用方必须沿用原工具和过滤条件。偏移分页使用 `p1.` 前缀和定长 Base64url 载荷，包含作用域及过滤条件摘要、数据指纹摘要和偏移量，不包含原始查询词或 namespace。按末项定位的 `list_agents` 使用 `a1.` 前缀和定长 ID 摘要。两种编码都无服务端状态。

偏移游标解码时先校验长度、格式和作用域：格式损坏或工具、过滤条件不符为 `cursor_invalid`，数据指纹变化为 `cursor_expired`。模型可见工具的输入在过渡期接受旧版游标，包括可能超过 4096 字符的旧 Context namespace 游标；新响应只返回短游标。新增分页工具应复用 Core 的短游标编解码器，并为输出 Schema 设置 64 字符上限；不要将查询条件、ID 或完整哈希直接编码进返回字符串。

## 分页入口审计（#235）

| 入口                                                                                                        | 结果                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `list_dsl_resources`、`list_expert_options`、`list_missions`、`list_mission_work_items`、`list_automations` | 共用 Desktop 管理分页，已改为短游标。                                                                        |
| `knowledge_revision_list_targets`、`knowledge_revision_list_drafts`、`knowledge_revision_inspect_rebase`    | 共用 Desktop 管理分页，已改为短游标。                                                                        |
| `get_evaluation_draft`                                                                                      | 原游标包含查询词，已改为短游标。                                                                             |
| `list_expert_context`                                                                                       | 原游标包含 namespace，已改为短游标。                                                                         |
| `list_agents`                                                                                               | 可配置的 Context ID 长度不受限；改为固定长度的锚点游标，并继续接受原始 ID 游标。                             |
| Desktop Mission 聊天                                                                                        | 旧 entries 游标编码无限长的工具调用 ID，可能超过 2048 字符的协议上限；新版改用定长摘要锚点，仍读取旧版游标。 |
| CLI 列表、Mission 事件及 Desktop Memory 页面                                                                | 属于独立的 CLI、事件续传或 UI 协议；游标字段长度有界或不序列化为字符串，未发现同类问题。                     |

## Context 工具结果

Context 工具仅通过 `text` 返回一份有界结果，不再在 `details` 中重复正文、列表、回执或错误。列表保留资源摘要、信任与敏感级别、Store 诊断和续页游标；容量分配先为诊断和游标预留空间，不依赖重复副本补齐被截掉的信息；读取保留正文、并发版本、实际读取范围和必要的续读参数；写入返回不含正文的回执，不额外计算或返回内容哈希；revision 与 etag 相同时只返回 revision，不同则保留两种并发令牌；错误保留稳定错误码和恢复信息。需要完整领域对象的 Host 调用 ContextSystem API，不从模型工具的展示结果恢复领域对象。

Mission 工具预览生成和持久化共用 800 字符上限。工具预览中的省略号表示展示摘要，归档截短计数只统计持久化阶段进一步截短的字段。优化仅影响后续调用；历史 Execution 和展示副本保持原样读取，不改写原始执行事实或持久状态 Schema。
