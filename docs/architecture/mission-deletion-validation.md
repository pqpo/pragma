# Mission 删除优化：审查与验证记录

日期：2026-10-01。基于远端 `main` 的 `a5054c38`，分支 `codex/mission-deletion-optimization`。
实施与验证使用独立 worktree，原工作区未提交改动未复制、未修改。

## Code Review：确认的问题与修复

| 确认问题                                                               | 已实施修复与验证                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 删除事务锁组合可能与 Session → delivery 的写入顺序相反                 | 固定 Session → delivery → Execution 顺序；锁竞争回归验证写入和删除均结束                      |
| 成功删除后再次 delete 会重新写删除意图，留下目录                       | 先读取持久删除状态，已提交/完成直接成功；重复删除与文件缺失断言                               |
| create 使用同一已删除 ID 可绕过写入隔离                                | 首次检查及最终 rename 的 Mission 锁内检查；晚到 create 回归                                   |
| catalog 已提交，但 Host 进度失败被当成删除失败                         | Core 完成 journal 后通知 Host；用已提交错误分类，worker 根据 Core journal 定向恢复            |
| 手动执行、定时执行可能重叠；超时回调退出前步骤租约被释放               | 共用 batch，锁内再次检查 pending；超时后仍持有跨进程租约，独立步骤继续；并发/挂起回归         |
| 初始清单与停止之间，已受理 turn 可创建新 Execution                     | 清单前封闭 Session 派发，停止后增量收集新 Execution 并更新准备记录                            |
| 只停止缓存的 Session，不能确认其他 owner Runtime                       | 定向查询 Runtime catalog；额外未停止 Runtime 保留会话，确认后重试回归                         |
| opening、invalidated Runtime 可能不在普通 close 清单                   | 跟踪 retiring/失败引用；opening 纳入停止确认，完整 cleanup 后台执行                           |
| Flow 只有停止入口，缺少删除后的完整 cleanup                            | MutableExecution/Flow 提供 finishDeletion，后台 settlement 调用                               |
| 成功的 retired cleanup 与 settlement 引用一直保留                      | 收尾成功后释放引用；失败引用保留诊断与重试                                                    |
| Native 关闭返回或收到终止信号不等于进程退出                            | Codex、OpenCode 等等待实际退出；ProcessSupervisor 未确认退出时抛稳定错误                      |
| Qoder 超时关闭和失败关闭会丢失 Query 引用                              | 保留 Native close promise；失败后即使 activeQuery 已脱离仍可重试，回归验证                    |
| DSL 只在入口检查 Mission 状态，最终 publish 可晚到                     | 最终 publish 与草稿状态写入共用 Mission 删除锁，并在锁内检查                                  |
| DSL 恢复会重新发布被删除隔离拒绝的 initiated journal                   | 未发布事务撤销后可 discard；已发布结果保留回执；被隔离 restart 不创建 replacement             |
| Attention、Memory 提炼结果可能晚到写入                                 | Attention 共用 owner 锁；Memory 最终提交共用 Execution 删除 admission，存储锁内检查持久 fence |
| Source-backed Usage record 只唤醒 Feed，不会直接补回消失的 observation | 新增批量 reconcile，锁内复用 observation ID 幂等补账，验证 Feed 中不存在的 observation        |
| IPC 将停止未确认的稳定错误码转换成 internal_error                      | 保留 `MISSION_DELETE_RUNTIME_STOP_UNCONFIRMED`、conflict、retryable；IPC 回归                 |
| 删除历史清单被二次全量读取，造成性能回退                               | 只检查新增 Execution；无活动运行时跳过二次历史遍历                                            |

Usage 账本的“独立实例会覆盖缓存”疑虑经核查不成立：既有写入本来就在锁内重读账本。
修复针对 source-backed sink 的补账入口，而不是不存在的缓存覆盖问题。
最新 main 已包含的递归删除 barrier 死锁修复直接复用，没有重复实现。

## 性能实测

本机 macOS、Node 23.11.0、锁定 pnpm 依赖。专用集成测试使用真实文件、owner 锁、journal、
catalog 与 Mission Store；Runtime 为可控测试 Runtime。每组 5 次；准备数据不计入前台删除。
P95 按本小样本最近秩法取最大值，仅表示该本机样本，不是大规模生产分布估计。

| 完成会话 Execution 数量 | 前台样本（ms）          | P95（ms） |
| ----------------------- | ----------------------- | --------- |
| 0                       | 57, 46, 53, 43, 51      | 57        |
| 10                      | 104, 95, 76, 90, 123    | 123       |
| 100                     | 282, 290, 279, 288, 284 | 290       |

