# Issue #348 R1 Code Review 与复核

状态：本轮 CR 确认的 15 项问题已修复并复核，工程与局部对照已完成；R1 阶段仍未完成验收。

PR #353 后续评论核验与追加修复见[补充报告](local-host-kernel-r1-pr-review-followup.md)；以下验证与性能记录保留原测量时点及源码身份。

审查对象为 `codex/issue-348-r1` 的未提交 R1 实现，以 `origin/main@8fdbd4526d0f62d0b36891165539ed9ec47dc603` 为起点。三位独立 reviewer 分别检查 owner 生命周期、公共控制和性能证据；主 Agent 逐项核对真实调用路径、故障窗口和边界，再授权修复。修复前源码保存于 `/tmp/pragma-r1-pre-cr`；此目录仅是本机辅助快照，最终代码与回归在当前 worktree。

## 确认的问题与修复

| ID  | 优先级 | 确认的故障窗口                                                                                 | 修复与回归                                                                                                                                                 |
| --- | ------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | P1     | generation 撤销期间 recovery 发布 Session，迟到返回被释放但缓存仍引用该关闭对象                | 撤销同身份的 Session/controlOwner/编译缓存；Desktop 关键 await 后检查 generation；保留 successor                                                           |
| O2  | P1     | recovered Flow 终态后重跑，controlOwner 仍指旧 Execution                                       | 安装、终态、checkpoint、停止与删除按 handle 身份同步发布/撤销；Desktop 真正重跑后 interrupt 必须针对新 Execution                                           |
| O3  | P2     | queued steer receipt 已确认，但 source cancel 提交失败，同进程重放跳过清理                     | confirmed replay 幂等取消 source；真实 SQLite 注入一次失败，fake Runtime driver steer 一次，queued result 正确取消                                         |
| C1  | P1     | Flow approval presentation 覆盖 Core user_question 语义，回传 tool_approval 导致 Flow 失败     | 保留 Core questions 与 approval semantics；真实 Core Flow approve/reject 回归                                                                              |
| C2  | P2     | human.responded 已耐久提交而投影失败，重放被拒绝为 INTERACTION_NOT_PENDING                     | recovery 前读取原 receipt，保持 applying，重放收敛；其他 requestId 拒绝；正常当前 interaction 不扫描历史                                                   |
| C3  | P3     | admission 检查后 Core CAS 发现 strict target 改变，异常被归为 COMMAND_REJECTED                 | 转为稳定 STEER_TARGET_CHANGED，不投递 Native，不改变拒绝含义                                                                                               |
| C4  | P2     | 冷 Flow interrupt 调用 recover，重新启动未完成 Task 后才 cancel                                | 增加 Core stop-only 窄边界，不 activate graph/startTurn；恢复原 Native identity 并确认停止后才持久取消；claim/CAS/fencing、缺 snapshot、停止失败与重放回归 |
| C5  | P1     | 终态释放封闭新 prompt 后，共用 dispatch guard 阻止在途 cancellation 的耐久提交                 | 分离取消 ownership 检查与新执行封闭，保留 Host/Session fencing；延迟取消与释放回归                                                                         |
| C6  | P2     | lease takeover 后旧 owner 正确失去持久写权限，但 turn result 等待尚未终态的 Execution 永不结束 | 本地 lease loss 取消 completion 观察并拒绝 result/usage，清订阅与计时器，不写 successor 的 Execution                                                       |
| H1  | P2     | 缺 Execution identity 的失败轮次错误匹配无 scope 日志，产生假指标                              | 缺 identity 保留 null 与缺测原因                                                                                                                           |
| H2  | P2     | 失败、部分和不完整轮次进入百分位                                                               | 保留原始轮次；逐指标记录排除数/原因；无有效样本为 null                                                                                                     |
| H3  | P2     | four-missions 每批新建四个 Mission，未覆盖四个 owner 的暖复用                                  | 只建立四个 Mission，记录 initial 与每批 followup identity                                                                                                  |
| H4  | P2     | retained steer 或 SDK ACK 被当作已消费                                                         | 原目标 Execution 实际 assistant output 出现唯一 marker 才验证消费；retained/ACK-only 保留失败                                                              |
| H5  | P2     | initial 与 followup 聚合隐藏冷暖差别                                                           | 保留总览，同时提供独立角色汇总及明确统计策略                                                                                                               |
| H6  | P2     | 测量起点 lane=running 被当作持续后台模型负载                                                   | 对每轮验证完整 boot/Execution/runtime run/attempt 的 Native 调用时间与真实前台区间重叠；缺任何证据为未验证                                                 |

