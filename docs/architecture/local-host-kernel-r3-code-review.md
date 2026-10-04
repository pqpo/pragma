# Local Host Kernel R3 CR 与修复复核

2026-10-03。审查范围：独立工作树的 R3 实施相对 `origin/main` / `921376a446d9da878b8d9fa5c9f1df69ab323272`。审查先定位实际行为，再复现、修复和独立复核；不把审查者的所有怀疑直接当作缺陷。

本文记录 `8387482a` 的历史 CR；后续 PR #355 评论与修复见 [独立跟进报告](./local-host-kernel-r3-pr-355-followup.md)。本文通过项不代替后续执行内核收敛的冻结验证。

## 已确认问题

| 问题                                                                               | 影响                                                  | 修复与回归                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前 Execution 没有事实时，result 返回上一轮成功；summary 忽略匹配的 terminal      | 展示错误结果或状态                                    | 以实际当前 Execution 关联事实，缺事实明确不可用；当前 terminal 更新 summary。真实 repository/query 回归。                                                                                                                                                            |
| UUID 目录迁移后，已构造 controller 仍写旧路径                                      | 两个 aggregate / lease authority                      | 默认路径在原 aggregate 锁内跟随已发布 canonical owner；活跃 lease 仍拒绝迁移。真实迁移后旧实例重新 claim 回归。                                                                                                                                                      |
| Desktop 注入的 CLI facade 使用完整 envelope 读取，拒绝 controller-only Mission     | get/list/watch/Board 入口失效，查询绕过历史迁移       | 两端共用 read ports；保留 sparse controller 事实，不伪造 renderer Mission。实际注入 facade 与两种格式回归。                                                                                                                                                          |
| retention 清除 successor Session 关联证据                                          | 恢复旧 Session 或丢失持久关联                         | 有界保留最新 send Session 指针及初始实际 Session anchor；索引构造为线性。真实 successor + aggregate compaction 回归。                                                                                                                                                |
| schema-less Flow 的 scalar / array / null 被 envelope 限制拒绝或改写               | 既有合法输入无法执行                                  | 对不属于 v11 object envelope 的输入使用既有 controller-only 格式；只对 undefined 应用默认输入。四种实际 Node Flow 输入回归。                                                                                                                                         |
| 旧 terminal 借用当前 claim，并继续 metadata / enrichment 写入                      | 接管后旧回调产生副作用                                | 捕获原 guard；精确 fencing 拒绝后停止后续写入，仍清理旧观察器。实际 controller 与 Desktop factory 回归。                                                                                                                                                             |
| resume await 恢复后借用新 guard 完成操作和释放                                     | 旧恢复完成 / 失败破坏新 owner                         | operation、等待、人工响应和 cleanup 全链传原 guard；resume 保持 pending 到底层释放后才提交结果，避免与自动 settlement 循环等待。真实 force revoke / reacquire 与两格式 facade 人工恢复回归。                                                                         |
| recovered / unbacked 自动 settlement 使用当前 guard                                | 旧 native 收尾释放后继 lease                          | settlement 与最终 release 校验原 claim；原生释放阻塞期间替换 claim 回归。                                                                                                                                                                                            |
| Flow idle、冷恢复及 checkpoint 释放未确认 native，或通过取消破坏 waiting           | lease 过早释放，人工等待无法恢复                      | Core 提供纯 Runtime / graph 释放出口；按真实 Human Invocation 等待事实 checkpoint，terminal 不调用 waiting checkpoint；释放后可立即同 App recover 新 handle。真实 native 阻塞与人工等待恢复回归。                                                                    |
| Memory 按 Mission ID 清理，阻塞 stop 进入串行登记链；暖 controller-only 缺重新绑定 | 迟到 terminal 关闭新资源，下一轮阻塞或 Attention 失效 | 明确 Execution 与 binding generation、登记新 prompt、独立后台 stop/flush、idle close 保留 pending barrier；暖 Session 复用实际 Context resolver。失败 admission 撤销 intent，并后台重放 intent 期间的旧终态，不阻塞下一轮。阻塞 Memory、多轮、失败前后终态竞态回归。 |

