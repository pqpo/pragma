# Expert Agent Examples

这个 workspace 用来展示如何直接使用 `ExpertAgent`。示例会把关键流程写在入口文件里，`src/harness` 只放少量可复用工具函数，不封装完整运行流程。

## 准备模型配置

```bash
cp examples/.env.example examples/.env
```

然后在 `examples/.env` 中填写模型 key：

```text
PRAGMA_MODEL_PROVIDER=openai
PRAGMA_MODEL_NAME=gpt-4o-mini
PRAGMA_MODEL_BASE_API=https://api.openai.com/v1
PRAGMA_MODEL_API=openai-responses
PRAGMA_MODEL_API_KEY=replace-with-your-api-key
```

也可以不写 `PRAGMA_MODEL_API_KEY`，改用环境变量 `OPENAI_API_KEY`。

## 运行基础示例

```bash
pnpm --filter @pragma/examples dev src/run-expert-agent.ts
```

传入自定义问题：

```bash
pnpm --filter @pragma/examples dev src/run-expert-agent.ts "用三句话说明 ExpertAgent 的最小使用流程"
```

基础示例默认使用仓库根目录下的 `workspace/` 作为 agent workspace，并会在启动时自动创建这个目录。

提交多轮任务，测试同一个 runtime session 内的连续对话：

```bash
pnpm --filter @pragma/examples dev src/run-expert-agent.ts --turn "记住：我的项目代号是 mesh-alpha" --turn "我刚才说的项目代号是什么？"
```

运行时会打印 `runtimeSessionId`。复制这个 id 后，可以在下一次运行中恢复 runtime session：

```bash
pnpm --filter @pragma/examples dev src/run-expert-agent.ts --runtime-session-id <runtime-session-id> --turn "继续上一次会话，我刚才让你记住了什么？"
```

需要固定 Pragma 自己的 system session id 时，也可以传入：

```bash
pnpm --filter @pragma/examples dev src/run-expert-agent.ts --system-session-id local-debug-session --turn "测试固定 system session id"
```

这个示例对应 `src/run-expert-agent.ts`。核心流程是：

1. 从 `.env` 读取模型配置。
2. 创建带 `models` 配置的 `ExpertAgent`。
3. 创建自定义 logger provider，并同时传给 `ExpertAgent` 与 `createPiRuntime()`。
4. 可选传入 `runtimeSession` 恢复 runtime session。
5. 使用 runtime 创建 session。
6. 对每个 turn 调用 `session.submit()` 并处理流式事件。
7. 在 `finally` 中关闭 session。

## 运行 Codex Runtime 示例

```bash
pnpm --filter @pragma/examples dev src/run-codex-runtime-agent.ts
```

这个示例使用本机 `codex app-server --listen stdio://` 作为 runtime，不读取 `.env`
里的 `PRAGMA_MODEL_*` 配置。运行前需要本机已安装并登录 Codex CLI：

```bash
codex login
```

传入 Codex 模型名：

```bash
pnpm --filter @pragma/examples dev src/run-codex-runtime-agent.ts --model gpt-5.5 "总结这个仓库的模块边界"
```

提交多轮任务并复用同一个 Codex thread：

```bash
pnpm --filter @pragma/examples dev src/run-codex-runtime-agent.ts \
  --turn "记住：我在测试 Codex runtime" \
  --turn "我刚才在测试什么？"
```

运行时会打印 `runtimeSessionId`，它对应 Codex thread id。下一次可以恢复：

```bash
pnpm --filter @pragma/examples dev src/run-codex-runtime-agent.ts \
  --runtime-session-id <runtime-session-id> \
  --turn "继续上一次 Codex runtime 会话"
```

也可以显式传入 Codex sandbox 和 approval policy：

```bash
pnpm --filter @pragma/examples dev src/run-codex-runtime-agent.ts \
  --sandbox workspace-write \
  --approval-policy on-request \
  --turn "列出 workspace 目录"
```

示例入口是 `src/run-codex-runtime-agent.ts`。它展示：

