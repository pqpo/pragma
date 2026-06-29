# Loop 使用指南

本文说明如何使用 ExpertMesh 当前 Loop API 构建工作流，从最小 Loop 到复杂应用，以及如何嵌套 Loop。

当前核心 API：

```ts
import { createLoopApp, defineLoop } from "@expertmesh/core";
```

Loop 模块源码：

```text
packages/core/src/loop
```

## 核心概念

Loop 是可执行工作流规格。它由步骤、状态、转移规则和运行环境组成。

主要对象：

- `LoopSpec`：Loop 构建器。
- `CompiledLoop`：编译后的 Loop。
- `LoopApp`：运行入口。
- `TaskManager`：任务分发与执行协调。
- `StateManager`：工作流和任务状态事实源。
- `Mailbox`：命令和事件通信通道。
- `TaskExecutionEnvironment`：步骤执行环境。

步骤类型：

```text
agent    调用 ExpertAgent，通过 RuntimeAdapter 执行
code     调用本地 TypeScript handler
subloop  调用另一个 Loop
```

## 最小 code Loop

```ts
import { createLoopApp, defineLoop } from "@expertmesh/core";
import { z } from "zod";

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

const greet = loop.code(
  "greet",
  ({ input }) => {
    const payload = z
      .object({
        name: z.string(),
      })
      .parse(input);

    return `Hello, ${payload.name}.`;
  },
  {
    reduce: ({ state, output }) => {
      state.results["message"] = output;
    },
  },
);

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

- `input` 是 Loop 输入 schema。
- `output` 是最终输出 schema。
- `result` 从 `LoopState` 里提取最终结果。
- `code()` 定义一个本地步骤。
- `reduce()` 把步骤输出写回 `state`。
- `flow()` 定义步骤转移。

## LoopState 和 reduce

每个 Loop run 都有一个 `LoopState`。当前典型用法是把中间结果写入：

```ts
state.results["key"] = output;
```

`reduce()` 只负责状态归并，不应该执行外部副作用。

推荐：

```ts
reduce: ({ state, output }) => {
  state.results["plan"] = output;
}
```

避免：

```ts
reduce: async ({ state, output }) => {
  await writeFile("result.json", JSON.stringify(output));
  state.results["plan"] = output;
}
```

外部副作用应该放在 `code` step handler 或 Agent/Runtime 的受控工具中。

## 带输出校验的步骤

步骤可以声明自己的输出 schema：

```ts
const classify = loop.code(
  "classify",
  ({ input }) => {
    const payload = z.object({ text: z.string() }).parse(input);

    return {
      kind: payload.text.includes("bug") ? "bug" : "feature",
    };
  },
  {
    output: z.object({
      kind: z.enum(["bug", "feature"]),
    }),
    reduce: ({ state, output }) => {
      state.results["kind"] = output.kind;
    },
  },
);
```

`TaskManager` 会在步骤完成后用 `step.output` 校验结果。

## route 分支

使用 `route(field, cases, fallback?)` 根据步骤输出字段选择下一步：

```ts
const tester = loop.code(
  "tester",
  ({ input }) => {
    const payload = z.object({ testsPassed: z.boolean() }).parse(input);
    return {
      status: payload.testsPassed ? "passed" : "failed",
    };
  },
  {
    output: z.object({
      status: z.enum(["passed", "failed"]),
    }),
  },
);

const ship = loop.code("ship", () => "ship", {
  reduce: ({ state, output }) => {
    state.results["nextAction"] = output;
  },
});

const fix = loop.code("fix", () => "fix", {
  reduce: ({ state, output }) => {
    state.results["nextAction"] = output;
  },
});

loop.flow(({ start, step, end }) => {
  start(tester).route("status", {
    passed: ship,
    failed: fix,
  });

  step(ship).next(end());
  step(fix).next(end());
});
```

如果可能出现未覆盖值，传入 fallback：

```ts
start(tester).route(
  "status",
  {
    passed: ship,
    failed: fix,
  },
  {
    fallback: fix,
  },
);
```

## limit 防止循环失控

`limit()` 给某个 step 设置访问次数上限：

```ts
loop.flow(({ start, step, fail }) => {
  start(retryStep)
    .limit({
      maxVisits: 3,
      onExceeded: fail("Retry limit exceeded."),
    })
    .next(retryStep);
});
```

适用场景：

- 重试修复。
- 多轮规划。
- 反复检查直到满足条件。

所有可能循环的流程都应设置 `maxVisits`。

## Agent step

Agent step 调用 `ExpertAgent`，通过 `RuntimeAdapter` 执行。

```ts
import { defineAgent, defineLoop } from "@expertmesh/core";
import { z } from "zod";

