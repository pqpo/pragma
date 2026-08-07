# 本地 Agent 桥接架构

本文描述云端 Pragma 如何通过 Desktop App 调度本地 Agent，并记录本地桥接的架构约束和目录规划。

## 结论

本地 Agent 的入口是 Desktop App，不是 `apps/local-runner`。

Desktop App 负责连接云端、注册本地能力、承载本地权限闸门，并调用本机 Claude Code、Codex、Qoder CLI、Antigravity CLI 或自研 Agent。云端 Server/Worker 负责调度、治理、审计和 Trace。

## 架构链路

```text
Cloud Pragma
├── apps/server
├── apps/worker
├── packages/server/src/runtime-gateway
└── packages/core
        │
        │ 双向安全连接，由 Desktop App 主动建立
        ↓
Desktop App
├── Device Session
├── Local Permission Guard
├── Workspace Scope
├── Claude Code Adapter
├── Codex Adapter
├── Qoder CLI Adapter
├── Antigravity CLI Adapter
└── Self-hosted Agent Adapter
```

云端不直接访问用户机器，不要求本机暴露公网端口。

## 职责边界

### 云端

- 用户、租户、设备、会话管理。
- ExpertRun / PlaybookRun 创建。
- 权限、预算、schema 校验。
- Runtime 选择：云端沙箱或本地 Agent。
- 任务下发、事件接收、取消、超时、重试。
- Trace、日志、artifact、成本和审计。

### Desktop App

- 用户登录和设备绑定。
- 本地工作区选择。
- 主动连接云端 Runtime Gateway。
- 注册本机 Runtime 能力。
- 调用本机 Claude Code、Codex、Qoder CLI、Antigravity CLI 或自研 Agent。
- 拦截文件、shell、git、网络和 secrets 访问。
- 在敏感操作前展示本地确认 UI。
- 回传日志、增量输出、tool call、diff、artifact 和最终结果。

### 本地 Agent

本地 Agent 是 Desktop App 后面的 Runtime 实现目标，不直接成为云端应用入口。

示例：

```text
Claude Code
Codex
Qoder CLI
Antigravity CLI
Self-hosted Agent
企业内部 Agent
```

## 通信模式

优先使用 Desktop App 主动建立的双向安全连接：

```text
Desktop App -> Cloud Runtime Gateway
```

推荐顺序：

1. WebSocket 或等价双向通道。
2. 企业网络受限时，降级为 App 主动轮询任务。
3. 后续如需交互式会话，再考虑受控 relay。

不允许把云端设计成直接 SSH、HTTP 或 RPC 访问用户本机。

## 协议对象

后续协议应放在：

```text
packages/core/src/local-agent-bridge
```

建议包含：

```text
DeviceRegistration
DeviceSession
RuntimeCapability
LocalRunRequest
LocalRunEvent
LocalPermissionRequest
LocalPermissionDecision
WorkspaceScope
ArtifactUpload
```

事件类型示例：

```text
device.connected
device.heartbeat
runtime.capabilities.updated
run.accepted
run.started
assistant.delta
tool.requested
permission.requested
permission.decided
file.diff
artifact.created
run.completed
run.failed
run.cancelled
```

## 目录规划

未来目录：

```text
apps/
  desktop/

packages/
  core/
    src/local-agent-bridge/
  server/
    src/runtime-gateway/
  runtime/
    antigravity/
    claude-code/
    codex/
    pi/
    qodercli/
```

说明：

- `apps/desktop` 是 Desktop App，不是 CLI runner。
- `packages/core/src/local-agent-bridge` 只放协议、schema、类型和桥接抽象。
- `packages/server/src/runtime-gateway` 放云端会话管理、任务下发和事件接收。
- `packages/core` 放 Runtime Adapter 合约、Runtime 选择公共协议和本地桥接协议。
- 具体 Runtime Adapter 实现属于独立 `@pragma/runtime-*` 包或 Desktop App 后面的本地适配层。

## 安全规则

- 云端不能任意执行本地 shell。
- 云端不能任意读取本地文件。
- 云端不能直接获取本地 secrets。
- 本地文件写入必须经过 workspace scope 和权限策略。
- 敏感操作必须本地确认或被明确策略允许。
- 所有本地运行事件必须可审计。
- Desktop App 必须能随时断开设备会话。

## 依赖规则

`A -> B` 表示 `A` 可以依赖 `B`：

```text
apps/server -> packages/server/src/runtime-gateway -> packages/core/src/local-agent-bridge -> packages/core -> packages/shared
apps/worker -> packages/core -> packages/shared
apps/desktop    -> runtime-* / packages/core/src/local-agent-bridge -> packages/core -> packages/shared
```

禁止：

```text
packages/core -> packages/server
packages/core -> packages/client
packages/core -> apps/*
apps/web -> packages/core
```

## 阶段建议

1. Phase 1：定义 Expert Manifest、RuntimeAdapter、RuntimeEvent。
2. Phase 2：实现云端 Runtime Gateway 和云端沙箱 Runtime。
3. Phase 3：定义 Local Agent Bridge 协议和设备注册模型。
4. Phase 4：实现 Desktop App 的连接、设备绑定、能力注册和权限闸门。
5. Phase 5：接入 Claude Code / Codex / Qoder CLI / Antigravity CLI 本地 Runtime Adapter。

## 当前桌面端基础架构

`apps/desktop` 已作为 Desktop App 产品入口建立第一版基础架构：

- Electron main process：负责原生窗口、本地工作区选择和未来本地权限闸门。
- preload：通过窄的类型化 IPC API 暴露桌面能力，Renderer 不直接访问 Node API。
- renderer：React/Vite 控制台，用于展示设备会话、Runtime Gateway 配置、工作区范围和本地 Runtime 能力占位。

当前实现已经装配 PI、Claude Code、Codex、Qoder CLI 和 Antigravity CLI 本地 Runtime，但仍刻意不包含云端连接、设备绑定、自动更新或 daemon 管理。下一步应先补 `packages/core/src/local-agent-bridge` 协议模块，再让 Desktop App 依赖该协议注册能力并连接 Runtime Gateway。

Antigravity 的系统提示词、startup messages、MCP、Skill、权限 Hook 和私有 HOME 适配见
[`antigravity-cli-runtime.md`](./antigravity-cli-runtime.md)。

Desktop Studio 已增加本机 Capability Library。Skill、MCP Server 与 HTTP Service 在 Desktop 中版本化保存，Expert 只引用固定 revision 和明确的 tool 白名单。HTTP Service 由 `@pragma/core` 的 in-process MCP adapter 转换为标准 MCP tools；Capability Library 不改变云端 Runtime Gateway 与 Desktop 主动连接的依赖方向。
