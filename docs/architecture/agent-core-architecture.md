# Agent Core Architecture

Core 分为声明、执行、Runtime 和存储四个边界：

1. `defineExpert()` 与 `defineExpertTeam()` 产生不可变 Expert 定义；普通 Expert 可显式注入
   `createAgentLauncher().tool` 获得受控 subagent 能力。
2. ExpertSession 接收外部 prompt；FlowSpec 通过 `task()`、`humanTask()`、`use()`、`compose()` 编排。
3. ExpertTurn 与 FlowExecution 共享 ExecutionStore、InvocationTree 和单一 Canonical Event Log；Output 是可重建投影。
4. Runtime driver 明确拆分 create、restore、start turn、steer、cancel turn 和 close session。

Expert 不再包装成单节点 Flow。普通 Expert subagent 与 ExpertTeam 共用同一个 delegation
执行机制：`delegate_expert` 创建子 Invocation，并共享父 Execution 的事件、取消和 Usage 聚合。

两种声明方式只负责提供不同的治理配置：

- standalone Expert 的 launcher 显式列出它可调用的子专家；
- ExpertTeam 根据当前调用者和团队 allowlist 动态生成 launcher；团队运行时会覆盖成员自己的
  standalone launcher，防止绕过团队边界。

根 launcher 的 `maxConcurrency` 和 `maxDepth` 是整个委派树的执行预算。`fresh` Context 在子调用
结束后释放；`reuse` Context 由 ExpertSession 或 Flow Execution 的 owner 负责持久化。

## 下一步重构方向：统一 Invocation Application Service

当前 Expert 的实际执行已经统一进入 `runExpertInvocation()`，普通 Expert subagent 与
ExpertTeam 成员也已经共用 delegation 机制。尚未完全收敛的是 Invocation 的创建和状态推进：

| 场景                 | Invocation 创建入口            | 特有语义                                       |
| -------------------- | ------------------------------ | ---------------------------------------------- |
| Flow Expert 节点     | `findOrCreateStepInvocation()` | `nodeId` 恢复幂等、reduce、route 和 transition |
| 普通 Expert subagent | `delegate()`                   | launcher 目标、Context、并发和深度             |
| ExpertTeam 成员      | `delegate()`                   | 团队 allowlist、Context、并发和深度            |

ExpertTeam 不是第三套执行机制。作为 Flow 节点时，团队根 Invocation 由 Flow 创建；作为
ExpertSession 根时，团队根 Invocation 由 ExpertSession 创建；团队成员始终通过通用 delegation
创建子 Invocation。

下一步应从 Flow 和 delegation 中提取内部 `InvocationService`，统一承担：

- 原子创建或幂等查找 Invocation。
- 维护 `rootInvocationId`、`parentInvocationId`、`nodeId` 和 definition 引用。
- 推进 `queued`、`running`、`succeeded`、`failed`、`cancelled` 状态。
- 将 Invocation 变更和 Canonical Event 在同一次 `ExecutionStore.commit()` 中提交。
- 为取消、恢复、Usage 聚合和 InvocationTree 提供一致不变量。

调用方仍保留自己的策略：

- Flow Scheduler 负责静态图遍历、`nodeId` 幂等、reduce 和 transition。
- Expert Delegation 负责 standalone launcher 或 ExpertTeam allowlist 的目标解析，以及 Context、
  并发和深度治理。
- `runExpertInvocation()` 负责 Expert Runtime Session 和模型执行，不负责 Flow 图推进。

建议使用带来源判别的内部请求，避免用可选字段混合不同语义：

```ts
type InvocationOrigin =
  | {
      readonly kind: "flow-step";
      readonly parentInvocationId: string;
      readonly nodeId: string;
    }
  | {
      readonly kind: "expert-delegation";
      readonly parentInvocationId: string;
      readonly sourceExpertId: string;
      readonly governance: "standalone-launcher" | "expert-team";
    };
```

### Dispatcher 与 Mailbox 边界

当前 Core 是进程内同步执行：Invocation 可靠落盘后由调用方直接执行，不需要 Mailbox。旧
Directive/Workflow 架构中的通用 Mailbox、TaskManager 和旧工作流运行器抽象不应恢复。

未来 Server/Worker 或 Desktop Runtime Gateway 需要分布式派发时，应在 Invocation 原子进入
`queued` 状态之后增加窄接口 `InvocationDispatcher`：

```text
InvocationService.ensureQueued()
→ ExecutionStore 原子提交 Invocation + invocation.queued
→ InvocationDispatcher.dispatch()
→ Inline Executor 或 Queue/Worker
```

本地实现使用 `InlineInvocationDispatcher`；分布式实现可以使用具备 lease、ack、retry 和
consumer ownership 的 Queue Dispatcher。Canonical Event Log 记录已经发生的事实，Dispatcher
传递尚待执行的命令，两者不能合并成同一个抽象。

在真正出现跨进程执行入口前，不提前新增 Queue、Mailbox package 或空实现；先完成
`InvocationService` 提取，并用现有 Flow、普通 Expert subagent 和 ExpertTeam 测试验证行为等价。
