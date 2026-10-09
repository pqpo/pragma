# Issue #368 第二阶段 CR 与修复记录

日期：2026-10-09。审查基线为 `origin/main` 的
`a69bd99d0591aef773cd126332ae3eecaa37e41a`，范围包含第二阶段全部工作区改动及用户授权的
21 项默认工具移除。没有实施第三阶段。

## 已核实并修复的发现

### P1：DSL pending prepare 在普通读取或最终写入失败后丢失恢复快照

位置：`packages/local-host/src/pragma-project-port.ts` 的 prepare、读取及 finally 恢复路径。
候选写入成功、草稿状态尚未落盘时，普通 inspect 会走旧 editing 恢复逻辑，恢复工作树并
删除 submission。随后相同 requestId 的 CLI prepare 找不到冻结快照，返回 internal_error。
最终草稿写入抛错时，finally 的回滚也有同样后果。

复现：真实 CLI 子进程回归先完成 prepare，再模拟候选已持久化而 draft/outer receipt
仍 pending；在重试前插入 inspect。修改前该断言失败，返回 `pragma.management-error/v1`
的 `internal_error`，不再返回原 prepared 结果。

修复：在写候选前，按原草稿 aggregate lock 写入独立的
`pragma.dsl-command-prepare/v1` journal，记录 changeSetId 与确切 submissionHash。
读取和 prepare 的 finally 都先核实 candidate 的草稿、Mission 和候选身份，验证冻结
快照，再完成 prepared 状态；已持久化候选的快照不会被回滚删除。未产生候选时继续复用
原 editing 恢复。没有改动既有 draft、candidate、commit/restart journal 的版本和格式。
新 family 不接受未来版本，CLI 保留权威 storage 错误，不让 legacy handler 抹成 internal_error。

验证：真实 CLI 覆盖 inspect → list → 相同请求重放 → commit；未来 journal 拒绝且草稿字节
不变。Project adapter 用真实端口故障注入拒绝最终写入和恢复写入，放开故障后 inspect
恢复原候选并成功发布 revision 1。两条路径均保留原 submission 和候选。

### P2：新增当前 DSL 测试 helper 硬编码 apiVersion

位置：`management-command.integration.test.ts` 的 Expert/ExpertTeam YAML helper。
当前写入版本必须由 Interpreter 权威能力常量给出；固定 `pragma/v5` 会在版本演进时使
当前 authoring 回归使用错误代际。已改为 `PRAGMA_DSL_WRITE_API_VERSION`。真实历史 fixture
及参考文档的历史版本内容保持原样。

验证：DSL version checker、Desktop Node typecheck 与完整 CLI 回归通过。

## 其余审查结果与边界

核对了命令枚举/argv、模型输入与可信 operationId 分离、审批后目标复验、receipt 及
approved-input 绑定、跨 Context owner 拒绝、Evaluation update journal、独立 prepare/commit、
默认 catalog 与显式 binding、Skill registry/生成文件及只读入口。没有将猜测直接列作问题：
Evaluation candidate 重放的 operation identity 来自 Mission、Context、requestId；原 payload
及审批后 payload 在原私有 receipt 范围内均绑定哈希，不能在该范围内用同一请求重放
不同目标；没有扩展第一阶段的跨 Session receipt 恢复协议。

这次 CR 没有发现其他已确认而未修复的代码问题。该结论不等于完成全部发行或 Runtime
验收；Pi Keychain、Qoder 额度、Windows/历史配置及成本对照等缺口继续以
[第二阶段实施记录](management-tools-cli-skills-phase-two-implementation.md)为准。

## 修复后验证

- command integration 与 Project adapter：2 文件、52 项通过（19 + 33）。
- 默认 Built-in DSL/catalog：15 项通过；management/host handler：33 项通过。
- Local Host build/lint/typecheck、Desktop Node typecheck、DSL version checker、diff whitespace 检查通过。
- Desktop 生产构建及 styles/main/preload/storage-worker 四项检查通过。
- 全仓 `pnpm check` 通过：19 package lint、19 package typecheck、11 task test:core。
- 修复后真实 Codex DSL authoring 通过：17 managed tools、Project revision 2，关联
  Expert/Team 原子创建、局部修改、提交拒绝和丢弃均完成。真实 Host receipt 与新 prepare
  journal 记录于 [Runtime 证据 JSON](management-tools-cli-skills-phase-two-runtime-evidence.json)
  的 `crFollowUp`；不改写原成本样本，不把故障注入回归写成真实模型崩溃恢复验证。

提交 PR 前补跑 `pnpm install --frozen-lockfile` 与完整根 `pnpm build` 均通过；
根构建 19 task 成功，其中 16 task 使用缓存。未扩大既有 Runtime 验收结论。
