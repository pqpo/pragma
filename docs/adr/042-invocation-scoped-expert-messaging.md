# ADR 042: Invocation-scoped Expert messaging

- Status: Superseded by ADR 043
- Date: 2026-08-22

## Context

旧的后续任务工具同时承担“创建后续任务”和“向运行中专家通信”两种含义。成员之间把通信实现为
新的子 Invocation 时，会额外形成 Join 依赖；双向通信因此可能把两个本应独立运行的 Invocation 连接成
等待环，并且消息可能在目标任务结束后错误进入同一 Agent 的下一项任务。

## Decision

Pragma 将任务委派和运行中通信拆成两个协议：

- `delegate_expert({ expertId, task })` 创建新的 AgentInstance、Runtime Context 和 Invocation；
- `delegate_expert({ agentId, task })` 复用既有 AgentInstance 与 Context，创建 FIFO Invocation；
- `message_expert({ agentId, invocationId, message })` 只写入该 Agent 当前明确 active Invocation 的 Inbox；
- `steer_expert({ agentId, invocationId, message })` 只向当前 Runtime turn 投递引导，由 Runtime 在最近的
  steering boundary 应用；它不应主动中断当前 tool call，也不提供后续 Invocation 降级；
- `wait_experts` 只 Join 当前 Invocation 直接委派的 Invocation。

Invocation 是可调度、可等待、可恢复的工作单。AgentInstance 是串行执行线程，同一时刻只有一个
`activeInvocationId`；一个 Runtime Context 可以被该 Agent 的多个 Invocation 顺序复用。

任务依赖由两类边组成：调用者到直接委派任务的 Join 边，以及同一 Agent 后序任务到前序非终态任务的
FIFO 边。提交委派前必须验证完整 Wait-for Graph 无环。Message 不创建 Invocation、不成为 Join 边，也不
跨 Invocation 投递。

消息接受和 Invocation 终结使用同一 Execution 乐观版本边界。消息先提交时，终结提交必须冲突并在下一
安全边界消费 Inbox；终结先提交时，消息返回 `stale_invocation`。接受的消息以 canonical 顺序批量消费，
产生 `expert.message.accepted` 与 `expert.message.consumed` 审计事件。

## Consequences

- Agent 选择工具时只需判断“新任务、可靠安全边界消息、当前 turn steer”三种意图。
- 双向消息不会改变 Wait-for Graph，原有通信型死锁被消除。
- 调用方必须保存并提交准确的 `invocationId`；不能只凭长期 `agentId` 向未来任务投递。
- 需要新结果时必须委派新的 Invocation；消息本身不能被 `wait_experts` 等待。
- 这是 breaking change；不保留旧任务工具或 steer fallback 别名。
