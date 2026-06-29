# Loop SDK 核心设计（API 草案）

## 核心理念

``` text
Everything is a Loop.
Agent is the smallest Loop.
Workflow is a Composable Loop.
Runtime executes Steps.
Channel connects Loops.
```

------------------------------------------------------------------------

# 1. 最小 Agent API

Agent 只声明“专家能力”和输入输出协议，不绑定具体 Runtime。

同一个 Agent 可以运行在不同 Runtime 中。例如：

- `default`
- `claude-code-local`
- `codex-local`
- `sandbox-node`
- `remote-container`

定义 Agent 时不关心 Runtime；Agent 自验证或执行 Loop 时默认使用 `default` Runtime；单个步骤需要特殊执行环境时再覆盖 Runtime。

最小声明使用 `defineAgent()`。它是 Loop SDK 面向用户的语法糖，底层可以归一化为当前项目里的 `ExpertAgent` 声明，但用户不需要直接调用 `ExpertAgent.create()`。

``` ts
import { defineAgent } from "@expertmesh/core";

const coder = defineAgent({
  id: "coder",
  name: "Coder",
  description: "负责代码实现",
  tags: ["coding"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "./repo",

  instructions: `
你是一个资深 Coding Agent。
根据任务修改代码，并确保测试通过。
`,
});
```

> 注：`defineAgent()` 是建议的 Loop SDK API；当前实现可映射到 `ExpertAgent` 的 `schemaVersion`、`id`、`displayName`、`description`、`tags`、`version`、`scope`、`workspace`、`models`、`skills`、`mcp`、`contextSystem`、`subAgents`、`tools`、`hooks` 等字段。这里的 `instructions` 可以映射到现有 system prompt 组装。

`defineAgent()` 不要求声明 `outputSchema`。

同一个 Agent 在不同任务里的输出可能不同：写代码、做评审、解释架构、生成迁移方案，都可以由同一个 `coder` 完成，但输出协议不应该被 Agent 声明固定死。

输出约束应该放在具体调用处：

- Agent 自验证时：`agent.run(input, { output })`
- Loop 步骤定义时：`loop.agent(..., { output })`
- Loop 整体定义时：`new LoopSpec({ inputSchema, outputSchema })`

只有当某个 Agent 本身就是稳定协议组件，例如“只做 PR Review 且永远返回同一种 ReviewResult”时，才可以给 Agent 声明默认 `outputSchema`。

Agent 可以自验证。运行概念上仍然通过 Runtime 执行，但 SDK 默认提供 Runtime registry，并自动注入 `createDefaultRuntime()`，所以最小调用不需要手动创建 Runtime。

``` ts
const result = await coder.run("实现 GitHub 登录", {
  output: z.object({
    summary: z.string(),
    changedFiles: z.array(z.string()),
    testsPassed: z.boolean(),
  }),
});
```

这等价于显式使用默认 Runtime registry：

``` ts
import { createRuntimeRegistry } from "@expertmesh/core";

const runtimes = createRuntimeRegistry();

const result = await coder.run("实现 GitHub 登录", {
  runtimes,
  output: z.object({
    summary: z.string(),
    changedFiles: z.array(z.string()),
    testsPassed: z.boolean(),
  }),
});
```

`createRuntimeRegistry()` 默认会注入 `createDefaultRuntime()`：

``` ts
import {
  createDefaultRuntime,
  createRuntimeRegistry,
} from "@expertmesh/core";

const runtimes = createRuntimeRegistry({
  runtimes: [
    createDefaultRuntime(),
  ],
  defaultRuntime: "default",
});
```

这里的 `"default"` 来自 Runtime adapter 的 descriptor：

``` ts
const runtime = createDefaultRuntime();

runtime.descriptor.id; // "default"
runtime.descriptor.kind; // "cloud-pi-agent"
runtime.descriptor.capabilities.targets; // ["agent", ...]
```

`createDefaultRuntime()` 是默认 Runtime facade，不是新的 Runtime 协议。当前实现等价于：

``` ts
function createDefaultRuntime(options?: DefaultRuntimeOptions): RuntimeAdapter {
  return createCloudPiRuntimeAdapter({
    ...options,
    descriptor: {
      id: "default",
      kind: "cloud-pi-agent",
      displayName: "Default Runtime",
    },
  });
}
```

未来如果默认 Runtime 从 PI agent 切换到其他实现，只需要修改 `createDefaultRuntime()` 的底层调用；上层 `coder.run(...)`、`createRuntimeRegistry()` 和 `createLoopApp()` 不需要改 API。

因此 `await coder.run("实现 GitHub 登录")` 成立，但不是绕过 Runtime 直接执行；它使用默认 Runtime registry 解析到 `default` Runtime。

需要切换执行环境时，再显式指定 Runtime：

``` ts
import {
  createCodexLocalRuntimeAdapter,
  createRuntimeRegistry,
} from "@expertmesh/core";

const runtimes = createRuntimeRegistry({
  runtimes: [
    createCodexLocalRuntimeAdapter(),
  ],
});

await coder.run("实现 GitHub 登录", {
  runtime: "codex-local",
  runtimes,
});
```

Loop 执行时同样默认拥有 Runtime registry：

``` ts
const app = createLoopApp();
```

`createLoopApp()` 默认使用 `createRuntimeRegistry()`，因此也会自动注入 `createDefaultRuntime()`。

