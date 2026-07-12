# Experts and Expert Sessions

```ts
const expert = await defineExpert({ ...options });
const session = await app.experts.createSession(expert);
const first = await session.prompt("hello", { requestId: "first" });
await first.result;

const resumed = await app.experts.resumeSession(expert, { sessionId: session.sessionId });
await resumed.prompt("continue", { requestId: "second" });
```

恢复会话不会自动重启 interrupted Turn。专家团使用同一个 Session API；外部只能向团队根提交 prompt。
