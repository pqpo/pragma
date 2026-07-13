# Agent Core Architecture

Core 分为声明、执行、Runtime 和存储四个边界：

1. `defineExpert()` 与 `defineExpertTeam()` 产生不可变 Expert 定义。
2. ExpertSession 接收外部 prompt；FlowSpec 通过 `task()`、`humanTask()`、`use()`、`compose()` 编排。
3. ExpertTurn 与 FlowExecution 共享 ExecutionStore、InvocationTree 和单一 Canonical Event Log；Output 是可重建投影。
4. Runtime driver 明确拆分 create、restore、start turn、steer、cancel turn 和 close session。

Expert 不再包装成单节点 Flow。团队委派直接创建子 Invocation，并受 allowlist、并发和深度限制。
