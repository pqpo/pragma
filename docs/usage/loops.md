# Loop 使用指南

本文说明 ExpertMesh Loop API 的核心使用方式。核心原则是：`Agent` 本身是 `Loop`，编译后的组合工作流也是 `Loop`，任何对象只要实现 `Loop` 接口，就可以注册进另一个 Loop。

当前核心 API：

```ts
import { createLoopApp, defineTask, defineFlow } from "@expertmesh/core";
```

## 阅读边界

本文只覆盖 Loop 的基础执行、组合、状态归并和分支控制。更进阶的主题拆在独立文档中：

- [Workflow 范式快捷 API](./workflow-patterns.md)
- [Human-in-the-loop](./human-in-the-loop.md)
- [Loop 运行组件与扩展](./loop-runtime-components.md)

## 核心概念

`Loop` 是统一的可执行单元：

```ts
interface Loop<TInput, TOutput> {
  readonly id: string;
  readonly inputSchema?: z.ZodType<TInput>;
  readonly outputSchema?: z.ZodType<TOutput>;
  run(request: StartLoopRunRequest<TInput>): Promise<LoopRunResult<TOutput>>;
}
```

`defineFlow()` 创建组合 Loop；组合 Loop 通过 `use(id, loop, options)` 注册子 Loop，不区分 agent、code、human operator 或 subloop。`ExpertAgent` 已实现 `Loop`，`defineTask()` 是把本地 TypeScript handler 包成 Loop 的便利函数。

主要对象：

- `Loop`：统一执行接口。
- `FlowSpec`：组合 Flow 构建器。
- `CompiledLoop`：编译后的组合 Loop，同时也是 `Loop`。
- `LoopApp`：运行入口，可运行任意 `Loop`。
- `LoopState`：workflow 运行中的状态容器。

## 最小组合 Loop

```ts
import { createLoopApp, defineTask, defineFlow } from "@expertmesh/core";
import { z } from "zod";

const greetLoop = defineTask({
  id: "greet",
  output: z.string(),
  handler: ({ input }) => {
    const payload = z.object({ name: z.string() }).parse(input);
    return `Hello, ${payload.name}.`;
  },
});

const flow = defineFlow({
  id: "hello-loop",
  input: z.object({
    name: z.string(),
  }),
  output: z.object({
    message: z.string(),
  }),
  result: ({ state }) => ({
    message: String(state.results["message"]),
  }),
});

const greet = flow.use("greet", greetLoop, {
  reduce: ({ state, output }) => {
    state.results["message"] = output;
  },
});

flow.compose(({ start, end }) => {
  start(greet).next(end());
});

const result = await createLoopApp().run(flow, {
  input: {
    name: "ExpertMesh",
  },
});

console.log(result.output);
```

关键点：

- `input` 是组合 Loop 的输入 schema。
- `output` 是最终输出 schema。
- `result` 从 `LoopState` 里提取最终结果。
- `use()` 注册任何实现了 `Loop` 的可执行单元。
- `reduce()` 把步骤输出写回 `state`。
- `compose()` 定义步骤转移。

## 运行单个 Loop

单个 Agent 或代码 Loop 可以直接交给 `LoopApp` 运行。`LoopApp` 会把它包装成单步 workflow，因此仍然有 `workflowRunId`、`LoopState` 和 mailbox 事件。

```ts
const result = await createLoopApp().run(greetLoop, {
  input: {
    name: "ExpertMesh",
  },
});
```

需要在运行过程中查询状态或订阅输出时，使用 `start()` 启动非阻塞运行，再通过 `runs` 查询和 watch：

```ts
const app = createLoopApp();

const handle = await app.start(greetLoop, {
  input: {
    name: "ExpertMesh",
  },
});

const snapshot = await app.runs.get(handle.workflowRunId);

for await (const event of app.runs.watch(handle.workflowRunId)) {
  console.log(event.type, event.payload);
}

const result = await handle.result;
```

`app.runs.list()` 返回当前可见的 workflow run 快照，可以按 `loopId`、`status` 或 `parentWorkflowRunId` 过滤。`app.runs.get(id)` 返回单个 run 的 workflow、tasks、task 状态计数和直接子 workflow id。

嵌套 Loop 会创建独立的子 `workflowRunId`，并在子 workflow 上记录 `parentWorkflowRunId` 和 `parentTaskRunId`。需要一次性查看完整树时使用：

```ts
const tree = await app.runs.getTree(handle.workflowRunId);
```

需要递归订阅父 run 和所有子 run 的后续事件时使用：

```ts
for await (const event of app.runs.watch(handle.workflowRunId, { recursive: true })) {
  console.log(event.workflowRunId, event.type);
}
```

如果只关心运行输出、进度和完成结果，可以使用更窄的 watch：

```ts
for await (const event of app.runs.watchOutput(handle.workflowRunId, { recursive: true })) {
  console.log(event.payload);
}
```

`watch()` 只表示订阅后续事件，不回放历史事件；历史事实以 `StateManager` 中的 workflow/task 状态为准，应通过 `get()` 或 `getTree()` 读取。

完整可运行示例见：