const planner = await defineAgent({
  id: "planner",
  name: "Planner",
  description: "负责拆解任务。",
  tags: ["planning"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  instructions: "把输入需求拆成可执行计划。",
});

const loop = defineLoop({
  id: "planning-loop",
  input: z.object({
    requirement: z.string(),
  }),
  output: z.object({
    plan: z.string(),
  }),
  result: ({ state }) => ({
    plan: String(state.results["plan"]),
  }),
});

const plan = loop.agent("plan", planner, {
  input: ({ state }) => ({
    requirement: state.input.requirement,
  }),
  output: z.object({
    plan: z.string(),
  }),
  reduce: ({ state, output }) => {
    state.results["plan"] = output.plan;
  },
});

loop.flow(({ start, end }) => {
  start(plan).next(end());
});
```

Agent step 的输入会被 `stringifyInput()` 转成 query 传给 Runtime。为了减少歧义，建议输入保持结构化、字段命名明确。

## Runtime 选择

LoopApp 默认创建 Runtime Registry：

```ts
const app = createLoopApp();
```

需要自定义 Runtime：

```ts
const app = createLoopApp({
  runtimes: createRuntimeRegistry({
    runtimes: [customRuntime],
    defaultRuntime: "custom",
  }),
});
```

可以在 step 上指定 runtime：

```ts
const plan = loop.agent("plan", planner, {
  runtime: "cloud-planner",
});

const verify = loop.code("verify", verifyHandler, {
  runtime: "sandbox-node",
});
```

也可以在运行请求上指定默认 runtime：

```ts
await app.run(loop, {
  input,
  runtime: "cloud-planner",
});
```

也可以在一次运行中按 step id 指定 runtime：

```ts
await app.run(loop, {
  input,
  runtimes: {
    plan: "cloud-planner",
    verify: "sandbox-node",
  },
});
```

Runtime 解析优先级：

```text
request.runtimes[step.id]
step.runtime
request.runtime
app.runtimes.defaultRuntime
```

## TaskExecutionEnvironment

Code step 会拿到 workspace：

```ts
const test = loop.code("test", async ({ workspace }) => {
  const result = await workspace.exec("pnpm test", {
    timeoutMs: 120_000,
  });

  return {
    passed: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
});
```

步骤可以声明环境需求：

```ts
const verify = loop.code("verify", verifyHandler, {
  environment: {
    strategy: {
      mode: "local-workspace",
    },
    workspace: {
      root: "/path/to/workspace",
      access: "readwrite",
    },
    capabilities: {
      filesystem: true,
      shell: true,
      network: false,
      humanApproval: true,
    },
  },
});
```

当前默认实现是 `createLocalTaskExecutionEnvironment()`，适合本地和测试。云端运行时应替换为受控沙箱环境。

## subloop 嵌套 Loop

子 Loop 适合把复杂流程拆成可复用模块。

```ts
const requirementLoop = defineLoop({
  id: "requirement-loop",
  input: z.object({
    requirement: z.string(),
  }),
  output: z.object({
    summary: z.string(),
  }),
  result: ({ state }) => ({
    summary: String(state.results["summary"]),
  }),
});

const summarize = requirementLoop.code("summarize", ({ input }) => {
  const payload = z.object({ requirement: z.string() }).parse(input);
  return `Plan for: ${payload.requirement}`;
}, {
  reduce: ({ state, output }) => {
    state.results["summary"] = output;
  },
});

requirementLoop.flow(({ start, end }) => {
  start(summarize).next(end());
});

const deliveryLoop = defineLoop({
  id: "delivery-loop",
  input: z.object({
    requirement: z.string(),
  }),
  output: z.object({
    plan: z.string(),
    verification: z.string(),
  }),
  result: ({ state }) => ({
    plan: String(state.results["plan"]),
    verification: String(state.results["verification"]),
  }),
});

const plan = deliveryLoop.subloop("plan", requirementLoop, {
  reduce: ({ state, output }) => {
    state.results["plan"] = output.summary;
  },
});

const verify = deliveryLoop.code("verify", () => "ready", {
  reduce: ({ state, output }) => {
    state.results["verification"] = output;
  },
});

deliveryLoop.flow(({ start, step, end }) => {
  start(plan).next(verify);
  step(verify).next(end());
});
```

嵌套规则：

- 子 Loop 应有明确输入输出 schema。
- 父 Loop 通过 `reduce()` 消费子 Loop 输出。
- 子 Loop 不应隐式修改父 Loop 状态。
- 子 Loop 可以继续包含 agent/code/subloop。

## 从简单 Loop 到大型应用

大型应用不要写成一个巨大 Loop。推荐拆成多个子 Loop：

```text
delivery-loop
  ├── intake-loop
  │   ├── normalize-request
  │   └── classify-request
  ├── planning-loop
  │   ├── planner-agent
  │   └── risk-review-agent
  ├── implementation-loop
  │   ├── coder-agent
  │   ├── test-code
  │   └── route pass/fail
  └── report-loop
      ├── summarize
      └── produce-artifact
```

拆分原则：

- 每个 Loop 负责一个稳定阶段。
- 每个 Loop 有清晰输入输出。
- 业务状态只通过 `LoopState` 和输出传递。
- 重试、路由、人工确认等控制流放在父 Loop。
- 可复用能力做成子 Loop。

## 大型应用示例骨架

```ts
const intakeLoop = defineLoop({
  id: "intake-loop",
  input: IntakeInputSchema,
  output: IntakeOutputSchema,
  result: ({ state }) => IntakeOutputSchema.parse(state.results["intake"]),
});

const planningLoop = defineLoop({
  id: "planning-loop",
  input: PlanningInputSchema,
  output: PlanningOutputSchema,
  result: ({ state }) => PlanningOutputSchema.parse(state.results["plan"]),
});

const implementationLoop = defineLoop({
  id: "implementation-loop",
  input: ImplementationInputSchema,
  output: ImplementationOutputSchema,
  result: ({ state }) => ImplementationOutputSchema.parse(state.results["implementation"]),
});

const deliveryLoop = defineLoop({
  id: "delivery-loop",
  input: DeliveryInputSchema,
  output: DeliveryOutputSchema,
  result: ({ state }) => DeliveryOutputSchema.parse({
    intake: state.results["intake"],
    plan: state.results["plan"],
    implementation: state.results["implementation"],
  }),
});

const intake = deliveryLoop.subloop("intake", intakeLoop, {
  reduce: ({ state, output }) => {
    state.results["intake"] = output;
  },
});

const plan = deliveryLoop.subloop("plan", planningLoop, {
  input: ({ state }) => state.results["intake"],
  reduce: ({ state, output }) => {
    state.results["plan"] = output;
  },
});

const implement = deliveryLoop.subloop("implement", implementationLoop, {
  input: ({ state }) => state.results["plan"],
  reduce: ({ state, output }) => {
    state.results["implementation"] = output;
  },
});

deliveryLoop.flow(({ start, step, end }) => {
  start(intake).next(plan);
  step(plan).next(implement);
  step(implement).next(end());
});
```

## 失败和取消

流程可以显式失败：

```ts
loop.flow(({ start, fail }) => {
  start(validate).next(fail("Input is invalid."));
});
```

运行时可取消：

```ts
const handle = await app.taskManager.startRun(loop.compile(), { input });
await handle.cancel("User cancelled.");
```

通常应用层使用：

```ts
await app.run(loop, { input });
```

如果需要取消、监听中间事件或管理 run handle，使用 `taskManager.startRun()`。

## 替换 Mailbox 和 StateManager

`createLoopApp()` 默认使用内存实现：

```ts
createInMemoryMailbox()
createInMemoryStateManager()
createLocalTaskManager()
createLocalTaskExecutionEnvironment()
```

生产或云端应用应替换：

```ts
const app = createLoopApp({
  mailbox: durableMailbox,
  stateManager: databaseStateManager,
  environment: sandboxEnvironment,
  runtimes,
});
```

替换原则：

- `StateManager` 是状态事实源，必须处理并发和幂等。
- `Mailbox` 是通信协议载体，必须支持重试和可观测性。
- `TaskManager` 不应直接写数据库或消息队列实现细节。
- `TaskExecutionEnvironment` 控制 workspace、shell、网络和权限。

## 测试建议

小型 Loop：

- 用 `createLoopApp()` 默认内存实现测试。
- 用 code step 验证状态归并和 route。

Agent Loop：

- 使用 fake RuntimeAdapter 测试 Loop 编排。
- 不在单元测试里依赖真实模型。

大型 Loop：

- 每个子 Loop 独立测试。
- 父 Loop 只测试输入输出连接和路由。
- 对循环路径设置 `limit()` 并测试上限行为。
