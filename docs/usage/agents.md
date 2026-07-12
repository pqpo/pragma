# Experts and Expert Sessions

```ts
const expert = await defineExpert({ ...options });
const session = await app.experts.createSession(expert);
const first = await session.prompt("hello", { requestId: "first" });
for await (const event of first.events()) {
  // 只接收订阅后的事件；Execution 结束后自动退出循环。
  console.log(event.type, event.payload);
}
const result = await first.result;

// 历史对话使用独立接口读取，不通过执行事件回放。
const messages = await session.getMessageHistory();

const resumed = await app.experts.resumeSession(expert, { sessionId: session.sessionId });
await resumed.prompt("continue", { requestId: "second" });
```

恢复会话不会自动重启 interrupted Turn。专家团使用同一个 Session API；外部只能向团队根提交 prompt。
