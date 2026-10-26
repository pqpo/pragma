# 历史决策与验收边界

当前规范见[文档入口](../README.md)与[ADR 索引](../adr/README.md)。
已完成阶段的计划、实施流水账、CR、采样 JSON 与源码快照已从工作树移除，可从 Git 历史追溯。
本页保留会影响后续判断的验收边界；清理文档不表示补齐了历史验收，也不授权删除迁移链或数据。

## 共享 Mission 内核（Issue 348）

Desktop 与 CLI 共用 Local Host application，最终边界见 [ADR 066](../adr/066-unified-local-host-mission-application.md)。
历史工程门禁与局部基准已交付，真实模型、OS 凭据、Electron UI 和后台负载的完整产品验收仍有缺口。
性能目标与复测口径见[性能入口](../performance/README.md)；不根据历史 fixture 结果宣布整体完成。

## 管理 CLI 与内置 Skill（Issue 368）

当前入口与明确授权的 cutover 依据保留在 [ADR 067](../adr/067-execution-management-cli-and-built-in-skills.md)。
当时 Pi Keychain、Qoder 额度、真实模型审批/取消/历史交接/崩溃恢复、签名安装包及跨平台负向矩阵未全部验收；
工具数量或静态 token 估算下降不能证明任务整体成本下降。
CLI 查询的最终契约见 [ADR 071](../adr/071-agent-friendly-cli-queries-and-owner-waiting.md)与
[ADR 076](../adr/076-managed-resource-cli-queries.md)，固定数据输出基准不代表生产模型成本。

## Claude Code 打包（Issue 327）

Claude 原生 CLI 由用户安装；Desktop 排除 SDK 附带的 CLI 二进制，不能静默回退。
打包约束与当前回归入口见[Claude Code Runtime](../architecture/claude-code-runtime.md)。
当时 macOS x64 原生链路及安装包提取审计有通过记录；Windows、Apple Silicon 原生执行/UI
和未安装外部 Claude 的完整平台矩阵仍需独立验证，交叉打包与 clean-HOME 测试不能替代。

## 保留的旧决策

- [ADR 053：旧 Skill Git 同步](adr/053-trusted-git-skill-synchronization.md)：已由 ADR 060/070 取代，保留历史协议依据。
