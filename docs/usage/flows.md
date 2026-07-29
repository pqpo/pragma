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

## Run dry 单元用例

Run Dry 用例保存在独立的 `Evaluation` 资源中，通过 `spec.target.ref` 关联 Flow；Flow 本身不再包含
`spec.runDry`。Run Dry 不启动 Runtime、不调用模型、不执行 Action、不等待 HumanTask，也不进入
nested Flow。所有节点的 `expectInput` 都表示用例原始 Flow input；Expert、Team 和 Human 节点使用
独立的 `expectPrompt` 校验渲染后提示词。

每个用例断言终态和精确节点路径，并可选断言结构化输出或错误片段。重复访问同一节点时，mock 使用
按访问顺序排列的数组。失败用例必须声明 `errorContains`，测试配置错误不能被“预期失败”掩盖。
Suite 只有在所有用例通过，且每条 ordinary/repeat edge、route case、array branch、fallback 以及
loop repeat/limit 结果都被覆盖时才通过。

Desktop 的“测评”大 Tab 用于独立维护、运行和保存 Evaluation，并为专家/专家团队的“测评集 +
LLM-as-Judge”预留入口。内置 Pragma Agent 创建 Flow 时同时分配 Flow 与 Evaluation ID，调用
`run_evaluation`，再将 Evaluation 作为 `prepare_flow_draft.additionalSources` 原子提交。
