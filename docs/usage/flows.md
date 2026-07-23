# Flows

```ts
const flow = defineFlow({ id: "review", version: "1.0.0" });
const prepare = flow.task({ id: "prepare", version: "1.0.0", handler });
const approve = flow.humanTask({ id: "approve", version: "1.0.0", request });
const revisionContext = defineContextIdResolver({
  id: "revision-context",
  version: "1.0.0",
  resolve: ({ state, previousContexts, freshContextId }) =>
    state["revisionRequest"] === undefined
      ? freshContextId
      : (previousContexts.at(-1)?.contextId ?? freshContextId),
});
const expertStep = flow.use("expert", expert, { contextId: revisionContext });
flow.compose(({ start, end }) => start(prepare).next(expertStep).next(approve).next(end()));
```

`flows.open()` 只读状态并提供观察接口。`flows.recover()` 校验定义后继续未完成节点，成功节点不会重复执行。

只有 Expert/ExpertTeam step 接受 `contextId`；Task、HumanTask 和 nested Flow 不接受。回边再次访问
Expert step 时会创建新 Invocation 并重新运行 resolver，返回旧 ID 表示复用 Runtime 对话，返回
`freshContextId` 表示隔离。修订要求和历史业务结果仍应通过 state/input 显式传递。

每个 Step 的 `Invocation.input` 保存该 Step 经过 `input` 映射后的实际输入；恢复已有 Invocation 时
复用持久化输入，不重新求值。`HumanTask` 会把 `questions`、顶层 `options` 或 approval 请求映射到
统一人工交互，并返回 `HumanInteractionResponse`：首个单选答案写入 `decision`，首个文本答案写入
`notes`，完整结果保留在 `answers`，approval 另外写入 `approved`。

每个成功 Step 的最新结果由 Core 自动保存到 `state.nodes.<nodeId>.result`。Expert 和 ExpertTeam
使用由文本段与变量段组成的 prompt；变量引用 Flow 输入或稳定 Node ID，结构化输出字段由输出
Schema 决定。循环重新访问节点时覆盖该节点的最新结果，历史结果仍保留在 Invocation 记录中。

完整的实时观测示例可运行：

```bash
pnpm --filter @pragma/examples example:flow-tui
```
