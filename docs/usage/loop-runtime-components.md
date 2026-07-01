# Loop 运行组件与扩展

本文面向需要替换默认内存组件、接入远程 sandbox 或规划分布式部署的开发者。基础用法请先阅读 [Loop 使用指南](./loops.md)。

## 默认组件

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
- `markTaskWaiting()` 应清除 lease owner 和 lease 过期时间；waiting task 不应被 `recoverExpiredLeases()` 恢复。
- `markTaskResumed()` 只能把 waiting task 恢复为 running。
- `createHumanInteraction()`、`resolveHumanInteraction()` 和 `listHumanInteractions()` 必须持久化人工等待点。
- `resolveHumanInteraction()` 必须幂等；重复响应不能覆盖首次有效响应。
- `markWorkflowWaiting()` 和 `markWorkflowRunning()` 必须保留 revision 并可审计。
- `applyTaskEvent()` 和 `applyWorkflowEvent()` 必须按 message id 幂等。
- `applyStepReduction()` 必须使用 revision 或等价机制防止并发覆盖。
- `recoverExpiredLeases(now)` 应找出 lease 过期且未完成的 task，允许 worker 重新派发或重试。
- 状态库里的记录应保留审计所需的时间、错误、runtime、sandbox、lease 和 human interaction 信息。

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
- Human task 等待时必须发布 `human.requested`、`task.waiting` 和 `workflow.waiting`，响应时必须发布 `human.responded`、`task.resumed` 和 `workflow.resumed`。
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
  +--> human interaction 状态
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
  +--> human.requested / human.responded
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
- Human Interaction 是产品层人工介入的事实源，UI 只提交 response，不直接修改 workflow state。
- sandbox 和 runtime 可以按租户、区域、能力或成本策略选择。

最小演进路径：

1. 使用默认 `createLoopApp()` 完成本地 workflow 验证。
2. 替换 `StateManager` 为数据库实现。
3. 替换 `Mailbox` 为可靠队列。
4. 启动多个 worker，共享同一个状态库和消息通道。
5. 替换 `SandboxManager` 为容器、远程执行服务或 Desktop bridge。
6. 将 Runtime Registry 扩展为租户级、区域级或能力感知的解析策略。
