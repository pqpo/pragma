# Agent Core Architecture

Core 分为声明、执行、Runtime 和存储四个边界：

1. `defineExpert()` 与 `defineExpertTeam()` 产生不可变 Expert 定义；普通 Expert 通过
   `createAgentLauncher().tools` 获得受控 subagent 生命周期能力。
2. ExpertSession 接收外部 prompt；FlowSpec 通过 `task()`、`humanTask()`、`use()`、`compose()` 编排。
3. ExpertTurn 与 FlowExecution 共享 ExecutionStore、InvocationTree 和单一 Canonical Event Log。
4. Runtime driver 明确拆分 create、restore、start turn、steer、cancel turn 和 close session。

Expert 不包装成单节点 Flow。普通 Expert 与 ExpertTeam 共用异步编排机制：`spawn_expert` 创建
Execution-scoped AgentInstance 和首个 Invocation，`followup_expert` 在相同 Agent Context 上追加
FIFO Invocation，`wait_experts` 按 Invocation ID 汇合结果。`list_experts` 和 `interrupt_expert`
只管理当前调用者直接创建的 Agent。

两种声明方式只负责提供不同治理配置：

- standalone Expert 的 launcher 显式列出可调用的子专家；
- ExpertTeam 根据当前调用者和 allowlist 动态生成工具，并覆盖成员自己的 standalone launcher。

根 launcher 的 `maxConcurrency` 和 `maxDepth` 是整个委派树的执行预算。每次 spawn 使用新 Context；
只有同一 Agent 的 followup 复用该 Context 和 Runtime 快照。等待子孙时释放并发 permit，避免嵌套死锁。

## InvocationService 与 ExpertOrchestrator

`InvocationService` 统一承担 Invocation 的可靠创建、状态迁移和 Canonical Event 原子提交。
Flow Scheduler 保留静态图遍历、`nodeId` 幂等、reduce 和 transition；`ExpertOrchestrator` 保留
Agent ownership、FIFO、并发、深度、wait、followup、interrupt 和终结屏障策略。

```text
Flow Scheduler / ExpertOrchestrator
→ InvocationService.ensureQueued() / transition()
→ ExecutionStore.commit(Agent + Invocation + Event)
→ runExpertInvocation()
→ RuntimeAgentSession.submit()
```

AgentInstance 与 Invocation 是不同身份：AgentInstance 表示当前 Execution 内可接收 followup 的线程，
Invocation 表示该线程上的一次任务。一个 Agent 同时最多运行一个 Invocation，不同 Agent 可并行。
Invocation 的 `agentTaskSequence` 是 FIFO 的唯一顺序源，不另存一份易漂移的 queue 数组。

父 Runtime turn 返回后，若仍存在未 join 的直属 Invocation，父 Invocation 进入 `waiting`，释放 permit，
等待全部结果并记录 `expert.children.completed`，然后在原 Context 中启动框架续跑。失败、取消和中断的
子 Invocation 都是可收集终态，不会自动使父 Invocation 失败。只有全部直属任务被 join 后父 Invocation
才能成功，因此不会依赖模型记住调用 wait。

## Dispatcher 与通知边界

当前 Core 是进程内异步执行：Invocation 可靠落盘后由 `ExpertOrchestrator` 调度，不恢复旧
Directive/Workflow 的通用 Mailbox、TaskManager 或工作流运行器。

未来 Server/Worker 或 Desktop Runtime Gateway 需要分布式派发时，只在 queued 提交之后增加窄接口：

```text
InvocationService.ensureQueued()
→ ExecutionStore 原子提交 Invocation + invocation.queued
→ InvocationDispatcher.dispatch()
→ Inline Executor 或 Queue/Worker
```

Canonical Event Log 记录已经发生的事实，Dispatcher 传递尚待执行的命令，两者不能合并。
第一版完成通知来自 Canonical Event Log 和进程内 LiveBus；wait 在订阅后重新读取持久化状态，避免丢失
瞬时通知。外部调用方通过 Execution events/view 观察进度，不轮询内部 mailbox。
