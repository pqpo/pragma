# 专家团如何共享上下文：Mission Board 的白板协作模型

> 《构建跨 Harness 的多 Agent 系统：Pragma 技术实践》第三篇

多个 Agent 一起工作时，最直接的共享上下文方案是把所有对话历史复制给每个 Agent。但这样很快会遇到问题：上下文越来越长，不同 Agent 的内部思考互相污染，私有信息扩大可见范围，而且没人知道当前计划、最终决策和最新产物究竟藏在哪一段对话中。

人类团队不会要求每位成员阅读所有人的完整聊天记录。更有效的协作方式通常是共享一块结构化白板：当前目标、计划、任务、进度、关键决策、产物位置以及交接说明都放在明确的位置。

Pragma 的 Mission Board 就是这样一块面向 Agent 的持久白板。

## Mission 是协作边界

Mission 表示一项持续推进的工作，而不只是一次模型调用。同一项 Mission 可以经历多次用户输入、多个 ExpertSession、一个或多个 Execution，也可以在不同 Harness 之间交接。

Mission Board 以 `ownerId` 绑定这项 Mission，并向 ContextSystem 注册两个命名空间：

```text
mission-board          Mission 内共享
mission-board-private  当前 Runtime Context 私有
```

共享白板中的内容可以被这项 Mission 的多个 Expert 读取；私有白板则根据可信的 `contextId` 路由到独立 Store。没有 Runtime Context 身份的调用无法访问私有内容。

这比“所有 Agent 共享一个文件夹”多了一层重要语义：共享不是存储路径带来的偶然结果，而是 Mission scope 明确授权的结果。

## 白板只有通用条目，没有专用状态对象

Mission Board 没有为 plan、TODO、decision 和 handoff 各造一个领域模型。它们只是普通 Context 条目的约定路径：

```text
plan.md
todos.md
progress.md
decisions.md
handoffs/<topic>.md
system/outputs/<...>
```

这种设计看似朴素，却避免了一个常见陷阱：当系统为每种协作内容都增加专用 Tool、Schema 和状态机后，Agent 必须理解越来越多的管理 API，Host 也需要维护多套重复的版本与权限逻辑。

Mission Board 复用 ContextStore 的 list、read、search、add、edit、delete 六种操作。路径表达使用习惯，而不是创造新的存储权威。

例如：

- `plan.md` 保存当前阶段和下一步，不保存详细历史；
- `progress.md` 保存跨重启仍然有用的检查点；
- `decisions.md` 保存已经确认的决定和原因；
- `handoffs/` 保存另一个 Expert 继续工作所需的最小上下文；
- `system/outputs/` 保存 Runtime 托管的大 Invocation 输出。

这些文件都可以按任务需要创建，不要求每项 Mission 机械生成一整套模板。

## 共享白板不是共享全部思考

Mission Board 明确区分共享和私有内容。

Agent 可以在 `mission-board-private` 中保存只属于当前 Runtime Context 的草稿或临时判断。它们不会因为同属一个 Mission 就自动暴露给其他 Expert，也不能未经明确决定被复制到共享 handoff、Memory 或导出物。

只有真正需要协作的信息才进入 `mission-board`：

- 已确认的需求和决策；
- 后续角色必须知道的约束；
- 当前计划与任务状态；
- 产物的受控引用；
- 可供下一个 Expert 接手的交接摘要。

这种设计把“Agent 的内部工作空间”和“团队的公共工作空间”分开，减少了上下文污染，也为敏感信息提供了更清晰的可见性边界。

## 用加载策略控制白板噪声

如果白板上的每个条目都在每轮预加载，最终仍会回到巨型 Prompt。Mission Board 因此沿用 ContextSystem 的渐进披露策略：

- 新条目默认是 `manual`，需要 list、search 或精确读取；
- 简洁的当前计划、进度摘要或 handoff 可以使用 `model_decision`；
- 只有短小、稳定、每个 Expert 都必须遵守的指令才适合 `always_on`。

详细报告、评审证据、历史过程和大输出应保持 `manual`。将内容提升为 `always_on` 会影响所有后续 Expert，因此需要显式人工批准。

Mission Board 还内置一个只读的 `GUIDE.md`，向 Agent 解释这些约定。Guide 是 critical、always-on 的系统内容，但业务白板仍按需加载。

## 乐观并发，而不是最后写入者获胜

多个 Expert 可能同时修改 `todos.md` 或 `progress.md`。如果简单覆盖文件，较慢的 Agent 会悄悄抹掉另一个 Agent 已经提交的更新。

Mission Board 要求编辑前先读取条目，并在写入时携带预期 revision 或 etag。发生冲突后，Agent 应读取最新版本、合并变化并重试。

这个机制不会自动解决语义冲突，但至少能防止无声覆盖。真正的冲突会被暴露为需要处理的状态，而不是伪装成一次成功写入。

同时，Board 会观察 add、edit、delete 操作并发布带版本的 mutation event。Host 可以据此更新 UI、形成审计，或者把适合的共享变化发布为 Memory Evidence。

## 文件产物只保存引用

Mission Board 不复制 Workspace 文件。一个 Expert 生成设计稿、代码或报告后，只在白板中记录受控的相对路径，让后续 Expert 到授权 Workspace 中读取。

这避免了两套文件权威：

```text
Workspace 负责真实文件
Mission Board 负责协作引用和说明
```

同样，大型 Invocation 输出由 Host 写入 `system/outputs/`，调用方只拿到摘要和 Context 引用。Board 是跨 Session 可用的交接面，但不是任意二进制 Artifact 仓库。

## Mission Board 与 Memory 的区别

Mission Board 和 Memory 都能保存跨轮次信息，但生命周期和权威完全不同。

| 维度   | Mission Board           | Memory                   |
| ------ | ----------------------- | ------------------------ |
| 范围   | 当前 Mission            | 跨 Mission               |
| 目标   | 协作和交接              | 长期经验与事实           |
| 写入者 | Agent 或用户直接维护    | Module 从 Evidence 提炼  |
| 时效   | 当前任务状态            | 可长期治理的记忆         |
| 召回   | 当前 Mission 内按需读取 | 联邦 Memory ContextStore |

Mission Board 的 mutation 可以成为 Evidence，但 Memory 的生成不能依赖 Agent 是否使用了白板。即使 Agent 从未写过 `plan.md`，Execution 的规范事件仍然应该进入 Memory Pipeline。

这种单向关系避免了把白板误当作记忆数据库，也避免 Memory 反过来直接修改当前任务的协作状态。

## 结语

多 Agent 协作的关键不是让每个 Agent 知道所有事情，而是让正确的信息在正确的协作边界中可见。

Mission Board 的核心价值可以概括为：

> 用一块 Mission-scoped、可检索、可并发控制、区分共享与私有范围的持久白板，替代完整对话历史的无限复制。

它解决了当前任务如何持续推进的问题，但任务结束后，哪些经验值得服务下一项 Mission，仍需要另一套证据和治理机制。下一篇将讨论 Pragma 的跨 Harness Memory Pipeline。

## 延伸阅读

- [Mission Board ADR](../adr/037-mission-board-context-store.md)
- [Context 使用指南](../usage/context.md)
- [Memory 使用指南](../usage/memory.md)
