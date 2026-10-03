# Issue #348 R2：PR #354 评论复核与修复

日期：2026-10-03。审查目标 `a355f31649f4832a10d23dda5ae71749b0a8c79f`，基线 `a2741325ab106b3cbc8f472d4feec98b1367ae55`。已读取全部普通评论（2）、行内评论（1）、review（1）与审查线程（1，API 无下一页）；[PR 评论](https://github.com/pqpo/pragma/pull/354#issuecomment-5966269275)提供评论原文；本地完整评论快照已清理，裁决见下表。

## 裁决

评论中两处 P1 均成立。此前 CR03 修复了冷 Flow 及 acquisition readiness，却遗漏冷 Expert/Team 的 recovery 目的；CR07/08 的执行 guard 不等于 stop 用途隔离，stop 仍解析 Plugin 与 inline Secret。前一轮“已确认问题已修复”的结论只覆盖当时列出的触发路径，不能据此宣称完整取消路径通过。本次补齐这些范围，不改变取消成功、目标验证或 Native 恢复的安全要求。

| 评论                                                         | 判定           | 修改                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通评论第 1 项：冷 Expert/Team interrupt 默认 execute       | 需要修复       | interrupt→recover→resolveExecutor 贯通 stop；其余恢复默认 execute。窄 recoverActiveOwner 端口同步传 purpose，Desktop 用共同 stop 元数据编译。                                                                                 |
| 行内评论及普通评论第 2 项：Plugin 与 inline Secret 阻止 stop | 需要修复       | Interpreter 明确 compilationPurpose=stop；保留 DSL/Runtime/delegation/Team/Flow 元数据，跳过 Plugin resolver、Capability/ContextStore adapter、Secret 和 artifact。FlowAction 保留 Task/DSL descriptor，不要求执行 registry。 |
| 阶段与验收缺口、Desktop/CLI 尚不等价                         | 保留           | R1/R2 的真实模型、OS 凭据和完整产品验收仍未完成；Node durable successor pointer 及完整 recovery 生命周期属于 R3，Runner 清理属于 R4，不关闭 #348。                                                                            |
| bot review activity/说明                                     | 无代码修改要求 | 作为审查活动信息保留，不执行评论中示例命令或触发新的 review。                                                                                                                                                                 |

## 停止定义的执行边界

停止用途继续使用 Interpreter 的 AST、链接和纯编译；Local Host 选择目的，未复制 DSL compiler。RuntimeProfile 只按既有 canonical adapter/config 读取运行时 ID 和模型元数据，不 bind/canUse/listModels；未知 adapter 明确拒绝。已有 system prepare 的 stop 分支保留定义配置读取，未伪造健康状态。普通执行的 identity、hash 和 compiler/persistent protocol version 保持，stop 环境 fingerprint 独立含用途，不记录为可用执行缓存。

Core 的进程内 WeakSet 标记不进入字段、definition descriptor 或持久格式。停止定义可以恢复已有 Session/Native snapshot 并停止，但新 Session/Flow start/recover、prompt/steer/queue resume、compaction、底层 Native submit/start 都拒绝，已有 snapshot 的 ownership 与 Native 恢复检查仍保留。队列 pump 不会因取消结束而重新 dispatch；组合成 Team/Flow、FlowSpec.compile 也保留保护。

Desktop 临时 stop Session 不进入执行 identity/cache；停止后释放 transient owner，保留 durable Session 与队列事实，正常发送重新编译并恢复可执行定义。Node 同样不把 stop 结果当 execution compilation metadata；释放停止 owner 后恢复资源可继续正常发送。

自定义 ContextPolicy 的纯 definition factory 和严格 graph descriptor 恢复语义保持；不根据 registry ref 猜测持久 resolver ID、不新增通用 metadata registry。Host 未提供的自定义 policy 或需要不健康外部状态的 factory 仍明确失败，这是注册恢复定义边界，不属于本次 Plugin/Secret live contribution 的取消修复。

## 证据边界

新增冷 Expert/Team 回归从真实 Node Interpreter/CAS/SQLite 运行状态复制独立冷存储，使用权威 Session Store API 交接副本 lease；不是实际 crash 验收。Core 既有 resume 将遗留 running turn 标为 interrupted，测试确认 stop 目的、持久控制结果、原环境不重写及恢复资源后正常 send，不宣称已停止旧进程的 Native turn。Core 原生停止保护另使用实际持久 Native snapshot 的测试 driver 恢复/停止验证；仍不能替代真实 provider/OS 凭据或 R3 产品恢复验收。

Desktop 另用真实 published Project/CAS、Plugin package bytes/fingerprint、运行中的 Session 与 queued receipt 构造独立冷存储，通过权威 SQLite aggregate API 重建 checkpoint，不复制活动数据库/WAL。坏 readiness/Plugin/Secret 时 interrupt 的执行资源调用与新 Runtime turn 均为零，停止定义 prompt 拒绝；Session 保持 open，queued receipt 按既有 interrupt 语义变为 cancelled，保留内容与身份。资源恢复后同 Session 正常 send/queue resume 成功。该测试仍不证明崩溃前原 Native 进程取消。

早期无活动 Session/无合法 target 的测试正确拒绝，未修改成功语义；改用真实运行快照。并行构建期间出现半成品 Core dist/import 与测试配置失败，不作为产品结果；最终冻结后的统一门禁才作为通过证据。

## 最终验证

冻结源码摘要 `4502e1a76d1ed74014c80112a7406c0cd146e0fad9b2f148e131650962ecb55d`（1,149 production 文件），验证及全部串行测量前后不变。所有最终命令退出 0：

- `pnpm check`：lint、typecheck、边界检查、481 项核心测试及 Desktop packaging。Core 的 9 项 stop-only 回归已加入常规 test:core。
- `pnpm build`：19 个任务通过。
- `pnpm test:mission-compilation`：101 项（Host 84、Desktop 17），新增 Desktop 冷 Session 回归已加入该入口。
- `pnpm test:mission-control`：134 项。
- 既有 Desktop cold Native Flow stop：1 项；Interpreter resource adapters：10 项。
- CLI：108 项；package:pack、release:reports、positive package smoke 均通过。

[验证摘要](../performance/local-host-kernel-r2/verification-summary.json)保存退出码、耗时、测试计数及通过的远程 CI 链接，完整日志已清理。此前 R2、CR 性能批次继续保留独立源码摘要。本次两组每端8场景×20样本，以及 system/Capability 各两组每端60样本全部串行；原完整批次两处阈值触发保留，四组追加复测未重复触发。暖缓存每组20/20、DSL=0，失效DSL=2，head/pinned读取0/1。详细准备/compile phase耗时、读取数与证据见 [性能报告](../performance/local-host-kernel-r2-performance.md#pr-354-评论修复后的独立测量批次)。

两处已确认 P1 的修复与上述工程门禁通过；R2 仍只标代码实施交付，完整阶段验收未完成。未获得新的真实 provider 样本，不关闭 #348、不宣称 R1/R2 全部完成；原 Native 进程取消、OS 凭据与完整产品性能等缺口继续保留。

## CI 跟进：活动存储复制竞态

[CI 37105763242](https://github.com/pqpo/pragma/actions/runs/37105763242/job/111153832527) 在 Mission compilation gate 失败：Node 冷 Expert 测试复制活动 Home 时，`aggregate.json.<uuid>.tmp` 被原子替换，递归 `cp` 的 `lstat` 报 `ENOENT`。这是测试快照构造竞态；CLI 跨 OS/Node 发布包门禁通过。此前本地通过不能证明该夹具没有竞态。

Node 改为只复制已发布 Project/CAS 不可变资源；Session 通过 `readSnapshot/create/transact/appendEvent`、Execution 通过 SQLite aggregate API、Runtime Session 通过 owner 定向读取及原子 claim/update API 重建。既有状态与 Native identity 保留，不复制 lease、活动 SQLite/WAL、Mission Inbox 或临时文件，不忽略 ENOENT、不增加超时。

Desktop 回归同步移除 Runtime Session 数据库目录复制，并隔离冷 Mission Inbox/owner scope。原测试共享控制目录，旧 standalone consumer 可能消费冷 Host 命令；隔离后取消记录必须落在 cold Session，保持原成功与身份断言。

本轮只修改测试夹具和本文，生产源码摘要仍为 `4502e1a76d1ed74014c80112a7406c0cd146e0fad9b2f148e131650962ecb55d`，未重跑或新建性能批次。Node 7 项和 Desktop 2 项定向回归通过；lint、Local Host/Desktop 类型检查及完整 compilation gate 101 项通过。远程 CI 将在推送后核验，不能把此前本地结果当成新的远程通过证据。

[CI 37109117171](https://github.com/pqpo/pragma/actions/runs/37109117171) 的重跑已消除上述 ENOENT，却暴露 Node Team 测试的收尾竞态：Execution 先提交 succeeded，Session/queue 收尾尚未完成，立即 release 正确触发 `ExpertSessionReleaseBlockedError`。测试改用同一 `MissionExecutionOwner` 的 Core `waitForPromptProcessing()` 屏障，并断言 idle 后再验证成功及 release；保留生产释放保护，不延长 timeout、不轮询重试 release。

[CI 37110030034](https://github.com/pqpo/pragma/actions/runs/37110030034) 的第三次运行在既有 Mission chat 回归较早失败，未进入 compilation gate：`bounds latest-page reads...` 的第一轮完成检查读取 Mission 当前投影，收到后来排队并移除的 Execution 的 cancelled。Core `removeQueuedPrompt` 只取消对应排队项，Mission 多 Execution 的异步终态投影不保证显示最早第一轮。测试现固定第一轮 Execution ID，从权威 SQLite 验证该轮 succeeded；保留页面最多读取三次、pending invalidation 和完整渲染断言，不把成功改成取消。此修改仍仅属于测试，生产摘要不变。