1. 创建普通 `ExpertAgent`。
2. 用 `createCodexRuntime()` 创建本地 Codex runtime。
3. 把 `--model` 映射为 `defaultModelName` 和单次 `submit({ modelName })`。
4. 用 `runtimeSession: { type: "codex-local", id }` 恢复 Codex thread。
5. 打印 Codex runtime 的流式 message/tool/progress 事件。

## 运行 Claude Code Runtime 示例

```bash
pnpm --filter @pragma/examples dev src/run-claude-code-runtime-agent.ts
```

这个示例使用本机 `claude` CLI 作为 runtime，不读取 `.env` 里的
`PRAGMA_MODEL_*` 配置。运行前需要本机已安装并登录 Claude Code：

```bash
claude --version
```

传入 Claude Code 模型名：

```bash
pnpm --filter @pragma/examples dev src/run-claude-code-runtime-agent.ts --model claude-sonnet-4-5 "总结这个仓库的 runtime 边界"
```

提交多轮任务并复用同一个 Claude Code session：

```bash
pnpm --filter @pragma/examples dev src/run-claude-code-runtime-agent.ts \
  --turn "记住：我在测试 Claude Code runtime" \
  --turn "我刚才在测试什么？"
```

运行时会打印 `runtimeSessionId`，下一次可以恢复：

```bash
pnpm --filter @pragma/examples dev src/run-claude-code-runtime-agent.ts \
  --runtime-session-id <runtime-session-id> \
  --turn "继续上一次 Claude Code runtime 会话"
```

也可以显式传入权限和隔离模式：

```bash
pnpm --filter @pragma/examples dev src/run-claude-code-runtime-agent.ts \
  --permission-mode plan \
  --isolation strict \
  --turn "列出 workspace 目录"
```

示例入口是 `src/run-claude-code-runtime-agent.ts`。它展示：

1. 用 `runtime.canUse()` 预检本机 Claude Code CLI。
2. 用 `createClaudeCodeRuntime()` 创建本地 Claude Code runtime。
3. 把 `--model` 映射为 `defaultModelName` 和单次 `submit({ modelName })`。
4. 用 `runtimeSession: { type: "claude-code-local", id }` 恢复 Claude Code session。
5. 打印 Claude Code runtime 的流式 message/tool/progress 事件。

## 运行 Memory System 示例

```bash
pnpm --filter @pragma/examples dev src/run-memory-system-example.ts
```

这个示例不依赖模型 key，专门演示：

1. 通过 `plugins: [{ entry: memoryPlugin }]` 显式注入四类记忆。
2. 默认只暴露 `task` 写工具，`experience` / `fact` 不再默认直出工具。
3. `memory` namespace 默认可写，并承载 summary 与 skill card。
4. 通过 memory plugin 的 `config` 关闭 `experience` / `fact` 后，会关闭对应的自动沉淀与 context 投影，而 task 工具和其他类别仍可独立保留。

示例入口是 `src/run-memory-system-example.ts`。

## 运行 Session 存储示例

```bash
pnpm --filter @pragma/examples dev src/run-session-storage-example.ts
```

这个示例演示 runtime session 在沙盒或 workspace 生命周期外的同步与恢复：

1. 使用 `workspace/session-storage-example/workspace-a` 创建会话。
2. 发送第一轮聊天，让模型记住项目代号和目标。
3. 通过 `sessionSyncCallback` 把 `.pragma/runtime-sessions/pi/<agent-id>` 同步到 `workspace/session-storage-example/long-term-session-storage`。
4. 切换到 `workspace/session-storage-example/workspace-b`。
5. 使用同一个 `runtimeSessionId` 创建新会话，并通过 `sessionRestoreHandler` 把长期存储恢复到新 workspace 的 session 目录。
6. 再发送一轮聊天，让模型总结上轮会话。
7. 关闭恢复后的会话时再次同步，模拟后续更新写回长期存储。

示例入口是 `src/run-session-storage-example.ts`。它用本地目录模拟长期存储；真实服务接入时，`sessionSyncCallback` 和 `sessionRestoreHandler` 可以在相同参数里读取 `agentId`、`runtimeSession.id`、`systemSessionId`、`workspace` 和 `context.attributes`，用于鉴权、租户隔离和对象存储路径选择。

