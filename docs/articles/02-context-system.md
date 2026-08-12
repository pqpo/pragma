# 上下文工程不只是拼 Prompt：Pragma ContextSystem 的设计

> 《构建跨 Harness 的多 Agent 系统：Pragma 技术实践》第二篇

在很多 Agent 项目中，上下文工程最终会变成一个越来越长的 Prompt 拼接函数：系统指令、用户偏好、项目文档、历史消息、检索结果和临时状态全部塞进同一个字符串，然后期待模型自己找出重点。

这种做法在 Demo 阶段很直接，但很难长期演进。随着上下文来源增多，系统会逐渐失去三个基本答案：内容从哪里来，为什么在这次运行中被加载，以及当前 Agent 是否有权读取或修改它。

Pragma 的 `ContextSystem` 试图把上下文从“Prompt 的一部分”提升为一个独立的运行子系统。

## 上下文不是一个字符串，而是一组受治理的来源

Pragma 把上下文来源抽象为 `ContextStore`。当前统一合约只有六种操作：

```text
listContext
readContext
searchContext
addContext
editContext
deleteContext
```

这看起来像一个很普通的内容存储接口，但关键在于它不规定底层实现。In-memory、JSON、文件系统、静态文档、Mission Board 和 Memory 都可以通过相同合约接入。

Core 只认识 Context 语义，不认识数据库、向量库或 Desktop 文件目录。Host 决定某个 namespace 最终绑定哪个 Store，以及它是否必需、是否可写、是否允许修改 `always_on` 内容、是否承担大输出的 overflow target。

一个 Expert 最终看到的上下文可以来自多个命名空间：

```text
project/*                项目知识
mission-board/*          Mission 共享白板
mission-board-private/*  当前 Runtime Context 私有记录
memory/*                 只读长期记忆
team/*                   当前 ExpertTeam 的临时关键指令
```

命名空间解决来源冲突，Binding 解决环境差异，运行时 scope 则决定当前调用是否有权访问具体内容。

## Prompt Assembly 应该是选择过程

ContextSystem 不会把所有 Store 的正文都拼进系统 Prompt。它先构建 Context Index，再根据元数据和加载规则选择不同层次的内容。

Pragma 使用三种主要触发语义：

- `always_on`：短小、稳定、每次都必须读取的关键指令；
- `model_decision`：进入启动索引，由模型判断是否继续读取正文；
- `manual`：默认不注入，只有在 list、search 或明确读取时才加载。

这构成了一种渐进披露机制：

```text
有限的 always-on 指令
        ↓
上下文摘要和索引
        ↓
模型按任务搜索或读取
        ↓
精确正文与证据
```

渐进披露不只是节省 Token。它还降低了无关信息对推理的干扰，并让“为什么加载某条内容”变得可解释。系统可以记录哪些条目被 preload、哪些被排除、哪些由 Agent 主动检索，而不是面对一个无法拆解的巨型 Prompt。

## 元数据是上下文治理的一部分

上下文条目除了正文，还需要描述它如何被使用。Pragma 的 Context 元数据包括触发策略、优先级、信任等级、敏感度以及修订信息。

这些字段分别回答：

- 它应该自动加载还是按需发现？
- 当预算不足时，哪些内容更重要？
- 内容来自系统、用户还是外部来源？
- 它能否进入共享上下文、Memory 或导出物？
- 修改时应该基于哪个 revision 或 etag？

ContextSystem 不应该代替具体 Host 做所有权限判断，但它必须携带足够的语义，让 Host 能够执行权限、审批和冲突控制。

尤其是写操作，不能退化成“模型想改就改”。对于重要 Store，修改需要基于已读取的 revision 或 etag，冲突后重新读取并合并。提升为 `always_on` 的内容会影响之后每一次运行，因此 Mission Board 等 Binding 会要求显式人工批准。

## Context 与 Runtime Session 不是一回事

上下文设计中另一个常见误区，是把“复用上下文”理解为“复制历史消息”。Pragma 把几种状态严格分开：

- `RuntimeContextRecord`：某个 Expert 在某个 Runtime 中的连续会话身份与 snapshot；
- ContextStore：Host 管理、可检索和可治理的知识或任务内容；
- Invocation input/output：本次调用显式传递的数据；
- Runtime message history：具体 Harness 的对话连续性。

是否复用 Runtime Context，只由最终解析出的 `contextId` 决定。复用 Context 可以延续某个 Agent 线程，但流程真正需要交付给后续节点的数据，仍应通过 Flow state、Invocation output 或 ContextStore 明确传递。

否则系统会依赖“模型大概还记得上一次对话”，既无法验证，也难以跨 Harness 交接。

## 大输出不应该淹没调用链

子 Agent 或 Flow step 可能产生很大的报告、代码分析或测试结果。如果把全部正文塞回父 Agent，调用树越深，上下文越容易爆炸。

Pragma 的 Invocation output 可以是两种形式：

```text
inline   有界的小结果
context  指向 ContextStore 条目的受控引用
```

超过阈值的输出由 Core 交给 Host 注入的唯一 overflow target。Desktop 使用 Mission Board 的 `system/outputs/` 保存这些结果，父 Agent 只接收有界摘要和引用，需要时再精确读取。

这让大输出在应用重启和后续 Session 中仍然存在，同时避免 Core 依赖某种物理文件布局。

## 为什么不自动做隐藏检索

ContextSystem 也影响 Pragma 的 Memory 召回设计。Host 不会偷偷从用户 Prompt 派生 query、检索几条记忆并自动注入。Agent 先看到有界 overview，需要时调用通用的 list、search、read 逐层深入。

这种设计牺牲了一部分“开箱即用的自动感”，换来的是可解释性：Agent 知道自己搜索了什么、读到了什么；Host 只负责权限、预算和审计，不成为第二个隐藏的召回决策者。

如果未来接入向量检索，它也应该实现为 ContextStore 的内部检索能力，而不是绕过 ContextSystem 创建另一套不可观察的 Prompt 注入通道。

## ContextSystem 的边界

ContextSystem 解决的是上下文的装配、发现、访问和修改协议，但它不拥有所有业务语义：

- Mission Board 决定一项 Mission 内如何共享白板；
- Memory 决定执行证据如何提炼为长期记忆；
- Flow state 决定确定性流程数据如何传递；
- Runtime Adapter 决定原生会话如何保存和压缩；
- Host 决定 Binding、权限和物理持久化。

保持这些边界很重要。把计划、记忆、聊天历史和流程状态都塞进 ContextSystem，会让它重新变成另一个无边界的“万能上下文管理器”。

## 结语

真正的上下文工程，不是找到一个更聪明的 Prompt 拼接顺序，而是建立一套可回答以下问题的系统：

```text
内容来自哪里？
为什么本次加载？
谁可以读取或修改？
如何控制长度？
如何跨 Session 和 Harness 继续使用？
如何在冲突和版本变化时保持正确？
```

ContextSystem 提供了这套底层语言。下一篇会在它之上讨论一个更具体的协作问题：多个 Expert 在同一项 Mission 中，如何共享计划、决策、进度和产物，而不复制彼此的全部对话。

## 延伸阅读

- [Context 使用指南](../usage/context.md)
- [Agent Core 架构](../architecture/agent-core-architecture.md)
- [Mission Board ADR](../adr/037-mission-board-context-store.md)
