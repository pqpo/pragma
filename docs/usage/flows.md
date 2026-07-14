# Flows

```ts
const flow = defineFlow({ id: "review", version: "1.0.0" });
const prepare = flow.task({ id: "prepare", version: "1.0.0", handler });
const approve = flow.humanTask({ id: "approve", version: "1.0.0", request });
const expertStep = flow.use("expert", expert);
flow.compose(({ start, end }) => start(prepare).next(expertStep).next(approve).next(end()));
```

`flows.open()` 只读状态并提供观察接口。`flows.recover()` 校验定义后继续未完成节点，成功节点不会重复执行。

每个 Step 的 `Invocation.input` 保存该 Step 经过 `input` 映射后的实际输入；恢复已有 Invocation 时
复用持久化输入，不重新求值。`HumanTask` 会把 `questions`、顶层 `options` 或 approval 请求映射到
统一人工交互，并返回 `HumanInteractionResponse`：首个单选答案写入 `decision`，首个文本答案写入
`notes`，完整结果保留在 `answers`，approval 另外写入 `approved`。

完整的实时观测示例可运行：

```bash
pnpm --filter @pragma/examples example:flow-tui
```
