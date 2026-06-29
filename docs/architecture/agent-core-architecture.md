# Agent Core 架构说明

本文说明 `@expertmesh/core` 的架构边界、模块分类、运行流程和未来分布式部署形态。

`@expertmesh/core` 是 ExpertMesh 的专家 Agent 执行核心。它不负责 HTTP API、数据库 Controller、Web UI 或 Desktop 权限界面，而是提供：

- 专家 Agent 的声明模型、创建入口和能力装配。
- Agent 上下文、工具、插件、子 Agent 和模型配置管理。
- Runtime Adapter 抽象，使 Agent 可以运行在不同执行环境中。
- Flow 编排能力，把 Agent、确定性任务或子 Flow 组织成可执行流程。
- Workflow、Task、Mailbox、Sandbox 等运行期协议边界。

Core 的定位是“可替换运行时 + 可治理编排协议”的中间层：

本文中的架构图、流程图、时序图统一使用 `text` 代码块和 ASCII/text 绘图，不使用 Mermaid、PlantUML、图片或外部绘图文件。

```text
+---------------------------+
| Server / Worker / Desktop |
+-------------+-------------+
              |
              v
+-------------+-------------+
|      @expertmesh/core      |
|                             |
|  - Agent 能力装配          |
|  - Runtime 执行适配        |
|  - Flow 编排               |
|  - Context / Tools         |
|  - Plugins / SubAgents     |
+-------------+-------------+
              |
              v
+-------------+-------------+
|     @expertmesh/shared     |
|  协议对象和状态模型        |
+---------------------------+
```

## 模块分类

Core 源码位于 `packages/core/src`。本文按职责分类说明模块，而不是按代码目录逐项展开。

### Agent 能力层

Agent 能力层负责把一个专家的身份、指令、上下文、工具、插件、子 Agent 和模型配置装配成标准 `ExpertAgent`。

```text
+-----------------------------+
| ExpertAgent.create(options) |
+--------------+--------------+
               |
               v
+--------------+--------------+
| Agent 创建期归一化           |
|                              |
|  +-- Plugin Loader           |
|  |   +-- MCP                 |
|  |   +-- Skills              |
|  |   +-- Models              |
|  |   +-- Tools               |
|  |   +-- Hooks               |
|  |                           |
|  +-- ContextManager          |
|  |   +-- ContextSystem       |
|  |                           |
|  +-- SubAgent Registry       |
|  +-- Managed Tools           |
+--------------+--------------+
               |
               v
+--------------+--------------+
|          ExpertAgent         |
+-----------------------------+
```

核心边界：

- `ExpertAgent.create()` 是标准创建入口。
- `defineAgent()` 和 `agent()` 只是声明语法糖，不应实现另一套 Agent 包装层。
- 插件、工具、上下文和子 Agent 都在 Agent 创建阶段归一化。
- Agent 不直接依赖具体模型 SDK、本地执行器、Server Controller 或 Web UI。

`ExpertAgent` 的主要能力包括：

- 构建运行上下文。
- 读写和搜索上下文。
- 创建默认上下文工具。
- 通过 Runtime Registry 创建运行会话。
- 作为 `Loop` 被组合 Flow 调用。

### Context 与工具层

Context 与工具层负责把长期知识、项目上下文和受控能力暴露给 Agent。

```text
+-----------------------------+
|        ContextSystem        |
+--------------+--------------+
               |
               +-- namespace: host
               |   +-- ContextStore
               |
               +-- namespace: plugin-a
               |   +-- ContextStore
               |
               +-- namespace: plugin-b
                   +-- ContextStore

+-----------------------------+
|        Context Tools        |
+--------------+--------------+
               |
               +-- list_expert_context
               +-- read_expert_context
               +-- search_expert_context
               +-- add / update / delete context
```

核心边界：

- 上下文通过 namespace 隔离来源。
- 上下文不会一次性塞进 Runtime，而是由 Agent 或工具按需读取。
- Tool approval 是工具能力的一部分，但最终权限仍应由 Runtime、Desktop 权限闸门或上层策略共同裁决。
- `packages/shared` 只保存跨端协议和值对象，不放 Node 专属上下文实现。

