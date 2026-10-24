# Runtime 与 Host 接入

- Host 负责接收任务、创建运行、权限校验、调度 DSL 资源、记录执行事实，并管理成本和治理流程。
- Core 定义专家能力、输入输出协议、Invocation 与 Runtime Adapter 合约。
- Core 通过可选 `UsageSink` 发出逐 Runtime turn 的 token observation，但不持久化跨 Execution
  的统计账本；Desktop、CLI 或未来云端 Host 负责统计持久化、保留和查询策略。
- 所有 Token 数量预估必须调用 `@pragma/core` 导出的统一 `RuntimeTokenCounter`。具体 Runtime、
  Desktop、CLI 或插件不得自行实现 chars/token、bytes/token、CJK 修正或其他 Token
  估算算法。Runtime 提供精确上报时必须优先采用上报值；只有缺少上报时才能调用统一计数器。
- 结构化消息的供应商协议序列化留在具体 Runtime，序列化后的文本统一交给
  `RuntimeTokenCounter`。统一 fallback 在 Core 中懒加载应用内安装的 tokenizer；不得把词表复制到
  Runtime package，不得从 CDN 下载并执行远程代码，也不得要求终端用户配置 tokenizer 环境变量。
- 新 Runtime 必须测试 Runtime 上报优先级和统一 Token 估算 fallback。代码评审发现新的 Runtime
  本地 Token 估算器时，按架构边界违规处理。
- Host 可以调用 Core；Core 不得反向依赖 Desktop、CLI 或未来 Host 应用层。
- 本地 Claude Code、Codex、Qoder CLI、Antigravity CLI、自研执行环境属于 Runtime Adapter 的实现目标，由 Desktop App 承载本地连接、授权和执行桥接；Host 调用 Core，Core 不依赖 Host。

## 基础能力

所有 Runtime 必须支持受管 MCP、Skill 按需加载和原生命令执行。权限模式不得通过整体隐藏 bash
或漏装 Skill 来实现。显式资源拒绝、受管 MCP 白名单与 Session 身份校验继续生效。
MCP 的“已连接”不等于工具对模型可用，验收必须实际调用工具；Skill 必须实际发现、加载并读取支持文件。

## Harness 原生权限

- Expert 设置选择 Harness、模型与该 Harness 自己提供的权限模式，默认完全访问，不提供 Plan。
- Adapter descriptor 的 `permissionModes` 是模式目录的唯一来源；不可用模式必须给出原因，未知或不可用 ID 必须拒绝。
- 模式必须参与 Adapter cache、编译身份和 Runtime Context 身份；不同模式不得复用同一原生 Session。
- 只读必须由 Harness 原生边界实施；受管 MCP 工具仍遵守各自 allowlist 与业务审批。Pi 不额外模拟只读或审批。
- 首期目录与迁移边界见 [ADR 078](../adr/078-expert-native-harness-permissions.md)。

Codex 在首次创建和恢复时都必须重新提交当前 `sandbox` 与 `approvalPolicy`。
回归覆盖各 Harness 支持模式的首次执行、恢复、切换，以及审批拒绝无副作用和批准重试。
Pi 的旧显式策略仅保留用于兼容历史 Adapter binding；新建产品配置只公开原生完全访问。


## 接入验收

新增 Runtime 或提升 capability 必须完成[Runtime Adapter 接入清单](runtime-adapter-integration-checklist.md)，保留代码、自动测试与真实 Runtime smoke 证据。配置落盘或 mock 成功不能单独证明 capability 可用。

- [Runtime 使用量统计](runtime-usage-accounting.md)
- [Runtime 进程环境](../architecture/runtime-process-environment-policy.md)
- [Codex 私有 Home](../adr/026-codex-minimal-home-projection.md)
- [OpenCode Runtime](../architecture/opencode-runtime.md)
- [Antigravity Runtime](../architecture/antigravity-cli-runtime.md)

## 未来云端桥接

当前只有 Desktop 与 CLI Host，没有 Server/Worker 应用。未来云端通过 Desktop 主动建立的安全连接下发任务，由 Desktop 承载本机权限与执行。不得新增独立 `apps/local-runner`。引入云端应用或桥接协议前先补 ADR、依赖边界和最小验证方案；本文不预建未来目录或接口。

## 本机 CLI 前提

- Qoder：主机安装可执行 `qodercli`，用 `qodercli --version` 核验；复用本机登录或 `QODER_PERSONAL_ACCESS_TOKEN`，非标准路径使用 `QODERCLI_PATH`。
- OpenCode：安装 `opencode` 并配置模型；支持范围、协议与存储见上方 Runtime 文档，不根据历史调研扩大能力声明。
- Antigravity：安装 `agy`，非标准路径使用 `AGY_PATH` 指向原生可执行文件而非 Windows `.cmd` shim；在 Pragma 外完成交互登录，认证模式与宿主隔离以 Runtime 文档为准。
- Desktop `predev` 负责准备 Electron 二进制，使用 package 脚本启动，不依赖安装包 postinstall 已经下载二进制的假设。
