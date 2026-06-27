# 本地 Agent 桥接架构

本文描述云端 ExpertMesh 如何通过 Desktop App 调度本地 Agent，并记录本地桥接的架构约束和目录规划。

## 结论

本地 Agent 的入口是 Desktop App，不是 `apps/local-runner`。

Desktop App 负责连接云端、注册本地能力、承载本地权限闸门，并调用本机 Claude Code、Codex 或自研 Agent。云端 Server/Worker 负责调度、治理、审计和 Trace。

## 架构链路

```text
Cloud ExpertMesh
├── apps/server
├── apps/worker
├── packages/server/runtime-gateway
└── packages/agent/*
        │
        │ 双向安全连接，由 Desktop App 主动建立
        ↓
Desktop App
├── Device Session
├── Local Permission Guard
├── Workspace Scope
├── Claude Code Adapter
├── Codex Adapter
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
- 调用本机 Claude Code、Codex 或自研 Agent。
- 拦截文件、shell、git、网络和 secrets 访问。
- 在敏感操作前展示本地确认 UI。
- 回传日志、增量输出、tool call、diff、artifact 和最终结果。

### 本地 Agent

本地 Agent 是 Desktop App 后面的 Runtime 实现目标，不直接成为云端应用入口。

示例：

```text
Claude Code
Codex
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
packages/agent/local-agent-bridge
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
  agent/
    agent-core/
    agent-runtime/
    local-agent-bridge/
  server/
    runtime-gateway/
```

说明：

- `apps/desktop` 是 Desktop App，不是 CLI runner。
- `packages/agent/local-agent-bridge` 只放协议、schema、类型和桥接抽象。
- `packages/server/runtime-gateway` 放云端会话管理、任务下发和事件接收。
- `packages/agent/agent-runtime` 放 Runtime 选择、云端 Runtime 和本地 Runtime 抽象。
- 具体 Claude Code / Codex 调用实现属于 Desktop App 的本地适配层。

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
apps/server -> packages/server/runtime-gateway -> packages/agent/local-agent-bridge -> packages/agent/agent-core -> packages/shared/*
apps/worker -> packages/agent/agent-runtime -> packages/agent/agent-core -> packages/shared/*
apps/desktop    -> packages/agent/local-agent-bridge -> packages/agent/agent-core -> packages/shared/*
```

禁止：

```text
packages/agent/* -> packages/server/*
packages/agent/* -> packages/client/*
packages/agent/* -> apps/*
apps/web -> packages/agent/*
```

## 阶段建议

1. Phase 1：定义 Expert Manifest、RuntimeAdapter、RuntimeEvent。
2. Phase 2：实现云端 Runtime Gateway 和云端沙箱 Runtime。
3. Phase 3：定义 Local Agent Bridge 协议和设备注册模型。
4. Phase 4：实现 Desktop App 的连接、设备绑定、能力注册和权限闸门。
5. Phase 5：接入 Claude Code / Codex 本地 Runtime Adapter。
