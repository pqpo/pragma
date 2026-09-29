# Issue #326 Code Review

日期：2026-09-29。审查对象：`feat/issue-326-memory-retrieval` 中 Issue #326 的实现和本轮修复。

审查覆盖 Embedding adapter、权威数据库/outbox、向量 worker/indexer、Host 配置和查询、Attention 触发与预算、持久状态迁移、Desktop 配置和 CLI 打包边界。首轮七项和后续评论复核追加的一项均已修复；没有遗留的已确认问题。

## 已确认并修复的问题

| 编号  | 级别 | 触发与原行为                                                                                                      | 修复                                                                                                                                  | 回归证明                                                                                                                      |
| ----- | ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CR-01 | P1   | 手动搜索先取得全文摘录，再等待向量 HTTP；等待期间执行 Forget 后，旧全文摘录仍会发布。                             | 网络检索完成后重新从当前 authority 构建全文投影；保留最终 scope 复核。                                                                | Episodic 集成测试在向量回调中真实 Forget，并断言权威记录消失、所有全文结果为空。                                              |
| CR-02 | P2   | 索引收到 401 等永久故障后点击 Rebuild，cache 已清空，但旧 indexer 的永久错误/退避状态仍阻止回填。                 | 等待在途 pass 完成，暂停后台 tick，丢弃旧 indexer，再 reset 并强制启动新 pass。                                                       | Host 集成测试先返回 401，再恢复供应商；不修改配置即可重建两条历史记忆。                                                       |
| CR-03 | P2   | 去抖期间旧 `new_error` 覆盖后续目标变化或任务版本；`isCurrent` 拒绝旧输入，最新任务没有评估。                     | 目标变化替换待处理事件；同一目标的普通观察保留失败内容，同时使用最新 taskVersion。                                                    | 两个 Attention 回归分别覆盖目标变化和普通事件推进版本，断言实际 Provider 输入。                                               |
| CR-04 | P2   | 连接测试固定发送两条较长输入，合法的 `maxBatchInputs=1` 或很小 token 限制会在发送前报错。                         | 使用短探针；批量能力和 token 预算允许时测试两条，否则测试一条。                                                                       | 单条输入、单 token 限制的真实 adapter 测试成功，且只有一次 HTTP。                                                             |
| CR-05 | P2   | 端点校验位于网络重试 catch 内，非法远程 HTTP 或 URL 查询参数被误报为网络故障，并重复读取凭据。                    | 在凭据读取和网络重试前校验端点，返回稳定的 `embedding_endpoint_invalid`。                                                             | 两种非法端点均拒绝；没有凭据读取或 HTTP 请求。                                                                                |
| CR-06 | P2   | CLI 查询失败后即使后续查询成功，旧错误仍留在共享状态；CLI 没有后台 tick 清除它。Host 主动取消也可能被记成故障。   | 查询错误与索引错误分开保存；查询成功只清查询错误，取消按组合 signal 识别。                                                            | 只读 CLI 先鉴权失败，再成功返回授权候选，状态恢复 ready。                                                                     |
| CR-07 | P2   | 检索关闭或 indexer 永久退避时不消费删除；更换模型失败时删除还只针对新 generation，旧 active generation 残留向量。 | 从 outbox 定向读取删除/失效/受限/过期项，在模型解析与退避 gate 前跨 generation 清理，使用 sequence CAS 确认；不开新空库，不调用模型。 | 真实历史数据库测试分别覆盖关闭检索与新代际 401；Forget/Invalidate 后各代际 segments 清空、删除 outbox 清空、HTTP 次数不增加。 |

修复没有新增持久协议版本：authority/outbox Schema、cache Schema 和 Attention v2 格式均未改变。新增 outbox 删除读取属于当前 Schema 的定向查询。

## 复核后未认定为问题的假设

