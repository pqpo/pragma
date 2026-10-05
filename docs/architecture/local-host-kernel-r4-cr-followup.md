# Issue #348 R4 CR 与修复复审

后续 PR 评论修复与最新验收见 [2026-10-05 followup](local-host-kernel-r4-pr-review-followup.md)；本文为前轮源码证据。

2026-10-04；基线与工作树见 [R4 实施报告](local-host-kernel-r4-implementation.md)。
本次审查共享 application/control/run、Desktop/CLI composition、内部调用、投递、terminal、Memory/Usage 与 CI 门禁。审核候选发现后，仅把可达且可复现的问题列为缺陷；修复后再次独立复审。

| 确认问题                                                      | 修复                                                                                                          | 回归证据                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| P1：catch-up 扫描水位丢弃已订阅的实时 output/state            | 水位仅过滤已重建的 Human 事实，实时事件按 eventId 去重                                                        | 真实 SQLite + StoredExecutionView/Core live bus；两页历史与并发实时输出        |
| P2：历史读取失败被 queue.close 吞掉                           | 关闭前 queue.fail，流向调用方传播原错误                                                                       | SQLite 读取故障，iterator 拒绝且 subscription 关闭                             |
| P2：一个 owner 释放失败中断全部关闭，失败后无法重试           | 隔离 owner，汇总错误，失败后允许 retry；保留原 guard 定向重试                                                 | 真 controller 故障、其他 Mission 关闭、资源关闭重试、successor lease CAS       |
| P1：controller-only Flow 未确认 Native stop 却释放 lease/资源 | 未确认 owner 保留，停止确认后精确清除，失败可重试                                                             | 真共享 factory/controller、Native stop 拒绝与 retry                            |
| P1：active Flow 忽略 cancel/settlement 失败或超时后清除 owner | 使用 Core stopForDeletion（冷 facade 使用 cancel）；成功 settlement 后按身份清除，未确认保持 owner/lease/资源 | active Native stop/settlement 两种故障、确认后 retry；独立直接 source 复现复审 |
| P2：新 CI adapter 门禁遗漏原有两项测试文件                    | 加回 Mission adapter host 和 Runtime availability                                                             | 完整 Desktop adapter gate                                                      |

专项共 12 条通过，覆盖未回答审批只投递一次、已回答审批不重播、实时输出不丢、错误传播、关闭故障隔离、定向 lease 重试、successor 保护、两端真实资源构造以及完整内核注入拒绝。
独立复审确认上述六项全部修复，本次范围内没有剩余已确认缺陷。

复验曾发现新增 active Flow 保护误用于 Session turn：两者都提供 `stopForDeletion`，按方法存在判断会跳过正常 Session 收尾并超时。已显式区分持有 Session 的路径，保持其原 `cancel → cancelPromptQueue → releaseAfterTerminal` 顺序；Flow 才使用新增保护。Desktop 真实 Expert/Team cold Session 与 delayed-cancellation/closed-Session 恢复契约用于验证纠正，失败日志保留在仓库外。

## 最终复验

Node 24.18.0 / pnpm 10.12.1，修正后最终串行复验：

| 门禁                                      | 结果                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| 全仓检查 / 构建                           | `pnpm check`、`pnpm build` 通过；Desktop main/preload/Bridge/storage worker 产物验证通过 |
| CLI 完整测试入口                          | Local Host 99 文件：902 passed、1 skipped；CLI 13 文件：108 passed                       |
| Desktop adapter gate                      | 97 passed、2 skipped；7 文件。真实 Native 专项单列                                       |
| Desktop 内部调用 / 平台 adapter           | 8 文件、37 passed                                                                        |
| Mission chat / Revision                   | 通过，计数见下述原始门禁日志                                                             |
| 真实 Codex suspended deletion             | 通过，确认挂起 Native 未停止时保留数据，恢复后重试完成                                   |
| CLI pack / reports / isolated npm install | 全部通过；新 tarball 实际安装与执行验证                                                  |

生产源码 1159 文件，SHA-256 `949681a946f34bd6c09274c7a8871a47d1028b5570ced64ce49507e2bf781aab`。门禁前后与性能对照前后摘要保持一致。完整日志及各命令退出码在仓库外 `/tmp/pragma-r4-cr-fixed-*.log`、`/tmp/pragma-r4-cr-fixed-verification.json`；前轮失败与旧产物复测日志保留，不作为最终通过证据。

[CR 后串行性能对照](../performance/local-host-kernel-r4-cr-comparison.md) 使用修正后源码，与 main 进行两组八场景、每侧每场景 20 次及 SQLite/preparation 对照。保留初轮阈值触发与追加复测，fixture 不能替代产品四目标。

真实模型、OS Keychain 与四项产品性能验收缺口继续按实施报告跟踪。CR 缺陷全部修复不等于 R4 或整体重构完成；issue #348 保持开放。
