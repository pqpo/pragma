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

launcher 向模型公开 `spawn_expert`、`continue_expert`、`list_agents`、`wait_experts`、
`steer_expert` 和 `interrupt_expert`。身份职责固定：`expertId` 选择定义，`contextId` 选择连续上下文，
`invocationId` 选择任务；`agentId` 仅用于返回值、状态和审计。

`spawn_expert({ expertId, task })` 总是创建全新 Context，返回
`{ expertId, contextId, agentId, invocationId, status }`。相关后续工作、失败重试或中断恢复使用
`continue_expert({ contextId, task })`；Context 本轮已绑定 Agent 时追加 FIFO，跨 prompt 时恢复 Runtime
snapshot 并返回新的 `agentId` 与 `agentDisposition: "materialized"`。

`list_agents` 的 `availableExperts` 是完整团队目录；`contexts` 同时包含本轮与历史成员 Context，并返回
`canContinue`、`canSteerNextBoundary`、`canQueueAfterCurrent` 和 `canInterrupt`。这些字段只是目录快照，
实际调用会重新授权。
完整目录可见不代表可以读取其他成员的完整输出、wait 其旧任务或修改它。

`steer_expert` 只修正一个 active Invocation，并要求显式选择投递语义：`delivery: "next_boundary"`
请求 Runtime 在当前 turn 的下一个可支持边界注入；Runtime 不支持时返回 `runtime_unsupported`，不会自动
降级。`delivery: "after_current"` 等当前 Runtime turn 完成后，在同一 Invocation 中启动排队的 continuation。
`interrupt_expert` 以 `invocationId` 精确停止任务：active 变为 `interrupted`，queued 变为
`cancelled`，终态返回 `already_terminal`，同 Context 的其他 FIFO 任务保留。

`wait_experts` 只允许当前 Invocation 直接通过 spawn 或 continue 创建的任务。成员 B continue 成员 A
的 Context 后可以等待自己新建的 Invocation，但不能等待 A 原有的 Invocation。返回的 `completed` 和
`pending` 都包含任务的 `invocationId`、`contextId`、`agentId` 与状态；终态项另外包含输出或错误。超时
最小 30 秒、默认 10 分钟、最大 60 分钟；超时不取消任务，调用方应取 pending 项的 `invocationId`
再次 wait。自动终结屏障同样有界为
10 分钟，超时后恢复 Agent 并提供 pending 状态。Join 边与同 Agent FIFO 边共同进行无环检查。

ExpertSession 的后续 prompt 会把同一 Session 的历史成员 Context 暴露为 resumable；continue 恢复其
snapshot。Context 的 Expert 与 Runtime identity 在所属 Session 内不可变。聊天分支会建立新的 Mission、
ExpertSession、Context 和 Runtime Session，只继承 transcript 语义，不暴露源 Session 的成员 Context。

Agent 实例只属于当前 Execution，操作权限由 `ownerContextId` 决定。外部客户端通过 Execution events 和 InvocationTree 观察状态，
不需要轮询内部任务；Core 不为所有 Tool 增加通用 background/sync 参数。

恢复会话不会自动重启 interrupted Turn。专家团使用同一个 Session API；外部只能向团队根提交 prompt。

`turn.usage` 返回单轮（包含该轮专家团委派调用）的累计 Usage；`session.getUsage()` 汇总当前
Session 中所有已经落盘的 Turn。Usage 不需要从事件流中解析。

`getMessageHistory()` 返回 Runtime 已经完成并标准化的消息，包括提供商实际暴露的 thinking、
tool call/result、bash 与 summary；实时 delta 不会伪装成历史消息。按单次委派查询使用
`{ kind: "invocation", invocationId }`，按某个专家查询使用 `{ kind: "executor", executorId }`。
同一专家的多段历史按 `contextId` 分组。
