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
- `SandboxManager`：workflow 和 task 的沙箱生命周期边界。

每次 root workflow 启动时都会创建默认 sandbox。未声明 sandbox 策略的 step 默认复用 workflow sandbox；step 可以通过 `sandbox: { strategy: { mode: "ephemeral" } }` 显式请求新 sandbox。当前默认实现是本机 workspace，不提供安全隔离，但接口按未来远程或容器沙箱实现设计。

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

## 自定义 LoopApp 运行组件

`createLoopApp()` 默认使用内存状态、内存消息、本地 sandbox 和本地 task manager。这个默认组合适合开发、测试和单进程验证。

需要接入分布式部署或自定义执行环境时，可以替换这些组件：

```ts
import { createLoopApp, createRuntimeRegistry } from "@expertmesh/core";

const app = createLoopApp({
  mailbox: customMailbox,
  stateManager: customStateManager,
  sandboxManager: customSandboxManager,
  taskManager: customTaskManager,
  loopStore: customLoopDefinitionStore,
  runtimes: createRuntimeRegistry({
    runtimes: [customRuntime],
    defaultRuntime: "custom-runtime",
  }),
});
```

可替换组件：

- `Mailbox`：命令和事件通道。
- `StateManager`：workflow、task、`LoopState` 的权威状态源。
- `SandboxManager`：workflow 和 task 的运行环境边界。
- `TaskManager`：任务派发、租约、执行和 transition 推进。
- `LoopDefinitionStore`：保存 workflow run 对应的已编译 Loop 定义。
- `RuntimeRegistry`：按 runtime id 解析具体 Runtime Adapter。

通常不需要一次性全部替换。单机开发只需要默认实现；生产部署一般先替换 `StateManager` 和 `Mailbox`，再替换 `SandboxManager` 和 `TaskManager`。

## 自定义 SandboxManager

`SandboxManager` 控制 workflow sandbox 和 task sandbox 的创建、复用、释放和清理。

```ts
import type { SandboxManager } from "@expertmesh/core";

const customSandboxManager: SandboxManager = {
  async createWorkflowSandbox(request) {
    const sandboxId = await sandboxService.create({
      workflowRunId: request.workflowRunId,
      loopId: request.loopId,
      input: request.input,
      requestedCapabilities: request.request?.capabilities,
      workspace: request.request?.workspace,
    });

    return {
      ref: {
        id: sandboxId,
        kind: "remote-container",
        workspaceRoot: "/workspace",
      },
      workspace: {
        root: "/workspace",
        exec: async (command, options = {}) => {
          return await sandboxService.exec(sandboxId, {
            command,
            cwd: options.cwd,
            env: options.env,
            timeoutMs: options.timeoutMs,
          });
        },
      },
    };
  },

  async resolveTaskSandbox(request) {
    if (request.request.strategy?.mode === "reuse-workflow") {
      return await sandboxService.attach(request.workflow.defaultSandbox.id);
    }

    return await sandboxService.createTaskSandbox({
      workflowRunId: request.workflow.id,
      taskRunId: request.task.id,
      strategy: request.request.strategy,
      workspace: request.request.workspace,
      capabilities: request.request.capabilities,
    });
  },

  async releaseTaskSandbox(lease, result) {
    await sandboxService.releaseTask(lease.ref.id, result.status);
  },

  async cleanupWorkflowSandboxes(workflowRunId) {
    await sandboxService.cleanupWorkflow(workflowRunId);
  },
};
```

Sandbox strategy 的语义：

- `reuse-workflow`：复用 workflow 默认 sandbox。
- `ephemeral`：为当前 task 创建一次性 sandbox。
- `reuse-step`：同一个 workflow、step 和 key 复用 sandbox。
- `attach`：挂载已有 sandbox id。

生产实现需要注意：

- `workspace.exec()` 应返回统一的 `exitCode`、`stdout`、`stderr`。
- `releaseTaskSandbox()` 和 `cleanupWorkflowSandboxes()` 必须可重试。
- sandbox capability 是运行环境能力声明，不应替代用户权限、工具审批或 Desktop 本地确认 UI。
- 如果 sandbox 是远程容器或 VM，日志、artifact 和文件同步应由 sandbox 服务或 Runtime 事件流显式处理。

## 自定义 StateManager

`StateManager` 是 workflow 和 task 的状态事实源。分布式部署时应使用事务性存储实现，例如 PostgreSQL、CockroachDB、DynamoDB 或其他支持条件更新的状态库。

```ts
import type { StateManager } from "@expertmesh/core";

const stateManagerMethods = createRepositoryBackedStateMethods({
  workflowRepo,
  taskRepo,
  appliedMessageRepo,
  transaction,
});

const customStateManager: StateManager = {
  async createWorkflowRun(request) {
    return await workflowRepo.insert({
      id: request.id,
      loopId: request.loopId,
      input: request.input,
      state: request.state,
      currentStepIds: [request.startStepId],
      completedStepIds: [],
      defaultSandbox: request.defaultSandbox,
      status: "running",
      revision: 0,
    });
  },

  async getWorkflowRun(workflowRunId) {
    return await workflowRepo.findById(workflowRunId);
  },

  async applyStepReduction(request) {
    return await transaction(async (tx) => {
      const workflow = await tx.workflows.getForUpdate(request.workflowRunId);

      if (workflow.revision !== request.expectedRevision) {
        throw new Error("Workflow revision conflict.");
      }

      const nextState = structuredClone(workflow.state);
      await request.reduce?.({
        state: nextState,
        output: request.output,
      });

      await tx.workflows.updateState({
        workflowRunId: request.workflowRunId,
        state: nextState,
        revision: workflow.revision + 1,
      });

      return nextState;
    });
  },

  // 其余方法应完整实现 TaskRun 状态流转、幂等事件应用和 lease 恢复。
  ...stateManagerMethods,
};
```

