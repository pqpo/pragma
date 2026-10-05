# Issue #348 R4：PR #356 最新评论复查

2026-10-05；读取全部普通评论、行内评论和 review，新增意见为 [6e22f019 复查评论](https://github.com/pqpo/pragma/pull/356#issuecomment-5987818567)。评论明确没有将两项测试失败认定为确定性源码缺陷，本次也不作该推断。

| 意见                                      | 核对与处理                                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 两项 Human waiting 首轮失败、独立重跑通过 | 首轮 107 passed / 2 failed 的证据有效，失败在 cold stop / dispose 前。新增 outcome、Execution status/version/error 与 Invocation node/status/waitReason/error 诊断；沿用原等待预算，不增加 timeout、重试或吞错。                     |
| GitHub 冲突、最新主 CI 缺失               | 确认 `CONFLICTING/DIRTY` 与 6e22f019 仅 CLI CI 通过。fetch 并 merge 最新 main `9d11c508` 无文本冲突，保留 queued turn running status 修复；推送 `2bf0f18a` 后 GitHub 为 `MERGEABLE`，最新主 `CI / verify` 和 CLI workflow 实际启动。 |

## 本地证据

- Node 23.11.0 / pnpm 10.12.1，`NODE_NO_WARNINGS=1`，未设置 `PRAGMA_LOG_LEVEL`：合流分支按评论相同七文件组合 **109/109 passed**，295.59s，`/tmp/pragma-pr356-round2-reproduce.log`。
- 相同环境，原三项 Human 用例连续五轮 **15/15 passed**；`/tmp/pragma-pr356-round2-human-{1..5}.log`。
- 原审查 checkout / HEAD `6e22f019`，相同 Node 23、相同七文件组合，临时仅加诊断：**109/109 passed**，294.08s，`/tmp/pragma-pr356-round2-original-head.log`。结束后恢复审查 checkout 原测试文件。
- Node 24.18.0：三项 Human 与真实失败诊断 **4/4 passed**，`/tmp/pragma-pr356-round2-node24-human.log`；相关 typecheck、lint、Prettier 通过。真实失败 fixture 验证诊断同时保留 Execution 和 Invocation 的 Runtime 根因；不输出 Context/定义快照。

两次完整复查与连续重跑只说明未再次复现，**不能解释或抵销原失败，不宣称稳定性验收已闭合**。原 `/tmp/pr356-recheck-host.log` 与 `/tmp/pr356-recheck-failures.log` 继续保留，后者是原三项重跑通过日志。没有定位到可确认的生产缺陷，不编造修复；新增诊断供下一次失败直接保留根因。

## 远端门禁与范围

最新候选必须取得自身主 `CI / verify`、CLI package verification 结果；旧 `cf5f9358` 主 CI 和 `6e22f019` CLI CI 均不替代。最终 run URL / commit 对应关系记录在 [PR #356](https://github.com/pqpo/pragma/pull/356) 的 Verification 中，使用真实 Checks 结果，不根据本地 merge-tree 宣布远端可合并。

本轮没有为未复现的失败修改生产语义；生产源码仅合入 main 已有 queued turn 状态修复。此前 [评论修复与完整门禁](local-host-kernel-r4-pr-review-followup.md) 和 [性能报告](../performance/local-host-kernel-r4-pr-review-comparison.md) 仍对应其记录的源码摘要，是历史证据，不能冒充合流后测量。

Human 旧失败根因、真实模型、OS Keychain 和四项产品性能验收缺口继续跟踪；即使远端 CI 全绿也不标记 R4 或整体重构完成，不关闭 #348。