## 运行审批示例

```bash
pnpm --filter @pragma/examples dev src/run-tool-approval-example.ts
```

这个示例展示两件事：

- 内置 `askUserQuestion` 会通过运行时注入的 human interaction handler 读取用户回答。
- 普通工具可以通过 `approval: { mode: "required" }` 声明为需要确认，运行时会先发出 `tool.approval_requested` 事件，再交给用户决定是否继续。

示例入口是 `src/run-tool-approval-example.ts`，它通过 `runtime.createSession({ humanInteractionHandler })` 注入人类交互 handler。handler 根据 `request.kind` 区分 `user_question` 和 `tool_approval`：CLI 中 `[question] askUserQuestion` 表示输入给模型的问题回答，`[approval] <tool>` 表示是否批准工具执行。`askUserQuestion` 的每个问题支持 `kind: "single_choice"`、`kind: "multiple_choice"` 和 `kind: "text"`；旧格式只传 `options` 时会按单选处理。

工具声明时可以直接要求审批：

```ts
approval: {
  mode: "required",
  reason: "Shell command may delete files.",
  when: ({ input }) =>
    typeof input === "object" &&
    input !== null &&
    "command" in input &&
    typeof input.command === "string" &&
    /\brm\b/.test(input.command),
}
```

插件也可以通过 `toolApprovals` 给已有工具追加审批策略。工具自带策略和插件策略会合并；只要任一策略命中，就会触发审批。

### 恢复未完成审批

```bash
pnpm --filter @pragma/examples dev src/run-resumable-tool-approval.ts --reset --workflow-id demo-approval
```

这个示例展示如何用 `@pragma/core` 的 durable human interaction 能力恢复未完成的工具审批：

1. 创建带 `approval: { mode: "required" }` 的 `deploy_preview` 工具。
2. 用 `createFileHumanInteractionStore()` 保存 pending approval。
3. 用 `createDurableHumanInteractionHandler()` 包装 CLI handler。
4. Runtime 在触发审批前保存聊天记录和 active turn。
5. 在 `Approve? [y/N]` 时按 `Ctrl-C` 模拟应用关闭。
6. 第二次启动时按 `workflowId` 或 `sessionId` 找回 pending approval，打印原聊天记录，并重新展示审批请求。
7. 输入 `y` 后继续执行工具并完成流程。

按 `workflowId` 恢复：

```bash
pnpm --filter @pragma/examples dev src/run-resumable-tool-approval.ts --workflow-id demo-approval
```

按 `sessionId` 恢复：

```bash
pnpm --filter @pragma/examples dev src/run-resumable-tool-approval.ts --session-id <session-id>
```

示例入口是 `src/run-resumable-tool-approval.ts`。它只把 runtime transcript 保存在示例自己的 session state 中；pending approval 的持久化、去重、resolve 和 clear 由 `createDurableHumanInteractionHandler()` 与 `HumanInteractionStore` 负责。真实产品接入时，应把 `HumanInteractionStore` 换成数据库实现，并把 `scope` 绑定到租户、用户、workflow/run 和 runtime session。

## 运行上下文示例

```bash
pnpm --filter @pragma/examples dev src/run-workspace-context-agent.ts
```

默认情况下，上下文示例也使用仓库根目录下的 `workspace/`，并使用内存 mock 上下文库。

传入外部 workspace 目录：

```bash
pnpm --filter @pragma/examples dev src/run-workspace-context-agent.ts --workspace ./workspace
```

传入 markdown 上下文目录后，示例会改用 `FileSystemContextStore`：

```bash
pnpm --filter @pragma/examples dev src/run-workspace-context-agent.ts --context ./docs
```

也可以同时传入 workspace、context 和自定义 query：

```bash
pnpm --filter @pragma/examples dev src/run-workspace-context-agent.ts --workspace ./workspace --context ./docs "总结这些上下文里的关键约束"
```

