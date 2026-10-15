# 记忆工具提炼 CR 与复审记录

日期：2026-10-15。范围：本次 Memory Curator 工具提炼改动及其调用、恢复、删除、权限与持久化边界。
审查后逐条核实，确认的问题均已修复；复审未发现仍未解决的阻塞项。此结论限于本次改动和下列验证范围。

| 问题                                                              | 修复                                                                                        | 回归依据                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 证据交付 token 预算耗尽后，已读候选的提交和完成也被阻断           | 预算在交付正文时检查；提交与完成不再消耗正文预算，完成允许在调用上限后收尾                  | `extraction-session.test.ts`：耗尽交付预算后仍提交并完成              |
| 已有 Episode 只返回被截断的目标、摘要和结果，遗漏尝试及恢复       | 所有语义段落分页读取，返回字符 cursor；每页有 token 上限                                    | 同文件：跨页读取完整尝试、结果、失败、恢复与最终结果                  |
| 工具正文中常见凭据格式脱敏不完整                                  | 覆盖带引号/空格的值、Authorization、独立 Bearer、access/refresh token                       | 同文件：六类凭据格式参数化回归                                        |
| 提炼配置读取失败被当作坏事件隔离，推进游标导致正文丢失            | 配置在事件批次处理前读取；失败用稳定错误码抛出，保持游标不变                                | `memory-plane-execution.test.ts`：配置失败后修复，原事件完整重放      |
| 会话运行中关闭工具内容授权仍可继续读取；恢复可能使用旧范围回执    | 每次工具调用及落库前复查授权；内置 extractor 恢复时比对当前证据及允许主体；保存权限错误诊断 | Session、内置 Curator 测试：撤权阻止读取/完成，证据或主体变化拒绝复用 |
| 查询页未展示的 Fact 仍被登记为可用 handle                         | 只在确认条目能进入交付页面后登记                                                            | Session 测试：未交付的下一 handle 必须拒绝                            |
| Episode 各段引用合法，但合计超过持久层 500 条限制，要到落库才失败 | 完成工具写回执前验证聚合引用上限                                                            | Session 测试：501 条引用不生成完成回执                                |
| 既有迁移测试存在错误最终版本断言和不完整历史 schema               | 使用真实历史 writer 输出的 SQL fixture，修正当前版本断言并记录来源                          | `memory-job-v3-migration.test.ts`：10 项通过，生产迁移链未修改        |

## 验证

- Memory：Session 与迁移测试 31 项；Semantic、Episodic、settings、Memory Plane、activity 测试 84 项。
- Built-in Agents：Curator 与 DSL 编译测试 17 项。
- Local Host：真实 Execution → Feed → 工具正文读取边界测试 4 项。
- Desktop：Curator Mission 适配测试 8 项。
- 合计 144 项针对性测试；未运行仓库全量测试。
- Memory / Built-in Agents lint、构建和相关 TypeScript 检查，以及 Desktop 打包产物验证用于检查跨包与宿主边界。

原有真实 Codex Runtime 冒烟结果保留在[实现验证记录](./tool-driven-memory-extraction.md)。
本轮 CR 没有再次运行真实模型；新增问题通过确定性的回归和真实本地持久化边界验证。

## PR #403 评论复核与修复

复核范围：PR 中的 2 条会话评论、1 条 review 正文与 1 条行内审查意见；自动审查的 provenance
意见与维护者评论第 5 项重复。维护者的 5 类 P1/P2 问题均成立，均已修复。

来源：[维护者评论](https://github.com/pqpo/pragma/pull/403#issuecomment-6188573264)、
[自动审查](https://github.com/pqpo/pragma/pull/403#discussion_r4280421080)。

| 评论                          | 修复及回归                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内联证据授权竞态              | 工具正文永不内联到 Mission Goal；`startRun` 前及 capability source 解析时调用 Session 的实时授权检查。真实 Mission 存储测试分别模拟创建 Goal 后撤权、编译阶段撤权，均阻止继续执行。                         |
| 私钥及典型令牌泄漏            | 脱敏完整/截断 PEM、OpenSSH 私钥块、GitHub、Slack 等格式令牌和嵌套敏感字段；Execution/Feed 测试以真实生成的临时 Ed25519 私钥验证完整结果、inputPreview、outputPreview 三条采集路径。                         |
| 证据数大于调用上限            | 每次 `read_evidence` 批量读取最多 20 条相邻证据，仍受 2,000 tokens/页和 admission 总预算约束；返回下一 evidence 与 cursor。130 条用户证据加终态事件在一次 admission 内完成并落库 Fact，未放宽完整阅读要求。 |
| 失效 Property handle          | 复用 `pN` 时对原 Fact 重新检查 `canUseFact(id, revision)`，覆盖撤权、过期和修订变化。                                                                                                                       |
| provenance 过早或缺少实际模型 | Runtime 成功结束后读取终态诊断，以实际 `responseModel` 和执行完成时间更新持久回执；临时诊断错误最多重读 4 次，绝不因此重跑模型；回归核对返回值与重新打开的回执一致。                                        |

验证：Memory 五个相关测试文件 122 项、Built-in Agents 17 项、Local Host 4 项、Desktop 12 项，
共 155 项针对性测试通过；相关 lint、TypeScript、包构建和 Desktop 打包验证通过。未运行仓库全量测试，
本轮没有再次执行真实模型冒烟。此前真实 Runtime 验证记录仍保留。

评论中将 Desktop 编排下沉至共享 Local Host 的建议被明确标为非阻塞后续工作；本次不扩大重构范围。