运行发生在 Loop 层时，Loop 负责选择 Runtime、托管 State、调度步骤。未指定 Runtime 时使用 `default`：

``` ts
const loop = new LoopSpec({
  id: "coding-loop",
  inputSchema: z.object({
    requirement: z.string(),
    repo: z.string(),
  }),
});

loop.agent("coder", coder, {
  input: ({ state }) => `
任务：${state.input.requirement}
仓库：${state.input.repo}
`,

  output: z.object({
    summary: z.string(),
    changedFiles: z.array(z.string()),
    testsPassed: z.boolean(),
  }),
});

const result = await app.run(loop, {
  input: {
    requirement: "实现 GitHub 登录",
    repo: "github.com/acme/app",
  },
});
```

步骤可以覆盖 Runtime：

``` ts
loop.agent("planner", plannerAgent);

loop.agent("coder", coderAgent, {
  runtime: "claude-code-local",
});

loop.code("verify-package", async ({ state, workspace }) => {
  return await workspace.exec("pnpm test");
}, {
  runtime: "sandbox-node",
});
```

同一个 Agent 在不同执行中可以切换 Runtime：

``` ts
await app.run(loop, {
  input,
});

await app.run(loop, {
  input,
  runtime: "codex-local",
});
```

也可以在一次运行内按步骤覆盖：

``` ts
await app.run(loop, {
  input,
  runtimes: {
    coder: "claude-code-local",
    "verify-package": "sandbox-node",
  },
});
```

设计原则：

``` text
Agent Declaration = defineAgent()
Agent Protocol    = normalized to ExpertAgent-compatible declaration
Agent Runtime     = not bound at declaration time
Agent Self Check  = agent.run(input, { runtime?, runtimes? })
Default Runtime   = createRuntimeRegistry() injects createDefaultRuntime()
Loop Default      = app.run(loop) uses default runtime unless overridden
Step Runtime      = step option runtime overrides loop default
Agent Input       = string by default, schema at call/step/loop layer
Agent Output      = string by default, schema at call/step/loop layer
Runtime Target    = agent | code | subloop | operator
```

`defineAgent()` 是主 API；`agent()` 可以作为更短的别名，但不建议在文档里主推，避免和 `loop.agent(...)` 这个“添加 Agent 步骤”的 API 混淆。

------------------------------------------------------------------------

# 2. LoopSpec API：核心能力

`LoopSpec` 是 Loop 的可执行规格。

Loop 负责定义整体输入输出协议。Agent 可以是通用能力，步骤负责把 Loop State 映射成 Agent 输入并约束该步骤输出，Loop 则负责约束整个工作流的入口和最终结果。

``` ts
const loop = defineLoop({
  id: "coding-loop",

  input: z.object({
    requirement: z.string(),
    repo: z.string(),
    branch: z.string().optional(),
  }),

  output: z.object({
    success: z.boolean(),
    summary: z.string(),
    changedFiles: z.array(z.string()),
  }),
});
```

`defineLoop()` 是推荐的用户侧入口，返回可继续声明步骤和 flow 的 builder。底层可以归一化为 `LoopSpec` / `LoopGraph`，但用户不需要直接维护图结构。

------------------------------------------------------------------------

# 3. 添加步骤

``` ts
const planner = loop.agent("planner", plannerAgent, {
  input: ({ state }) => `
需求：${state.input.requirement}
仓库：${state.input.repo}

请输出技术方案。
`,

  reduce: ({ state, output }) => {
    state.artifacts.plan = output;
  },
});

const coder = loop.agent("coder", coderAgent, {
  runtime: "claude-code-local",

  input: ({ state }) => `
需求：${state.input.requirement}
技术方案：${state.artifacts.plan}

请完成代码修改。
`,

  reduce: ({ state, output }) => {
    state.artifacts.codeChange = output;
    state.flags.codeChanged = true;
  },
});

const tester = loop.agent("tester", testerAgent, {
  output: z.object({
    status: z.enum(["passed", "failed"]),
    summary: z.string(),
    failures: z.array(z.string()).optional(),
  }),

  input: ({ state }) => `
请验证本次代码变更：
${JSON.stringify(state.artifacts.codeChange)}
`,

  reduce: ({ state, output }) => {
    state.results.test = output;
    state.flags.testsPassed = output.status === "passed";
  },
});

const reviewer = loop.agent("reviewer", reviewerAgent, {
  output: z.object({
    decision: z.enum(["approved", "rejected"]),
    comments: z.array(z.string()),
  }),

  input: ({ state }) => `
请评审本次实现和测试结果：
${JSON.stringify(state.results.test)}
`,

  reduce: ({ state, output }) => {
    state.results.review = output;
    state.flags.reviewApproved = output.decision === "approved";
  },
});
```

步骤不一定是 Agent，也可以是一段代码、一个 Operator、一个 SubLoop 或一个外部任务。

``` ts
const install = loop.code("install", async ({ workspace }) => {
  await workspace.exec("pnpm install");

  return {
    installed: true,
  };
}, {
  runtime: "sandbox-node",
});

const unitTest = loop.code("unit-test", async ({ workspace }) => {
  const result = await workspace.exec("pnpm test");

  return {
    passed: result.exitCode === 0,
    output: result.stdout,
  };
}, {
  runtime: "sandbox-node",
});

loop.flow(({ start }) => {
  start(coder)
    .next(install)
    .next(unitTest);
});
```

步骤 Runtime 选择规则：

