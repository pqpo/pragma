# Experts and Expert Sessions

```ts
const expert = await defineExpert({ ...options });
const session = await app.experts.createSession(expert);
const first = await session.prompt("hello");
console.log(first.requestId); // Core 自动生成，可在需要时用于幂等重试。
const retry = await session.prompt("hello", { requestId: first.requestId });
console.log(retry.executionId === first.executionId); // true
const output = await first.subscribeOutput({ scope: { kind: "root" } });
for await (const item of output) console.log(item.channel, item.delta ?? item.value);
const result = await first.result;
const turnUsage = await first.usage;

// 历史对话使用独立接口读取，不通过执行事件回放。
const histories = await session.getMessageHistory({ scope: { kind: "root" } });
const events = await session.listEvents();
// Usage 随 Execution 持久化；Session API 汇总所有已完成 Turn。
const sessionUsage = await session.getUsage();

const resumed = await app.experts.resumeSession(expert, { sessionId: session.sessionId });
await resumed.prompt("continue");
```

`createSession()` 会在返回前创建唯一根 Runtime Context；同一 Session 的所有根 prompt 都延续这条
Runtime 对话，进程恢复后也不变。需要完全独立的根对话时应创建新的 ExpertSession。
`createSession({ sessionId })` 只是用指定 ID 创建新 Session，同 ID 已存在会报错；恢复已有 Session
只能使用 `resumeSession()`。`createSession({ runtime })` 中的 Runtime 只用于首次绑定根 Context，绑定后
Runtime identity 只保存在该 Context 上。

普通 Expert 可以显式注入 subagent launcher：

```ts
const researcher = await defineExpert({ ...researcherOptions });
const researcherContext = defineContextIdResolver({
  id: "researcher-by-owner",
  version: "1.0.0",
  resolve: ({ ownerContextId, target }) => `${ownerContextId}:${target.expertId}`,
});
const launcher = createAgentLauncher({
  experts: [researcher],
  maxConcurrency: 2,
  maxDepth: 1,
  contextId: researcherContext,
});
const coordinator = await defineExpert({
  ...coordinatorOptions,
  tools: launcher.tools,
});
const session = await app.experts.createSession(coordinator);
```

launcher 向模型公开 `delegate_expert`、`wait_experts`、`list_agents`、`message_expert`、
`steer_expert` 和 `interrupt_expert`。`delegate_expert` 使用 `expertId` 时创建 AgentInstance，使用
`agentId` 时在既有 Context 上追加 FIFO Invocation；两者都先原子落盘再立即返回
`{ agentId, invocationId, contextId, disposition }`。`message_expert` 只向目标明确的 active
Invocation Inbox 投递消息，`steer_expert` 只尝试立即影响当前 Runtime turn；两者都不会创建任务。
Resolver 返回同一 Context 时，dispatch 会原子归并到同一 agent 并按 FIFO 串行；默认 resolver 每次创建新 Context。
`wait_experts` 按精确的
Invocation ID 收集结果；等待超时最小 30 秒、默认 10 分钟、最大 60 分钟。父 Invocation 即使遗漏
wait，也会在终结屏障等待未 join 的直接子任务并续跑综合。任务边和同 Agent FIFO 边共同构成
无环 Wait-for Graph；消息边不进入该图。

ExpertTeam 使用完全相同的配置入口：`delegation.contextId`。Resolver 只能从当前 owner 的兼容
Context 候选中选择；相同字符串不能跨 ExpertSession/FlowExecution，也不能切换 Expert 或 Runtime。
ExpertSession 的后续 prompt 会把本 Session 的历史成员 Context 作为候选并恢复其 snapshot；由于每个
prompt 仍是独立 Execution，本轮会创建新的 AgentInstance，但相同 `contextId` 继续代表同一 Runtime 对话。

Agent 实例只属于当前 Execution，操作权限由 `ownerContextId` 决定。外部客户端通过 Execution events 和 InvocationTree 观察状态，
不需要轮询内部任务；Core 不为所有 Tool 增加通用 background/sync 参数。

恢复会话不会自动重启 interrupted Turn。专家团使用同一个 Session API；外部只能向团队根提交 prompt。

`turn.usage` 返回单轮（包含该轮专家团委派调用）的累计 Usage；`session.getUsage()` 汇总当前
Session 中所有已经落盘的 Turn。Usage 不需要从事件流中解析。

`getMessageHistory()` 返回 Runtime 已经完成并标准化的消息，包括提供商实际暴露的 thinking、
tool call/result、bash 与 summary；实时 delta 不会伪装成历史消息。按单次委派查询使用
`{ kind: "invocation", invocationId }`，按某个专家查询使用 `{ kind: "executor", executorId }`。
同一专家的多段历史按 `contextId` 分组。
