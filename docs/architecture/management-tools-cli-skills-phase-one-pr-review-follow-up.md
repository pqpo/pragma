# PR #371 评论核实与修复

日期：2026-10-09。审阅基线：`d29e922aea99e997a7919bd15ad746d6e205f5ba`。
已读取普通评论 2 条、review 1 份、逐行评论 1 条；机器人摘要与 review 外层说明没有独立修改项。

## 审批绑定评论

[逐行评论](https://github.com/pqpo/pragma/pull/371#discussion_r4222018730)要求使用当前 task handler。
核实发现：Core 原本会在首次提供 handler 时包装为读取 active Execution 的代理，所以“普通热复用
必然发给已结束 Execution”的概括不成立。但首次 Session 未配置 handler、后续 submit 才提供时，
旧 hook 始终得到 undefined，commit 无法 checkpoint/审批。用提交 `d29e922` 的原 hook 复现：
初始有 handler 的 warm case 通过，初始无 handler 的 case 返回 failed 而非 input_required。

修复：TaskSubmitContext 显式传递当前 submission 的 humanInteractionHandler；command hook
只读取 active task 的 handler/context。真实 Core Driver + 真实 HTTP command channel 的 warm
回归覆盖两种初始状态，后续 Execution checkpoint、再后续 Execution 批准与实际发布，旧 handler
未收到请求。没有修改持久 Schema 或恢复原六个默认工具。

## 历史草稿兼容评论

[普通评论](https://github.com/pqpo/pragma/pull/371#issuecomment-6072783694)指出旧 handler 未写 owner sidecar。
该问题成立。旧格式没有可推导的 Mission/Context，不能把缺记录直接当成别的 owner，也不能自动放行。

修复使用明确的受控交接，而非伪造历史 ownership：

- 新增 CLI-only `flow draft recover` / `dsl changes recover`，使用原 target UUID，始终需要当前
  Execution 的 required 审批。验证原 parser/业务读取后，原子写新 owner metadata；不重写原草稿
  或 prepared candidate。准备变更的恢复不等于发布，commit 仍有独立审批。
- 普通 get/update/commit 遇到无记录时返回 unowned_target 和恢复命令，不再称其属于其他 Context。
- 缺本地 sidecar 时，对目标 ID 定向查询 Pragma 已拥有 Runtime Session 的 owner metadata，
  支持同 Mission/Context 在其他 Runtime Session 恢复；任何已知 foreign owner 都拒绝接管。
  查询只列两级 canonical 目录并读目标 sidecar，不读 native SDK Session 树，不在启动时扫描/升级。
- 共享目标锁用于所有新 command ownership claim；create/prepare 在创建目标前预留 owner，
  避免未写 sidecar 的瞬间被误认为旧数据。请求 receipt 与 owner family 均保持现有 v1 格式。
- 审批修改输入后重新检查真实目标；按命令选择 draftId/changeSetId，避免未使用字段干扰 fencing。
  额外回归验证 distractor ID、审批替换目标都不能发布其他 Context 的变更。

历史 fixture 由 main `a32bdedb` 的未修改原 adapter 实际执行 create/update/prepare 写出，
不是用当前对象改版本伪造。原 writer 的路径/hash、生成方式与 IDs 记录在
`apps/desktop/src/main/features/built-in-agents/__fixtures__/legacy-flow-a32bdedb/`。
共享 pragma/v5 与 Flow draft DTO 自该 commit 未改变；执行历史 writer 时使用同一契约的现有依赖。
这是无业务格式转换的显式 ownership handoff；无需提高已有 DSL/草稿版本或删除旧数据。

验证场景：旧 parser 首次读取、未交接拒绝、审批拒绝、Human checkpoint 后重试、成功交接且字节
保留、相同 requestId 重放、续编、旧 prepared change 交接、独立 commit 拒绝/批准、同 owner
另一 Session 恢复、foreign owner 拒绝、未来 DSL/损坏 JSON 拒绝且不生成 owner。

## 验证记录

- Desktop command integration 与 Mission adapter Host：2 个文件、20 项通过；其中 command suite
  15 项覆盖 warm approvals、真实历史 fixture 交接与目标隔离。
- Built-in management tools：15 项通过；CLI management client：5 项通过。
- 真实 Codex Runtime：`verify-flow-command-runtime.ts codex legacy after` 成功，耗时 77.227 秒。
  模型通过 CLI 实际遇到 unowned_target，再经 Host recover 审批恢复历史 draft，修改
  maxNodeVisits=2000，validate/prepare，并通过独立 commit 审批发布 Project revision 1。
  probe 读取实际持久化结果并断言 Flow limits 与两次审批；脱敏结果见
  [Runtime 证据](management-tools-cli-skills-phase-one-pr-review-runtime-evidence.json)。

全仓 `pnpm check` 通过：Runtime feature 与 DSL version 检查通过，lint/typecheck 各 19 个
package 通过，test:core 的 11 个任务通过（481 项 Vitest 断言及 Desktop packaging 检查）。
`pnpm build` 的 19 个 package 全部通过，包括 Desktop styles/main/preload/storage worker
产物验证；`git diff --check` 通过。提交前复读全部评论，数量与审阅基线一致，没有新修改项。
默认 managed tools 仍为 38，六个 Flow 原定义和 handler 保留供显式 binding 使用，未实施其他阶段迁移。
原验收记录中尚未完成的 Pi/Windows Desktop 与手工 UI 检查继续保留；本次 Codex 结果不替代这些门禁。
没有向 PR 发送回复或代替 reviewer 标记 thread resolved。
