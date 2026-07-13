# Experts and Expert Sessions

```ts
const expert = await defineExpert({ ...options });
const session = await app.experts.createSession(expert);
const first = await session.prompt("hello", { requestId: "first" });
for await (const event of first.events()) {
  // 只接收订阅后的事件；Execution 结束后自动退出循环。
  console.log(event.type, event.data);
}
const result = await first.result;
const turnUsage = await first.usage;

// 历史对话使用独立接口读取，不通过执行事件回放。
const messages = await session.getMessageHistory();
// Usage 随 Execution 持久化；Session API 汇总所有已完成 Turn。
const sessionUsage = await session.getUsage();

const resumed = await app.experts.resumeSession(expert, { sessionId: session.sessionId });
await resumed.prompt("continue", { requestId: "second" });
```

恢复会话不会自动重启 interrupted Turn。专家团使用同一个 Session API；外部只能向团队根提交 prompt。

`turn.usage` 返回单轮（包含该轮专家团委派调用）的累计 Usage；`session.getUsage()` 汇总当前
Session 中所有已经落盘的 Turn。Usage 不需要从 `turn.events()` 的 `runtime.run.completed` 事件中解析。
