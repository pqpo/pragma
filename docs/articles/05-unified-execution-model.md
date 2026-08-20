# 统一 Expert、ExpertTeam 与 Flow：如何组合复杂的 Agent 系统

> 《构建跨 Harness 的多 Agent 系统：Pragma 技术实践》第五篇

构建多 Agent 系统时，很容易逐渐形成三套运行机制：单 Agent 用聊天 Session，团队协作用 Subagent Manager，确定性流程再使用一套 Workflow Engine。

三者分别实现并不困难，真正困难的是组合之后会发生什么：Flow 中调用 Team，Team 成员再启动子 Agent，子 Agent 又调用另一个 Flow。此时谁负责取消？并发预算属于哪一层？输出如何回到父节点？一个进程崩溃后从哪里继续？Usage 和审计应该记录在哪条链上？

Pragma 的核心选择是：Expert、ExpertTeam 与 Flow 提供不同的声明和治理方式，但运行时统一落入同一个 Execution / Invocation 模型。

## 三种组合原语

### Expert：可持续执行的能力单元

Expert 定义角色范围、指令、Runtime、模型、Capability、ContextStore 和工具。ExpertSession 接收外部 Prompt，并为根 Expert 创建唯一的根 Runtime Context。同一 Session 的后续 Prompt 继续复用这个 Context；需要一个全新根上下文时，应创建新的 ExpertSession。

普通 Expert 还可以通过显式注入的生命周期工具调用已授权的其他 Expert：

```text
spawn_expert
wait_experts
list_agents
followup_expert
interrupt_expert
```

这些工具不是某个 Runtime 的私有 Subagent 功能，而是 Core 的受治理 Invocation 机制。

### ExpertTeam：带治理边界的动态协作

ExpertTeam 由 coordinator 接收外部任务。coordinator 在当前 Team Execution 内拥有系统继承的全量管理权限，成员之间则按 `spawn` / `interact` 权限协作。它和普通 Expert launcher 使用同一套生命周期工具，但 Team 运行时会覆盖成员自己的 standalone launcher，防止成员绕过团队边界调用未授权对象。

Team 可以提供只在本次团队执行中生效的关键指令，所有参与者都能读取，但不会修改可复用 Expert 定义，也不会泄漏到使用同一 Expert 的其他 Team。

### Flow：确定性的控制结构

Flow 用静态图组合 Expert、ExpertTeam、子 Flow、Task 和 HumanTask。普通边保持 DAG；需要循环时必须使用具名 `repeat` transition，并声明正整数 `maxIterations` 和离开循环的 `onLimit` 路径。

Flow 负责确定性控制：输入映射、状态归约、条件路由、循环、超时和人工等待。Expert 负责开放式推理。两者互补，而不是互相替代。

## Expert 不需要包装成单节点 Flow

一种常见的“统一”方式，是把所有 Expert 调用都包装成只有一个节点的 Flow。表面上对象数量变少了，实际上会产生错误抽象：

- 普通对话也要背负 Flow graph 和 scheduler 语义；
- 子 Agent 的线程、follow-up 和 wait 被伪装成工作流节点；
- Runtime Context 复用与静态图节点复用混在一起；
- Team 委派很难表达动态产生的子任务。

Pragma 统一的是执行事实，而不是强迫所有声明对象长成同一种形状。

```text
Expert / Team / Flow
        ↓
InvocationService
        ↓
ExecutionStore + Invocation Tree
        ↓
Runtime Context + Canonical Event Log
```

Expert 可以保持自然的 Session API，Flow 可以保持图语义，但两者产生的任务都成为 Invocation。

## Execution、Invocation、AgentInstance 与 Context

统一执行模型中最容易混淆的是四种身份。

### Execution：一项可观察、可恢复的运行

Execution 保存根定义、状态、输入、Flow state、最终输出、Usage 和版本。它拥有一棵 Invocation Tree 和一条单调递增的 Canonical Event Log。

### Invocation：一次具体任务

Invocation 表示某个 Expert、Team、Flow、Task 或 HumanTask 的一次调用。它拥有输入、输出、状态、父子关系和 `contextId`。同一 Flow 节点被循环再次访问时会创建新的 Invocation，而不是覆盖第一次访问。

### AgentInstance：可以接收后续任务的线程

AgentInstance 表示当前 Execution 中一个可 follow-up 的 Agent 线程。同一个 AgentInstance 同时最多运行一个 Invocation；后续任务通过 `agentTaskSequence` 严格 FIFO 排队。

### RuntimeContextRecord：Harness 对话连续性

Runtime Context 保存 Expert 身份、不可变 Runtime binding、model selection、原生 Session snapshot 和 lifecycle。Invocation 与 AgentInstance 只引用 `contextId`，不复制 Runtime Session 身份。

这四者解决的是不同问题：

```text
Execution       整项运行
Invocation      一次任务
AgentInstance   可连续派发的 Agent 线程
Runtime Context Harness 会话及其快照
```

把它们合并成一个 Session 对象，会使委派、循环、恢复和审计互相牵制。

