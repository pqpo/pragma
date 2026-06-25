# Expert Agent Examples

这个 workspace 用来展示如何直接使用 `ExpertAgent`。示例会把关键流程写在入口文件里，`src/harness` 只放少量可复用工具函数，不封装完整运行流程。

## 准备模型配置

```bash
cp examples/.env.example examples/.env
```

然后在 `examples/.env` 中填写模型 key：

```text
EXPERTMESH_MODEL_PROVIDER=openai
EXPERTMESH_MODEL_NAME=gpt-4o-mini
EXPERTMESH_MODEL_BASE_API=https://api.openai.com/v1
EXPERTMESH_MODEL_API=openai-responses
EXPERTMESH_MODEL_API_KEY=replace-with-your-api-key
```

也可以不写 `EXPERTMESH_MODEL_API_KEY`，改用环境变量 `OPENAI_API_KEY`。

## 运行基础示例

```bash
pnpm --filter @expertmesh/examples start:basic
```

传入自定义问题：

```bash
pnpm --filter @expertmesh/examples start:basic "用三句话说明 ExpertAgent 的最小使用流程"
```

基础示例默认使用仓库根目录下的 `workspace/` 作为 agent workspace，并会在启动时自动创建这个目录。

提交多轮任务，测试同一个 runtime session 内的连续对话：

```bash
pnpm --filter @expertmesh/examples start:basic --turn "记住：我的项目代号是 mesh-alpha" --turn "我刚才说的项目代号是什么？"
```

运行时会打印 `runtimeSessionId`。复制这个 id 后，可以在下一次运行中恢复 runtime session：

```bash
pnpm --filter @expertmesh/examples start:basic --runtime-session-id <runtime-session-id> --turn "继续上一次会话，我刚才让你记住了什么？"
```

需要固定 ExpertMesh 自己的 system session id 时，也可以传入：

```bash
pnpm --filter @expertmesh/examples start:basic --system-session-id local-debug-session --turn "测试固定 system session id"
```

这个示例对应 `src/run-expert-agent.ts`。核心流程是：

1. 从 `.env` 读取模型配置。
2. 创建带 `models` 配置的 `ExpertAgent`。
3. 创建自定义 logger provider，并同时传给 `ExpertAgent` 与 `createCloudPiRuntimeAdapter()`。
4. 可选传入 `runtimeSession` 恢复 runtime session。
5. 使用 runtime 创建 session。
6. 对每个 turn 调用 `session.submit()` 并处理流式事件。
7. 在 `finally` 中关闭 session。

## 运行审批示例

```bash
pnpm --filter @expertmesh/examples start:approval
```

这个示例展示两件事：

- 内置 `askUserQuestion` 会通过运行时注入的 approval handler 读取用户回答。
- 普通工具可以通过 `approval: { mode: "required" }` 声明为需要确认，运行时会先发出 `tool.approval_requested` 事件，再交给用户决定是否继续。

示例入口是 `src/run-tool-approval-example.ts`，它直接把审批 handler 放进 `runtime.createSession({ context })` 的 `attributes.toolApprovalHandler`，以便在 CLI 中交互式确认。

## 运行上下文示例

```bash
pnpm --filter @expertmesh/examples start:workspace-context
```

默认情况下，上下文示例也使用仓库根目录下的 `workspace/`，并使用内存 mock 上下文库。

传入外部 workspace 目录：

```bash
pnpm --filter @expertmesh/examples start:workspace-context --workspace ./workspace
```

传入 markdown 上下文目录后，示例会改用 `FileSystemContextStore`：

```bash
pnpm --filter @expertmesh/examples start:workspace-context --context ./docs
```

也可以同时传入 workspace、context 和自定义 query：

```bash
pnpm --filter @expertmesh/examples start:workspace-context --workspace ./workspace --context ./docs "总结这些上下文里的关键约束"
```

这个示例对应 `src/run-workspace-context-agent.ts`，额外展示：

- 用 `cac` 读取 `--workspace`、`--context` 和 query。
- 未传 `--context` 时，用 `createInMemoryContextStore()` 注册 always-on 和 model-decision mock 上下文。
- 传入 `--context` 时，用 `FileSystemContextStore` 从外部 markdown 目录读取上下文条目。
- 调用 `agent.buildContext()` 预检上下文。
- 通过同一套 runtime session 流程运行 agent。

## Harness 边界

`src/harness` 里的代码只做辅助：

- `model-config.ts`：读取 `.env` 并生成 ExpertAgent models config。
- `cli.ts`：用 `cac` 读取示例 CLI 参数。
- `paths.ts`：定位 examples 目录、仓库根目录和默认 workspace。
- `logger.ts`：演示自定义 logger provider，输出简短审计日志。
- `expert-agent-example-utils.ts`：打印运行信息、预检上下文。

不要把业务流程继续包进 harness。新增示例时，应在 `src/run-*.ts` 中显式写出 ExpertAgent 的创建、models 配置、runtime session、`session.submit()` 流式事件处理和清理步骤。
