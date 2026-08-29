# CLI M6 合并交接说明

- 负责人：开发专家（b2cd7xn16ntzcc0w）
- 时间：2026-08-25 19:50 CST

## 合并范围

- 将 `origin/main` `a9de7747` 合并到 `feat/pragma-cli` `8602be02`。
- 两边共同祖先为 `785381d6`；main 侧纳入 18 个 commit（`3a5cdf7d` 至 `a9de7747`），CLI 侧保留共同祖先之后的 7 个 commit。
- 合并前执行了 `git fetch origin`；未推送远端。

## 冲突与自动合并核实

- 唯一内容冲突是 `apps/desktop/src/main/features/missions/mission-ipc.ts`。
- 解决方式：保留 CLI 通过 `localHost.getMission()` 的 Host 边界，同时吸收 main 的 `MissionStoreError("mission_not_found", ...)` 稳定错误语义；main 的 Mission 分支创建、分页历史、错误包装和完成/重开 mutation 处理均保留。
- 已核对自动合并的 Desktop package、application container、mission runner、mission store/test 及 lockfile：CLI 的 Local Host 依赖与装配保留，main 的 schema v9、Mission 分页/分支与运行时更新保留。
- 无未解决冲突、冲突标记或 `git diff --check` 问题。`handoffs/cli-m5-test-report.md` 保持未跟踪，未纳入提交。

## 质量检查

- `pnpm install --frozen-lockfile`：通过，lockfile 与 workspace manifest 一致。
- `pnpm typecheck`：通过，24/24 packages。
- `pnpm lint`：通过，24/24 packages。
- `pnpm build`：通过，24/24 packages；Desktop main/preload/renderer、样式检查及 bundle 扫描通过。
- Desktop 受影响测试：12 files、249 tests 通过。
- `@pragma/local-host`：7 files、57 tests 通过。
- `@pragma/cli`：3 files、13 tests 通过。
- `@pragma/core`：46 files、307 tests 通过。
- `@pragma/interpreter`：10 files、107 tests 通过。
- `@pragma/runtime-qodercli`：9 files、31 tests 通过。
- `@pragma/shared`：8 files、35 tests 通过。

## 遗留风险

- 未重跑 Desktop 全量测试；M5 记录显示该套件在负载下曾出现不同测试点的 flaky 超时/断言失败。本次受影响测试、全仓 typecheck/lint/build 均通过，未修改相关 flaky 测试或业务代码。
- Desktop build 仍输出既有的第三方 `eval` 与动态 import 提示，但不影响构建结果。