实现要求：

- task 状态流转必须是原子操作。
- `applyTaskEvent()` 和 `applyWorkflowEvent()` 必须按 message id 幂等。
- `applyStepReduction()` 必须使用 revision 或等价机制防止并发覆盖。
- `recoverExpiredLeases(now)` 应找出 lease 过期且未完成的 task，允许 worker 重新派发或重试。
- 状态库里的记录应保留审计所需的时间、错误、runtime、sandbox 和 lease 信息。

## 自定义 Mailbox

`Mailbox` 是命令和事件通道。它承载 `task.dispatch`、`task.completed`、`task.failed`、`workflow.started` 等消息，但不保存权威业务状态。

```ts
import type { Mailbox } from "@expertmesh/core";

const customMailbox: Mailbox = {
  async publish(message) {
    await queue.publish({
      id: message.id,
      type: message.type,
      kind: message.kind,
      workflowRunId: message.workflowRunId,
      taskRunId: message.taskRunId,
      payload: message.payload,
      occurredAt: message.occurredAt,
      producer: message.producer,
    });
  },

  async subscribe(filter, handler) {
    const subscription = await queue.subscribe(
      {
        workflowRunId: filter.workflowRunId,
        taskRunId: filter.taskRunId,
        types: filter.types,
        consumerGroup: filter.consumerGroup,
      },
      async (message) => {
        await handler(message, {
          ack: async () => {
            await queue.ack(message.id);
          },
        });
      },
    );

    return {
      unsubscribe: async () => {
        await subscription.close();
      },
    };
  },
};
```

生产实现建议：

- 可以使用至少一次投递，但 `StateManager` 必须保证幂等。
- consumer group 应支持多 worker 竞争消费。
- ack 应在 handler 成功后执行。
- 消息要保留足够的 trace 字段，便于审计和排障。

## 自定义 TaskManager

大多数情况下可以继续使用 `createLocalTaskManager()`，只替换它依赖的 `Mailbox`、`StateManager`、`SandboxManager` 和 `LoopDefinitionStore`。

```ts
import { createLocalTaskManager, createLoopApp } from "@expertmesh/core";

const taskManager = createLocalTaskManager({
  mailbox: customMailbox,
  stateManager: customStateManager,
  runtimes,
  sandboxManager: customSandboxManager,
  loopStore: customLoopDefinitionStore,
  workerId: process.env.WORKER_ID,
  leaseTtlMs: 60_000,
  heartbeatIntervalMs: 20_000,
});

const app = createLoopApp({
  mailbox: customMailbox,
  stateManager: customStateManager,
  sandboxManager: customSandboxManager,
  loopStore: customLoopDefinitionStore,
  runtimes,
  taskManager,
});
```

只有在需要把任务派发、worker 选择、远程执行、重试策略或配额治理放到专门调度系统里时，才需要完整实现 `TaskManager`。

自定义 `TaskManager` 必须保留这些语义：

- `startRun()` 创建 workflow run，并发布初始事件或触发首次派发。
- `dispatchReadyTasks()` 只派发当前可运行 step，避免重复创建活跃 task。
- `leaseTask()` 必须避免多个 worker 同时执行同一个 task。
- `executeTask()` 必须通过 `SandboxManager` 获取执行环境。
- task 成功、失败和取消后必须通过 `StateManager` 和 `Mailbox` 推进状态。
- `recoverExpiredLeases()` 必须能恢复 worker 崩溃或心跳丢失后的任务。

## 面向未来的分布式部署

分布式部署时，推荐把 Core 的本地默认组件替换为以下拓扑：

```text
API Server
  |
  +--> 接收用户请求
  +--> 校验权限、预算、输入 schema
  +--> 创建 workflow run
  |
  v
State Store
  |
  +--> workflow/task 状态
  +--> LoopState
  +--> revision
  +--> lease
  +--> 幂等 message id
  |
  v
Mailbox / Queue
  |
  +--> task.dispatch
  +--> task.completed
  +--> task.failed
  +--> workflow events
  |
  v
Worker Pool
  |
  +--> lease task
  +--> resolve sandbox
  +--> run step.loop
  +--> publish progress and completion
  |
  v
Sandbox / Runtime Layer
  |
  +--> cloud container
  +--> VM
  +--> Kubernetes job
  +--> Desktop local runtime
  +--> hosted model/runtime adapter
```

部署原则：

- API Server 负责控制面，不直接长时间执行 task。
- Worker Pool 负责执行面，可以水平扩缩容。
- `StateManager` 是最终事实源，Mailbox 只是通信通道。
- Runtime event stream 用于进度、日志和 UI 展示，不作为最终状态事实源。
- task lease 和幂等状态应用是分布式可靠性的核心。
- sandbox 和 runtime 可以按租户、区域、能力或成本策略选择。

最小演进路径：

1. 使用默认 `createLoopApp()` 完成本地 workflow 验证。
2. 替换 `StateManager` 为数据库实现。
3. 替换 `Mailbox` 为可靠队列。
4. 启动多个 worker，共享同一个状态库和消息通道。
5. 替换 `SandboxManager` 为容器、远程执行服务或 Desktop bridge。
6. 将 Runtime Registry 扩展为租户级、区域级或能力感知的解析策略。
