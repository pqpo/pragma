# Codex Steer 竞态修复 CR

审核范围：本 worktree 的 Codex RPC 错误分类、Core 队列承接、Desktop / Local Host 投影及相关测试。
逐项检查了触发路径和持久状态；以下五项成立，已修复。二次复核未发现本次范围内的未处理问题。

| 优先级 | 问题与影响                                                                                                                  | 修复与验证                                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1     | 不确定投递只能通过便捷 API 防重，直接调用队列 Steer 或用相同 requestId 将失败的 strict Steer 转为 enqueue，仍可能重复执行。 | Core 在读取和事务声明两个位置拒绝不确定队列投递；Store 只允许确定 `not_dispatched` 的 strict 记录降级。真实 Adapter 集成测试及 Core 幂等回归覆盖。                      |
| P1     | 不确定状态落盘后，暂停事件写入失败会跳过内存暂停；刷新后的投影也只依赖事件，可能恢复执行或显示错误状态。                    | 持久化 deliveryAttempt 是暂停的权威依据，调度、Core 查询、Desktop 和 Local Host 均检查它；先设置内存暂停再写诊断事件。覆盖事件写入失败及删除暂停事件后的 Desktop 投影。 |
| P1     | 清空队列后，迟到的拒绝 / 未知回复和恢复扫描可能将取消记录重新排队；strict Steer 的迟到拒绝也可能触发 enqueue fallback。     | 状态与 attemptId 校验保护恢复路径；strict 完成和恢复不覆盖 cancelled 记录。集成测试分别覆盖两种入口、确定拒绝和未知错误，且再次执行恢复扫描。                           |
| P1     | Codex 返回空成功结果或错误 turnId 也被当作确认成功，原排队消息会被移走。                                                    | `turn/steer` 成功必须返回预期 turnId，否则按未知投递处理；低层测试覆盖五种非法结果，集成测试验证保留消息与暂停队列。                                                    |
| P2     | 排队 Steer 设置调度闸门后等待“未来活动轮”，可能阻止自己所等待的排队轮启动；本地超时还会被归为未知投递。                     | 排队 Steer 只等待已经被声明的活动轮；未调用 Runtime 的无活动轮 / 启动超时返回 `SteerNotDispatchedError`。覆盖旧轮结束后对后续排队项再次调用 Steer。                     |

验证包含真实 Codex Adapter、RPC Client、Core ExpertSession 和文件 Store，供应商 stdio peer 可控；
同时覆盖队列恢复的子进程崩溃测试、Mission Runner 投影和 renderer 不确定状态展示。
本次未进行真实模型调用中的轮末竞态测试，也未切换到 ACP。

最终验证结果：

- Codex 全包 76 项通过；补齐 strict 取消保护后，最终 12 项 Steer 集成用例全部通过。
- Core 队列相关 11 项、子进程崩溃恢复 1 项、Local Host 投影 2 项全部通过。
- Desktop Host 3 项、renderer 9 项全部通过，包含缺失暂停事件后的刷新状态。
- 依赖构建、Core / Codex / Local Host 类型检查、Desktop Node 类型检查、改动文件 ESLint、
  样式校验及 `git diff --check` 通过。

## PR #330 评论复核

已读取 PR 的讨论、review body 和逐行评论。人工 review 的两项 P2 均成立；自动 review 的
订阅泄漏评论与第一项为同一问题。

- 排队 Execution 在订阅后、启动前取消或中断时，Live Bus 不保证 complete。观察器现在收到
  `execution.cancelled` / `execution.interrupted` / `execution.failed` / `execution.succeeded`
  即返回，finally 关闭订阅，调用方 finally 删除对应的 `queuedTurnObservers` 条目。
  回归保持 Live Bus 未 complete，验证 Promise 结算、close 以及迟到 start 不重新接管页面。
- strict Steer 的 `failed/not_dispatched` 记录落盘后、enqueue fallback 提交前存在崩溃窗口。
  相同 requestId 的显式 enqueue fallback 重放现在先读取既有投递事实，校验内容，再由 Store
  原子 replacement 恢复排队，不重新调用 native Steer。没有 fallback 的 strict 重试仍失败，
  不确定投递、内容冲突与取消保护保持原有规则。
  新回归在真实子进程中经 Runtime 拒绝写出记录，在 fallback 提交前 SIGKILL；恢复后保持另一轮
  活动，验证重放成功、native Steer 调用为零、只有一个 enqueue Execution 并正常完成。
  该进程崩溃测试单独放在 `strict-steer-fallback-crash.test.ts`，不增加默认快速测试门禁的 I/O。

两项新回归都验证了旧实现失败：旧观察器在取消事件后超时；旧 Core 在崩溃重放时于
`duplicate.status === "failed"` 分支抛出普通 Error，无法完成 fallback。恢复修复后，观察器
7 项、崩溃重放 1 项、Core Steer 相关 5 项、既有 Codex Steer 集成 12 项及 Desktop 队列/清理
相关 12 项通过。崩溃测试显式等待 Runtime 的 `rawQuery` 对应轮实际启动，并用 gate 保持它活动，
避免只依赖短暂 running 状态造成误通过。

## 与 OpenCode steer PR #329 合并后的恢复边界

公共 Core 保留 receipt / terminal recovery 契约：不确定或正在投递的消息禁止清空队列及自动重放；Codex 使用显式 terminal abandon，普通 resume 不清除 uncertain 标记。迟到回复的取消回归通过显式关闭 Session 并恢复已关闭 Session 验证，同步断言普通 queue clear 无法绕过投递 fence。队列观察器、明确拒绝的 strict fallback 崩溃恢复及关闭／attempt identity 防复活保护保持有效。
