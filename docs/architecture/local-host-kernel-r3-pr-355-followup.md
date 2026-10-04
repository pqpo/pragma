# Issue #348 R3：PR #355 评论复核与修复

2026-10-04。读取 PR #355 全部普通评论（2）、行内评论（2）和 review（1），包括分页结果。审查提交 `a41c763dc2da78d4a3dd8b66f8d521c5193b3245`；最新 `origin/main` 为 `921376a446d9da878b8d9fa5c9f1df69ab323272`。本报告是本轮修复记录，先前 CR 与性能报告仍只证明各自冻结提交。

## 评论裁决

| 来源                                                                                       | 判定                   | 修复范围                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [checkpoint Memory P1](https://github.com/pqpo/pragma/pull/355#discussion_r4173743092)     | 成立                   | 两种持久格式在 `input_required` 可见前，以实际 Execution ID 完成 waiting Memory generation 并释放闲置资源。                                       |
| [resume receipt P2](https://github.com/pqpo/pragma/pull/355#discussion_r4173743097)        | 成立                   | reservation 后所有读取/恢复失败均进入原 receipt 结算；detach 继续同一 reservation，不递归重复前置 admission。保留原 guard fencing。               |
| [维护者评论：Memory 统一](https://github.com/pqpo/pragma/pull/355#issuecomment-5975112735) | 属于本次目标，需要修改 | Local Host 拥有唯一 generation、admission rollback、迟到 terminal、延迟重放及清理实现。Desktop/Node 仅提供存储、Attention、feed 和通知资源端口。  |
| 同一维护者评论：持久格式下执行编排统一                                                     | 属于本次目标，需要修改 | 格式只提供真实读取、资源准备和持久投影，不伪造完整 Mission；执行生命周期统一。必须以最终实现与双格式核心回归确认，不能用共用 factory/owner 代替。 |
| bot review 活动摘要与说明                                                                  | 无代码修改要求         | 仅为审查活动信息，不触发评论中的示例命令。                                                                                                        |

## 复现与验收边界

双格式真实 Node HumanTask 回归在修复前为完整 envelope 失败、controller-only 通过：完整 envelope 返回 `input_required` 时，真实 Run Memory 的 `complete` 调用为零。回归保留原 Context、`systemSessionId`、Runtime Session ref 和 Expert 副作用一次的断言。

resume 同步和 detach 的 aggregate 读取失败均复现 receipt 留在 queued；修复后真实 controller 的 8 项 receipt/fencing 测试通过，同一请求重复读取 rejected/applied 结果，不重新恢复。原 guard 被替换后仍拒绝旧回调结算和释放。

独立 Memory 复核另发现首轮 binding 占位 owner 在 prompt 拒绝后残留，导致 stop/close 均未执行；临时复现结果 `{stopped:0,closed:0}`。共享实现将 binding reservation 与 accepted Execution 区分，首轮 rollback 后后台 stop/flush，pending barrier 保持至资源收尾，不写虚假终态。修复后同一复现为 `{stopped:1,closed:1}`，独立复核确认关闭。

Memory 的 cold durable backfill 也接入同一 `reconcile`：保留真实 current Execution 检查，不安装虚假 active owner，新 admission 期间的旧终态按 accepted/rejected 分别丢弃或重放。Desktop 全进程 shutdown 继续由应用资源端关闭 Memory Plane。

定向验证：Memory 15、resume receipt/fencing 8、迁至 Host 的 read-model 5，共 28 项通过；双格式 Node HumanTask checkpoint 修复后 2 项通过。Desktop 删除 5 个纯 helper 测试副本，保留尚无等价核心集成覆盖的实际资源接线和成功能力断言。上述定向结果不代替源码冻结后的完整门禁。

## 执行与 Memory 归属

`mission-memory-lifecycle.ts` 维护唯一 binding / accepted Execution / provisional intent generation；Native Attention stop 与 delivery flush 在短 metadata 串行队列之外等待。首轮拒绝、旧终态与新 admission 竞争、等待 checkpoint、cold durable reconcile 与 close/pause 使用同一实现。

`execution-kernel.ts` 接收真实 Mission/controller 事实组成的内存 subject 与 Core resource plan，统一 Native open、显式恢复、queued turn 复用、successor、admission、settlement 与 release。subject 不序列化为 Mission envelope，不补造 initial message 或 UI metadata。完整 envelope 与 controller-only 适配只负责真实读取、编译/资源参数和必要持久投影；删除第二套 persistence control router 及自定义 prepare/recover 回调。

successor 先检查 pending/active Session，成功创建新 Session 后再关闭旧 Session；创建失败保留原 owner，旧 Session 关闭失败则确认 Native stop 后清理未关联的新 Session。已缺失的恢复 Session fail closed，不通过创建新 Session 重跑副作用。Memory admission 在准备前建立 intent；Native 接纳与持久投影区分，投影失败保留真实 accepted Execution，成功 no-op 回滚 intent。旧 request receipt 不重新登记 Memory 或派发模型。

必要新增 await 是 checkpoint 实际 Execution 的 Memory completion、恢复 receipt 的 durable rejection 以及共享恢复/释放边界；不等待完整 Memory/Usage consumer 收尾来发布 terminal。没有新增持久格式、版本或迁移链，也没有另建 store/worker/feed。Mission semantic write 继续持有原 owner/aggregate 锁，Core ownership 与 lease fencing 保持；R4 内部调用全面收敛不扩入本次修改。P01–P17 与四轮 batching、readiness/cache、独立 live output / durable terminal / Session release 机制延续原报告。

独立最终审查还关闭了两处格式政策残留：完整 Mission 首轮 Memory binding 变化接入共享 successor 策略；request-lifetime 冷恢复控制后的 Native / lease 释放使用公共结算。Memory/successor 标记在新 Session 成功安装后才清除，失败恢复或创建不丢重试要求；删除两项提前 consume 的死 API。idle eligibility 在 kernel 只实现一次，两格式及无暖 owner 路径均读取真实 Session/Execution，禁止 active、queued、running、waiting 提前闲置释放。

最后的 Native 释放与 lease 释放之间发现 admission 竞争窗口。共同结算的 ready tail 现在在同一 owner admission 锁中重查原 guard、owner、pending Inbox 与 Native readiness，再进行必要投影、Native release、CAS detach 和 lease release；轮询不占锁，新 successor 的结算任务不会被旧 task 吞掉。新增真实 Core、File ExpertSession、Mission controller/lease 与共享 Memory 的确定性竞争回归 2 项通过，分别阻塞 Native 与资源完成。此项修复前未运行复现；不使用修改 fixture 的模拟结果冒充历史证据。

真实终态 Flow receipt 回归还发现 Core 会拒绝 `recover(succeeded)`；现用真实只读 `flows.open` 与 durable terminal，返回原 Execution 结果，不安装可变 Native/Memory owner 或再次派发。真实 Core 回归覆盖终态 Flow 和旧 receipt A 与活跃 owner B 的竞争。初次 check/build 早于这项发现，不作为最终证据。

随后完整生命周期门禁通过 194 项、失败 1 项：controller-only Mission 的冷恢复忽略持久环境指纹变化，沿用旧 Session。修复 `authorityChanged` 对 warm owner 的错误依赖，持久旧环境自身即可触发共享 successor；缺失历史环境仍由 Native 恢复校验。未降低原 Session/Context/Runtime refs 与副作用断言。定向双格式 Node 2 项、authority 8 项通过，独立只读复核无确认问题；完整门禁重新冻结运行。

Desktop 后续门禁另通过 86 项、失败 1 项：不兼容定义创建 successor 后，旧 Session 缺少原 `interrupted` 持久终态。旧 Execution / Invocation / Session / prompt 的退休事务已迁到 kernel，删除 service 副本；successor 创建失败不改旧状态，退休失败清理未关联 successor。保留既有成功断言，精确原用例修复后通过；真实 Core/SQLite 部分提交回归确认：Execution 已终态，首次 Session 事务注入磁盘失败后，重试补齐 interrupted、清 active/prompt，Native dispatch 不增加；Host kernel/authority 25 项及双格式 Node successor 2 项通过。上述失败记录分别保留，不以 Host 的 195 项通过代替两端门禁。

## 冻结源码验证

工程提交 `c73619ea9114716ff5c49deb3c9b735f7a16408c`；生产源码 SHA-256 `53eb31ea467868bd2be424d8492bb7c2bd1eb0fc27d28d073ff68ce8a2d3dc17`，完整工程门禁前后相同。命令、退出码、耗时、日志摘要及早期失败证据见 [verification.json](../performance/local-host-kernel-r3-pr-355/verification.json)。

| 门禁                                                | 最终结果                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm check` / `pnpm build`                         | 均退出 0；构建 19/19 tasks，包括 Desktop preload/Bridge 和打包 Host storage worker 验证 |
| `test:mission-lifecycle`                            | Host 196；Desktop 87，通过；默认 2 项跳过                                               |
| `test:mission-control`                              | Host 135 + 6；Desktop 4，通过                                                           |
| `test:mission-compilation`                          | Host 98；Desktop 17，通过                                                               |
| `test:mission-chat`                                 | Core 2；Memory 3；Host 74；Desktop 66 + 6，通过                                         |
| `test:revision`                                     | Built-in 13；Desktop 69 + 6，通过                                                       |
| CLI tests / Memory / Core checkpoint+Flow           | 108 / 15 / 6，通过                                                                      |
| 真实 suspended Codex 删除                           | 显式启用 Native 用例，1 项通过；不能等同于真实模型成功或所有原生 SDK 恢复验收           |
| CLI pack / audit / release reports / positive smoke | 均退出 0                                                                                |

计数按各命令分别记录，有重叠，不是独立用例总数。定向 `-t` 的非目标用例只记录 skip，不算通过。生命周期默认跳过项分别为单独启用的 Native 删除（上表通过）及五样本删除 benchmark（未运行）。保留真实文件/SQLite、SIGKILL 与 Desktop/Node 接管回归的原 Context、`systemSessionId`、RuntimeSessionRef 和副作用次数断言；测试 Runtime 证据不扩大为真实 SDK 全类验收。

## 串行性能与剩余验收

最新 `origin/main` `921376a446d9da878b8d9fa5c9f1df69ab323272` 与工程提交 `c73619ea` 独占串行比较；两组、每场景每侧 20 次，覆盖 cold、warm 和六种环境 invalidation，另测 storage/preparation。两侧源码前后摘要相同；全部 probe 的 `completeProbePassed`、`sourceUnchanged` 通过，无 probe error。P50/P95 使用 nearest-rank，少于 20 个样本不填分位数。阈值为候选 P95 比 main 高超过 10%，且绝对差超过 20 ms。

| 初始触发（组）               | 指标                               | main / candidate P95，ms | 两组每侧 40 次追加结果                     |
| ---------------------------- | ---------------------------------- | ------------------------ | ------------------------------------------ |
| cold（1）                    | preparation                        | 249.49 / 307.67          | 264.62 / 282.96；256.80 / 268.78，均未触发 |
| cold（2）                    | fixture completion → Core terminal | 29.06 / 62.19            | 22.80 / 22.96；26.55 / 22.57，均未触发     |
| capability invalidation（2） | preparation                        | 680.29 / 809.41          | 666.45 / 674.43；729.32 / 697.03，均未触发 |

追加场景中全部可比较指标均未触发；初始 storage/preparation 指标均未触发。结论仅为该 fixture/本机串行条件下未观察到持续阈值回归，不能确定初始波动原因，也不证明完整产品性能。保留所有异常和追加样本，见 [原始数据与命令](../performance/local-host-kernel-r3-pr-355/)及 [复算结果](../performance/local-host-kernel-r3-pr-355/comparison.json)。复算命令：`python3 docs/performance/local-host-kernel-r3-cr-analyze.py local-host-kernel-r3-pr-355`。

真实 provider、OS 凭据、完整 Electron 产品与正常后台负载性能缺口继续保留；不标记 R3 阶段完成，不关闭 issue #348。
