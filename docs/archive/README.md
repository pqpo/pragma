# 历史归档

这里保留当时的计划、实施、CR 与验收证据，供追溯使用。内容不是当前开发指令，旧 TODO 不自动成为新任务；归档也不意味着未完成验收已经通过。
当前入口见[文档索引](../README.md)与[ADR 索引](../adr/README.md)。

## 分类

- `architecture/`：Issue 348 共享内核各轮实施/CR、管理工具迁移阶段报告、原生打包审查和 Mission 删除验证；关联 JSON 证据随报告移动。
- `plans/`：Issue 398 的阶段执行与评审记录；当前 CLI 用法见[CLI Agent 指南](../usage/cli-agent.md)。
- `adr/`：被后继替代但仍有追溯价值的旧决策。
- 性能与 Runtime 调研保留在原目录，以保护探针的路径假设；[性能索引](../performance/README.md)明确其历史范围。

## 报告目录

- [Desktop Claude Code packaging audit — issue #327](architecture/claude-code-packaging-audit.md)
- [Mission 统一 Local Host 应用内核分阶段重构方案](architecture/local-host-application-kernel-refactor.md)
- [Issue #348 R1 Code Review 与复核](architecture/local-host-kernel-r1-code-review.md)
- [Issue #348 R1 实施与验证](architecture/local-host-kernel-r1-implementation.md)
- [Issue #348 R1：PR #353 评论核验与修复](architecture/local-host-kernel-r1-pr-review-followup.md)
- [Issue #348 R1：第二轮 PR 评论核验](architecture/local-host-kernel-r1-pr-review-r2.md)
- [Issue #348 R1：大输出与真实 Mission 释放问题修复](architecture/local-host-kernel-r1-token-counter-followup.md)
- [Issue #348 R2：CR、裁决与修复验证](architecture/local-host-kernel-r2-code-review.md)
- [Issue #348 R2：Mission 编译编排实施与验证](architecture/local-host-kernel-r2-implementation.md)
- [Issue #348 R2：PR #354 评论复核与修复](architecture/local-host-kernel-r2-pr-354-followup.md)
- [Local Host Kernel R3 CR 与修复复核](architecture/local-host-kernel-r3-code-review.md)
- [Local Host Kernel R3 实施与验证](architecture/local-host-kernel-r3-implementation.md)
- [PR #355：Flow result 拒绝观察时序修复](architecture/local-host-kernel-r3-pr-355-flow-rejection-followup.md)
- [Issue #348 R3：PR #355 评论复核与修复](architecture/local-host-kernel-r3-pr-355-followup.md)
- [Issue #348 R4 CR 与修复复审](architecture/local-host-kernel-r4-cr-followup.md)
- [PR #356：完整组合失败与文件锁竞争复查](architecture/local-host-kernel-r4-file-lock-followup.md)
- [Issue #348 R4 实施与验收](architecture/local-host-kernel-r4-implementation.md)
- [Issue #348 R4：PR #356 最新评论复查](architecture/local-host-kernel-r4-pr-recheck.md)
- [Issue #348 R4：PR #356 评论修复](architecture/local-host-kernel-r4-pr-review-followup.md)
- [Issue #368：管理工具迁移到 CLI + 内置 Skill 的三阶段计划](architecture/management-tools-cli-skills-migration-plan.md)
- [Issue #368 第一阶段 Code Review 与修复复核](architecture/management-tools-cli-skills-phase-one-code-review.md)
- [Issue #368 第一阶段实施与验收记录](architecture/management-tools-cli-skills-phase-one-implementation.md)
- [PR #371 评论核实与修复](architecture/management-tools-cli-skills-phase-one-pr-review-follow-up.md)
- [Issue #368 第三阶段 CR 与 PR 评论修复结论](architecture/management-tools-cli-skills-phase-three-code-review.md)
- [Issue #368 第三阶段实施与三阶段验收结论](architecture/management-tools-cli-skills-phase-three-implementation.md)
- [Issue #368 第二阶段 CR 与修复记录](architecture/management-tools-cli-skills-phase-two-code-review.md)
- [Issue #368 第二阶段实施与验收记录](architecture/management-tools-cli-skills-phase-two-implementation.md)
- [管理 CLI 统一 Skill 实施记录](architecture/management-tools-cli-skills-unified-skill-implementation.md)
- [Mission 删除优化：审查与验证记录](architecture/mission-deletion-validation.md)
- [Issue #398 输出基准](plans/issue-398-output-evidence.md)
- [Issue #398：CR 复核与修复](plans/issue-398-review.md)
- [Issue #398：CLI Agent 工作流实施清单](plans/issue-398.md)
- [ADR 053: Trusted Git Skill synchronization](adr/053-trusted-git-skill-synchronization.md)
