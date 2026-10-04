# Local Host Kernel R3 实施与验证

日期：2026-10-03。基线：`origin/main` / `921376a446d9da878b8d9fa5c9f1df69ab323272`（PR #354）。独立工作树，分支 `codex/issue-348-r3`。

本文是首次交付记录；PR #355 后续评论、生命周期进一步收敛及最新验证见 [跟进报告](./local-host-kernel-r3-pr-355-followup.md)。各报告的测试与性能结论分别绑定其记录的冻结源码。

状态：R3 工程实现已交付，本地门禁和串行 fixture 对照已完成，阶段验收仍未完成。R1 / R2 已合并；其真实模型、OS 凭据与完整产品性能缺口继续保留，不因本轮工程测试关闭。

## 实施边界

Local Host 承接原 Desktop Run / Session / Recovery、queue continuation、successor、人工 checkpoint、owner idle release、删除前冻结，以及 Mission repository、semantic write、现有 v3→v11 历史迁移与产品投影。Desktop 提供 Runtime、Knowledge draft、权限、凭据与产品 presentation 资源端口。首轮 attached run 只能使用 canonical execution service，删除 runExecutor 反向注入与任意 application.run 替代入口。

Mission v11 / controller / Session / Runtime 持久格式及目录不升级。Node 新建完整 envelope 使用真实 project binding 和原 requestId；已有 controller-only Mission 保留事实，不补造初始消息或 metadata。新建 envelope 与已有 controller 目录共存，manifest 最后发布；部分发布可在首次定向读取时重放，冲突保留并 fail closed。

共用 R1 MissionExecutionOwner、R2 compiler、同一 Execution / ExpertSession store、storage pool 和 canonical feed。live output、必要 durable terminal、Session release 分开。request lifetime 不等待全部 observer、Memory、Usage 后处理；idle pause 保留应用 store，永久 close 才关闭 store/feed。冷停止使用独立 purpose/context 缓存，不解析已失效可执行资源。

R4 的系统/内置内部调用全面收敛不在本轮范围；P01–P17 与四轮优化保持原机制，迁移已有测试，避免第二套同义测试。

## 关键边界与修复

- controller-only 与完整 envelope 共用 canonical service、consumer 和 R1 owner；两类读取适配器不另立执行 authority。Session 关联优先使用已接受 send 的持久指针，随后用 run.started / 原 root Invocation 证明，不扫描 Session 树或用 Mission ID 猜测。
- Desktop 使用 host lifetime 保留暖 owner；CLI request lifetime 只等待必要 terminal、Core prompt processing 与 Native Session release。Flow terminal 不作为 native 停机证明：lease-loss teardown 使用 Core 原有停机确认，不调用持久数据删除。
- fresh envelope 以真实 binding/requestId 发布；历史 UUID 路径的迁移遵守 aggregate→metadata 锁顺序，活跃旧 lease 拒绝迁移，释放后重放原事实。无事件的真实 envelope 可以读取 summary/events；缺 terminal 事实时结果明确不可用。
- semantic replay 的返回值在原 fence/journal 内取得，移除恢复后第二次不受保护的写入。owner.stop 等待已启动 recovery/renew/acquisition，迟到回调按原 identity 清理；停止后清理 recovery token。

新增必要 await 为 Node fresh envelope 发布、必要 Mission terminal 提交及真实底层释放；移除 per-run store/feed close、完整 observer/Memory/Usage 收尾等待与 Desktop runExecutor 转发。原 Core standalone 合并 terminal 与 Session active-binding 释放事务不增加；Team/Flow 保留各自终态条件。Node 新完整 envelope 额外一次初始发布（manifest 最后）；semantic journal 与产品 metadata 仍使用既有文件事务。逻辑提交与文件/SQLite I/O 不能混算，性能 probe 的读取计数仅为 API 次数。

## 验证

后续 CR 与修复复核见 [CR 报告](./local-host-kernel-r3-code-review.md)。以下计数与性能对应首次冻结工程提交；修复后的证据由 CR 报告独立记录，保留历史结果以便对照。

