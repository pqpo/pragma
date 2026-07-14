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
  context: "reuse",
  maxConcurrency: 2,
  maxDepth: 1,
});
const coordinator = await defineExpert({
  ...coordinatorOptions,
  tools: [launcher.tool],
});
const session = await app.experts.createSession(coordinator);
```

launcher 向模型公开 `delegate_expert`。每次调用都会在当前 Execution 下创建子 Invocation，
因此子专家出现在同一 InvocationTree 中，并参与父 Turn 的取消和 Usage 汇总。

恢复会话不会自动重启 interrupted Turn。专家团使用同一个 Session API；外部只能向团队根提交 prompt。

`turn.usage` 返回单轮（包含该轮专家团委派调用）的累计 Usage；`session.getUsage()` 汇总当前
Session 中所有已经落盘的 Turn。Usage 不需要从事件流中解析。

`getMessageHistory()` 返回 Runtime 已经完成并标准化的消息，包括提供商实际暴露的 thinking、
tool call/result、bash 与 summary；实时 delta 不会伪装成历史消息。按单次委派查询使用
`{ kind: "invocation", invocationId }`，按某个专家查询使用 `{ kind: "executor", executorId }`。
同一专家的多段历史按 `contextId` 分组。
