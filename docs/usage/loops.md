# Loop 使用指南

本文说明当前 ExpertMesh Loop API。核心原则是：`Agent` 本身是 `Loop`，编译后的组合工作流也是 `Loop`，任何对象只要实现 `Loop` 接口，就可以注册进另一个 Loop。

当前核心 API：

```ts
import { createLoopApp, defineCodeLoop, defineLoop } from "@expertmesh/core";
```

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

`defineLoop()` 创建组合 Loop；组合 Loop 通过 `use(id, loop, options)` 注册子 Loop，不区分 agent、code 或 subloop。`ExpertAgent` 已实现 `Loop`，`defineCodeLoop()` 是把本地 TypeScript handler 包成 Loop 的便利函数。

主要对象：

- `Loop`：统一执行接口。
- `LoopSpec`：组合 Loop 构建器。
- `CompiledLoop`：编译后的组合 Loop，同时也是 `Loop`。
- `LoopApp`：运行入口，可运行任意 `Loop`。
- `TaskManager`：任务分发与执行协调。
- `StateManager`：工作流和任务状态事实源。
- `Mailbox`：命令和事件通信通道。
- `TaskExecutionEnvironment`：步骤执行环境。

## 最小组合 Loop

```ts
import { createLoopApp, defineCodeLoop, defineLoop } from "@expertmesh/core";
import { z } from "zod";

const greetLoop = defineCodeLoop({
  id: "greet",
  output: z.string(),
  handler: ({ input }) => {
    const payload = z.object({ name: z.string() }).parse(input);
    return `Hello, ${payload.name}.`;
  },
});

const loop = defineLoop({
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

const greet = loop.use("greet", greetLoop, {
  reduce: ({ state, output }) => {
    state.results["message"] = output;
  },
});

loop.flow(({ start, end }) => {
  start(greet).next(end());
});

const result = await createLoopApp().run(loop, {
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
- `flow()` 定义步骤转移。

## 运行单个 Loop

单个 Agent 或代码 Loop 可以直接交给 `LoopApp` 运行。`LoopApp` 会把它包装成单步 workflow，因此仍然有 `workflowRunId`、`LoopState` 和 mailbox 事件。

```ts
const result = await createLoopApp().run(greetLoop, {
  input: {
    name: "ExpertMesh",
  },
});
```

## Agent 作为 Loop

`ExpertAgent` 已实现 `Loop`。在组合流程中注册 Agent 和注册任意其他 Loop 没有区别：

```ts
import { defineAgent, defineLoop } from "@expertmesh/core";
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

const loop = defineLoop({
  id: "planning-loop",
  output: z.object({
    plan: z.unknown(),
  }),
  result: ({ state }) => ({
    plan: state.results["plan"],
  }),
});

const plan = loop.use("plan", planner, {
  output: z.object({
    steps: z.array(z.string()),
  }),
  reduce: ({ state, output }) => {
    state.results["plan"] = output;
  },
});

loop.flow(({ start, end }) => {
  start(plan).next(end());
});
```

## 嵌套组合 Loop

编译后的组合 Loop 也是 `Loop`，所以嵌套流程仍然使用 `use()`：

```ts
const requirementLoop = defineLoop({
  id: "requirement-loop",
  result: ({ state }) => state.results["summary"],
});

const summarize = requirementLoop.use(
  "summarize",
  defineCodeLoop({
    id: "summarize",
    handler: ({ input }) => String(input),
  }),
  {
    reduce: ({ state, output }) => {
      state.results["summary"] = output;
    },
  },
);

requirementLoop.flow(({ start, end }) => {
  start(summarize).next(end());
});

const deliveryLoop = defineLoop({
  id: "delivery-loop",
});

const intake = deliveryLoop.use("intake", requirementLoop.compile(), {
  reduce: ({ state, output }) => {
    state.results["requirement"] = output;
  },
});

deliveryLoop.flow(({ start, end }) => {
  start(intake).next(end());
});
```

## LoopState 和 reduce

每个 Loop run 都有一个 `LoopState`。当前典型用法是把中间结果写入：

```ts
state.results["key"] = output;
```

`reduce()` 只负责状态归并，不应该执行外部副作用。外部副作用应该放在代码 Loop handler 或 Agent/Runtime 的受控工具中。

## 输出校验

输出 schema 可以声明在被注册的 Loop 上，也可以在 `use()` 时覆盖：

```ts
const classifyLoop = defineCodeLoop({
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

const classify = loop.use("classify", classifyLoop, {
  reduce: ({ state, output }) => {
    state.results["kind"] = output.kind;
  },
});
```

`TaskManager` 会在步骤完成后用 `use()` 的 `output` 或子 Loop 的 `outputSchema` 校验结果。

## route 分支

`route(field, cases, fallback?)` 根据步骤输出字段选择下一步：

```ts
const tester = loop.use(
  "tester",
  defineCodeLoop({
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

const ship = loop.use("ship", defineCodeLoop({ id: "ship", handler: () => "ship" }));
const fix = loop.use("fix", defineCodeLoop({ id: "fix", handler: () => "fix" }));

loop.flow(({ start, step, end }) => {
  start(tester).route("status", {
    passed: ship,
    failed: fix,
  });

  step(ship).next(end());
  step(fix).next(end());
});
```

## limit 防止循环失控

`limit()` 给某个 step 设置访问次数上限：

```ts
loop.flow(({ start, step, fail }) => {
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
const plan = loop.use("plan", planner, {
  runtime: "cloud-pi-agent",
});

await createLoopApp().run(loop, {
  input: {},
  runtime: "cloud-pi-agent",
  runtimes: {
    plan: "cloud-pi-agent",
  },
});
```

`runtimes` 中的 step 级配置优先级最高，其次是 `use()` 的 `runtime`，最后是运行请求的 `runtime` 和 registry 默认 runtime。