### Runtime 执行层

Runtime 执行层负责屏蔽具体执行环境。Agent 只知道如何创建会话和提交任务，不知道底层是 PI agent SDK、云端沙箱、本地 Desktop 桥接，还是自托管执行器。

```text
+-------------+       createSession({ runtime, runtimes })
| ExpertAgent |-------------------------------------------+
+-------------+                                           |
                                                            v
                                                   +--------+---------+
                                                   | RuntimeRegistry |
                                                   +--------+---------+
                                                            |
                                                            | resolve(runtimeId)
                                                            v
                                                   +--------+---------+
                                                   | RuntimeAdapter  |
                                                   +--------+---------+
                                                            |
                                                            | createSession()
                                                            v
                                                   +--------+---------+
                                                   | RuntimeAgent    |
                                                   | Session         |
                                                   +--------+---------+
                                                            |
                                                            | submit({ query, output })
                                                            v
                                                   +--------+---------+
                                                   | RuntimeSubmit   |
                                                   | Handle          |
                                                   +--------+---------+
                                                            |
                                                            +-- events: AsyncIterable<RuntimeStreamEvent>
                                                            +-- result: Promise<RuntimeRunResult>
                                                            +-- cancel()
```

核心边界：

- `RuntimeAdapter` 是稳定扩展点。
- `RuntimeAgentSession` 表示一次 Agent 会话。
- `submit()` 同时返回流式事件和最终结构化结果。
- `cloud-pi-agent` 是当前默认 Runtime 实现，不是 Core 的唯一假设。
- 未来 Runtime 可以接入云端容器沙箱、本地 Desktop Runtime、自托管 Runtime 或远程托管 Agent。

当前默认 Runtime：

```text
+-----------------------------+
|        cloud-pi-agent       |
+--------------+--------------+
               |
               +-- 转换 ExpertAgent 声明
               +-- 转换模型、工具、MCP、Skills、SubAgents
               +-- 管理 PI Runtime Session
               +-- 转换事件流和最终结果
```

### Flow 编排层

Flow 编排层负责把多个可执行单元组织成可执行流程。这里的可执行单元不只包括 Agent，也包括本地确定性任务、编译后的组合 Flow，以及任何实现 `Loop` 协议的对象。

这里有一个刻意的命名分层：

- `Loop` 是底层统一执行协议，表示“可以被运行”的最小接口。
- `defineFlow()` 是用户侧组合入口，返回 `FlowSpec` builder。
- `defineTask()` 把确定性 TypeScript handler 包装成一个 leaf `Loop`。
- 编译归一化默认发生在 `flow.use()` 和 `createLoopApp().run()` 边界，用户日常不需要显式调用 `compile()`。
- `CompiledLoop` 是内部执行形态，本身也是 `Loop`，所以组合 Flow 可以继续嵌套。

```text
+-----------------------------+
|            Loop             |
+--------------+--------------+
               |
               +-- ExpertAgent
               +-- Task Loop
               +-- CompiledLoop
               +-- 任何实现 Loop 接口的对象

+-----------------------------+
|          FlowSpec           |
+--------------+--------------+
               |
               +-- use(id, loop, options)
               +-- compose(builder)
               +-- compile()
                   for advanced validation / registration

+-----------------------------+
|         CompiledLoop        |
+--------------+--------------+
               |
               +-- steps
               +-- transitions
               +-- limits
               +-- result resolver
```

Flow 的关键设计是：步骤只持有 `Loop`，不再按 agent、task、subflow 建立不同分支。

```text
+-----------------------------+
|     LoopStepDefinition      |
+--------------+--------------+
               |
               +-- id
               +-- loop
               +-- input resolver
               +-- output schema
               +-- reduce
               +-- sandbox request
               +-- runtime override
```

核心边界：

