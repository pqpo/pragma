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

## 基础能力与权限模式

所有 Runtime 必须支持受管 MCP、Skill 按需加载和原生命令执行。权限模式不得通过整体隐藏 bash
或漏装 Skill 来实现。显式资源拒绝、受管 MCP 白名单与 Session 身份校验继续生效。

| 模式               | 原生副作用审批                                               | 原生沙箱                           |
| ------------------ | ------------------------------------------------------------ | ---------------------------------- |
| `request-approval` | 原生策略要求额外授权时转交 Host；无 handler 或拒绝时不得执行 | 保留 Runtime 支持的 workspace 限制 |
| `auto-approve`     | 自动批准已支持的原生操作                                     | 保留 Runtime 支持的 workspace 限制 |
| `full-access`      | 自动批准                                                     | 使用 Runtime 的完整访问模式        |

受管 MCP 的逐工具审批仍由 Core 负责，Host 在自动模式下提供自动决策，不能绕过 Gateway 的工具白名单。
各 Runtime 的原生审批粒度不同，不能将请求审批等同于逐次工具确认。
Pi 当前通过包装原生 bash/write/edit 逐次请求 Host 审批，尚无普通操作与额外授权操作的策略区分；
也没有独立 OS 沙箱，`auto-approve` 与 `full-access` 的原生命令执行范围相同。
这些是 [Issue #425](https://github.com/pqpo/pragma/issues/425) 中明确延期的能力缺口，不能宣称三种模式的语义已完全一致，
不得把审批当成 OS 隔离。
Codex 在首次创建和恢复时都必须重新提交当前 `sandbox` 与 `approvalPolicy`，不能沿用历史宽松权限。
Desktop 与 CLI 均须将当前模式传给 Adapter，缓存键必须区分模式。

回归必须覆盖三种模式的首次执行与恢复，以及审批拒绝无副作用、之后重新批准可执行。
MCP 的“已连接”不等于工具对模型可用，验收必须实际调用工具；Skill 必须实际发现、加载并读取支持文件。

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
