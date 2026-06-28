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
import { defineAgent } from "@expertmesh/loop";

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
import { createRuntimeRegistry } from "@expertmesh/agent-runtime";

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
} from "@expertmesh/agent-runtime";

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
} from "@expertmesh/agent-runtime";

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
packages/agent/agent-core
  RuntimeAdapter        通用 Runtime 接口
  RuntimeRegistry       通用 Runtime registry 接口
  RuntimeInvocation     通用步骤执行请求
  RuntimeExecution      通用步骤执行句柄
  RuntimeEvent          通用运行事件

packages/agent/agent-runtime
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
import { createRuntimeRegistry } from "@expertmesh/agent-runtime";

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
RuntimeAdapter 通用接口         -> @expertmesh/agent-core
RuntimeAdapter 具体实现         -> @expertmesh/agent-runtime
Server / Worker 调度 Runtime    -> apps/server、apps/worker 或 server orchestration package
Desktop 本地权限与连接桥接      -> apps/desktop + packages/agent/local-agent-bridge
```

------------------------------------------------------------------------

# 8. Channel

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

# 9. State

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
Step 负责 reduce
Loop 托管 State
Runtime 只接收 State Snapshot 并返回步骤结果
```

------------------------------------------------------------------------

# 10. Pattern

``` ts
Patterns.planActVerify()
Patterns.clarifyThenConfirm()
Patterns.multiAgentReview()
Patterns.routerExperts()
Patterns.generateJudgeRefine()
Patterns.supervisorWorkers()
```

------------------------------------------------------------------------

# 11. 发布与调用

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

# 12. API 分层

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
