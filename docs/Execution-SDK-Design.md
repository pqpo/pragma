# Execution SDK Design

Pragma 只有两种顶层执行对象：Expert Session 与 Flow Execution。声明入口只有
`defineExpert()`、`defineExpertTeam()` 和 `defineFlow()`。

```ts
const session = await app.experts.createSession(expert);
const turn = await session.prompt("hello");
console.log(turn.requestId);

const execution = await app.flows.start(flow, { input });
const view = await app.flows.open({ executionId: execution.executionId });
```

每个 ExpertTurn 和 FlowExecution 都对应一个 Execution。Execution 的根和全部子调用由
InvocationTree 表示。完整 `AgentMessage` 与编排事实进入单一 Canonical Event Log，并使用
`{ executionId, sequence }` cursor 分页；实时 token delta 只通过 `subscribeOutput()` 分发，
不长期持久化。`getMessageHistory()` 从 `invocation.message.appended` 投影，不维护第二份消息文件。

观察接口按职责拆分：`subscribeOutput()` 和 `subscribeEvents()` 只接收订阅后的未来数据，
`listEvents()` 读取有限的持久化事件，`getMessageHistory()` 读取完整标准消息，`getTree()`
读取最终 InvocationTree。Runtime 原生 Session 只负责恢复具体 Runtime，不作为公共历史数据源。
Expert Session 自身的 state、prompt queue 与 Session 级语义事件通过同一个可恢复事务 journal
提交，避免崩溃恢复后出现状态已经变化但对应事件永久缺失。

Flow Expert step、`createAgentLauncher().tools` 和 `defineExpertTeam()` 共享
`ContextResolutionService`、`InvocationService` 与 Execution 级
`ExpertOrchestrator`。前者为普通 Expert 显式列出目标，后者从团队 allowlist 解析目标；两者都
创建 Execution-scoped AgentInstance 和子 Invocation，不创建隐藏 ExpertSession 或伪装成单节点 Flow。

Expert 恢复只恢复会话上下文，不重启 interrupted Turn。Flow recover 会继续未完成
Invocation，并跳过已经成功的节点。`interrupted` 对普通提交是不可覆盖终态；只有持有当前
Execution recovery claim 的恢复提交可以将 Flow 自身及未完成子 Invocation 重新置为 queued/running，
避免迟到的 Runtime 事件把已中断任务意外复活。
