# Human Interaction

本文说明 Directive 层的人类等待点，以及 Agent Runtime 工具审批的可恢复交互处理。先阅读 [Directive 使用指南](./directives.md) 会更容易理解 `flow.use()`、`reduce()` 和 `route()`。

## 基本模型

`defineHumanTask()` 用于创建人工等待点。它返回普通 `Directive`，因此可以像 Agent、代码 task 或子 Flow 一样注册到 `flow.use()`，并通过 `reduce()` 和 `route()` 推进后续流程。

Human task 执行时，`TaskManager` 会创建 `HumanInteractionRecord`，把 workflow/task 标记为 `waiting`，发布 `human.requested`、`task.waiting` 和 `workflow.waiting`。外部 UI、CLI 或 Desktop 通过 `taskManager.respondToHumanInteraction()` 提交响应后，workflow/task 恢复，Human step 返回响应对象，然后进入普通的 `reduce()` 和 `route()`。

## 最小示例

```ts
import { createPragma, defineFlow, defineHumanTask } from "@pragma/core";
import { z } from "zod";

const app = createPragma();

const flow = defineFlow({
  id: "approval-directive",
  output: z.object({
    approved: z.boolean(),
  }),
  result: ({ state }) => ({
    approved: state.flags["approved"] ?? false,
  }),
});

const approve = flow.use(
  "approve",
  defineHumanTask({
    id: "human-approval",
    output: z.object({
      approved: z.boolean(),
    }),
    request: {
      kind: "approval",
      title: "Approve plan",
      prompt: "Should the workflow continue?",
    },
  }),
  {
    reduce: ({ state, output }) => {
      state.flags["approved"] = output.approved;
    },
  },
);

flow.compose(({ start, end }) => {
  start(approve).next(end());
});

const handle = await app.start(flow, {
  input: {},
});

const interaction = (await app.stateManager.listHumanInteractions(handle.workflowRunId))[0];

if (interaction !== undefined) {
  await app.taskManager.respondToHumanInteraction({
    interactionId: interaction.id,
    response: {
      approved: true,
    },
    operator: {
      id: "local-user",
      kind: "user",
    },
  });
}

const result = await handle.result;
console.log(result.output);
```

实际产品层不应轮询 `listHumanInteractions()`。推荐通过 `app.runs.watchOutput(workflowRunId)` 或自定义 Mailbox 订阅 `human.requested`，把请求展示给用户，再调用 `respondToHumanInteraction()`。

## 需求澄清 Directive

需求澄清适合建模为“Agent/Task 判断是否需要更多信息，Human task 收集答案，再回到澄清步骤”：

```text
clarifier -> human_question -> clarifier -> ready
```

推荐约束：

- clarifier 输出结构化字段，例如 `{ status: "needs_input" | "ready", questions }`。
- `human_question` 的 response 写入 `state.messages` 或 `state.context`。
- clarifier 的回边必须配置 `limit()`，避免无限追问。

可运行示例：

```bash
pnpm --filter @pragma/examples dev src/run-human-clarification.ts
```

## 编码 review gate

编码阶段的人类介入不应使用 tool approval 表达。tool approval 只适合单个工具调用，例如删除文件、执行 shell、访问网络。阶段性验收、vibecoding 介入和“点击通过后进入下一步”应使用 `review_gate`：

```text
coder -> verify -> human_review_gate
              |        |
              |        +-- approved -> next
              |        +-- request_changes -> coder
              |        +-- manual_patch -> verify
```

推荐约束：

- `coder` 和 `verify` 复用 workflow sandbox，使 Agent 修改、人工修改和验证看到同一份 workspace。
- `manual_patch` 响应应记录到 `state.artifacts`，然后重新进入 verify。
- `approved` 才能进入下一步；`request_changes` 回到 coder，并把 feedback 放进下一次 coder input。
- `coder` 和 `review_gate` 都应配置访问上限。

可运行示例：