## Context 复用由身份决定

Flow step、普通 Expert launcher 和 ExpertTeam delegation 统一使用具名、带版本的 `ContextIdResolver`。Resolver 返回新 ID 就创建隔离的 Runtime Context；返回已有 ID 就复用该 Context，并将 dispatch 合并到对应 Agent 的 FIFO。

Pragma 不再额外维护 `fresh/reuse` 布尔策略，因为真正决定复用的是最终 `contextId`。这允许实现多种组合：

- Flow 每次访问 Expert 都使用新 Context；
- 循环中的 coordinator 复用 Context；
- Team coordinator 复用、成员保持隔离；
- 多次 dispatch 汇入同一个 Agent 线程。

但流程必要数据仍然必须通过 input、state、output 或 ContextStore 显式传递。复用 Runtime Context 不能替代确定性的数据交接。

## 并发、等待与自动 Join

根 launcher 的 `maxConcurrency` 和 `maxDepth` 是整棵委派树的预算，而不是每个 Agent 各自重新获得一份额度。

当父 Agent 等待子任务时，它会释放并发 permit，避免一种典型死锁：父任务占满全部并发名额，却在等待没有名额启动的子任务。

子 Agent 的失败、取消或中断都是可收集终态，不会自动把父 Invocation 判为失败。父 Agent可以读取结果后决定重试、换人或降级。

如果模型启动了子 Agent 却忘记调用 `wait_experts`，框架也不会允许父 Invocation 直接成功。父 Runtime turn 返回后，只要还有未 join 的直属 Invocation，父 Invocation 就进入 `waiting`，等待全部结果，记录 `expert.children.completed`，然后在原 Runtime Context 中启动一次框架续跑，让父 Agent完成综合。

这使正确性不依赖模型是否记住了生命周期协议。

## Flow 的状态必须可恢复

Flow Scheduler 保留静态图遍历、输入映射、reduce 和 transition。循环控制使用 `nodeId + visit` 建立稳定访问身份，并在调度下一节点前持久化计数与状态。

HumanTask 可以让 Flow 进入持久等待；应用重启后继续等待，而不是重新执行之前已经成功的节点。Flow 的绝对 deadline 也会持久化，但 HumanTask 等待期间暂停计时，避免用户第二天批准时任务仅因为应用关闭过而超时。

嵌套 Flow 仍处于同一个 Execution 中。它有自己的子 Invocation 和状态 namespace，但不会另开一套无法关联的执行历史。

## Canonical Event 是统一观察面

Expert turn 和 FlowExecution 共享同一个 `ExecutionStore.commit()` 边界。Invocation 状态、Context、AgentInstance 和新增事件可以幂等提交；本地文件实现使用可恢复 transaction journal，未来数据库实现也必须提供等价的事务、唯一事件和乐观版本语义。

系统严格区分：

- LiveBus 上的 token、thinking 和 tool delta：实时、短期、非恢复来源；
- Canonical Event Log 中的完整消息和生命周期事实：持久、可重放、可审计。

终态也受到保护：Execution 或 Invocation 一旦成功、失败或取消，后续提交可以补充信息，但不能把它改成另一种最终结果。

统一事件面带来的价值是，Mission UI、Memory Evidence、Usage、审计和恢复不需要分别理解 Expert、Team 和 Flow 的内部实现。

## 组合能力来自同一治理边界

统一之后，Pragma 可以表达：

```text
Flow        = Expert + ExpertTeam + 子 Flow + HumanTask
Expert Tool = Expert + ExpertTeam + Flow
```

一个 Expert 可以把 Flow 当成同步工具，也可以委派另一个 Expert；Flow 可以调用 Team；Team 成员可以在显式权限范围内继续拆分任务。无论怎样嵌套，任务仍然处于同一个 Execution 中，因此共享：

- Context ownership；
- 并发和深度预算；
- 输出与大结果引用；
- 取消、超时和中断；
- Usage 与 Canonical Event；
- 恢复和审计链。

这才是“能够搭建复杂 Agent 系统”的基础。复杂性来自组合，而不是来自为每种组合再造一个新的运行器。

## 结语

Expert、ExpertTeam 和 Flow 不是三套互不相关的产品功能：

```text
Expert      提供专业能力
ExpertTeam  提供动态协作和治理边界
Flow        提供确定性的控制结构
Execution   提供共同的运行与可靠性底座
```

当三者共享同一种 Execution 语义后，开发者可以选择最适合任务的组合原语，而不用为每种组合重新解决 Session、并发、事件、取消和恢复。

下一篇将讨论如何把这些运行对象从 TypeScript 代码提升为一种可移植、可验证、可版本化的工作方式定义。

## 延伸阅读

- [Agent Core 架构](../architecture/agent-core-architecture.md)
- [Expert 与 Session 使用指南](../usage/agents.md)
- [Flow 使用指南](../usage/flows.md)
- [Flow 常用模式](../usage/flow-patterns.md)
- [Execution Canonical Event Log ADR](../adr/007-execution-canonical-event-log.md)
