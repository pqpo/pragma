# Issue #348 R1：PR #353 评论核验与修复

状态：PR 评论确认的两项新增问题属实，已修复并独立复核。R1 阶段仍未完成验收，PR 保持 Draft；R2/R3/R4 未开展。

本补充对应[审查评论](https://github.com/pqpo/pragma/pull/353#issuecomment-5951008582)，审查基点为 `7506a9d502de72e8fbd67f224b4cd8573d23a948`。原[CR 报告](local-host-kernel-r1-code-review.md)和局部性能数据保留原时间、原源码身份，本补充不覆盖历史失败记录。

## 评论 1：终态命令误报成功

属实。Desktop `submitMissionCommand()` 等待 Controller 终态后只拒绝 `rejected`，因此 `expired`、`failed` 也会令 send/respond/queue/interrupt 的薄转发接口正常 resolve。

回归使用真实 Mission Controller、Inbox、文件持久投影和计数 consumer。恢复审查基点的生产分支时，`expired` 和 `failed` 两项失败，`applied` 与 `rejected` 两项通过；修复后四项全部通过。`expired` 由真实 Inbox 过期处理产生，consumer apply 为 0；`failed` 经合法的 Controller `completeOperation` 制作终态 fixture，不声称生产 command consumer 自然产生了该状态。后者通常写入 applied/rejected。

修复仅允许 `applied` 返回成功，其余结果优先透传持久 error。既有 Error 转换保留 code、category、retryable、details。缺失 error 时提供合法稳定兜底；`EXECUTION_FAILED` 按权威 factory 的 cause-dependent policy 显式指定 retryable，expired/rejected 使用固定 policy。首次类型检查发现联合 code 的类型限制，已改为分别调用 factory，失败记录保留。

测试同时覆盖 applied 成功返回、rejected 错误保留、三种缺 error 兜底、重试不改 durable projection、不重复 consumer apply，以及 Runtime startTurn 为 0。缺 error 仅在 application 返回边界故障注入，不改写真实持久数据。

## 评论 2：自动控制回归门禁缺失

属实。原 PR 的 CI/Release 只执行 core、mission-chat、revision；这些脚本不调用控制专项。

在 `.github/workflows/ci.yml` 与 `desktop-release.yml` 的 verify 中加入独立 `pnpm test:mission-control`，失败阻止后续流程。Release 保留已验证产物复用条件 `inputs.source_run_id == ''`，未扩大 `test:core`。根专项脚本先构建 Desktop 的全部依赖，随后执行既有 Local Host 控制专项、四项 Core strict-target/receipt 回归和新增四项 Desktop 终态转发回归，可单独运行。

两份 YAML 的解析、唯一门禁、install/build 顺序、失败传播和 Release verify 依赖通过静态核验；另一位 reviewer 只读复核生产分支、测试和脚本后未发现新问题。构建、测试和诊断由主 Agent 串行运行。

## 本轮验证

使用 Node24.18。[验证记录](../performance/local-host-kernel-r1-pr-review-validation.json)保留复现、fixture 修正、类型检查失败及最终重跑的日志摘要与 SHA256。测试组覆盖有交集，不相加为唯一测试数。

| 命令/检查                                   | 最终结果                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm test:mission-control`                 | 105 + 4 + 4 = 113 通过                                                                       |
| `pnpm check`                                | 通过；lint/typecheck 与 11 个基础任务、456 项基础测试，10 个有效测试缓存                     |
| `pnpm build`                                | 通过；19 tasks，18 个有效缓存，Desktop 重新构建；main/preload/styles/storage worker 验证通过 |
| 完整 Desktop Runner                         | 未通过；⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯； Test Files 1 failed (1)； Tests 1 failed            | 84 passed (85) |
| YAML 门禁结构、源码格式、`git diff --check` | 通过                                                                                         |

本轮源码 digest 为 `73fb3854355518b68aa24fc1bbfb99499d00898d08e466bcbf4a1d7fcdcab0b8`，见[差量源码清单](../performance/local-host-kernel-r1-pr-review-source.json)。清单引用原 CR 的 1,164 文件范围，仅列变更 SHA；workflow 单独校验。验证后源码保持不变；文档不属于该源码范围。原工作区保持 clean，所有修复位于原独立 worktree。

## 评论 3：大输出与真实 Runtime 验收

评论对验收缺口的判断属实，不能将旧 main 也失败解释为候选无回归。此前 main 是 running/succeeded 断言失败，候选是原 30 秒 timeout；两种失败和原报告保留。

独立子进程对安装的 `gpt-tokenizer/o200k_base` 计数 `x.repeat(200001)`，得到 25,001 tokens，同步耗时约 19.639 秒；零延时 timer 也到 19.640 秒才执行，确认该输入存在同步阻塞风险。相关共享计数、Runtime driver、stream controller 和 overflow 实现在审查基点与 main 间无差异。这是诊断线索，尚不足以证明历史两种失败有相同根因。临时观察器的单场景诊断重跑通过，耗时约 25.2 秒；临时改动已恢复。最终未改 fixture、未延长 timeout 的完整 Runner 仍在该场景触发 30 秒 deadline，实际场景耗时约 55.9 秒，结果见上表。末尾另有 Flow recovery claim renewal 的 Execution not found 诊断，保留为日志信号；未把记录日志等同于 unhandled rejection。单场景通过不能消除完整套件失败与历史不稳定性。

本阶段未修改统一 token 计数算法或引入新的性能算法。[技术方案](local-host-application-kernel-refactor.md)要求职责迁移与新性能算法分开，完整的大输出阻塞/两侧差异仍作为验收问题保留。没有通过删除场景、减少输出或放宽 deadline 使验收通过。

本次不重复真实模型/Native 测量：此前 Keychain 120 秒超时、真实模型有效样本 0；Native resume 未正常退出、steering 无实际消费证据，以及规定场景/后台负载、逐请求 I/O、Mission/Studio 首屏缺口均继续保留。原 12 次局部对照绑定旧 digest `228f00277f24f0588abad69e374e713afd3790f3c42973f5b3f11c5a3563b430`，不是本轮新源码的性能验收。阶段状态与 performanceAcceptancePassed 继续为 false。