- `Loop` 是统一执行接口。
- `ExpertAgent` 本身实现 `Loop`。
- `defineTask()` 把确定性 TypeScript handler 包装为 `Loop`。
- `defineFlow()` 声明组合流程，`.compose()` 声明步骤之间的流转。
- `flow.use()` 可以接收 Agent、Task、CompiledLoop、子 Flow 或任何 `Loop` 实现。
- `createLoopApp().run()` 可以直接运行 Agent、Task、CompiledLoop 或 Flow。
- `CompiledLoop` 也实现 `Loop`，所以可以继续嵌套。
- `reduce()` 只做状态归并，不应执行外部副作用。

### 运行协调层

运行协调层是 Loop 执行时最重要的边界。它由 `TaskManager`、`StateManager`、`Mailbox`、`SandboxManager` 和 `LoopDefinitionStore` 协作完成。

```text
+-----------------------------+
|           LoopApp           |
+--------------+--------------+
               |
               +-- TaskManager
               |   +-- 分发 task
               |   +-- 获取 lease
               |   +-- 执行 step.loop.run()
               |   +-- 推进 transition
               |
               +-- StateManager
               |   +-- workflow / task 权威状态
               |   +-- LoopState
               |   +-- revision
               |   +-- 幂等事件应用
               |
               +-- Mailbox
               |   +-- command / event 发布订阅
               |   +-- consumer group
               |
               +-- SandboxManager
               |   +-- workflow sandbox
               |   +-- task sandbox
               |   +-- workspace capability
               |
               +-- LoopDefinitionStore
                   +-- workflowRunId 与 CompiledLoop 绑定
```

职责边界：

| 模块                  | 负责                                                | 不负责                        |
| --------------------- | --------------------------------------------------- | ----------------------------- |
| `TaskManager`         | 任务分发、租约、执行协调、transition 推进           | 保存权威状态、承载消息系统    |
| `StateManager`        | Workflow/Task 状态、`LoopState`、revision、幂等应用 | 执行 Agent、发布消息          |
| `Mailbox`             | command/event 发布订阅、消息过滤、通信协议承载      | 决定状态变化、执行任务        |
| `SandboxManager`      | sandbox 生命周期、workspace、capability             | 编排 transition、保存业务状态 |
| `LoopDefinitionStore` | 保存运行所需的已编译 Loop 定义                      | 执行步骤、修改状态            |

默认本地组装：

```text
+-----------------------------+
|       createLoopApp()       |
+--------------+--------------+
               |
               +-- InMemoryMailbox
               +-- InMemoryStateManager
               +-- InMemoryLoopDefinitionStore
               +-- LocalSandboxManager
               +-- LocalTaskManager
               +-- RuntimeRegistry
```

这个默认实现适合本地验证和单进程测试。生产或分布式部署时，应替换为持久化状态、可靠消息、远程沙箱和多 worker 任务执行。

## 运行流程

### Agent 会话流程

```text
Participants:
  Caller
  ExpertAgent
  RuntimeRegistry
  RuntimeAdapter
  RuntimeAgentSession
  Concrete Runtime

Sequence:
  Caller              -> ExpertAgent:         agent.createSession()
  ExpertAgent         -> RuntimeRegistry:     resolve(runtimeId)
  RuntimeRegistry     -> RuntimeAdapter:      return adapter
  ExpertAgent         -> RuntimeAdapter:      createSession(agent config)
  RuntimeAdapter      -> RuntimeAgentSession: create session
  Caller              -> RuntimeAgentSession: submit(query, output schema)
  RuntimeAgentSession -> Concrete Runtime:    execute
  Concrete Runtime    -> Caller:              stream events
  Concrete Runtime    -> Caller:              final result
```

Agent 会话是 Runtime 层概念。它适合单个专家任务，也可以由 Flow 的某个 step 间接触发。

### Loop 执行流程

