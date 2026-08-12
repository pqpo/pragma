# 模型不是 Agent：如何构建跨 Harness 的统一 Runtime 层

> 《构建跨 Harness 的多 Agent 系统：Pragma 技术实践》第一篇

很多 AI 应用把“模型”视为最重要的运行时选择：给模型名称加一个下拉框，再把请求发给不同供应商，就完成了所谓的多模型架构。

这对普通聊天应用或许足够，但对 Agent 系统远远不够。

同一个模型运行在普通 API、Codex、Claude Code 或其他 Agent Harness 中，得到的不是同一种能力。模型只负责推理和生成，真正决定 Agent 能做什么的，是模型之外的整套执行环境：Agent Loop、工具系统、工作区访问、Session 管理、权限机制、上下文压缩、子 Agent 能力，以及取消和恢复协议。

因此，Pragma 没有把 Codex、Claude Code、PI、Qoder CLI 和 Antigravity CLI 当作五种“模型提供商”，而是把它们当作五种独立的 Runtime。

## Harness 才是完整的执行能力

可以把一个实际可工作的 Agent 粗略表示为：

```text
Agent 能力
= 模型
+ Agent Loop
+ Harness
+ Tools / MCP
+ Context 与 Session
+ 权限和沙箱
+ Streaming、取消与恢复
```

这解释了一个常见现象：即使底层使用相近的模型，不同 Coding Agent 在真实仓库任务中的表现仍可能明显不同。差异并不只来自 Prompt，也来自 Harness 如何搜索代码、调用工具、保留会话、处理失败以及约束权限。

如果编排系统只抽象模型 API，它最终会遇到两个问题：

1. 为了统一接口，不得不丢掉各 Harness 的原生能力；
2. 为了保留原生能力，又会让上层工作流直接依赖某个具体 Harness。

Pragma 的选择是统一运行语义，而不是强行统一所有实现细节。

## Core 定义语义，Adapter 处理方言

`@pragma/core` 只定义 Runtime 合约，不依赖任何具体 Runtime。每个 `@pragma/runtime-*` package 独立依赖 Core，并负责把供应商或 CLI 的协议映射到统一语义。

当前 Runtime Driver 覆盖的生命周期包括：

```text
canUse / listModels
        ↓
prepare
        ↓
createSession 或 restoreSession
        ↓
startTurn
        ↓
mapEvent / collectUsage
        ↓
steerTurn / cancelTurn
        ↓
checkpoint / compactContext
        ↓
closeSession
```

这里的关键不是方法数量，而是职责边界。

Core 负责：

- 什么时候创建或恢复 Runtime Session；
- Session 由哪个 ExpertSession 或 FlowExecution 拥有；
- 如何提交任务、取消、续写和关闭；
- 如何向 Execution 发送统一事件；
- 如何记录 Runtime Context 和 Usage。

具体 Adapter 负责：

- CLI 参数、SDK 调用和环境变量；
- 供应商原生 Session 的创建与恢复；
- 原生事件到统一事件的转换；
- 原生工具、MCP、Skill 和附件协议；
- 供应商特有的权限、压缩和用量字段。

这样，Core 不需要知道 Claude Code 的配置格式，也不需要知道 Codex 如何保存 Session；而 Adapter 不需要重新实现 Expert 编排、Invocation 状态机或持久化所有权。

## 归一化事件，而不是抹平能力

不同 Runtime 的事件模型差异很大。有的直接输出 token delta，有的输出结构化 message；有的暴露原生子 Agent，有的把工具调用混在消息流里；Usage、Thinking、Tool Result 和 Session ID 的表达也各不相同。

Pragma 把这些原生事件归一化为稳定的运行事件和消息，但不会假设所有 Runtime 都拥有相同能力。Runtime Descriptor 会显式声明：

