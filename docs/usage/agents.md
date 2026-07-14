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

普通 Expert 可以显式注入 subagent launcher：

```ts
const researcher = await defineExpert({ ...researcherOptions });
const launcher = createAgentLauncher({
  experts: [researcher],
  maxConcurrency: 2,
  maxDepth: 1,
});
const coordinator = await defineExpert({
  ...coordinatorOptions,
  tools: launcher.tools,
});
const session = await app.experts.createSession(coordinator);
```

launcher 向模型公开 `spawn_expert`、`wait_experts`、`list_experts`、`followup_expert` 和
`interrupt_expert`。`spawn_expert` 先原子落盘再立即返回 `{ agentId, invocationId }`；多个 agent
可以并行运行，同一 agent 的 followup 按 FIFO 串行并复用其 Context。`wait_experts` 按精确的
Invocation ID 收集结果。父 Invocation 即使遗漏 wait，也会在终结屏障等待未 join 的子任务并续跑综合。

Agent 实例只属于当前 Execution。外部客户端通过 Execution events 和 InvocationTree 观察状态，
不需要轮询内部任务；Core 不为所有 Tool 增加通用 background/sync 参数。

恢复会话不会自动重启 interrupted Turn。专家团使用同一个 Session API；外部只能向团队根提交 prompt。

`turn.usage` 返回单轮（包含该轮专家团委派调用）的累计 Usage；`session.getUsage()` 汇总当前
Session 中所有已经落盘的 Turn。Usage 不需要从事件流中解析。

`getMessageHistory()` 返回 Runtime 已经完成并标准化的消息，包括提供商实际暴露的 thinking、
tool call/result、bash 与 summary；实时 delta 不会伪装成历史消息。按单次委派查询使用
`{ kind: "invocation", invocationId }`，按某个专家查询使用 `{ kind: "executor", executorId }`。
同一专家的多段历史按 `contextId` 分组。
