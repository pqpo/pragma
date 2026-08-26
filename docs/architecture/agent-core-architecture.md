# Agent Core Architecture

Core 分为声明、执行、Runtime 和存储四个边界：

1. `defineExpert()` 与 `defineExpertTeam()` 产生不可变 Expert 定义；普通 Expert 通过
   `createAgentLauncher().tools` 获得受控 subagent 生命周期能力。
2. ExpertSession 接收外部 prompt；FlowSpec 通过 `task()`、`humanTask()`、`use()`、`compose()` 编排。
3. ExpertTurn 与 FlowExecution 共享 ExecutionStore、InvocationTree 和单一 Canonical Event Log。
4. Runtime driver 明确拆分 create、restore、start turn、steer、cancel turn 和 close session。

Expert 不包装成单节点 Flow。普通 Expert 与 ExpertTeam 共用异步编排机制：`spawn_expert` 按
`expertId` 创建全新 Runtime Context、Execution-scoped AgentInstance 和 Invocation；
`continue_expert` 按当前 Team Session 的 `contextId` 追加 FIFO Invocation。本轮复用 Agent，跨轮恢复
snapshot 并物化新 Agent。`wait_experts` 只汇合调用者直接创建的 Invocation；`steer_expert` 按
`invocationId` 选择在当前 Runtime turn 的下一个 steering boundary 注入，或等该 turn 完成后排队启动
continuation；`interrupt_expert` 精确停止一个 active 或 queued Invocation。

两种声明方式只负责提供不同治理配置：

- standalone Expert 的 launcher 显式列出可调用的子专家；
- ExpertTeam 根据当前调用者和成员权限策略动态生成工具；coordinator 在当前 Team Session 内拥有
  系统继承的全量管理权限。团队工具覆盖成员自己的 standalone launcher。

根 launcher 的 `maxConcurrency` 和 `maxDepth` 是整个委派树的执行预算。Flow step 继续通过
`ContextIdResolver` 选择 Context；delegation 不接受 Context policy：spawn 固定 fresh，continue 固定
复用显式 `contextId`。等待任务或人工输入时释放并发 permit，避免嵌套死锁。

ExpertSession 根 Expert 不属于 delegation：Session 创建时同步建立唯一根 Runtime Context，所有根 prompt
始终引用该 Context；需要 fresh root 时创建新的 ExpertSession。`createSession({ runtime })` 只负责在创建
根 Context 前完成 Runtime routing，后续执行和恢复只读取 Context 上不可变的 `runtimeId`。

## InvocationService 与 ExpertOrchestrator

`InvocationService` 统一承担 Invocation 的可靠创建、状态迁移和 Canonical Event 原子提交。
Flow Scheduler 保留静态图遍历、按 `nodeId + visit` 幂等的循环访问、reduce 和 transition；同一节点
被条件回边再次访问时创建新的 Invocation，恢复时按访问序号重放既有 Invocation。
`ExpertOrchestrator` 保留 Agent ownership、FIFO、并发、深度、wait、steer、interrupt 和终结屏障策略。

Flow 回边后会为新的 Invocation 再次调用 step resolver：返回旧 `contextId` 就沿用 Runtime Session，
返回新 ID 就隔离。Team 成员是否连续由 Agent 显式选择 spawn 或 continue。流程必要数据（修订要求、
历史产物）仍通过 state/input 显式传递；Context 复用只负责 Runtime 对话连续性。

```text
Flow Scheduler / ExpertOrchestrator
→ InvocationService.ensureQueued() / transition()
→ ContextResolutionService.resolve()
→ ExecutionStore.commit(Context + Agent + Invocation + Event)
→ runExpertInvocation()
→ RuntimeAgentSession.submit()
```

RuntimeContextRecord、AgentInstance 与 Invocation 是三个不同身份：Context 保存 Runtime 对话与 snapshot，
AgentInstance 表示当前 owner Context 下串行执行的线程，Invocation 表示该线程上的一次可调度、可等待、
可恢复任务。一个 Agent 同时最多运行一个 active Invocation，不同 Agent 可并行。
Invocation 的 `agentTaskSequence` 是 FIFO 的唯一顺序源，不另存一份易漂移的 queue 数组。
ExpertSession 以 Session Context Registry 作为跨 prompt 的 Context/snapshot 来源；每个 prompt 的
Execution 只物化本轮 AgentInstance、Invocation 及其 Context binding，因此跨 prompt 复用 Context
不会把上一轮 Agent 的任务队列带入本轮。

Runtime Context 使用显式 origin：根 Context 由 ExpertSession 创建，Flow 与 delegation Context 由
Invocation 创建。Snapshot 只保存 `systemSessionId` 与 `RuntimeSessionRef`，不复制 Expert 或 Runtime identity。

父 Runtime turn 返回后，若仍存在未 join 的直属 Invocation，父 Invocation 进入 `waiting`，释放 permit，
最多等待 10 分钟。全部终结时记录 `expert.children.completed`；超时时记录
`expert.children.wait-timed-out` 并携带 pending 状态恢复原 Context，让 Agent 决定再次 wait、steer 或
interrupt。失败、取消和中断的
子 Invocation 都是可收集终态，不会自动使父 Invocation 失败。只有全部直属任务被 join 后父 Invocation
才能成功，因此不会依赖模型记住调用 wait。

Invocation 输出统一为 `inline` 或通用 `context` 引用。超过阈值的输出由 Core 通过 Host 注入的唯一
Context overflow target 写入；Core 不认识 Mission Board 包或物理存储。Desktop 将 Mission Board 作为
Mission-scoped Context binding 注入，因此 successor Session、Flow 与应用重启后仍共享同一白板。
`wait_experts` 和自动续跑只传有界摘要与 Context 引用。计划、TODO、进度、决策、handoff 和 process
都是 Mission Board `GUIDE.md` 描述的使用范式，不新增专用 managed tool。

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
