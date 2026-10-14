# Mission 删除优化：审查与验证记录

## Issue #397：语义事务与 owner 搬移的协调

Local Host 最终搬移 owner 前，按 semantic-write → aggregate → repository metadata →
Execution/Session 的既有删除锁顺序获取屏障。semantic-write 锁覆盖准备 journal、业务 mutation
与事件提交的完整生命周期；aggregate 锁覆盖 lease 校验与持久化，避免已验证的 writer 在搬移
后递归创建旧目录。搬移时仍未完成的 journal 随 owner 保存在回收站，不自动重放或删除。

后台删除恢复与 Runtime Session catalog 自动恢复同样通过 Core 的共享存储屏障：
semantic-write → aggregate → repository metadata → catalog deletion。catalog 自动恢复先读取
待处理事务 ID，再逐个获取 owner 屏障；等待 Mission 锁时不持有 catalog 删除锁。取得屏障和
catalog 锁后重新读取 journal 与 catalog 进度，正常删除或其他恢复已完成的事务不重复搬移。
Core 只协调存储锁，不反向依赖 Local Host。

并发回归用真实删除事务构造 prepared + moving + 原目录尚在的故障窗口，分别暂停已经通过
校验的 aggregate 写入与完整 semantic-write 事务，再从后台和 catalog 自动恢复入口触发
搬移。四种组合均等待在途写入完成，事件保存在 trash 中；完成后拒绝迟到写入且原路径不重建。
修复前实现上的四种组合均提前搬移，回归测试失败。

Node 与 Desktop composition 均在 aggregate 锁内检查 owner 目录之外的已提交/已完成删除记录，
拒绝迟到 claim、续租、写入与恢复。prepared 阶段仅在 owner 尚未搬移时允许 controller 完成 Runtime 停止；
repository 写入继续使用删除 fencing。语义 journal 存在但 aggregate 缺失时不能生成新 lease，
包括默认路径解析器遇到 canonical journal-only 目录的情况。

fencing 同步核对底层 storage deletion journal，不依赖后台恢复先执行。即使上层记录仍为
prepared，底层已经 trashed，或 owner 已出现在本次事务的 trash 中且原路径消失，也禁止新
claim/写入；真正尚未搬移的 prepared 不被误判为已提交。Desktop 与 Node 共用这一判定。

共享读取端口新增 `listDiagnostics()`，区分删除状态、缺失主数据、无效事务、权限错误和待完成
事务，返回可读条目及明确诊断。既有严格 `list()` 保留失败行为，并附带可读 Mission ID 和诊断。
CLI 与 Desktop 的 Local Host facade 均提供该入口；CLI 的文本和 JSON/JSONL 展示部分结果警告。
删除记录 owner mismatch 使用结构化损坏诊断；已有 IntegrationError 同样补足 Mission ID、
阶段与文件，并保留底层精确 details，文本警告展示这些定位字段。未知异常继续失败，文件与
journal 保持原状。持久格式与协议版本保持不变；Core 的 journal 读取 Schema 接受 writer
合法省略的 Runtime owner 列表并默认成空数组。

Flow 崩溃恢复中的短暂 SQLite BUSY/LOCKED 争用使用有界、可让出 Worker 的重试：覆盖打开
Execution WAL 元数据和既有 Mission receipt 操作。只重试 SQLite 数值错误码对应的锁争用，
不重复已开始的 Execution 业务事务，也不隐藏损坏或版本错误。真实 SQLite 独占锁回归验证锁
超过旧等待窗口后仍可恢复读取。

回归覆盖健康 Mission 与 journal-only 目录并存、待恢复事务、异常聚合与未知错误、删除中残留、
同进程及独立进程的事务/删除竞争，以及重启和 completed 删除记录对新 claim 的 fencing。
这证明当前代码中的竞态机制及其防护，不据此认定用户现场由删除操作造成；现场仍需核对原始
journal、删除记录与路径迁移记录。

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

## PR 评论复核

读取 PR #351 的所有普通评论、审查记录及行内评论，确认四项修复建议均有依据：

- TS canonical worker 不能依赖预先存在的 workspace dist。Shared 新增 pragma-source 源码导出，
  TS worker 显式选择该条件并通过 scoped tsx 加载源码；不向 Zod 等第三方启用 types 条件。
  隔离 fixture 没有 Shared/Core dist，并在父进程移除继承条件后验证 worker 独立启动。
- Attention 的失败停止 Promise 不再永久保留；后处理重新调用停止函数，仍对进行中的停止去重。
- Runtime pool 对已确认 native stop、完整 close 失败的 Session 保留可重试清理身份；后处理的
  Host settlement 同步改为回调，避免继续重放旧 rejected Promise。底层 lifecycle 允许重新执行
  失败 cleanup，resource scope 仅重试失败 disposer，已成功的 destroy hook 不再重复调用。
  回归覆盖失败后实际再次 close、
  并发重试去重，以及持久 worker 的第二次 settlement 成功。
- 所有 observer settlement 登记都在完成或失败后释放引用，且检查 Promise 身份，避免旧完成
  清除新登记的 active settlement；覆盖 idle Mission、失败和替换三种情况。

评论提出的进一步将前台 Mission 生命周期下沉 Local Host 属于后续架构建议，本次维持已授权方案。

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