``` text
app.run(...).runtimes[stepId]
  > step.runtime
  > app.run(...).runtime
  > app.defaultRuntime
```

------------------------------------------------------------------------

# 4. 步骤流转 API

``` ts
const loop = defineLoop({
  id: "coding-loop",
  input: CodingInputSchema,
  output: CodingOutputSchema,
});

const planner = loop.agent("planner", plannerAgent);
const coder = loop.agent("coder", coderAgent);
const tester = loop.agent("tester", testerAgent, {
  output: z.object({
    status: z.enum(["passed", "failed"]),
    summary: z.string(),
  }),
});
const reviewer = loop.agent("reviewer", reviewerAgent, {
  output: z.object({
    decision: z.enum(["approved", "rejected"]),
    comments: z.array(z.string()),
  }),
});

const codingLoop = loop
  .flow(({ start, step, end }) => {
    start(planner)
      .next(coder)
      .next(tester)
      .route("status", {
        passed: reviewer,
        failed: coder,
      });

    step(reviewer).route("decision", {
      approved: end(),
      rejected: coder,
    });
  })
  .compile();
```

推荐的流转 API 以“主干连续 + 历史节点显式声明”为核心：

- `start(step)` 声明唯一入口。
- `.next(step)` 声明普通顺序流转。
- `.route(field, cases)` 基于当前链尾步骤的结构化输出字段路由。
- `step(existingStep)` 显式切换到已经声明过的步骤，用于补充分支、回边和子流程出口。
- `end()` 显式结束整个 Loop。
- `compile()` 将 builder 归一化为不可变、可执行、可校验的 `CompiledLoop`。

形成：

``` text
Planner -> Coder -> Tester
              ^       |
              | failed
              |
           Reviewer
              | approved -> End
              + rejected -> Coder
```

## 路由字段

`route()` 的 key 必须来自上一步输出 schema 中指定字段的可枚举值。不要让 SDK 猜测路由字段。

``` ts
const tester = loop.agent("tester", testerAgent, {
  output: z.object({
    status: z.enum(["passed", "failed"]),
    summary: z.string(),
  }),
});

start(planner)
  .next(coder)
  .next(tester)
  .route("status", {
    passed: reviewer,
    failed: coder,
  });
```

`compile()` 必须校验：

- `status` 存在于 `tester.output`。
- `status` 是可枚举字段，例如 `z.enum()`、literal union 或可解析的 discriminated union。
- route cases 覆盖所有枚举值，或者声明 fallback。
- route case 不能出现 schema 中不存在的 key。

复杂路由可以使用函数，但它属于高级能力，治理性弱于 schema route：

``` ts
step(reviewer).route((output) => {
  if (output.score >= 0.9) return "approved";
  if (output.needsFix) return "rejected";
  return "manual-review";
}, {
  approved: end(),
  rejected: coder,
  "manual-review": humanReview,
});
```

## 循环退出与中断

Loop 允许回边，但回边不能只靠图结构表达长期运行策略。循环必须能声明退出、中断或失败策略。

第一种方式是给步骤声明访问上限。适合“无论从哪里回到 coder，总次数都不能超过 N 次”的场景：

``` ts
loop.flow(({ start, step, end, fail }) => {
  start(planner)
    .next(coder)
    .next(tester)
    .route("status", {
      passed: reviewer,
      failed: coder,
    });

  step(reviewer).route("decision", {
    approved: end(),
    rejected: coder,
  });

  step(coder).limit({
    maxVisits: 5,
    onExceeded: fail("too-many-revisions"),
  });
});
```

第二种方式是在特定回边上声明 retry 策略。适合“只有 reviewer rejected 这条边受次数限制”的场景：

``` ts
loop.flow(({ start, step, end, fail, retry }) => {
  start(planner)
    .next(coder)
    .next(tester)
    .route("status", {
      passed: reviewer,
      failed: coder,
    });

  step(reviewer).route("decision", {
    approved: end(),
    rejected: retry(coder, {
      maxAttempts: 5,
      onExceeded: fail("review-not-approved"),
    }),
  });
});
```

`limit()` 是节点级策略，`retry()` 是边级策略。两者都应被编译进 `LoopGraph` 的 policy，而不是隐藏在 Runtime 里。

`compile()` 对循环还需要校验：

- 回边允许存在。
- 至少存在一个可到达的 terminal、`end()` 或 `fail()` 路径。
- 存在循环时，循环上的节点或边必须声明中断策略，例如 `maxVisits`、`maxAttempts`、timeout、external cancel 或 daemon/watch 标记。
- 超限策略必须显式声明，不能默认无限重试。

## 编译

``` text
defineLoop(...)
  -> builder
  -> compile()
  -> CompiledLoop
  -> app.run(compiledLoop, input)
```

`compile()` 是 Loop DSL 的验证边界。它至少需要检查：

- 必须有且只有一个 start。
- step id 唯一。
- 所有 transition target 存在。
- 所有 route 字段和 route case 与输出 schema 一致。
- route 分支必须完整覆盖，或者提供 fallback。
- 不可达 step 报错。
- 无出口节点只有在它是自然 terminal 时才合法。
- 循环必须有退出或中断策略。
- 编译结果不可变，便于发布、缓存、可视化、恢复执行和审计。

------------------------------------------------------------------------

# 5. 内置 Operators

``` ts
loop.parallel()
loop.route()
loop.handoff()
loop.retry()
loop.reflect()
loop.vote()
loop.merge()
loop.guard()
loop.approve()
loop.checkpoint()
loop.rollback()
loop.subloop()
```