```bash
pnpm --filter @pragma/examples dev src/run-human-review-gate.ts
```

## Agent 内部提问

`ExpertAgent` 作为 Flow step 运行时，内置 `askUserQuestion` 会通过 Directive human interaction broker 创建 `question` interaction。也就是说，Agent 内部提问和显式 `defineHumanTask()` 走同一套 `human.requested` / `human.responded` 协议。

这保证了：

- 用户问题可以被 UI 统一展示。
- workflow/task 会进入 `waiting`，不会被误判为失败或重派发。
- 用户回答会被记录为 Human Interaction 审计事实。

## 可恢复工具审批

Runtime 工具审批通过 `humanInteractionHandler` 进入人工交互。普通 handler 只在当前进程内等待用户响应；如果应用关闭，正在等待的 Promise 会消失。因此需要把 pending request 先持久化，再把请求交给 CLI/UI。

Core 提供 `createDurableHumanInteractionHandler()` 和 `HumanInteractionStore` 处理这件事：

```ts
import {
  createDurableHumanInteractionHandler,
  createFileHumanInteractionStore,
} from "@pragma/core";

const store = createFileHumanInteractionStore({
  rootDir: ".pragma/human-interactions",
});

const humanInteractionHandler = createDurableHumanInteractionHandler({
  scope: {
    workflowId,
    runtimeSessionId,
  },
  store,
  delegate: async (request) => {
    if (request.kind === "tool_approval") {
      const approved = await showApprovalDialog(request);

      return {
        kind: "tool_approval",
        approved,
      };
    }

    return {
      kind: "user_question",
      answered: false,
      reason: "No question UI is configured.",
    };
  },
});

const session = await runtime.createSession({
  agent,
  runtimeSession: {
    type: "example-runtime",
    id: runtimeSessionId,
  },
  humanInteractionHandler,
});
```

`createDurableHumanInteractionHandler()` 的行为：

1. 收到 `tool_approval` 或 `user_question` 时，先写入 `store.savePending()`。
2. 调用 `delegate` 展示 CLI/UI。
3. `delegate` 返回响应后调用 `store.resolve()`，pending interaction 会被清理。
4. 如果进程退出、Ctrl-C 或 `delegate` 抛错，pending interaction 会保留，供下次启动恢复。

恢复时用同一个 scope 查询 pending interaction，然后恢复相同 runtime session：

```ts
const pending = await store.getPending({ workflowId });
const runtimeSessionId = pending?.scope["runtimeSessionId"] ?? createNewSessionId();

const session = await runtime.createSession({
  agent,
  runtimeSession: {
    type: "example-runtime",
    id: runtimeSessionId,
  },
  humanInteractionHandler: createDurableHumanInteractionHandler({
    scope: {
      workflowId,
      runtimeSessionId,
    },
    store,
    delegate: createCliHumanInteractionHandler(),
  }),
});

if (pending !== undefined) {
  printTranscript(session.messages());
  // 重新 submit 原 run/query，或让 runtime 从自己的 checkpoint 恢复到等待点。
}
```

注意：进程退出后不能恢复原来的 JavaScript Promise。这里恢复的是 durable human interaction record，并要求 runtime 能通过相同 `runtimeSessionId` 和自身 checkpoint/消息状态重新进入等待点。聊天记录、run/query、runtime checkpoint 仍由具体 runtime/session 负责持久化；human interaction store 只负责 pending request、response、scope 和审计事实。

可运行示例：

```bash
pnpm --filter @pragma/examples dev src/run-resumable-tool-approval.ts --reset --workflow-id demo-approval
```

在 `Approve? [y/N]` 提示时按 `Ctrl-C`，然后恢复：

```bash
pnpm --filter @pragma/examples dev src/run-resumable-tool-approval.ts --workflow-id demo-approval
```

也可以使用示例输出的 session id：

```bash
pnpm --filter @pragma/examples dev src/run-resumable-tool-approval.ts --session-id <session-id>
```
