# Issue #348 R1：大输出与真实 Mission 释放问题修复

本记录续接[第二轮 PR 评论核验](local-host-kernel-r1-pr-review-r2.md)。PR #353 的大输出失败属实；真实模型样本与规定的完整产品验收仍是证据缺口，不能把它们当作已修复的代码问题。实际 Native Mission smoke 已补齐，边界见下文。R1 阶段验收仍未通过，R2/R3/R4 未开展。

## 修复与范围

最新用户要求“check 是否是真的问题，如果属实则修复”。依据该追加要求，修复实际阻塞：Core 的统一 `RuntimeTokenCounter` 在本地 tokenizer 已加载后，识别超过 4,096 UTF-16 单位的连续空白或非空白 run，对整个文本使用原有 Unicode heuristic。未增加 Runtime 局部估算器、BPE 算法、分块 tokenizer 或 worker。reported Usage 仍然优先，缺少上报才估算；流式期间零计数、attempt 结束单次结算和异步入账保持。普通短 run 的长正文仍使用原 tokenizer。

这是防御修复带来的明确估算策略变化，不是声称所有计数行为完全等价：200,001 个连续 `x` 从 tokenizer 的 25,001 tokens 改为 heuristic 的 50,001，仍标为 `estimated`，不是计费用量。Context 与 Memory 预算也使用这个结果；其他文本可能高估或低估。保护只针对巨大单个 piece，任意输入仍不保证常数时间。没有更改持久 Schema 或协议版本。

Memory 关联回归实际复现：`"a_".repeat(1800) + "." + "a_".repeat(3000)`、预算 1,500，句号缩短后的片段切回 tokenizer，变成 1,803 tokens。`projectMemory` 现在只复查第一个偏好的句边界一次，超预算时保留二分已经验证的 `end`；完整重组和每段预算都有真实回归，不丢正文。

原 Desktop 大输出测试的 200,001 字符、30 秒 deadline 与 overflow 断言全部保留。大输出 Host 场景、Core reported/fallback driver 两项和 Memory 三项预算回归已加入现有 `test:mission-chat`，由现有 CI/Release 执行，不添加独立构建或性能后台任务。

## 真实 Mission 释放边界

实际 Native Codex + Local Host 默认 CLI 组合（真实 SQLite、FileExpertSessionStore、Mission Inbox/lease；没有替换 release callback）确认 queue 和 strict steer 的实际 marker 消费，但首轮成功后、已接受 successor 尚在运行时，CLI 收尾错误调用 Session release，导致首轮 outcome 变为 `ExpertSessionReleaseBlockedError`。这属于本轮新增验证确认的代码缺陷，已修复并继续完整验证。

独立 CR 又发现原提议的 `listTurns()` 等待会观察全部历史 Execution，以及把 queued-steer 的投递中 prompt 当成实际 active turn 会等待一个 uncertain prompt 永不结算。最终实现使用 Core `waitForPromptProcessing()` 等待实际 processing、queue restart 和已接入的 prompt/strict-steer/queue-steer/resume admission；不创建历史 turn observer，不等待 Usage、消息历史或全部事件。API 区分 `idle` 与 `lease-lost`：后者只表示 fencing 丢失后的既有清理完成，并不表示 Native 已收束。等待及 human/terminal release 的 admission 屏障响应同一 lease-loss 信号，移除 listener；Host 在该分支完成 fenced terminal release，保留 Execution 失败与 successor claim。正常成功、失败暂停、人类 checkpoint 和 uncertain delivery 分别保持正确边界。Mission 的续租与 Inbox 消费保留到下层真正释放，失败保留 live owner，迟到清理再次检查 owner identity，不释放后继。

修复前真实 Mission 两次烟测均以 exit 1 自行退出，外层没有强制超时，实际 queue/steer 消费通过；重新打开时命令保持 queued、进程内 owner/guard 缺失而持久 live lease 仍在。先验证已确认的释放竞态修复，不把该恢复超时独立归类为新代码缺陷。人类 checkpoint 测试第一版把 Invocation 等人误认成 Execution 已 waiting，修正 fixture 前的红/绿失败如实保留，不计作生产回归证据。改用实际 SQLite durable `human.waiting` 后，旧 CoreRun/owner-scope 的七项新增回归全部失败（0 unhandled），均恢复旧源再测试并在 finally 原样还原新源；修复后 CoreRun/owner-scope/execution-system 完整三个文件 **150/150**、0 unhandled。首次整组 149/150 的唯一失败是新 uncertain 测试成功释放后重复 close 的 cleanup，修正后重跑通过。之后仅将两项新 fixture 的 Expert ID 改为合法 16 位 Crockford Base32，Local Host lint/typecheck 与最终控制门禁重新验证。

## 验证与剩余缺口

Core token-counter/stream-controller 两文件 21 项通过；Memory 全套 12 项通过，包含修复前 2 通过、1 失败的预算反例。全仓 `pnpm check` 已通过，11 个基础测试任务合计 471 项。计数阶段 `pnpm build` 通过；完整 Desktop Runner **85/85** 通过（130.59 秒），原 oversized fixture 和 deadline 未修改；`test:mission-chat` 82 项、`test:mission-control` 113 项通过。后续 Core/Host 释放改动需另行验证，以上不能自动视作最终源码检查。