## 多模型并行

``` ts
const plans = loop.parallel("multi-model-plan", [
  loop.agent("claude", claudePlanner),
  loop.agent("gpt", gptPlanner),
  loop.agent("gemini", geminiPlanner),
]);

const judge = loop.agent("judge", judgeAgent);

loop.flow(({ start, step }) => {
  start(plans)
    .next(judge);

  step(judge).route("decision", {
    accepted: coder,
    rejected: plans,
  });
});
```

## 路由模式

``` ts
loop.route("task-router", {
  by: ({ state }) => state.input.taskType,

  routes: {
    frontend: frontendAgent,
    backend: backendAgent,
    database: databaseAgent,
    unknown: clarifyAgent,
  },
});
```

## 转交模式

``` ts
loop.handoff("expert-handoff", {
  from: generalAgent,
  to: ({ state }) => state.requiredExpert,
});
```

## 人工审批

``` ts
const approve = loop.approve("human-review");

loop.flow(({ start }) => {
  start(planner)
    .next(approve)
    .route("decision", {
      approved: coder,
      rejected: planner,
    });
});
```

------------------------------------------------------------------------

# 6. SubLoop

``` ts
const deliveryLoop = new LoopSpec({...});

deliveryLoop.subloop("requirement", requirementLoop);
deliveryLoop.subloop("design", designLoop);
deliveryLoop.subloop("coding", codingLoop);
deliveryLoop.subloop("release", releaseLoop);
```

------------------------------------------------------------------------

# 7. Runtime

Runtime 是 Loop 步骤的通用执行环境，不只服务 Agent。

一个 Runtime 可以执行：

- Agent 步骤，例如 PI agent、Claude Code、Codex、自研 Agent。
- Code 步骤，例如 Node sandbox、remote container、workflow runner。
- SubLoop 步骤，例如把另一个 Loop 作为子任务执行。
- Operator 步骤，例如 parallel、route、retry、guard、approve。

Runtime 当前应分成“核心协议”和“具体实现”两层。

``` text
packages/core
  RuntimeAdapter        通用 Runtime 接口
  RuntimeRegistry       通用 Runtime registry 接口
  RuntimeInvocation     通用步骤执行请求
  RuntimeExecution      通用步骤执行句柄
  RuntimeEvent          通用运行事件

packages/core
  createRuntimeRegistry() 默认 Runtime registry 实现
  createDefaultRuntime() 默认 Runtime facade，当前底层调用 createCloudPiRuntimeAdapter()
  createCloudPiRuntimeAdapter()
  createNodeSandboxRuntimeAdapter()
  createCodexLocalRuntimeAdapter()
  RuntimeAdapter 具体实现
```

也就是说，`RuntimeAdapter` 和 `RuntimeRegistry` 接口属于 `agent-core` 层；`createRuntimeRegistry()` 默认实现、`createDefaultRuntime()` facade 和具体 runtime adapter 属于 `agent-runtime` 层。

建议的通用 Runtime 接口：

``` ts
type RuntimeTarget =
  | {
      type: "agent";
      agent: ExpertAgent;
    }
  | {
      type: "code";
      handler: LoopCodeHandler;
    }
  | {
      type: "subloop";
      loop: LoopSpec;
    }
  | {
      type: "operator";
      operator: LoopOperator;
    };

type RuntimeInvocation<TInput = unknown, TOutput = unknown> = {
  runId: string;
  stepId: string;
  loopId: string;
  target: RuntimeTarget;
  input: TInput;
  state: LoopStateSnapshot;
  context: RuntimeContext;
  outputSchema?: z.ZodType<TOutput>;
  signal?: AbortSignal;
};

type RuntimeExecution<TOutput = unknown> = {
  id: string;
  events: AsyncIterable<RuntimeEvent>;
  result: Promise<RuntimeResult<TOutput>>;
  cancel: () => Promise<void>;
};

interface RuntimeAdapter {
  readonly descriptor: RuntimeDescriptor;
  readonly canExecute: (target: RuntimeTarget) => boolean | Promise<boolean>;
  readonly execute: <TInput, TOutput>(
    invocation: RuntimeInvocation<TInput, TOutput>,
  ) => Promise<RuntimeExecution<TOutput>>;
}
```

Runtime descriptor 用来声明能力，而不是把能力写死在步骤里：

``` ts
type RuntimeDescriptor = {
  id: string;
  kind: string;
  displayName: string;
  capabilities: {
    targets: readonly RuntimeTargetType[];
    executionLocations: readonly ("cloud" | "local" | "self_hosted")[];
    supportsStreaming?: boolean;
    supportsAbort?: boolean;
    supportsFilesystem?: boolean;
    supportsShell?: boolean;
    supportsNetwork?: boolean;
    supportsHumanApproval?: boolean;
  };
};
```

默认 Runtime registry：

``` ts
import { createRuntimeRegistry } from "@expertmesh/core";

const runtimes = createRuntimeRegistry();

// 等价于注册 createDefaultRuntime()，并设置 defaultRuntime = "default"。
```

`createLoopApp()` 默认使用这个 registry：

``` ts
const app = createLoopApp();

await app.run("coding-loop", input);
```

步骤级覆盖 Runtime：

