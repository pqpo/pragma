# Issue #348 R4：PR #356 评论修复

最新评论复查与遗留稳定性缺口见 [PR recheck](local-host-kernel-r4-pr-recheck.md)。

2026-10-05；审查基于 `cf5f935`，本次读取 PR 的全部普通评论、行内评论和 review。机器人汇总没有独立修改要求；其余意见均确认适用。

| 评论                                                                                       | 判断与处理                                                                                                                                            | 回归边界                                                                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Human catch-up 错误传播](https://github.com/pqpo/pragma/pull/356#issuecomment-5986197166) | 确认：独立 failure Promise 进入 handle.result，pump 保留拒绝；iterator 与 result 均收到原错误                                                         | 真 SQLite；Native 完成与等待审批；实际 CLI onEvent/outcome，失败退出与定向 lease 释放          |
| [claim/dispose 竞态](https://github.com/pqpo/pragma/pull/356#issuecomment-5986197166)      | 确认：先封闭普通 acquisition/admission，等待已进入持久化的 claim，再使用最终 guard 释放                                                               | 真 controller gated claim、禁止 shutdown 后启动 Runtime、successor CAS、失败 retry             |
| [实际关闭接线](https://github.com/pqpo/pragma/pull/356#issuecomment-5986197166)            | 确认：Desktop before-quit 等待共享 dispose，未确认 Native stop 时阻止退出并保留资源；CLI 自建 Host 在命令结束时关闭，借入 Host 由调用方管理           | Electron quit 契约、Native 失败重试和资源顺序；CLI 普通关闭、错误退出、borrowed Host 与 detach |
| [终端 receipt 投递中断](https://github.com/pqpo/pragma/pull/356#discussion_r4177437834)    | 确认：终端持续 delivery；关闭前 canonical facts 转交 durable receipts。show/query 定向恢复该 Mission，保持 backoff、其他 Host lease 和无 Runtime 边界 | 真 Node facade、metadata/history/Memory/archive 恢复、只读立即 dispose、其他 owner 不被抢占    |

CLI detach 接受任务后仍由当前进程执行。返回 accepted 时不取消 Native；引用工作结束后的 beforeExit 调用相同共享关闭，仅在关闭期间保活。共享关闭对持久 Human waiting 使用既有 Core checkpoint/kernel release，保留恢复语义；普通 lease-loss 路径继续执行原停止策略。

完整 Host 关闭等待已接受的 receipt recovery 和 Memory completion；只调用 version/help 的未使用 facade 不启动 Memory/feed。普通失败 receipt 保留 attempt 与 backoff，只重新唤醒正常延期的投递。

CI 原失败位于 Mission delivery intake 恢复测试：生产首次 retry 为一秒，而 Vitest 默认等待也为一秒。调整该测试的等待上限，保留实际 retry/backoff；不把原失败 CI 当作通过证据。

复审追加修复：Desktop 资源与 Memory Plane 记录成功关闭步骤，部分失败重试不重复关闭已关闭的 SQLite；只读恢复与共享 shutdown 共用 owner-scope 的失败 lease 释放 custody，按原 guard 重试并保留 successor CAS。

完整门禁首轮发现并继续修复：controller-only Human checkpoint 的显式恢复释放路径遗漏 Memory completion，Native owner 已释放后，Memory owner 却未清除。修复通过共享 Native 释放边界通知资源 completion，保留实际 Execution ID 和原 lease 策略。旧路径迁移测试则在删除目录前补齐自建 Host dispose，避免异步只读恢复与清理争锁。保留首轮失败日志，不扩大关闭超时或增加删除重试。

关闭真实 SIGKILL 接管 fixture 时继续发现旧 Session observer 等待仅由原 Core 实例通知的 promise，导致 Native 已释放仍无法 dispose。共享释放资源端口现在在真实 Native Kernel release 成功后，按实际 Execution ID 通知并等待 observer/订阅清理，再删除 owner；未确认 Native 停止时不发该信号。测试 fixture 统一先关闭所有自建 Host，再恢复 mock 和删除目录，不吞关闭失败。

Native 已确认释放的 observer 不再附着下一 Session turn，避免仍保留 queued prompt 时等待或重新创建 observer；普通运行中的后继 turn 行为保留。

Desktop 全套复验进一步发现普通 Native release 等待了后台 Memory completion，破坏可选后台任务不阻塞控制的边界。现在普通释放只等待 Native/observer，资源任务在返回前同步登记并独立投递；完整 dispose 在 Native 释放后循环排空，再关闭资源。真实两端接管保留 blocked Memory 断言和原 30 秒上限，并新增关闭资源必须在 Memory 完成后的断言；独立复审未发现剩余已确认缺陷。

## 最终验证

Node 24.18.0 / pnpm 10.12.1；最终串行门禁全部通过。最终生产源码 1160 文件，SHA-256 `4ff92e8dd60d7ca28e36b5a6f3f5dae5f07b3e0c3dbd0c10c5576443bdcf7539`，门禁前后相同；最后后台登记改动另补 Local Host typecheck、ESLint/build 后再进入完整业务门禁。

| 验证                                        | 结果                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm check` / `pnpm build`                 | 通过；Desktop main/preload/Bridge/storage worker 产物契约通过         |
| CLI 测试入口的共享底层业务门禁              | 100 文件，923 passed、1 skipped                                       |
| CLI 契约                                    | 15 文件，114 passed                                                   |
| Desktop composition/IPC/平台契约            | 9 文件，113 passed、2 skipped                                         |
| Desktop 内部调用适配                        | 8 文件，37 passed                                                     |
| Mission chat                                | Core 2、Memory 3、Local Host 107、renderer 66、Desktop 6 passed       |
| Revision                                    | Interpreter 13、Desktop revision 69、adapter 6 passed                 |
| 显式真实 suspended Codex 删除               | 1 passed；Native 未确认时保留，恢复后重试成功；不代表真实模型业务成功 |
| CLI pack / release reports / 隔离安装 smoke | 全通过；tarball 安装后实际执行命令                                    |

`test:business` 仍排除单列的真实 OS Keychain 门禁；跳过项和定向筛选均保留原策略，Native 删除测试另行显式启用。完整 11 项命令、耗时与原始日志保留在 `/tmp/pragma-pr356-final4-verification.json` 和 `/tmp/pragma-pr356-final4-*.log`；此前失败轮次亦保留，未改测试超时。

本报告不替代历史 [R4 实施报告](local-host-kernel-r4-implementation.md) 与 [前轮 CR](local-host-kernel-r4-cr-followup.md) 的事实；旧源码性能结果仍是历史证据。最新[性能补测](../performance/local-host-kernel-r4-pr-review-comparison.md)：初轮 640 次、触发场景追加 480 次，存储定向追加 640 个提交样本；两组追加未发现稳定阈值回退，初轮异常保留。

真实模型、OS Keychain 和四项产品性能验收缺口继续跟踪。评论修复完成不代表 R4 或整体重构验收完成；issue #348 保持开放。