串行 main/candidate/candidate/main 的两个交替组，均在独立 Node 24.18 进程加载同版 `gpt-tokenizer@3.4.0`、暖计数器后采样。主线巨大 `x` 输入计数 20,647.15/21,091.22 ms、零延迟 timer 被推迟同等时长；候选 3.39/3.81 ms，timer 延迟 3.89/4.01 ms。普通短 run 的 128,000 字符正文每侧 40 样本，P95 12.32→14.18 ms（+1.86 ms，约 +15.1%），未同时触发 >10% 且 >20 ms 双阈值；不是普通正文改善或完整 Mission 不回退结论。原始输出见[计数对照](../performance/local-host-kernel-r1-counter-comparison.json)，[复现 probe](../performance/local-host-kernel-r1-counter-probe.mjs)绑定源码与脚本 SHA。

真实 Codex 0.159.0 通用 resume/steering probe 正常 exit 0（31.80/29.15 秒）；resume 两项断言通过，steer marker 在原 turn 输出中实际出现。这两项单 Session 证据不代替 actual Mission smoke。

真实 Pi + DeepSeek v4 flash warm pilot 再次在 `credentials-read` 阶段触发内部 120 秒 Keychain timeout（外层 120.17 秒、exit 1），未完成原凭据读取、未进入模型请求，有效样本为 **0**；没有改认证存储或跳过凭据边界。记录见[模型重试](../performance/local-host-kernel-r1-counter-model-pilot.json)。

`performanceAcceptancePassed = false`；第一阶段仍未标记完成。缺少可比较的 Pi 模型基线、规定的全部前台/后台负载与 I/O/首屏样本；Native smoke 的重新打开是正常资源释放后建立新 composition，不是崩溃或活跃进程强制接管验收，也未覆盖 Desktop UI/observer 全流程。

## 最终代码检查

生产源码以[源码记录](../performance/local-host-kernel-r1-counter-source.json)绑定：既有 1,164 文件清单加 Memory projection 一个明确新增范围，排序 path/NUL/SHA256/LF 的摘要为 `97dc2af78fdc1b8fb748ef9a3f45223ec4ed0583506bbb5c0f8f802c19c6b6c8`。测试、脚本、工作流单独保存 SHA；docs 不进入生产摘要。原工作区改动保留，未修改或撤销其代码。旧对照记录保留其旧 source digest；本轮计数 probe 的候选 counter 文件 SHA 与最终文件一致，不把它升级为完整 Host 性能验收。

所有构建、测试和 Runtime smoke 依次执行；计数对照期间没有构建或测试。以下测试组有交集，不相加为唯一测试数量：

| 检查                                                  | 最终结果                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm check`                                          | lint/typecheck 通过；11 个基础任务共 471 项通过                                        |
| `pnpm build`                                          | 19 个构建任务通过；Desktop main/preload/styles/packaged storage worker 验证通过        |
| CoreRun / owner-scope / execution-system 完整相关套件 | 150/150，0 unhandled                                                                   |
| `pnpm test:mission-control`                           | 134 项通过；含新增 owner-scope 与 processing/lease-loss 回归，现有 CI/Release 自动执行 |
| `pnpm test:mission-chat`                              | 82 项通过；含 Core 巨大 reported/fallback driver、Memory 预算及原 Host overflow 场景   |
| Desktop Runner 全套                                   | 85/85，原 200,001 字符/30 秒 deadline 保留；外层 131.26 秒                             |

[验证原始记录](../performance/local-host-kernel-r1-counter-validation.json)保留每次失败与通过、命令、退出码、日志 SHA 和验证阶段；[Native Mission 原始记录](../performance/local-host-kernel-r1-counter-native-mission.json)与[可复现 probe](../performance/local-host-kernel-r1-native-mission-probe.mts)记录真实行为，外层 supervisor 才确认实际进程退出。

最终真实 Native Mission 18 项断言全部通过，外层 **74.82 秒、exit 0、无强制 timeout**：默认 CLI 首轮 finalization、durable queued-before-terminal、strict steer 原 Execution 实际消费、queued turn 实际消费与上下文记忆、重新打开后原 Context/systemSessionId/RuntimeSessionRef 精确复用、自动 owner 和持久 lease 释放、恢复 Execution 的终态投影都确认。此前重新打开失败没有单独修改 recovery 业务，已确认的释放修复后该路径通过。

最后 smoke 的第一次新源尝试 exit 1 且未输出 raw JSON：probe 在 Execution terminal 后过早关闭 SQLite，后台 recovered-owner 还在投影。修正探针等待真实 owner 移除与持久 lease 释放，再检查 `run.succeeded` 投影；沿用既有等待 timeout，不手动替代 production release，不抑制错误。日志 SHA 和缺失 raw 的原因保留；最终 raw 标记的 `processExitConfirmed=false` 只表示探针自身不能证明退出，supervisor 的实际 exit 0 才是进程证据。

复现最终 Native smoke（先构建）：

```bash
node --import tsx docs/performance/local-host-kernel-r1-native-mission-probe.mts /tmp/pragma-native-mission-smoke.json
```

本轮修复不迁移 R2 编译、R3 完整生命周期或 R4 Runner 内部调用。R1 代码修复与以上检查通过，R1 **阶段验收仍未完成**，PR 保持 Draft，不宣称性能验收通过。