```text
+-----------------------------+
| LoopApp.run(loop, request) |
+--------------+--------------+
               |
               v
+--------------+--------------+
| compileLoop()               |
+--------------+--------------+
               |
               v
+--------------+--------------+
| createWorkflowSandbox()     |
+--------------+--------------+
               |
               v
+--------------+--------------+
| createWorkflowRun()         |
+--------------+--------------+
               |
               v
+--------------+--------------+
| publish(workflow.started)   |
+--------------+--------------+
               |
               v
+--------------+--------------+
| dispatchReadyTasks()        |
+--------------+--------------+
               |
               v
+--------------+--------------+
| createTaskRun()             |
+--------------+--------------+
               |
               v
+--------------+--------------+
| publish(task.dispatch)      |
+--------------+--------------+
               |
               v
+--------------+--------------+
| leaseTask()                 |
+--------------+--------------+
               |
               v
+--------------+--------------+
| resolveTaskSandbox()        |
+--------------+--------------+
               |
               v
+--------------+--------------+
| step.loop.run()             |
|                             |
|  +-- Agent Runtime Session  |
|  +-- Task handler           |
|  +-- nested CompiledLoop    |
+--------------+--------------+
               |
               v
+--------------+--------------+
| markTaskSucceeded()         |
| or markTaskFailed()         |
+--------------+--------------+
               |
               v
+--------------+--------------+
| publish(task completed      |
| or task failed)             |
+--------------+--------------+
               |
               v
+--------------+--------------+
| applyTaskEvent()            |
+--------------+--------------+
               |
               v
+--------------+--------------+
| applyStepReduction()        |
+--------------+--------------+
               |
               v
+--------------+--------------+
| next step                   |
| or workflow completed       |
+-----------------------------+
```

这个流程中，`TaskManager` 可以被替换为远程 worker 调度器，`StateManager` 可以被替换为数据库实现，`Mailbox` 可以被替换为队列或事件总线，`SandboxManager` 可以被替换为容器、VM、Kubernetes Job 或 Desktop 本地工作区。

## 状态模型

Loop 运行状态来自 `@expertmesh/shared`，Core 只通过接口读写。

```text
+-----------------------------+
|      WorkflowRunRecord      |
+--------------+--------------+
               |
               +-- id
               +-- loopId
               +-- status
               +-- currentStepIds
               +-- completedStepIds
               +-- state: LoopState
               +-- defaultSandbox
               +-- revision

+-----------------------------+
|        TaskRunRecord        |
+--------------+--------------+
               |
               +-- id
               +-- workflowRunId
               +-- stepId
               +-- visit
               +-- status
               +-- input / output / error
               +-- runtimeId
               +-- sandbox
               +-- lease
```

状态推进原则：

- `StateManager` 是状态事实源。
- 所有 task 状态流转必须经过 `StateManager`。
- `revision` 用于防止并发覆盖。
- message id 用于幂等事件应用。
- `LoopState` 保存工作流输入、中间结果和步骤归并后的状态。

典型 task 状态流转：

```text
+---------+     +------------+     +--------+     +---------+
| pending | --> | dispatched | --> | leased | --> | running |
+---------+     +------------+     +--------+     +----+----+
                                                        |
                                                        v
                                      +-----------------+-----------------+
                                      | succeeded / failed / cancelled    |
                                      +-----------------------------------+
```

典型 workflow 状态流转：

```text
+---------+     +-----------------------------------+
| running | --> | succeeded / failed / cancelled    |
+---------+     +-----------------------------------+
```

## Sandbox 模型

Sandbox 是 Loop 执行时的工作区和能力边界。它不是固定实现，而是 `SandboxManager` 接口。

```text
+-----------------------------+
|        SandboxRequest       |
+--------------+--------------+
               |
               +-- strategy
               |   +-- reuse-workflow
               |   +-- ephemeral
               |   +-- reuse-step
               |   +-- attach
               |
               +-- workspace
               |   +-- root
               |   +-- access
               |
               +-- capabilities
                   +-- filesystem
                   +-- shell
                   +-- network
                   +-- humanApproval
```

当前默认 `LocalSandboxManager` 使用本机 workspace，不提供强安全隔离。它用于开发、测试和本地单进程运行。未来生产环境应根据部署形态替换为：

- 容器沙箱。
- VM / Firecracker 沙箱。
- Kubernetes Job / Pod 沙箱。
- 远程执行服务。
- Desktop 本地授权工作区。