``` ts
const loop = new LoopSpec({ id: "coding-loop" });

loop.agent("planner", plannerAgent);

loop.agent("coder", coderAgent, {
  runtime: "claude-code-local",
});

loop.code("test", runTests, {
  runtime: "sandbox-node",
});
```

运行级覆盖 Runtime：

``` ts
await app.run(loop, {
  input,
  runtimes: {
    coder: "codex-local",
    test: "remote-container",
  },
});
```

Runtime 选择过程：

``` ts
const runtimeId =
  runOptions.runtimes?.[invocation.step.id] ??
  invocation.step.runtime ??
  runOptions.runtime ??
  app.defaultRuntime;

const runtime = app.runtimes.get(runtimeId);

if (!(await runtime.canExecute(invocation.target))) {
  throw new Error(`Runtime ${runtimeId} cannot execute step ${invocation.step.id}`);
}

return await runtime.execute(invocation);
```

分层原则：

``` text
LoopSpec / Pattern / Channel   -> 未来 Loop SDK 层
RuntimeAdapter 通用接口         -> @expertmesh/core
RuntimeAdapter 具体实现         -> @expertmesh/core
Server / Worker 调度 Runtime    -> apps/server、apps/worker 或 server orchestration package
Desktop 本地权限与连接桥接      -> apps/desktop + packages/core/src/local-agent-bridge
```

------------------------------------------------------------------------

# 8. Loop 执行层技术方案

Loop SDK 的用户侧 API 负责声明“要做什么”，实现层负责把 `CompiledLoop` 变成可恢复、可观测、可替换 Runtime 的执行过程。

实现层需要避免把调度、状态、通信、执行细节混在一个对象里。推荐拆成三组核心事实边界：

``` text
Mailbox                传递“发生了什么”
StateManager           保存“现在是什么”
TaskManager            决定“接下来做什么”，以及“单个任务怎么执行”
```

`TaskManager` 同时负责 Loop run 编排和单个 task run 生命周期。内部可以拆私有模块，但公开接口和文档统一使用 `TaskManager`，避免把 workflow 调度和 task 执行拆成两个顶层概念。

## 8.1 分层架构

``` text
createLoopApp()
  -> TaskManager
     -> StateManager
     -> Mailbox
     -> RuntimeRegistry
```

职责边界：

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `TaskManager` | 创建 run、读取 `CompiledLoop`、判断可执行节点、处理 transition、为节点创建 task run、租约、重试、取消、超时、把任务派发给 Runtime | 直接修改 Loop State |
| `Mailbox` | 传递 task command、task event、workflow event、ack、heartbeat | 判断下一步该执行哪个节点 |
| `StateManager` | 持久化 workflow run、task run、state snapshot、step output、revision、事件应用结果 | 做消息投递 |
| `RuntimeAdapter` | 执行具体 agent/code/subloop/operator 并产生流式事件和结果 | 直接修改 Loop State |

`TaskManager` 内部可以依赖一个执行环境接口，用于获取 workspace、session、权限和未来 sandbox，但它不作为 Loop 执行层之外的独立 manager 暴露。

最小本机实现可以全部在一个进程内运行：

``` text
InMemoryMailbox
InMemoryStateManager
InMemoryLoopDefinitionStore
LocalSandboxManager
LocalTaskManager
RuntimeRegistry
```

但协议必须按跨进程模型设计，不能假设执行方和调度方在同一个调用栈里。

## 8.2 执行流程

``` text
app.run(compiledLoop, input)
  -> TaskManager.startRun()
  -> SandboxManager.createWorkflowSandbox()
  -> StateManager.createWorkflowRun(defaultSandbox)
  -> TaskManager.dispatchReadyTasks()
  -> Mailbox.publish(task.dispatch)
  -> TaskWorker consume task.dispatch
  -> TaskManager.startTask()
  -> SandboxManager.resolveTaskSandbox()
  -> RuntimeAdapter.execute()
  -> Mailbox.publish(task.started / task.progress / task.completed / task.failed)
  -> TaskManager consume task.completed
  -> StateManager.applyTaskResult()
  -> TaskManager.evaluateTransitions()
  -> dispatch next task or complete workflow
```

关键原则：

- 每个 Loop 节点执行一次都生成一个独立 `taskRunId`，即使是同一个 `stepId` 因回边被多次访问，也必须是不同 task run。
- Agent 任务、Code 任务、SubLoop 任务、Operator 任务都走同一套 task dispatch / task result 协议。
- Runtime 不直接调用 `next()`；Runtime 只返回当前任务发生的事件和结果。
- `reduce()` 只能由 `TaskManager` 协调 `StateManager` 在 task 完成后执行，不能由 Runtime 或 Agent 直接修改共享 State。
- TaskManager 是否进入下一个节点，只由 `CompiledLoop`、当前 State、任务结果和 policy 决定。

## 8.3 Mailbox 协议

Mailbox 是传递事实和命令的协议层，不是状态数据库。它可以由本机内存队列、Redis Streams、WebSocket、MQ、NATS、Kafka 或云厂商队列实现。

Mailbox 消息分为两类：

- `command`：要求某个执行方做一件事，例如 `task.dispatch`、`task.cancel`。
- `event`：声明已经发生的事实，例如 `task.started`、`task.completed`、`task.failed`。

建议的 envelope：

``` ts
type MailboxMessage<TPayload = unknown> = {
  id: string;
  kind: "command" | "event";
  type: string;
  workflowRunId: string;
  taskRunId?: string;
  stepId?: string;
  parentTaskRunId?: string;
  causationId?: string;
  correlationId?: string;
  sequence?: number;
  payload: TPayload;
  occurredAt: string;
  producer: {
    id: string;
    kind: "task-manager" | "task-worker" | "runtime" | "operator" | "external";
  };
};
```

