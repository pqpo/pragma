# Pragma Examples

示例按功能目录组织，每个文件聚焦验证一个能力。建议从 `experts/getting-started`
开始，再逐步阅读会话、团队和 Flow 示例。

## 1. Expert 入门：TUI 聊天

这个示例会创建一个最小 Expert 和一个 `ExpertSession`，然后在同一个 Session 中持续
接收控制台输入，因此 Expert 可以使用之前轮次的对话内容。全屏 TUI 会区分并流式展示
`Thinking`、工具调用、工具结果和最终回答；发生 `askUserQuestion` 时，底部输入区会切换成答题模式。

准备模型配置：

```bash
cp examples/.env.example examples/.env
```

编辑 `examples/.env` 后，从仓库根目录运行：

```bash
pnpm --filter @pragma/examples example:expert-chat
```

也可以直接指定源码入口：

```bash
pnpm --filter @pragma/examples dev src/experts/getting-started/console-chat.ts
```

输入 `/exit` 或按 `Ctrl+C` 结束聊天，使用 `PgUp` / `PgDn` 滚动历史输出。

### 如何验证

先做一个可人工判断的最小多轮测试：

```text
你 > 请记住验证码 7319，只回复“记住了”
你 > 我刚才给你的验证码是什么？
```

第二轮应回答 `7319`。这验证了：

1. `.env` 中的模型配置确实被 PI Runtime 使用；
2. prompt 确实提交给了 Expert；
3. 两轮输入属于控制台打印出的同一个 `ExpertSession`；
4. Runtime 保留并使用了同一会话的上下文。

再输入“现在几点？”，Expert 应调用 `get_current_time`，TUI 会依次展示工具调用参数、流式工具输出
和完成状态。输入下面的提示可验证 Human-in-the-loop：

```text
你 > 请先用 askUserQuestion 问我想聊哪个主题，再根据回答继续。
```

TUI 应显示结构化问题；单选题可输入编号或选项名，多选题使用逗号分隔，文本题直接输入内容。
回答会通过 `respondToHumanInteraction()` 交还正在等待的 Turn。

`Thinking` 只会在模型和提供商实际返回 reasoning delta 时出现；TUI 不会伪造思考内容。

实时输出只监听订阅后的未来增量，并在 Execution 结束后自动关闭：

```ts
activeTurn = await session.prompt(prompt);
await ui.followTurn(activeTurn);
```

需要读取既有对话时使用 Session 的 message history，而不是重放执行事件：

```ts
const histories = await session.getMessageHistory();
const events = await session.listEvents();
const sessionUsage = await session.getUsage();
```

Usage 随 Execution 持久化。`turn.usage` 读取单轮汇总，`session.getUsage()` 汇总 Session
内所有已完成 Turn；TUI 底部会显示最近完成 Turn 的 token Usage。

模型输出并非确定性结果；这个检查验证的是调用链与多轮上下文，不代表对任意事实问题的
答案都准确。业务准确性应为具体 Expert 准备固定输入、期望标准和自动化评测。

## 2. 本地 Runtime：Codex、Claude Code 与 Antigravity CLI TUI 聊天

三个示例分别验证已安装并已登录的 Codex CLI、Claude Code CLI 和 Antigravity CLI。启动后会依次：

1. 通过 Runtime 的 `canUse()` 检查 CLI 是否可用；
2. 通过 `listModels()` 探测当前环境支持的模型；
3. 让你输入编号选择模型，或直接回车沿用 CLI 默认模型；
4. 根据所选模型展示支持的思考深度，选择编号或回车沿用 CLI 默认深度；
5. 创建带测试用 In-memory Context Store 的 ExpertSession 并进入全屏流式 TUI。

```bash
pnpm --filter @pragma/examples example:runtime-codex
pnpm --filter @pragma/examples example:runtime-claude-code
pnpm --filter @pragma/examples example:runtime-antigravity
```

这些本地 Runtime 使用各自 CLI 已有的认证和模型配置，不读取 `PRAGMA_MODEL_*`。Antigravity 示例要求
`agy >= 1.1.11`，首次 OAuth 登录需先在外部终端运行交互式 `agy`；非标准安装可设置 `AGY_PATH`。
Context Store 同时准备了 `always_on`、`model_decision`、`manual` 三类内容。进入聊天后可依次输入：

```text
你 > always-on marker 是什么？
你 > 请加载 model-decision 测试上下文，告诉我 marker 和支持频道
你 > 请列出测试上下文，再读取验证码和发布代号，并说明信息来源
```

回答应分别包含 `AO-2048`、`MD-4096`、`7319` 和 `Aurora Finch`。`always_on` 内容会自动
预加载；后两类验证中，流式输出应出现 `list_expert_context` 或 `read_expert_context` 等
上下文工具调用。测试上下文只存在于当前 example 进程的内存中，不会写入 workspace。

