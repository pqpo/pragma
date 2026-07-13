# Execution SDK Design

Pragma 只有两种顶层执行对象：Expert Session 与 Flow Execution。声明入口只有
`defineExpert()`、`defineExpertTeam()` 和 `defineFlow()`。

```ts
const session = await app.experts.createSession(expert);
const turn = await session.prompt("hello", { requestId: "request-1" });

const execution = await app.flows.start(flow, { input });
const view = await app.flows.open({ executionId: execution.executionId });
```

每个 ExpertTurn 和 FlowExecution 都对应一个 Execution。Execution 的根和全部子调用由
InvocationTree 表示。所有运行事实进入单一 Canonical Event Log，并使用
`{ executionId, sequence }` cursor 回放；Output 保留相同源 cursor，但只是事件投影，不独立持久化或编号。

`createAgentLauncher().tool` 和 `defineExpertTeam()` 共享同一个 delegation application service。
前者为普通 Expert 显式列出 subagent，后者从团队 allowlist 解析目标；两者都直接创建子
Invocation，不创建隐藏的 ExpertSession 或伪装成单节点 Flow。

Expert 恢复只恢复会话上下文，不重启 interrupted Turn。Flow recover 会继续未完成
Invocation，并跳过已经成功的节点。