C4 是 interrupt 控制语义的必要修复：未搬迁首轮 run、完整 recovery、编译编排或内部 consumer，不提前实施 R2/R3/R4。生产持久 Schema 与版本未升级。停止失败保持可恢复 Execution，不以写 cancelled 代替 Native 停止确认。

## 对 CR 结果的独立审核

- O3 原描述“永远不清理”被收窄：已有 restart queue recovery 能清理；本轮修复的是同进程 replay 不收敛。
- 未将“Flow discard 默认空操作”作为确定缺陷：正常 Desktop Flow run/recovery 有共同 admission 与 generation 边界，未证明生产上存在无管控 Flow 的路径。仍明确审查覆盖范围。
- 修复复核额外要求：C2 的 receipt 查找不能使正常答复扫描全 Session 历史；C4 的 cancellation claim 检查必须绑定同一 record/version CAS；开放 Context 缺 snapshot 必须 fail closed；当前 Capability head 变化不能凭空成为停止原 Native 的限制。
- 已消费的 steer 复用当前 Execution，点击前 dispatch/首 delta 不能借用。此类延迟继续为 null 并排除统计，未声称获得 steer SDK latency。
- `interrupted` 是可恢复状态。复核修复使有效 recovery claim 的停止路径在同一 CAS 中取消 Execution/Invocation 并关闭 Context；普通 Controller、无 claim、错误/过期 claim 仍拒绝该转换，未先写 queued，也未重新执行。现有 Schema/字段/版本及读取含义不变。
- 停止编译与 Desktop host Capability、凭据、MCP、Context 健康解耦；插件、非 Desktop declarative artifact 或外部定义不可解析时保留 graph 校验并 fail closed，不虚构可停止定义。
- 宽套件追加 C5/C6：取消专用校验只豁免新请求封闭，仍校验 Host/Session lease；本地 lease loss 立即结束读/事件观察，每次等待独立解除 abort listener，清理 timer/订阅，不通过旧 owner 写终态解除等待。
- 回归通过真实 Core Session factory 与 SQLite 边界，但使用 fake Runtime driver；这些结果不替代原生 SDK 的验收证据。
- source tests 使用显式 Core source alias；旧 dist 导致的初次测试失败保留为尝试记录，不把旧构建误作最新代码证据。

## 最终验证

[验证记录](../performance/local-host-kernel-r1-cr-validation.json)保留全部 34 次执行，包括失败尝试、日志 SHA256、失败摘录和最终重跑结果。各组覆盖重叠，不相加成唯一测试数。使用 Node24.18，最终验证基于已重建 Core/Local Host 和 production Desktop。

| 验证                                                     | 最终结果                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 全仓 `pnpm check`                                        | 通过：lint/typecheck、11 个基础任务 456 项；1 个有效缓存，10 个实际执行                                           |
| 全仓 `pnpm build`                                        | 通过：19 tasks；main workspace import、preload Bridge、styles、打包 storage worker 验证通过                       |
| `pnpm test:mission-control`                              | 105 + 4 = 109 通过                                                                                                |
| 完整 Local Host execution-system                         | 120/120 通过，0 unhandled；包含 Team restart 全部恢复身份断言                                                     |
| Core Flow / Execution 与 event writer/stream/recovery    | 8 / 19 通过                                                                                                       |
| SQLite、worker、pagination、Usage、canonical、deletion   | 74 通过                                                                                                           |
| 完整 Desktop Runner                                      | **80 通过、1 失败、0 unhandled**；套件未通过                                                                      |
| CLI 全套 / Desktop contracts / adapter Host              | 108 / 55 / 4 通过                                                                                                 |
| E2E harness helpers                                      | 20 通过                                                                                                           |
| CLI pack/audit、release reports、隔离安装 positive smoke | 通过，macOS x64 / Node24；[最终包 fingerprint](../performance/local-host-kernel-r1-cr-cli-artifact-manifest.json) |
| 修改的代码/配置格式、`git diff --check`                  | 42 文件格式通过；diff check 通过                                                                                  |

最终 Core 取消改动后另补跑跨进程 controller 与历史状态迁移，8 + 12 = 20/20 通过，0 unhandled；不与性能测量并行。

首轮 Local Host 宽套件发现 C5/C6 和 timer spy 清理问题，失败记录保留。Team restart fixture 的过时外层 cleanup 文本断言改为检查 AggregateError 中真实的模拟 cleanup cause，全部后续恢复及 Runtime/Context identity 断言保留并通过。没有将未执行的恢复断言当作通过。

首轮完整 Runner 发现重复答复错误消息文本断言及新 crash fixture 未隔离活跃 controller 的清理竞争。已改为稳定错误码与独立 SQLite crash snapshot，并等待真实 teardown；最终两个相关场景通过，未延长超时。

