# PR #355：Flow result 拒绝观察时序修复

2026-10-04。复核[最新评论](https://github.com/pqpo/pragma/pull/355#issuecomment-5976510624)，审查源码 `2a89780a14f73d2cb8319e1bc96cd6fbc7cdff43`。结论：问题成立。

## 证据与修复

[原 CI verify](https://github.com/pqpo/pragma/actions/runs/37174256448/job/111353468774) 的 Host 生命周期 196 个断言通过，但 Vitest 捕获 1 个 unhandled rejection，步骤退出 1；Revision 和 Build 随后跳过。原本地通过记录仅证明其冻结源码与当次环境，不能代替这次远程门禁。

Core Flow 的 result 在 handle 创建后立即开始观察 durable Execution。Local Host 恢复取得 handle 后，还等待 Memory accepted 登记及 owner 持久投影，之后才安装业务 observer。恢复快速失败时，原 result 会先拒绝，CI 的 `PromiseRejectionHandledWarning` 也证明处理器后来才安装。SIGKILL 用例本来就断言恢复返回 `EXECUTION_FAILED`，因此不能把恢复失败改成成功。底层幂等冲突是否属于新增回归，此次证据不能确定；原诊断与安全失败继续保留。

唯一生产改动在共用 `openLocalHostFlowExecution`：取得 start/recover 的真实 handle 后立即安装 `void execution.result.catch(() => undefined)`，返回原 handle。它只提前观察拒绝，不替换、await 或返回 catch 后的 Promise；后续消费者仍收到原 result 的失败。两种持久格式与 Desktop/Node 经同一 kernel 入口受保护。Expert 原有即时结果观察保持，不扩入 R4。

没有新增 await、持久写入、版本/迁移变更或 Native 执行；cold stop 与 release 路径保持。

## 确定性回归

在既有 Host kernel 核心测试补两项，使用真实 Core、SQLite 与 File ExpertSession：

- 首轮 Flow Runtime 快速失败，Memory accepted 登记被 gate 阻塞。
- 原 Expert→Human checkpoint Flow 恢复，owner 投影中响应人工后，后续 Task 快速失败；持久投影被 gate 阻塞。

durable failed 后跨事件循环才让下游观察 result；不安装全局 unhandled listener、不放宽 Vitest 设置。断言真实 handle 与 result Promise 的对象身份、原诊断、Native create/dispatch 一次、恢复前后完整 Context snapshots，以及 Native/owner/lease 释放。

把生产 helper 恢复为原提交实现、保持新测试不变：2 个断言通过，但捕获 2 个 unhandled rejection，命令退出 **1**，复现成功。随后恢复修复：完整 kernel **19 项通过、退出 0**。原真实 SIGKILL 接管用例在 `CI=true` 下 **1 项通过**，原 `EXECUTION_FAILED`、Context/Runtime refs 与 Native 副作用次数断言未修改。

修复提交 `2265bed1` 的首轮 [CI](https://github.com/pqpo/pragma/actions/runs/37179215302/job/111368161618) 又发现新增测试使用默认 1 秒 `waitFor`，Memory gate 尚未进入即超时；该次聊天门禁 75 通过、1 失败，无 unhandled 报告。改为明确的 Memory/projectOwner 进入信号，并与原 operation 的拒绝或意外提前完成竞争；不提前观察 result，不只延长进入门禁的超时。等待 durable.failed 保留有界条件检查。

同步调整后再次用原生产 helper 跑新测试：仍复现 2 个 unhandled、退出 1；恢复修复后完整 kernel 19 项、Host lint/typecheck 均通过。独立复核确认没有遮蔽原操作错误或削弱任何断言。生产源码 SHA-256 保持 `b099fd7588578a628d8a972cca0e314c5bbc9acff9c84f8cb7baa10982cfc6a2`。本地完整生命周期（Host 198、Desktop 87）和 Revision（13 + 69 + 6）在同一生产源码下通过；同步调整只改测试。

## 完整门禁发现的 successor 收尾竞态

提交 `0453ca0c` 的 [CI 首次运行](https://github.com/pqpo/pragma/actions/runs/37180056543/attempts/1) 已通过聊天门禁，Host 生命周期 197 通过、1 失败，没有 unhandled 报告；Revision / Build 仍跳过。失败的完整 envelope successor 已成功执行，但新 Host 提交 continuation 时仍读到旧活跃 Mission lease，最终收到 `COMMAND_RESULT_TIMEOUT`。这不是仅凭延长 5 秒等待预算可以关闭的问题。

确认的交错：terminal observer 的 `forgetActive` 先移除 live output 标记，request resource release 随后取得 admission；其严格 `active === captured` 检查把 observer 已脱离误判成 successor，跳过 Native / lease release。`stopOwner` 只停止本机 poller，因此不能补上持久 lease 收尾。

共用 request release 允许 observer 已脱离，但保留原 Session / Context 对象身份，并核对 Mission 最新 Execution 与 Session 最后 Execution 均仍属于原 turn。不同 active、较新 Execution 或较新 Session 仍拒绝迟到释放；Native 释放前和持久 lease 释放时均验证原 guard。live output、durable terminal 和 Session release 继续独立。

增强既有两格式 successor 用例，完整 envelope 用 gate 强制 observer detach 先于 release 身份检查；原 5 秒预算、Context snapshots、Session 关联与冷 Desktop 接管断言保留，新增真实持久 lease 已清除和三次 Native dispatch（首轮、successor、冷 continuation 各一次）。旧实现确定性得到 1 失败 / 1 通过（lease 残留），修复后两格式曾 2/2 通过；最终门禁还验证移动至冷 continuation 之后的新增 dispatch 断言。独立 CR 未发现确认问题。

此修复增加定向身份读取和 guard 检查；本轮未重新测量 fixture 或完整产品性能，历史性能记录不覆盖该改动。

## 远程复跑发现的初轮入口与 queued steer 投影

`0453ca0c` 的 [CI 第二次运行](https://github.com/pqpo/pragma/actions/runs/37180056543/attempts/2) Host 198 通过；Desktop 85 通过、2 失败、2 默认跳过，Revision / Build 仍跳过。两项不能靠调整成功断言取得通过。

before-run send 原本在已持有 admission 内直接 `runMission`，显式 Run 则登记共用 `startRun`。初轮 readiness 被阻塞时，另一个入口可能绕过该 gate；日志本身不证明重复 Native dispatch。修复让权威读取发现首次运行需求后退出 reservation，调用唯一 `startMission` / `startRun`，再重入 admission 读取实际状态并接受原 request。这样并发入口共用同一 Promise，不嵌套 admission；普通 warm 路径不增加读取，controller-only 的初轮 no-op 不会无限重试。

queued steer 的源排队 Execution 会由 Core 取消，但 receipt 成功。旧 `attachNextSessionTurn` fallback 未排除已转换的 `queue_steer` prompt，可能把取消的源 Execution 当下一轮投影，误将成功的原活跃轮展示为 cancelled。该 fallback 现在与既有 queued observer 一样排除 `queue_steer`；不改变 Core receipt、原 Execution 或成功语义。

初轮回归使用真实 `MissionExecutionOwner.startRun/admit`，明确验证 startup 在 reservation 之外，并发 send / Run 只执行一次启动；旧实现 1 项失败，修复后 Host admission 10/10。增强既有 Desktop queued 用例，持久 terminal 写入等待 Core processing idle，并等真实 `mission.observer_settled` 后再核对最终 Mission；旧 fallback 确定性错误关联取消的源 ID，1 项失败。还原修复后 Desktop 初轮 / steer 8/8，Host / Desktop typecheck、Host build、相关 ESLint 均退出 0；未放宽超时或成功断言。

successor 修复快照 `ccff3efa…` 下已重新通过 check、build（19/19）、Host 生命周期 198、Desktop 87、Revision 13+69+6，前后摘要一致。最终初轮 / queue 修复的完整门禁以最新提交 CI 为准，不把前一源码快照的结果当作新源码证明。

## 最终 Desktop fixture 的阶段校正

生产修复 `a19abadc`（源码 SHA-256 `5de2487c846c077d0ea68760bc02c7307395104df007988d3854a987783d93ce`）本地 check、19/19 build、Host 生命周期 198 / Desktop 87、Revision 13+69+6 全通过，前后摘要一致。其 [远程 CI](https://github.com/pqpo/pragma/actions/runs/37182471303) Host 198 通过，Desktop 86 通过、1 失败、2 默认跳过；Revision / Build 再次跳过，不能记作最终门禁通过。

before-run 用例的 `mockImplementationOnce` 把 owner acquisition 的 readiness precheck 当初轮 gate。真实初轮尚未开始时已阻塞，该 gate 不能约束随后显式 Run。加实际 `mission.message_accepted(kind=initial)` 阶段诊断后，旧 fixture 确定性得到 0 对 1、退出 1，证明该次剩余失败是测试阶段定位错误。

仅修 fixture：用局部 AsyncLocalStorage 标记真实 adapter owner precheck，正常完成它；真实初轮首次 readiness 才进入 gate，并断言进入时已登记且仅有一个 initial run。首次实际 send 拒绝、no-execution、队列顺序、原 ID 成功、Core receipt / source 及 Native 次数断言保留，不放宽超时。修正后初轮 / steer 8/8、Desktop typecheck、ESLint、格式检查通过。生产 / dist 保持原源码，完整最终远程门禁以最新 PR checks 为准。

## 工程门禁与边界

本轮 `pnpm check` 和 `pnpm build`（19/19 tasks）均退出 0，生产源码前后摘要一致。业务与测试提交 `a59f0067956357f82f7ddffc7ca5331d812d85ae` 的[完整 CI](https://github.com/pqpo/pragma/actions/runs/37183690211) 与 [CLI package verification](https://github.com/pqpo/pragma/actions/runs/37183690275) 均通过；后续性能数据清理只修改文档和复算脚本。完整远程 CI（聊天、控制、编译、生命周期、Revision 和 Build）以 [PR #355 checks](https://github.com/pqpo/pragma/pull/355/checks) 的最新提交结果为准；不能把通过断言数单独当作门禁通过。

本次未重测 fixture 性能；Flow 拒绝观察本身没有增加等待或 I/O，successor 收尾修复的新增定向读取尚无新性能测量证据。[上一轮性能](./local-host-kernel-r3-pr-355-followup.md)仅对应其记录的冻结源码，不扩大为新提交的完整产品性能证据。真实 Runtime、OS 凭据、完整 Electron/背景负载性能缺口继续保留；R3 验收未完成，不关闭 #348。