核心消息类型：

``` text
workflow.started
workflow.completed
workflow.failed
workflow.cancelled

task.dispatch
task.leased
task.started
task.progress
task.output.delta
task.completed
task.failed
task.cancelled
task.heartbeat

sandbox.created
sandbox.attached
sandbox.reused
sandbox.released
```

`task.dispatch` payload 应包含执行所需的最小闭包，而不是整份可变对象引用：

``` ts
type TaskDispatchPayload = {
  taskRunId: string;
  workflowRunId: string;
  loopId: string;
  stepId: string;
  visit: number;
  target: RuntimeTarget;
  input: unknown;
  outputSchemaRef?: string;
  stateSnapshot: LoopStateSnapshot;
  runtime: {
    requestedId?: string;
    resolvedId: string;
  };
  sandbox: SandboxRequest;
  policy: TaskPolicy;
};
```

`task.completed` payload：

``` ts
type TaskCompletedPayload = {
  taskRunId: string;
  workflowRunId: string;
  stepId: string;
  output: unknown;
  usage?: RuntimeUsage;
  artifacts?: readonly RuntimeArtifact[];
  sandbox?: SandboxRef;
};
```

`task.failed` payload：

``` ts
type TaskFailedPayload = {
  taskRunId: string;
  workflowRunId: string;
  stepId: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
  sandbox?: SandboxRef;
};
```

Mailbox 接口：

``` ts
interface Mailbox {
  publish<TPayload>(message: MailboxMessage<TPayload>): Promise<void>;

  subscribe(
    filter: MailboxSubscriptionFilter,
    handler: MailboxMessageHandler,
  ): Promise<MailboxSubscription>;

  requestAck?: (messageId: string) => Promise<void>;
}

type MailboxSubscriptionFilter = {
  workflowRunId?: string;
  taskRunId?: string;
  types?: readonly string[];
  consumerGroup?: string;
};

type MailboxMessageHandler = (
  message: MailboxMessage,
  context: MailboxDeliveryContext,
) => Promise<void>;
```

传输实现约束：

- 至少保证 at-least-once delivery，因此所有 manager 必须幂等。
- 消息必须有全局唯一 `id`，`StateManager` 需要记录已应用 message id。
- 同一个 `workflowRunId` 内的状态应用必须有确定顺序；可用 `sequence`、state revision 或数据库事务保证。
- Mailbox 可以丢弃已 ack 的传输消息，但不能作为长期审计日志唯一来源；审计事件应由 `StateManager` 或 Trace Store 落盘。
- 本机实现可以用 `AsyncIterable` / `EventEmitter`，但公开接口不能泄露本机调用栈语义。

## 8.4 StateManager

`StateManager` 是 Loop State 的托管边界，也是 workflow 当前状态的唯一事实来源。它保存的 `state` 就是用户在 step `input` / `reduce` 中看到的那份 Loop State，而不是另一套内部状态。

用户写的 reducer：

``` ts
reduce: ({ state, output }) => {
  state.results.review = output;
  state.flags.reviewApproved = output.decision === "approved";
},
```

执行时应被理解为：

``` text
StateManager 读取当前 LoopStateSnapshot
  -> 创建可变 draft state
  -> TaskManager 调用 step.reduce({ state: draft, output })
  -> StateManager 校验并提交 draft
  -> 生成新的 LoopStateSnapshot 和 revision
```

也就是说，`reduce()` 是用户侧的状态变更声明；`StateManager` 负责把这次变更变成可持久化、可恢复、可审计、可并发保护的新状态版本。

``` ts
interface StateManager {
  createWorkflowRun(request: CreateWorkflowRunRequest): Promise<WorkflowRunRecord>;
  getWorkflowRun(workflowRunId: string): Promise<WorkflowRunRecord | undefined>;

  createTaskRun(request: CreateTaskRunRequest): Promise<TaskRunRecord>;
  getTaskRun(taskRunId: string): Promise<TaskRunRecord | undefined>;

  applyTaskEvent(message: MailboxMessage): Promise<StateTransitionResult>;
  applyWorkflowEvent(message: MailboxMessage): Promise<StateTransitionResult>;

  applyStepReduction(request: ApplyStepReductionRequest): Promise<LoopStateSnapshot>;

  listReadyTransitions(workflowRunId: string): Promise<readonly ReadyTransition[]>;
}

type ApplyStepReductionRequest = {
  workflowRunId: string;
  taskRunId: string;
  stepId: string;
  output: unknown;
  expectedRevision: number;
  reduce: (context: { state: LoopState; output: unknown }) => void | Promise<void>;
};
```

建议保存的状态模型：

``` ts
type WorkflowRunRecord = {
  id: string;
  loopId: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  input: unknown;
  state: LoopStateSnapshot;
  defaultSandbox: SandboxRef;
  currentStepIds: readonly string[];
  completedStepIds: readonly string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type TaskRunRecord = {
  id: string;
  workflowRunId: string;
  stepId: string;
  visit: number;
  status:
    | "pending"
    | "dispatched"
    | "leased"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "dead_letter";
  runtimeId: string;
  sandbox?: SandboxRef;
  input: unknown;
  output?: unknown;
  error?: unknown;
  attempt: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
};
```