```bash
pnpm --filter @expertmesh/examples start:loop-watch
```

## Agent 作为 Loop

`ExpertAgent` 已实现 `Loop`。在组合流程中注册 Agent 和注册任意其他 Loop 没有区别：

```ts
import { defineAgent, defineFlow } from "@expertmesh/core";
import { z } from "zod";

const planner = await defineAgent({
  id: "planner",
  name: "Planner",
  description: "Create an execution plan.",
  tags: [],
  version: "0.0.0",
  scope: "project",
  workspace: process.cwd(),
});

const flow = defineFlow({
  id: "planning-loop",
  output: z.object({
    plan: z.unknown(),
  }),
  result: ({ state }) => ({
    plan: state.results["plan"],
  }),
});

const plan = flow.use("plan", planner, {
  output: z.object({
    steps: z.array(z.string()),
  }),
  reduce: ({ state, output }) => {
    state.results["plan"] = output;
  },
});

flow.compose(({ start, end }) => {
  start(plan).next(end());
});
```

## 嵌套组合 Flow

子 Flow 可以直接注册进父 Flow。`use()` 会在注册边界自动把子 Flow 归一化为可运行的 `Loop`，日常使用不需要显式调用 `compile()`：

```ts
const requirementLoop = defineFlow({
  id: "requirement-loop",
  result: ({ state }) => state.results["summary"],
});

const summarize = requirementLoop.use(
  "summarize",
  defineTask({
    id: "summarize",
    handler: ({ input }) => String(input),
  }),
  {
    reduce: ({ state, output }) => {
      state.results["summary"] = output;
    },
  },
);

requirementLoop.compose(({ start, end }) => {
  start(summarize).next(end());
});

const deliveryLoop = defineFlow({
  id: "delivery-loop",
});

const intake = deliveryLoop.use("intake", requirementLoop, {
  reduce: ({ state, output }) => {
    state.results["requirement"] = output;
  },
});

deliveryLoop.compose(({ start, end }) => {
  start(intake).next(end());
});
```

`compile()` 是高级 API，主要用于预校验、调试或把 Flow 注册到分布式运行系统。普通执行路径由 `flow.use()` 和 `createLoopApp().run()` 自动完成编译归一化。

## LoopState 和 reduce

每个 Loop run 都有一个 `LoopState`。当前典型用法是把中间结果写入：

```ts
state.results["key"] = output;
```

`reduce()` 只负责状态归并，不应该执行外部副作用。外部副作用应该放在代码 Loop handler 或 Agent/Runtime 的受控工具中。

## 输出校验

输出 schema 可以声明在被注册的 Loop 上，也可以在 `use()` 时覆盖：

```ts
const classifyLoop = defineTask({
  id: "classify",
  output: z.object({
    kind: z.enum(["bug", "feature"]),
  }),
  handler: ({ input }) => {
    const payload = z.object({ text: z.string() }).parse(input);
    return {
      kind: payload.text.includes("bug") ? "bug" : "feature",
    };
  },
});

const classify = flow.use("classify", classifyLoop, {
  reduce: ({ state, output }) => {
    state.results["kind"] = output.kind;
  },
});
```

`TaskManager` 会在步骤完成后用 `use()` 的 `output` 或子 Loop 的 `outputSchema` 校验结果。

## route 分支

`route(field, cases, fallback?)` 根据步骤输出字段选择下一步：

```ts
const tester = flow.use(
  "tester",
  defineTask({
    id: "tester",
    output: z.object({
      status: z.enum(["passed", "failed"]),
    }),
    handler: ({ input }) => {
      const payload = z.object({ testsPassed: z.boolean() }).parse(input);
      return {
        status: payload.testsPassed ? "passed" : "failed",
      };
    },
  }),
);

const ship = flow.use("ship", defineTask({ id: "ship", handler: () => "ship" }));
const fix = flow.use("fix", defineTask({ id: "fix", handler: () => "fix" }));

flow.compose(({ start, step, end }) => {
  start(tester).route("status", {
    passed: ship,
    failed: fix,
  });

  step(ship).next(end());
  step(fix).next(end());
});
```

更常见的分类路由也可以直接用 [Workflow routing](./workflow-patterns.md#routing) 快捷 API。

## limit 防止循环失控

`limit()` 给某个 step 设置访问次数上限：

```ts
flow.compose(({ start, step, fail }) => {
  start(retryStep)
    .limit({
      maxVisits: 3,
      onExceeded: fail("Retry limit exceeded"),
    })
    .next(retryStep);
});
```

## 运行时选择

运行时仍然通过 `RuntimeRegistry` 解析。`runtime` 可以在 `use()` 上设置，也可以在运行请求中统一指定：

```ts
const plan = flow.use("plan", planner, {
  runtime: "cloud-pi-agent",
});

await createLoopApp().run(flow, {
  input: {},
  runtime: "cloud-pi-agent",
  runtimes: {
    plan: "cloud-pi-agent",
  },
});
```

`runtimes` 中的 step 级配置优先级最高，其次是 `use()` 的 `runtime`，最后是运行请求的 `runtime` 和 registry 默认 runtime。
