# Issue #348 R2：PR #354 评论复核与修复

日期：2026-10-03。审查目标 `a355f31649f4832a10d23dda5ae71749b0a8c79f`，基线 `a2741325ab106b3cbc8f472d4feec98b1367ae55`。已读取全部普通评论（2）、行内评论（1）、review（1）与审查线程（1，API 无下一页）；[评论快照](../performance/local-host-kernel-r2/pr-354-followup/comments.json)保存读取时的状态。

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

[逐命令结果与原始日志摘要](../performance/local-host-kernel-r2/pr-354-followup/validation.json)保存退出码、耗时、测试计数和日志 SHA256。此前 R2、CR 性能批次继续保留独立源码摘要。本次两组每端8场景×20样本，以及 system/Capability 各两组每端60样本全部串行；原完整批次两处阈值触发保留，四组追加复测未重复触发。暖缓存每组20/20、DSL=0，失效DSL=2，head/pinned读取0/1。详细准备/compile phase耗时、读取数与证据见 [性能报告](../performance/local-host-kernel-r2-performance.md#pr-354-评论修复后的独立测量批次)。

两处已确认 P1 的修复与上述工程门禁通过；R2 仍只标代码实施交付，完整阶段验收未完成。未获得新的真实 provider 样本，不关闭 #348、不宣称 R1/R2 全部完成；原 Native 进程取消、OS 凭据与完整产品性能等缺口继续保留。
