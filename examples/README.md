# Pragma Examples

这些示例只使用新的声明与执行边界：

- `expert-single-multi.ts`：单专家单轮与多轮。
- `expert-resume.ts`：恢复 ExpertSession 后通过新 prompt 继续对话。
- `expert-queue-steer.ts`：持久化 prompt queue，以及 Runtime 不支持安全 steer 时的明确拒绝。
- `expert-team-delegation.ts`：协调专家按 allowlist 委派成员。
- `expert-team-tree.ts`：读取团队 InvocationTree 与成员节点。
- `flow-basic.ts`：内联 Task 与 `compose()`。
- `flow-experts.ts`：Flow 调用 Expert 和 ExpertTeam。
- `flow-human.ts`：HumanTask 响应。
- `flow-recovery.ts`：`flows.open()` 只读观察执行状态。
- `flow-tree.ts`：Flow InvocationTree 与总输出流。

运行示例：

```bash
pnpm --filter @pragma/examples dev src/expert-single-multi.ts
```

示例默认使用 PI Runtime；运行前应配置对应模型凭据。所有外部 prompt 必须提交给
`ExpertSession`，Flow 只能通过 `app.flows` 启动、打开或恢复。