三个 Runtime TUI 与 Getting Started 共用同一套交互层，也支持 `Thinking`、工具调用与工具输出增量、
`askUserQuestion`、`/exit`、`Ctrl+C` 和滚动历史。模型与思考深度仍在进入全屏 TUI 前选择。

## 3. Context、MCP、Skills、Plugin 与 Tool 审批

Context 示例不调用模型，可直接运行：

```bash
pnpm --filter @pragma/examples example:context
```

它使用 `FileSystemContextStore` 演示 preload、检索、CRUD 和基于
`ExpertAgentRunContext` 的 member/admin 授权。示例数据写入仓库根目录的
`workspace/context-example/`。

其余能力示例使用 `.env` 中的 PI Runtime 模型配置，并接受可选的命令行 prompt：

```bash
pnpm --filter @pragma/examples example:mcp
pnpm --filter @pragma/examples example:skills
pnpm --filter @pragma/examples example:plugin
pnpm --filter @pragma/examples example:tool-approval
```

- `example:mcp`：使用 in-process MCP Server，展示工具白名单、调用和 Session 关闭时的资源释放。
- `example:skills`：把 `skills/code-review/SKILL.md` 作为 local Skill 装配给 Expert。
- `example:plugin`：加载 `plugins/learning-plugin`，展示配置、Context、Tool 和 Hooks。
- `example:tool-approval`：由 `plugins/tool-approval-policy` 给宿主 Tool 添加 required 审批，
  再通过 `ExpertTurn.respondToHumanInteraction()` 批准或拒绝。

Tool 审批示例只演示当前进程中仍处于活动状态的 `ExpertTurn`。它没有沿用旧版跨进程
pending interaction 恢复语义；Session 恢复应使用当前 `app.experts.resumeSession()` API，
Flow 恢复应使用 `app.flows.recover()`。

## 4. 导出并加载 `.pragma` bundle

下面的示例不依赖 Desktop。它加载一个同时引用 Skill、MCP 和 Markdown 知识库的 Expert，
将根资源及其传递依赖导出为 `.pragma`，再直接通过 Interpreter 加载文件、检查环境需求、
绑定 Runtime/MCP，并编译恢复 Expert：

```bash
pnpm --filter @pragma/examples example:bundle
```

生成的文件位于 `workspace/bundle-example/portable-product-expert.pragma`。Skill 和知识库作为
portable project artifact 随 bundle 传输；MCP 与 Runtime 是目标 Host 的环境资产，通过
`bindEnvironment()` 返回的 immutable overlay 补齐，不会改写 bundle 内的 DSL。

## 源码目录

```text
src/
  bundles/              # `.pragma` 导出、加载、绑定与编译
  capabilities/         # Context、MCP、Skills、Plugin 与 Tool 审批
  experts/
    getting-started/
      console-chat.ts
    conversations/      # 单轮、多轮、恢复、queue 与 steer
    subagents/          # 普通 Expert 手动注入五个生命周期工具
    teams/              # defineExpertTeam、委派与 InvocationTree
  flows/                # Task、Expert、HumanTask、恢复与树
  runtimes/             # 不同 Runtime
    codex/
      console-chat.ts
    claude-code/
      console-chat.ts
  support/              # 示例共用装配

plugins/                 # 示例 Plugin 与 manifest
projects/                # Bundle 示例使用的 portable DSL、Skill 与知识库
skills/                  # 示例 SKILL.md
```

完整入口索引见 [`src/README.md`](./src/README.md)。

进阶示例均已按功能归档，可直接运行：

- `experts/conversations/single-multi.ts`：单专家单轮与多轮。
- `experts/conversations/resume.ts`：恢复 ExpertSession 后通过新 prompt 继续对话。
- `experts/conversations/queue-steer.ts`：持久化 prompt queue 与 steer。
- `experts/subagents/delegation.ts`：交互式 Main Agent 通过 `createAgentLauncher().tools`
  按需委派负责代码探索的 Research Agent。
- `experts/teams/delegation.ts`：交互式工程评审 Team，由 Lead 按需委派实现研究、架构审查和
  测试分析三个成员。
- `experts/teams/invocation-tree.ts`：读取团队 InvocationTree 与成员节点。
- `flows/basic.ts`：内联 Task 与 `compose()`。
- `flows/experts.ts`：Flow 调用 Expert 和 ExpertTeam。
- `flows/human.ts`：HumanTask 响应。
- `flows/recovery.ts`：`flows.open()` 只读观察执行状态。
- `flows/invocation-tree.ts`：Flow InvocationTree 与总输出流。
- `flows/product-requirement-review.ts`：复杂产品需求评审 Flow，串联普通 Task、单 Expert、
  ExpertTeam、HumanTask 和三路决策分支；`revise` 会回到 ExpertTeam 重新评审，只有
  `approve` 与 `reject` 是终点。示例使用全屏 Flow TUI 展示完整执行过程。