工程提交：`dba3405a94edc22fc6042c7297f0fdcb04025f8a`。最终命令、退出码、耗时及日志摘要见 [验证 JSON](../performance/local-host-kernel-r3/verification.json)。早期失败与修复记录保留，不能将测试启动或局部通过写成验收通过。已完成真实文件/SQLite/进程 SIGKILL 的 Expert、Team、Flow 恢复；逐一核对原 Context、systemSessionId、RuntimeSessionRef 和 dispatch 次数。Flow 中断后安全失败并保留关联，不宣称模型继续执行成功。实际 Desktop factory 与 Node facade 互接管覆盖完整和 controller-only Mission，永久挂起的 Memory 后处理不阻止必要释放。

真实 Codex suspended-process 删除专项通过：未确认停止时保留 owner 数据，恢复进程后确认退出并重试完成。该专项不等于真实模型成功或全产品性能验收。

最终门禁（同一冻结工程提交；不将不同门禁的重复测试相加）：

| 门禁                                              | 结果                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `test:mission-lifecycle`                          | Host 151；Desktop 91 通过、2 跳过                                                                                                    |
| `test:mission-compilation`                        | Host 92；Desktop 17 通过                                                                                                             |
| `test:mission-control`                            | Host 127；Core 选中 6；Desktop 选中 4 通过                                                                                           |
| `test:mission-chat`                               | Core 2；Memory 3；Host 38；renderer 66；runner 选中 6 通过                                                                           |
| `test:revision`                                   | Built-in 13；Desktop 69；runner 选中 6 通过                                                                                          |
| CLI 全测试 / repository 定向补测                  | 108 / 84 通过                                                                                                                        |
| `pnpm check` / `pnpm build`                       | runtime feature、DSL version、lint、typecheck、Core 及 workspace build 通过；Desktop main/preload/Bridge/storage worker 产物验证通过 |
| CLI pack / packed audit / report / positive smoke | 隔离 npm 安装与运行通过                                                                                                              |
| Native Codex suspended-process 删除               | 单项通过；未停机拒绝并保留数据，确认退出后重试成功                                                                                   |

默认 lifecycle 跳过的是 Native Codex 删除（已单独执行）与五样本删除 benchmark（未执行）。跨进程崩溃测试采用测试 Runtime driver；不能替代真实 SDK 全类验收。

[串行性能报告](../performance/local-host-kernel-r3-comparison.md)保存两组每场景 20 次与完整源码前后摘要。cold 准备、model-invalidation terminal 各曾触发一次阈值，分别追加两组每侧 40 次，未持续触发；保留异常样本与定位限制。存储/准备对照可比较指标未触发阈值；少样本不填 P95。完整产品性能仍未验收。

## P01–P17

| 项目    | 本轮处理与证据边界                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P01–P03 | 保留 host/request lifetime、Inbox 唤醒与 R2 pinned/cache/readiness；idle、successor、strict authority 和冷停止回归。                       |
| P04–P05 | 搬迁原 chat/work/status query 与水位测试，保留 renderer 的进行中读取、dirty 合并与晚到响应规则。                                           |
| P06–P08 | Core/Runtime 队列、统一 TokenCounter、合并 terminal 与 active release 未改；运行既有 core/chat 专项。                                      |
| P09     | 必要 durable terminal 与完整 observer 分离；Native release 独立验证，后台 Memory/Usage 不进入下一轮 dispatch 屏障。                        |
| P10–P13 | 同一 storage pool/store/feed；idle pause 不关闭 authority；WAL/FULL、容量、prepared conversion 与首次定向迁移保持；串行存储/准备对照单列。 |
| P14–P16 | 完整 fenced semantic journal、回放无重复副作用、degraded 诊断与删除/迟到回调回归；Native 停机确认专项。                                    |
| P17     | 启动顺序、闲时容量统计及不设写入门禁保持；本轮不新增启动扫描/维护。                                                                        |

P01–P17 的机制保留不代表完整产品验收；真实 provider、renderer、正常后台负载和 OS 凭据缺口仍需独立证据。

## 保留的验收边界

真实 provider 同条件模型性能、OS 凭据、完整 Electron UI 与正常 Memory / Automation 背景负载，以及 Expert / Team / Flow 全部原生进程崩溃与两端互接管证据必须分别验证。测试 Runtime 的真实存储 / SIGKILL 结果不等于真实模型或原生子进程验收。全部适用项通过后才更新 R3 为完成；本报告不关闭 #348。