三组均低于 1 秒。复核中二次全量历史读取曾产生 1007 ms 的 P95，已通过增量核对修复。
主要开销改进包括取消非必要租约 fsync、并行 owner 锁、删除 journal 完整清单一次写入、
批量 rename，以及 Usage、Memory、DSL、claim、observer 从前台迁出。
没有记录 pristine main 的同环境基线，不将用户报告的十秒当成同条件基线实验。

运行性能测试：

```sh
PRAGMA_MISSION_DELETE_BENCHMARK=1 pnpm --filter @pragma/desktop exec vitest run src/main/features/missions/mission-deletion.test.ts -t 'measures completed'
```

## 后续性能复核

后台 worker 复核确认并修复以下问题：

- 已提交但尚未完成的任务，每秒重新提交相同状态并写盘。现在仅在 prepared → committed
  时提交，进度未变化时不保存；等待重试或已有挂起回调时不获取归档进度锁。等待重试
  用例验证文件 inode 和 mtime 均不变化。
- 已提交任务仍读取删除 journal；回收站及 journal 被淘汰后，其他清理也会停住。现在只在
  prepared 阶段恢复关联事务，已持久确认 committed 的任务独立继续，Usage 来源过期留下缺口。
- 最后一步完成后、任务归档前崩溃，下一轮没有待执行步骤，无法归档。现在所有 committed
  任务都会核对是否完成，且未完成任务不重复写盘。

删除服务 12 个测试通过，包含上述回归、并发去重、挂起隔离与事务恢复。

与测试和构建并行时，重复测量的 0/10/100 Execution 前台 P95 分别为 312/107/972 ms。
该轮有 CPU/文件系统竞争，不能与空闲样本直接当成代码前后对照，但显示性能对机器负载敏感。
停止本任务的并行测试与构建后再次测量：

| Execution 数量 | 最新前台样本（ms）      | P95（ms） |
| -------------- | ----------------------- | --------- |
| 0              | 191, 137, 113, 136, 130 | 191       |
| 10             | 81, 100, 315, 88, 76    | 315       |
| 100            | 286, 282, 293, 299, 295 | 299       |

每组仍为五次，三个规模均低于 1 秒；小样本和机器负载波动仍存在。

隔离机制确有新增成本，不能表述为完全零开销。本机 Node 微测：对 100 个尚未删除的 owner
轮询 10,000 次，五轮平均每次标记检查约 15–18 μs；50 次两 owner 空提交保护的 P50 为
6.8 ms，P95 为 8.7 ms。微测包含文件锁成本，不包含 Memory 数据库实际提交。

多 owner 的最终提交与删除共享批次互斥锁，以避免并行 owner 锁的死锁；无关 Mission 仍可能
在此处排队。当前证据支持已测规模前台删除达标，但尚未完成大量并发 Mission 和挂起后台任务
的长期资源压力测试，也没有正常执行吞吐量的 main 对照基线。后台每秒仍读取活动删除任务；
完成任务已移出活动目录，未完成任务很多时仍有与任务数成正比的轮询成本。

## 真实 Runtime 与质量检查

真实 Codex app-server（gpt-6.1-sol）验证：仅暂停测试创建的子进程，Native stop 无法确认时返回
`MISSION_DELETE_RUNTIME_STOP_UNCONFIRMED`，Mission 文件与准备记录保留。恢复进程后确认退出，
再次删除成功；最终实测首次请求 15035 ms（含前台准备），重试 112 ms，进程已退出，
Mission 文件不存在。该实验不会操作用户其他进程。

```sh
PRAGMA_MISSION_DELETE_NATIVE=1 PRAGMA_MISSION_DELETE_MODEL=gpt-6.1-sol pnpm --filter @pragma/desktop exec vitest run src/main/features/missions/mission-deletion.test.ts -t 'real suspended'
```

相关验证覆盖：Core owner fence 的独立 Node 进程晚到提交、文件锁、canonical delivery、状态迁移
历史 fixture/当前 no-op/未来拒绝、Runtime pool、ProcessSupervisor、普通 Session close/恢复；
Local Host 删除任务与 Usage；Memory Episodic/Semantic/Activity/Attention；Desktop 删除、投递、
DSL 项目适配器、Chat、IPC；Codex/Qoder/OpenCode 适配器的相关测试。
`pnpm test:revision` 已通过。相关模块 Lint、类型检查，以及 Desktop main/preload/renderer 构建与
打包边界验证已通过。最终增量改动另做相应检查。

依赖安装遵守锁文件。Qoder SDK 安装脚本的下载因本机证书链错误
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` 失败，使用 `--ignore-scripts` 完成锁定依赖安装。
Qoder SDK 模拟测试通过；未验证真实 Qoder CLI 的 Native 退出。
OpenCode 本机进程 smoke 测试通过，其余需要显式 Runtime 集成环境的用例保持跳过。

所有源码、回归测试和本记录位于独立 worktree 的 `codex/mission-deletion-optimization` 分支，供 PR 审查。