- Host 反复读取 binding 会重置单次 Jev 判断预算：一次判断捕获同一个 Provider 实例，后续阶段与重试共享同一 AbortSignal 的预算；用于有效性复核的新 binding 不替换该实例。
- 授权仅在向量 top-K 之后过滤：worker 在排序前接收并检查授权 ID/revision，Host 在发布前再次核对当前 authority；已有集成测试覆盖。
- 删除旧模型目录条目会导致旧索引使用新模型查询：旧 active binding 保留原模型及限制，查询使用原模型，直到新 generation 完成后切换；Host 回归覆盖此情况。

## 首轮验证

本轮新增九个回归案例，涉及真实 authority SQLite、真实 cache worker、加密凭据存储和真实联邦 Context 投影；外部供应商 HTTP 使用可控响应。

最终检查均通过：

- `pnpm lint`：19 个任务通过。
- `pnpm typecheck`：19 个任务通过，包括 Desktop main/renderer 与 CLI。
- `pnpm test:core`：11 个任务通过；本轮实际执行 Memory 98 项、Local Host 11 项和 Desktop 启动 5 项，其余未变更的领域复用通过的缓存。
- Desktop 专项：连接测试与 Memory Plane 共 11 项通过。
- `pnpm build`：19 个任务通过，包括 Desktop 生产构建、main/preload 自包含与 Bridge 验证，以及 CLI worker 构建。
- CLI `package:pack`：实际 tarball 打包与审计通过，未发布。
- 本轮变更的 Prettier 检查及 `git diff --check` 通过。

CR-01 另使用隔离的旧执行顺序副本复现：权威 Forget 已成功，仍返回四条旧摘录；修复后的正式集成测试返回空列表。临时副本已删除。其他问题的初次失败与修复后通过也保留在本机 `/tmp/pragma-326-cr-*.log`，日志不作为需要提交的产物。

原实现的性能、离线检索评测与 UI 检查见 [实现验证](./issue-326-memory-retrieval.md)。本轮未使用真实 Embedding/Jev 凭据，真实供应商联调和模型质量评测仍不属于已验证结果。

## 评论复核：CR-08，候选判断结果契约（P2）

[用户评论](https://github.com/pqpo/pragma/issues/326#issuecomment-5884571439) 指出 Provider 结果的 key 可以缺失、重复或未知，Controller 转成 Map 后会静默接受。经测试确认，这是首轮 CR 遗漏的问题。缺失并非被显式赋了低分，而是候选未获得判断却被当作该轮处理完成；无效批次中的部分低分还可能错误淘汰已有 Attention。

修复：

- `CandidateDecisionSchema` 拒绝重复 key；Controller 校验响应数量及 key 集合与请求候选完全一致。
- 每轮捕获候选快照及 SHA-256 digest，包含 revision 和正文/元数据；返回后核验快照未改变，并在任何选择或展开之前复核当前 authority revision。
- 非法结果报告 `attention_response_invalid`，audit 记为 failed，保留仍有效的已有 Attention，不把不可用判断当作负向证据；仍允许既有的独立保守降级路径。
- 关联读取与向量扩展合并时按候选身份去重，避免同一记录来自两条路径时产生重复请求候选。

已有防护也经复核：Jev HTTP adapter 已要求每个请求问题均有有效答案；Host 判断缓存的 digest 已包含完整输入和候选 revision；批次间的请求前 guard 原本已经有效。新增返回后 guard 补齐了最后一批响应与选择/展开之间的检查。

没有修改持久 Attention v2、authority、cache 格式，也没有要求供应商输出额外的 digest 字段；绑定由 Host 的请求快照、缓存身份和 authority 复核实现。

新增八个用例覆盖缺失、重复、未知 key、批次间/末批 revision 变化、快照变化、合法重排与空候选；同时扩充既有扩展测试，覆盖关联和向量命中重叠。修复前五个针对性用例中四个失败，已有批次间 guard 的用例通过；修复后均通过。

追加修复的最终验证：Memory 106 项、Local Host 11 项、Desktop Memory Plane 10 项通过；Memory lint、typecheck、build 及变更格式检查通过。外部 HTTP 使用可控响应，未执行真实供应商联调。首轮的完整 workspace 构建结果记录在上方，不冒充本次重新执行的全仓库检查。