独立复核指出并修复了 Flow waiting 冷释放、controller-only 新 ID 登记、自动清理原 guard 三处首轮漏项。随后核对后台 enrichment 的正常 lease 释放顺序，避免新增 guard 校验错误跳过正常 Memory 清理。

已驳回：CLI 自动 Run outcome 必然在 Flow native 释放前完成。该路径已经等待 Core 事件泵的原生收尾；确认的问题位于直接 idle / recover / checkpoint 释放出口。未以怀疑替换既有成功能力。

完整统一门禁另复现了活跃 Mission 删除先撤销 lease、再取消旧 Session 的顺序错误：原 guard 正确拒绝取消，却使已冻结删除失败。修复在 admission 冻结后保留原 lease，由既有 terminalDelete 停止 consumer、确认 Native 停止并移动 owner 图；不绕过旧 guard，不吞原生停止错误。另修正 Memory 终态后台重放函数的参数类型，不伪造 status。原失败回归与 Native 拒绝/重试回归已通过，独立复核确认关闭。另用实际双 scope 验证外部活跃 lease：第二个 execution service 的 delete 返回 `MISSION_LEASE_HELD`，第一个 scope 的原 guard 与 snapshot claim 保持有效，Mission 文件保留。

## 最终验证

修复工程提交：`8387482a0374fd9ac466b387fbb8fd8b478254b2`。本轮 11 组已确认问题全部修复并通过独立复核，未关闭的已确认 CR 问题为 0。核心验证结果见下表。

| 门禁                                                      | 修复后结果                                                                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `test:mission-lifecycle`                                  | Host 166；Desktop 92 通过、2 默认跳过                                                                                         |
| `test:mission-compilation`                                | Host 98；Desktop 17 通过                                                                                                      |
| `test:mission-control`                                    | Host 135；选中 Core 6、Desktop 4 通过                                                                                         |
| `test:mission-chat`                                       | Core 2、Memory 3、Host 44、renderer 66、选中 runner 6 通过                                                                    |
| `test:revision`                                           | Built-in 13、Desktop 69、选中 runner 6 通过                                                                                   |
| CLI 全测试 / Memory / Core Flow 专项                      | 108 / 9 / 6 通过                                                                                                              |
| `pnpm check` / `pnpm build`                               | runtime feature、DSL version、lint、typecheck、Core 门禁与 19 个构建任务通过；main/preload/Bridge/storage worker 产物验证通过 |
| CLI pack / packed audit / release report / positive smoke | 隔离安装和实际产物运行通过                                                                                                    |
| Native Codex suspended-process 删除                       | 单项通过；约 15.2s 未确认停止拒绝并保留文件，恢复进程后约 0.8s 重试成功                                                       |

编译/control/chat/revision 的通过发生在最后一处删除顺序和 callback 参数类型修正前；最终 lifecycle/check/native 已覆盖这两处改动。不同门禁包含重叠测试，不累加总数。默认 lifecycle 跳过原生 Codex 删除和五样本删除 benchmark；前者本轮另行通过，后者未运行。

完整门禁发现的删除拒绝和 TypeScript 递归参数错误均已修复后重跑通过。一次 CLI 构建前置钩子以及一次 lifecycle 子进程启动标记在并发依赖重构建时超时，保持源码、超时和断言不变，串行完整重跑分别 108、166 + 92 通过；并发干扰是根据前后运行推断，未证明另有生产根因。保留失败记录，不将早期局部通过当作最终门禁。

历史实施验证见 [R3 实施报告](./local-host-kernel-r3-implementation.md)，首次冻结提交的性能与测试不替代本轮修复后证据。

[修复后串行性能对照](../performance/local-host-kernel-r3-cr-comparison.md)：两组各场景 20 次；初始 cold、model-invalidation、capability-invalidation 触发后分别追加两组每侧 40 次，未持续触发原指标。记录全部初始异常与追加的一次 terminal 尾部触发结论；存储/准备可比较指标未触发。生产源码前后摘要一致。

## 验收边界

本轮“修复全部问题”仅指审查中复现并确认的缺陷全部关闭，不保证不存在任何未知缺陷。R1 / R2 / R3 的真实模型、OS 凭据、完整 Electron 产品和正常后台负载性能验收缺口继续保留；不将 R3 阶段标为完成，不关闭 issue #348。