唯一未通过的最终业务场景是 oversized reply。旧 main 同场景也失败（running/succeeded 断言差异）；本次候选触发原有 30 秒 deadline，场景实际约 55.7 秒。保留两侧不同失败形式，不声称相同堆栈、同一根因或该测试通过，仍需独立定位。此前 mission-chat 76、revision 88、跨进程 controller 8、历史 migration 12、Desktop deletion/observer/services/capacity 22 + 2 原有 skipped 的 CR 执行结果亦保留；本轮未修改对应 Schema、算法或迁移链。

## CR 后局部性能对照

使用最终源码，两轮串行 `main1 → candidate1 → main2 → candidate2`，共 12 次有效运行。任务 build/test 全部结束后才开始测量，用户其他应用未关闭。[环境与每次运行](../performance/local-host-kernel-r1-cr-comparison-environment.json)、[源码清单](../performance/local-host-kernel-r1-cr-source-snapshots.json)、[全部指标差值](../performance/local-host-kernel-r1-cr-local-comparison.json)均保存。main HEAD 为仅增加文档的 `ceb29c9`，生产代码仍等价 `8fdbd45`；测量时的候选未提交。

main digest：`bfba71f5b8cdb29fff47cf4d117ac1f2aed40e97fa727483ee8e392b0b55043a`。候选 digest：`228f00277f24f0588abad69e374e713afd3790f3c42973f5b3f11c5a3563b430`。测量前后相同。清单覆盖 Desktop/CLI/Local Host/Core/Shared 的指定源码与 scripts，以及 package/lock；不是未列入范围的全仓身份。CLI 构建包另以 fingerprint 关联。

每格分别列两轮值，单位 ms，不合并 P95，不将波动归因于重构收益。storage canonical 开启，单 owner 每轮 20 样本、四 owner 80 样本；UI 每模式/规模每轮 40 样本。

| 指标                                     | main 第1 / 第2轮 | CR 后候选 第1 / 第2轮 |
| ---------------------------------------- | ---------------- | --------------------- |
| 500 历史，单 owner commit P95            | 7.80 / 8.28      | 6.92 / 7.01           |
| 5,000 历史，单 owner commit P95          | 7.11 / 7.16      | 10.16 / 6.81          |
| 5,000 历史，四 owner commit P95          | 57.95 / 68.69    | 57.29 / 70.11         |
| 5,000 历史转换期间，前台 batch read P95  | 85.23 / 83.26    | 82.89 / 66.39         |
| 50,000 历史转换期间，前台 batch read P95 | 46.08 / 46.85    | 46.82 / 46.84         |
| streaming 100 entries，input→paint P95   | 35.80 / 35.40    | 35.50 / 35.80         |
| streaming 1,000 entries，input→paint P95 | 35.60 / 35.20    | 35.50 / 35.60         |
| streaming 5,000 entries，input→paint P95 | 35.80 / 35.40    | 35.70 / 35.70         |

500 历史准备读取批次少于 20，百分位保持 null；准备读取是四 owner batch，不能作为单 Mission admission。所有 UI 场景 Long Task 为 0。commit/read、准备、paint、worker queue、file lock 等已测耗时没有触发“>10% 且 >20ms”双阈值。单 owner 第1轮 5,000 历史 commit 有相对波动，完整原始值保留；不宣称严格零回退。

5,000 历史单 owner 两轮双方均为 42 worker requests / 22 writes，request/response payload 为 5960/16670 bytes，数据库增长 0，进程磁盘写 3,411,968 bytes。进程 counter 包含 worker/后台与延迟写，不是每请求磁盘 I/O。真实 Mission control admission、实际 Mission/Studio 首屏及正常产品后台模型负载不由局部 benchmark 代替。CR 前数据仍保留并明确标注，未用旧候选数字宣称新源码通过。

## 真实模型与阶段状态

最终源码的真实 warm pilot 再次因 `MISSION_BENCHMARK_KEYCHAIN_TIMEOUT` 失败：120.156 秒、exit 1、有效样本 0、无结果文件，见[本轮模型尝试](../performance/local-host-kernel-r1-cr-model-pilot-status.json)。此前 main/candidate 也均在 Keychain 准备阶段 120 秒超时、有效样本 0；Native resume 仅输出断言通过但未正常退出，steering 未获得真实 consumed 证据。没有把 fake Runtime driver 回归当原生 SDK 验收。

本轮确认的 15 项代码及证据口径问题全部关闭。R1 仍是候选交付，未标记阶段完成或性能验收通过。剩余条件为 oversized reply 失败定位、可比较真实模型前后样本、规定场景/后台负载样本量、真实请求 I/O 与 Mission/Studio 首屏，以及完整 Native queue/steer/recovery smoke。R2/R3/R4 未开展；原工作区改动保留，此验证记录生成时尚未提交或推送候选。