- 是否支持 Streaming；
- 是否支持 MCP；
- 是否支持 Resume、Steer、Cancel 和 Close；
- 是否能检查或手动压缩 Context Window；
- 支持哪些执行位置和任务目标。

“不支持”必须表现为明确的 capability 或诊断，不能静默退化。否则上层 Flow 以为一次取消已经生效，底层进程却仍在运行；或者界面宣称可以恢复，实际上只是重新创建了一个全新会话。

这也是为什么 Pragma 为 Runtime 接入维护了证据清单：类型正确只能证明接口形状正确，不能证明真实 CLI 的加载顺序、事件、权限和资源释放符合预期。每项能力都需要实现、自动测试和真实 Runtime smoke 证据。

## 两层 Session 身份

跨 Harness 恢复最容易出错的地方，是把供应商 Session ID 当成系统唯一身份。

Pragma 区分两层身份：

```text
systemSessionId       Pragma 管理的稳定 Session 身份
RuntimeSessionRef     具体 Runtime 返回的原生会话引用
```

前者用于所有权、路径、恢复和审计，后者只用于让具体 Adapter 找回原生会话。每个 Runtime Session 必须由 ExpertSession Context 或 FlowExecution Invocation 明确拥有，并通过原子 claim 避免两个 owner 同时占有同一个系统会话。

因此，“进程退出”不等于“Session 被删除”，“拿到一个原生 Session ID”也不代表调用方有权恢复它。恢复时还必须核对 owner、Runtime、Context 和原始引用。

## 路由属于新的 Runtime Context

Pragma 支持在不同 Expert、Team 成员和 Flow step 上选择不同 Runtime。路由完成后，最终 `runtimeId` 被写入新的 `RuntimeContextRecord`，后续执行只读取这份不可变绑定。

这样做比每次调用时重新路由更可靠：

- 恢复不会因为默认 Runtime 改变而悄悄换 Harness；
- 同一 Execution 中不同 Expert 可以使用不同 Runtime；
- 历史运行能说明当时实际绑定了哪个环境；
- Context 是否复用，也不会与 Runtime 选择混为一谈。

可移植的 Expert 或 Flow 只声明语义需求和 RuntimeProfile 引用；真正的本机路径、凭据和安装状态由 Host Binding 解决。工作方式因此不会被某台机器上的 CLI 路径绑死。

## 统一不等于安全边界已经完成

Runtime Adapter 可以映射每个 Harness 自己的权限模式，但这不等于 Pragma 已经拥有跨 Runtime 的统一 Local Permission Guard。

截至当前实现，不同 Adapter 仍依赖各自的权限机制，Claude Code 也仍存在默认 `bypassPermissions` 的路径。Desktop 虽然已经管理工具权限策略和工作区选择，但覆盖文件、Shell、网络、Secret 与 Git 的统一本地闸门尚未闭合。

因此，Runtime 抽象解决的是“如何接入和治理不同 Harness 的运行语义”，安全闸门则是必须继续完成的 Host 边界。两者不能混为一谈，更不能因为 Adapter 有一个 permission 字段就宣称整个系统已经安全。

## 结语

跨 Harness 架构真正要保留的，不是某个 SDK 的共同子集，而是一个稳定的上层执行模型：Session 有明确所有者，能力可以被检查，事件可以被理解，任务可以取消和恢复，环境可以替换但语义不会漂移。

模型会快速迭代，Agent Harness 也会不断变化。Pragma 的 Runtime 层试图建立的是一条更长期的边界：

> 让工作方式依赖能力和协议，而不是依赖今天恰好最流行的某一个 Agent 产品。

下一篇将继续讨论 Runtime 之上的另一个核心问题：Agent 每次执行时，究竟应该获得哪些上下文。

## 延伸阅读

- [Agent Core 架构](../architecture/agent-core-architecture.md)
- [Runtime Adapter 接入清单](../conventions/runtime-adapter-integration-checklist.md)
- [当前架构概览](../architecture/current-architecture-overview.md)
