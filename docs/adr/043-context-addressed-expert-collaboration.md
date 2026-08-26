# ADR 043: Context-addressed Expert collaboration

- Status: Accepted
- Date: 2026-08-25
- Supersedes: ADR 042 tool decisions

## Context

`delegate_expert` 同时用 `expertId` 表示新建工作、用 `agentId` 表示连续工作，Agent 仅凭工具名和
description 很难判断是否会丢失上下文。`message_expert` 与 `steer_expert` 又把同一种“修正当前任务”
意图拆成两个低频工具。AgentInstance 只属于 Execution，无法作为跨 prompt 的连续性句柄；真正稳定的
连续性边界是 ExpertTeam Session 内的 Runtime Context。

## Decision

协作工具固定为六个，并让输入身份与意图一一对应：

- `spawn_expert({ expertId, task })` 始终创建新的 Runtime Context、AgentInstance 和 Invocation；
- `continue_expert({ contextId, task })` 在当前 Team Session 内复用 Context。本轮复用已绑定 Agent，
  跨 Execution 则恢复 snapshot 并物化新的 AgentInstance；
- `list_agents(...)` 返回完整团队目录以及本轮和历史成员 Context；
- `wait_experts({ invocationIds, ... })` 只等待当前 Invocation 直接通过 spawn 或 continue 创建的任务；
- `steer_expert({ invocationId, instruction, delivery })` 以 `next_boundary` 请求 Runtime 在当前 turn 的
  下一个可支持边界注入，以 `after_current` 替代旧 message，在当前 turn 完成后启动同一 Invocation 的
  排队 continuation；两种语义必须显式选择；
- `interrupt_expert({ invocationId, reason? })` 只停止精确 Invocation。

`expertId` 只选择 Expert 定义，`contextId` 只选择 Session 内连续上下文，`invocationId` 只选择任务，
`agentId` 只用于返回值、状态和审计。删除 `delegate_expert` 与 `message_expert`，不保留兼容别名。

`spawn` 权限控制新 Context；`interact` 权限控制 continue 与 steer，但不授予 interrupt。协调者拥有当前
Team Session 的管理权限，owner 可以中断自己创建的 Agent 工作。目录可见性不授予读取完整输出、wait
或写权限，所有操作都在执行时沿 Invocation → Agent → Context 重新授权。

等待图由调用者到直接任务的 Join 边和同 Agent 后序到前序非终态任务的 FIFO 边组成。spawn/continue
在同一乐观事务边界创建 Invocation 并验证无环；版本冲突后重新读取和验证。wait 不增加任意 peer 边，
steer 不创建任务或依赖。等待和人工交互释放并发 permit。自动终结屏障使用 10 分钟有界等待，超时后
恢复协调 Agent 并返回 pending，让其再次 wait、steer 或 interrupt。

聊天分支是新的 Mission、ExpertSession、Context 和 Runtime Session。它通过只读 transcript 和 Mission
Board 获得语义连续性，不继承源 Session 的成员 Context，因此可以选择不同 Runtime。成员 Context 的
portable handoff 需要创建 branch-local Context 和新 `contextId`，不修改本决策。

DSL `apiVersion` 保持 `pragma/v5`。Compiler 写入版本升级到 `pragma.dsl/v9`；v8→v9 迁移删除 ExpertTeam
delegation 与 delegate tool policy 上的 Context policy。Host 不改写权威 Revision；原 v8 Revision 即升级前
备份，v9 结果继续写入可重建的派生 view，失败时丢弃 view 后可从原 Revision 重试。

## Consequences

- Agent 从工具名和 description 即可区分新建、连续、修正、等待和停止。
- Context 能跨同一 Session 的多个 prompt 恢复，而 AgentInstance 继续保持 Execution-scoped。
- 一个 Context 在一个 Execution 中只有一个 Agent FIFO；并行工作必须 spawn 新 Context。
- continue 他人 Context 的调用者只能 wait 自己新建的 Invocation，不能 wait 对方旧任务。
- 旧工具名和旧 DSL delegation Context policy 会被拒绝或迁移，不存在长期兼容分支。