`StateManager` 应用 `task.completed` 时执行以下动作：

1. 校验 message 尚未被应用。
2. 校验 task 当前状态允许完成。
3. 校验 output schema。
4. 基于当前 `LoopStateSnapshot` 创建 reducer draft。
5. 由 `TaskManager` 调用该 step 的 `reduce({ state: draft, output })`。
6. `StateManager` 提交 draft，生成新的 `LoopStateSnapshot` 和 revision。
7. 写入 task output、workflow state、revision 和审计事件。
8. 返回需要 TaskManager 继续评估的 transition hints。

`LoopStateSnapshot` 必须是序列化后的不可变快照。Runtime 拿到 snapshot 后可以读取，但不能持有可变引用。

# 9. TaskManager

TaskManager 负责从 `CompiledLoop` 和 State 中推导下一步，也负责单个 task run 的生命周期。

``` ts
interface TaskManager {
  startRun<TInput>(
    loop: CompiledLoop,
    request: StartLoopRunRequest<TInput>,
  ): Promise<WorkflowRunHandle>;

  handleEvent(message: MailboxMessage): Promise<void>;
  dispatchReadyTasks(workflowRunId: string): Promise<void>;
  cancelRun(workflowRunId: string, reason?: string): Promise<void>;

  leaseTask(message: MailboxMessage<TaskDispatchPayload>): Promise<TaskLease | undefined>;
  executeTask(lease: TaskLease): Promise<void>;
  cancelTask(taskRunId: string, reason?: string): Promise<void>;
  recoverExpiredLeases(now: Date): Promise<readonly TaskRunRecord[]>;
}
```

它在 Loop run 编排层需要处理：

- start 节点派发；
- 顺序 `.next()`；
- schema route；
- 函数 route；
- parallel / merge；
- retry 和 limit；
- subloop 完成后回到父 task；
- end / fail terminal；
- 外部取消、超时和人工审批等待。

TaskManager 不应该在 transition 判断阶段直接调用 Runtime，而是创建 task run 后通过 Mailbox 发送 `task.dispatch`。这样当前本机执行和未来远程 Worker / Desktop 执行使用同一模型。

`TaskManager` 的构造依赖里注入 sandbox 生命周期接口：

``` ts
const taskManager = createLocalTaskManager({
  mailbox,
  stateManager,
  runtimes,
  sandboxManager: createLocalSandboxManager({
    workspaceRoot: process.cwd(),
  }),
});
```

`executeTask()` 的内部流程：

``` text
task.dispatch
  -> lease task
  -> publish task.leased
  -> resolve task sandbox
  -> publish sandbox.attached / sandbox.reused
  -> publish task.started
  -> renew lease and publish task.heartbeat
  -> runtime.execute(invocation)
  -> forward runtime stream as task.progress / task.output.delta
  -> publish task.completed or task.failed
  -> release or retain sandbox according to policy
```

`TaskManager` 的幂等要求：

- 重复收到同一个 `task.dispatch` 时，只能有一个有效 lease。
- `task.completed` 重复投递时，`StateManager` 只能应用一次。
- lease 超时后可以重新派发，但旧 worker 迟到的 completed 事件必须被拒绝或标记 stale。
- task attempt 必须写入 `TaskRunRecord`，retry 不能覆盖历史 attempt。

# 10. Sandbox 接口

每个 root workflow 启动时创建默认 sandbox。后续任务默认复用 workflow sandbox，单个 step 可以显式要求新建 ephemeral sandbox，也可以 attach 到已有 sandbox。这个决策不应该写死在 RuntimeAdapter 中，而应该作为 `TaskManager` 的可替换依赖，通过 `SandboxManager` 注入。

``` ts
type SandboxStrategy =
  | { mode: "reuse-workflow"; key?: string }
  | { mode: "ephemeral" }
  | { mode: "reuse-step"; key?: string }
  | { mode: "attach"; sandboxId: string };

type SandboxRequest = {
  strategy: SandboxStrategy;
  workspace?: {
    root?: string;
    access: "readonly" | "readwrite";
  };
  capabilities?: {
    filesystem?: boolean;
    shell?: boolean;
    network?: boolean;
    humanApproval?: boolean;
  };
};

interface SandboxManager {
  createWorkflowSandbox(request: CreateWorkflowSandboxRequest): Promise<SandboxLease>;
  resolveTaskSandbox(request: ResolveTaskSandboxRequest): Promise<SandboxLease>;
  releaseTaskSandbox(lease: SandboxLease, result: SandboxReleaseResult): Promise<void>;
  cleanupWorkflowSandboxes(workflowRunId: string): Promise<void>;
}
```

策略示例：

``` ts
loop.agent("coder", coderAgent, {
  runtime: "claude-code-local",
  sandbox: {
    strategy: { mode: "reuse-workflow" },
    capabilities: {
      filesystem: true,
      shell: true,
      network: false,
    },
  },
});

loop.code("unit-test", runTests, {
  runtime: "sandbox-node",
  sandbox: {
    strategy: { mode: "ephemeral" },
  },
});
```

Sandbox 策略与 Runtime 选择是两个维度：

- Runtime 决定“用什么执行器执行”。
- Sandbox 决定“在哪里、带着什么权限和工作区执行”。

当前本机版本提供 `LocalSandboxManager`，只解析本机 `workspace` / session ref。未来需要远程或容器 sandbox 时，只替换这个接口实现，例如：