Sandbox 边界不应绕过 Tool approval、Runtime permission 或 Desktop 本地权限 UI。它只负责运行环境的资源边界，权限治理仍需要上层策略共同参与。

## 分布式部署形态

Core 当前默认本地实现可以平滑演进到分布式部署。推荐拆分如下：

```text
+-----------------------------+
|          API Server         |
|                             |
|  - 创建 workflow run        |
|  - 校验用户、租户、预算权限 |
|  - 写入 StateManager        |
|  - 发布 Mailbox command     |
+--------------+--------------+
               |
               v
+--------------+--------------+
|   Reliable Mailbox / Queue  |
+--------------+--------------+
               |
               v
+--------------+--------------+
|          Worker Pool        |
|                             |
|  - lease task               |
|  - resolve sandbox          |
|  - execute step.loop.run()  |
|  - stream progress          |
|  - publish completion event |
+--------------+--------------+
               |
               v
+--------------+--------------+
|          State Store        |
|                             |
|  - workflow/task state      |
|  - revision                 |
|  - idempotency              |
|  - audit trail              |
+-----------------------------+
```

可替换组件：

| 当前默认                      | 分布式替换方向                                                     |
| ----------------------------- | ------------------------------------------------------------------ |
| `InMemoryStateManager`        | PostgreSQL、CockroachDB、DynamoDB、FoundationDB 或其他事务性状态库 |
| `InMemoryMailbox`             | Redis Streams、SQS、Kafka、NATS、RabbitMQ 或内部事件总线           |
| `LocalTaskManager`            | 多 worker 调度器、远程执行 worker、Kubernetes worker               |
| `LocalSandboxManager`         | 容器、VM、Kubernetes、远程沙箱、Desktop bridge                     |
| `InMemoryLoopDefinitionStore` | 数据库、对象存储、版本化 workflow definition store                 |
| 默认 `RuntimeRegistry`        | 租户级、区域级或能力感知 Runtime Registry                          |

分布式实现必须保留以下语义：

- task lease 必须可续租、可过期恢复。
- task completion / failure / cancellation 必须幂等。
- workflow state update 必须有并发保护。
- message delivery 可以至少一次，但状态应用必须防重复。
- sandbox cleanup 必须可重试。
- Runtime event stream 不应成为状态事实源，最终状态仍以 `StateManager` 为准。

## 本地 Desktop Runtime 方向

未来本地 Agent 通过 Desktop App 接入云端，不新增 `apps/local-runner`。

```text
+-----------------------------+
|    Cloud Server / Worker    |
+--------------+--------------+
               |
               v
+--------------+--------------+
|        Runtime Gateway      |
+--------------+--------------+
               |
               v
+--------------+--------------+
|        双向安全连接         |
+--------------+--------------+
               |
               v
+--------------+--------------+
|         Desktop App         |
|                             |
|  +-- Local Permission Guard |
|  +-- Local Sandbox          |
|  |   / Workspace            |
|  +-- Local Agent Adapter    |
|      +-- Claude Code        |
|      +-- Codex              |
|      +-- 自研本地 Agent     |
+-----------------------------+
```

Core 中应承载桥接协议、消息类型和 Runtime Adapter 合约；Desktop App 承载登录、设备绑定、本地工作区选择和用户确认 UI；Server/Worker 承载调度、审计、预算和治理。

## 设计约束

- Core 可以依赖 `@expertmesh/shared`，不依赖 `@expertmesh/client`、Web UI 或 Server 应用层。
- Server/Worker 可以调度 Core，Core 不反向调用 Server Controller。
- Agent 执行能力优先加到 `ExpertAgent` 和 Runtime Adapter 边界，不只放在某个 SDK 包装层里。
- Runtime 实现可以替换，但必须把事件、结果、取消和错误转换成 Core 统一协议。
- Loop 运行期组件可以替换，但必须保留 `TaskManager`、`StateManager`、`Mailbox`、`SandboxManager` 的职责边界。
- 文档和实现冲突时，以更接近当前代码的具体文档为准，并同步修正另一处。