这个示例对应 `src/run-workspace-context-agent.ts`，额外展示：

- 用 `cac` 读取 `--workspace`、`--context` 和 query。
- 未传 `--context` 时，用 `createInMemoryContextStore()` 注册 always-on 和 model-decision mock 上下文。
- 传入 `--context` 时，用 `FileSystemContextStore` 从外部 markdown 目录读取上下文条目。
- 调用 `agent.buildContext()` 预检上下文。
- 通过同一套 runtime session 流程运行 agent。

## 运行 Directive 示例

Directive 示例不需要模型 key，全部使用本机 `code` step：

```bash
pnpm --filter @pragma/examples dev src/run-directive-code.ts
pnpm --filter @pragma/examples dev src/run-directive-route.ts
pnpm --filter @pragma/examples dev src/run-directive-nested.ts
pnpm --filter @pragma/examples dev src/run-directive-watch.ts
pnpm --filter @pragma/examples dev src/run-agent-delegation.ts
pnpm --filter @pragma/examples dev src/run-workflow-patterns.ts
pnpm --filter @pragma/examples dev src/run-human-clarification.ts
pnpm --filter @pragma/examples dev src/run-human-review-gate.ts
```

- `run-directive-code.ts`：最小 `defineFlow()` + `defineTask()` + `reduce()`。
- `run-directive-route.ts`：根据 step 结构化输出字段 `.route("status", ...)`。
- `run-directive-nested.ts`：把一个 Directive 作为另一个 Directive 的 nested directive step。
- `run-directive-watch.ts`：用 `app.start()` 非阻塞启动 run，再用 `app.runs.get()`、`app.runs.list()`、`app.runs.getTree()`、`app.runs.watch()` 和 `app.runs.watchOutput()` 查询状态并递归订阅嵌套 Directive 事件。
- `run-agent-delegation.ts`：演示父 `coding-agent` 通过 `launch_agent` 工具委派 `code-explorer-agent`，底层创建 child workflow run，并通过同一个 StateManager 出现在 run tree 中。
- `run-workflow-patterns.ts`：演示 `patterns.promptChain()`、`patterns.routing()`、`patterns.parallel()`、`patterns.orchestratorWorkers()` 和 `patterns.evaluatorOptimizer()` 五类快捷范式。
- `run-human-clarification.ts`：演示 `clarifier -> human question -> clarifier` 的多轮需求澄清，Human step 会让 workflow/task 进入 waiting，CLI 回答后恢复。
- `run-human-review-gate.ts`：演示 `coder -> verify -> human review gate`，CLI 可选择 approve、request changes 或 manual patch，并通过普通 `.route("decision", ...)` 推进或回环。

Human Interaction 示例是平台协议的最小本地验证路径，不依赖模型 key。它们展示的是 `defineHumanTask()`、`human.requested` 事件和 `taskManager.respondToHumanInteraction()`，后续 Web、Server 或 Desktop UI 应接入同一套协议。

Agent 委派示例需要模型 key。它展示的是 ExpertAgent 之间通过 `launch_agent` 互相委派任务，而不是 runtime 私有子会话。每次委派都会创建新的 child workflow run；`--session-policy reuse_by_agent` 只复用底层 runtime conversation/session ref，不复用 workflow run：

```bash
pnpm --filter @pragma/examples dev src/run-agent-delegation.ts --session-policy reuse_by_agent
```

## 示例辅助边界

`src/harness` 里的代码只做辅助：

- `model-config.ts`：读取 `.env` 并生成 ExpertAgent models config。
- `cli.ts`：用 `cac` 读取示例 CLI 参数。
- `paths.ts`：定位 examples 目录、仓库根目录和默认 workspace。
- `logger.ts`：演示自定义 logger provider，输出简短审计日志。
- `expert-agent-example-utils.ts`：打印运行信息、预检上下文。

不要把业务流程继续包进 harness。新增示例时，应在 `src/run-*.ts` 中显式写出 ExpertAgent 的创建、models 配置、runtime session、`session.submit()` 流式事件处理和清理步骤。