``` text
LocalSandboxManager          当前本机执行
CloudSandboxManager          云端容器 / sandbox
DesktopSandboxManager        Desktop 授权工作区
RemoteRunnerSandboxManager   self-hosted runner
```

这样 `TaskManager` 的生命周期、租约、重试、Mailbox 协议都不需要改变。

SubLoop 默认继承父 task 的 sandbox，但可以显式覆盖：

``` ts
loop.subloop("coding", codingLoop, {
  sandbox: {
    strategy: { mode: "reuse-workflow", key: "source-repo" },
  },
});
```

# 11. 本机实现与未来扩展

第一阶段建议实现本机可验证闭环：

``` text
createLoopApp()
  -> InMemoryMailbox
  -> InMemoryStateManager
  -> LocalTaskManager
  -> RuntimeRegistry
```

目录建议：

``` text
packages/shared/src/loop/
  mailbox.schema.ts        跨进程消息 envelope 和 payload schema
  workflow-state.schema.ts workflow/task 状态 schema

packages/core/src/loop/
  loop-spec.ts
  compiled-loop.ts
  task-manager.ts
  task-execution-environment.ts
  state-manager.ts
  mailbox.ts
  in-memory-mailbox.ts
  in-memory-state-manager.ts
  local-task-execution-environment.ts
```

跨进程或基础设施实现以后再放到对应边界：

``` text
packages/server/src/runtime-gateway/
  redis-mailbox-transport.ts
  mq-mailbox-transport.ts
  workflow-run-store.ts

packages/core/src/local-agent-bridge/
  desktop-mailbox-protocol.ts
  local-runtime-capability.ts

apps/desktop/
  desktop-mailbox-client.ts
  local-permission-guard.ts
```

不要在第一阶段引入 `apps/local-runner`。本地 Agent 未来仍通过 Desktop App 主动连接云端，由 Desktop 承载权限确认和本机执行桥接。

扩展路径：

| 阶段 | Mailbox | State | Worker | Execution Environment |
| --- | --- | --- | --- | --- |
| 本机 SDK | In-memory queue | In-memory store | 同进程 TaskManager | 本机 workspace/session |
| 单机服务 | Redis Streams | 数据库 | apps/worker | Node sandbox/container |
| 云端分布式 | MQ / NATS / Kafka | 数据库 + Trace Store | 多 worker consumer group | cloud sandbox |
| 本地桥接 | WebSocket mailbox bridge | 云端 State + 本地 session cache | Desktop App | Desktop 授权 workspace |

设计上 Mailbox、StateManager、TaskManager 都以接口依赖注入给 `createLoopApp()`：

``` ts
const app = createLoopApp({
  mailbox,
  stateManager,
  taskManager,
  runtimes,
});
```

默认不传时创建本机实现：

``` ts
const app = createLoopApp();
```

这保证最小 API 仍然轻量，同时内部执行模型可以平滑迁移到 Server/Worker 或 Desktop bridge。

# 12. Channel

这里的 Channel 是用户侧或步骤侧看到的事件通道，可以构建在 Mailbox 之上，但不等同于实现层 Mailbox。

Channel 面向业务语义，例如 `code.changed`、`review.failed`；Mailbox 面向执行协议，例如 `task.dispatch`、`task.completed`。Channel 消息可以被 TaskManager 转换成 workflow event，也可以只作为 trace / notification。

``` ts
const channel = channel({
  type: "mailbox",
});
```

``` ts
await ctx.channel.send("code.changed", {...});

ctx.channel.on("review.failed", async (msg) => {
  await ctx.goto("coder");
});
```

------------------------------------------------------------------------

# 13. Loop State

``` ts
type LoopState = {
  input: unknown;
  context: Record<string, any>;
  artifacts: Record<string, any>;
  results: Record<string, any>;
  flags: Record<string, boolean>;
  messages: Message[];
  metrics: Record<string, any>;
  private: Record<string, any>;
};
```

原则：

``` text
Agent 不直接修改 State
Step 定义 reduce
TaskManager 调用 reduce
StateManager 托管并提交 Loop State
Runtime 只接收 State Snapshot 并返回步骤结果
```

------------------------------------------------------------------------

# 14. Pattern

``` ts
Patterns.planActVerify()
Patterns.clarifyThenConfirm()
Patterns.multiAgentReview()
Patterns.routerExperts()
Patterns.generateJudgeRefine()
Patterns.supervisorWorkers()
```

------------------------------------------------------------------------

# 15. 发布与调用

``` ts
await app.publish(codingLoop);

const result = await client.loop("coding-loop").run({
  requirement: "...",
});
```

Loop 也可以作为另一个 Loop 的步骤：

``` ts
deliveryLoop.subloop("coding", client.loop("coding-loop"));
```

------------------------------------------------------------------------

# 16. API 分层

``` text
defineAgent()
defineLoop()
LoopSpec
CompiledLoop
RuntimeAdapter
channel()
Patterns.*
createLoopApp()
client.loop()
```

------------------------------------------------------------------------

# 总结

``` text
Agent 使用文本协议。
Loop 使用 Schema 协议。
Route 使用步骤输出 Schema 的可枚举字段。
State 由 Loop 托管。
Runtime 执行步骤。
Channel 负责通信。
Operator 负责组合。
Pattern 负责复用。
Loop 可以组合 Loop。
compile() 负责把 DSL 校验并归一化为不可变执行图。
Everything is a Loop.
```