例如：

```bash
pnpm --filter @pragma/examples dev src/experts/conversations/single-multi.ts
```

Subagent 与专家团委派示例也提供了快捷命令：

```bash
pnpm --filter @pragma/examples example:expert-subagent
pnpm --filter @pragma/examples example:expert-team
```

复杂 Flow TUI 示例使用 `.env` 中的 PI Runtime 模型配置：

```bash
pnpm --filter @pragma/examples example:flow-tui
```

示例会直接执行一份“Execution replay and comparison”产品需求。左侧节点图展示 Task、Expert、
Team、Human review gate 和最终分支；右侧可切换查看所选节点的 Activity、Input 与 Output。
Team 节点可展开查看 coordinator 和各成员自己的 Thinking、Tool 与回答。评审门禁中选择
`approve`、`revise` 或 `reject`，再输入评审意见。`revise` 会把修订意见与上一次团队评审作为
新输入送回跨职能团队，并再次进入人工门禁；明确选择 `approve` 或 `reject` 后 Flow 才会结束。
该 Team step 设置了具名 `ContextIdResolver`：首次评审返回 Core 提供的新 ID，存在修订请求时选择
上一轮兼容 Context，因此 coordinator 会沿用上一轮 Runtime 对话。若省略 `contextId`，Core 的
`pragma.context.fresh@v1` 会让每轮使用独立 Context。Team member 仍由 delegation resolver 独立决定；
本例保持默认行为，所以每轮新 spawn 的 reviewer 使用新的 Agent Context。
发生回边后，TUI 右侧按 `Round 1`、`Round 2` 展示每次访问各自的 Activity、Input 与 Output。

- `↑` / `↓`：选择节点或 Team 成员。
- `←` / `→`：切换 Activity、Input、Output。
- `Enter`：展开或折叠 Team；Human 交互中用于提交选择。
- `PgUp` / `PgDn`：滚动当前详情。
- `q` 或 `Ctrl+C`：退出；执行中退出会先取消 Flow。

Thinking 只在 Runtime 实际发送 reasoning delta 时展示；示例不会伪造模型思考内容。

Subagent 示例也使用同一套多 Agent TUI。主视图默认只展示 Main Agent 与用户的对话，顶部同时
显示 Research Agent 的执行状态；切换到 Research 面板后，可以单独查看它的思考、代码搜索、
文件读取、工具输出和研究结论。可以输入：

```text
你 > 请查看 Pragma 的实现原理，并说明一次 Expert 调用是如何执行的。
```

Main Agent 的提示词没有写死 Research Agent id，也没有强制每轮委派。`createAgentLauncher()` 会把
可用 Expert 的 `id`、`name` 和 `description` 注入 `spawn_expert` 工具描述，模型据此判断何时
委派。Research Agent 的 description 明确覆盖架构分析、实现追踪和代码搜索，因此这类问题预期会
自动路由给它。简单对话则应由 Main Agent 自己回答。

Team 示例使用全屏 TUI。主视图默认只展示 Engineering Lead 与用户的对话，顶部成员栏同时显示
Implementation、Architecture 和 Tests 等成员的 `idle`、`working`、`done` 或 `failed` 状态。
Lead 会根据成员 description 选择一个或多个专家；面对跨实现、架构和质量的宽问题时，可以并发
委派互补的调查任务，再综合为团队结论。例如：

```text
你 > 请评审 Pragma 的 delegation 实现，说明当前调用链、架构风险和测试缺口，并给出改进优先级。
```

两个 TUI 都会按 Agent 隔离保存解析后的思考、工具调用、工具输出、状态和回答：

- `Tab` / `Shift+Tab`：依次切换 Agent。
- `F1` - `F4`：直接打开对应 Agent 面板；Subagent 示例使用 `F1` / `F2`。
- `Esc`：回到 Main Agent 或 Lead 主流程。
- `PgUp` / `PgDn`：滚动当前面板。
- `Ctrl+C` 或输入 `/exit`：取消当前 Turn 并退出。

当 Main、Lead 或任一 Subagent 调用 `askUserQuestion` 时，TUI 会订阅对应的
`human.requested` 事件，把成员状态标记为 `input`，并在底部切换到答题模式。单选题可输入编号或
选项名称，多选题使用逗号分隔，文本题直接输入内容；包含多道题时会依次收集答案并通过
`respondToHumanInteraction()` 回传。需要审批的工具也可以在同一位置输入 `y` / `n` 响应。

所有外部 prompt 必须提交给 `ExpertSession`；Flow 只能通过 `app.flows` 启动、打开或恢复。
