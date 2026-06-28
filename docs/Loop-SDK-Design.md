# Loop SDK 核心设计（API 草案）

## 核心理念

``` text
Everything is a Loop.
Agent is the smallest Loop.
Workflow is a Composable Loop.
Runtime executes Loops.
Channel connects Loops.
```

------------------------------------------------------------------------

# 1. 最小 Agent API

Agent 入参默认是 `string`，出参默认也是 `string`，但可以声明
`outputSchema`。

``` ts
const coder = agent({
  name: "coder",
  description: "负责代码实现",

  runtime: "claude-code",

  system: `
你是一个资深 Coding Agent。
根据任务修改代码，并确保测试通过。
`,

  tools: [readFile, writeFile, bash],

  outputSchema: z.object({
    summary: z.string(),
    changedFiles: z.array(z.string()),
    testsPassed: z.boolean(),
  }),
});
```

调用：

``` ts
const result = await coder.run(`
任务：实现 GitHub 登录
仓库：github.com/acme/app
`);
```

设计原则：

``` text
Agent Input  = string
Agent Output = string | schema
```

------------------------------------------------------------------------

# 2. LoopGraph API：核心能力

`LoopGraph` 是真正的一等公民，不是简单 `defineLoop()`。

``` ts
const loop = new LoopGraph({
  name: "coding-loop",

  inputSchema: z.object({
    requirement: z.string(),
    repo: z.string(),
    branch: z.string().optional(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    summary: z.string(),
    changedFiles: z.array(z.string()),
  }),
});
```

------------------------------------------------------------------------

# 3. 添加 Agent 节点

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
  input: ({ state }) => `
请验证本次代码变更：
${JSON.stringify(state.artifacts.codeChange)}
`,

  reduce: ({ state, output }) => {
    state.results.test = output;
    state.flags.testsPassed = output.testsPassed;
  },
});
```

------------------------------------------------------------------------

# 4. 节点流转 API

``` ts
loop.start(planner);

loop.edge(planner, coder);
loop.edge(coder, tester);

loop.when(tester, "passed").goto(reviewer);
loop.when(tester, "failed").goto(coder);

loop.when(reviewer, "approved").end();
loop.when(reviewer, "rejected").goto(coder);
```

形成：

``` text
Planner → Coder → Tester
              ↑      ↓
              ← failed
```

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

loop.edge(plans, judge);
loop.when(judge, "accepted").goto(coder);
loop.when(judge, "rejected").goto(plans);
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

loop.edge(planner, approve);
loop.when(approve, "approved").goto(coder);
loop.when(approve, "rejected").goto(planner);
```

------------------------------------------------------------------------

# 6. SubLoop

``` ts
const deliveryLoop = new LoopGraph({...});

deliveryLoop.subloop("requirement", requirementLoop);
deliveryLoop.subloop("design", designLoop);
deliveryLoop.subloop("coding", codingLoop);
deliveryLoop.subloop("release", releaseLoop);
```

------------------------------------------------------------------------

# 7. Runtime

``` ts
const runtime = runtime({
  name: "claude-code-local",
  type: "claude-code",
  workspace: "./repo",
});
```

运行：

``` ts
await app.run("coding-loop", input, {
  runtime: "claude-code-local",
});
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
Node 负责 reduce
Runtime 托管 State
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

Loop 也可以作为另一个 Loop 的节点：

``` ts
deliveryLoop.subloop("coding", client.loop("coding-loop"));
```

------------------------------------------------------------------------

# 12. API 分层

``` text
agent()
LoopGraph
runtime()
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
State 由 Runtime 托管。
Channel 负责通信。
Operator 负责组合。
Pattern 负责复用。
Loop 可以组合 Loop。
Everything is a Loop.
```
