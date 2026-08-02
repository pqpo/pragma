# Examples 源码索引

示例按能力边界组织。每个入口直接展示关键装配步骤，不通过辅助层隐藏 Expert、Session 或
Flow 的公共 API。

## Expert、Subagent 与团队

- `experts/getting-started/console-chat.ts`：单 Expert 全屏 TUI、多轮消息、流式 Thinking/Tool、
  `askUserQuestion` 与 Usage。
- `experts/conversations/single-multi.ts`：单 Expert 的单轮和多轮执行。
- `experts/conversations/resume.ts`：恢复 `ExpertSession` 后继续提交 prompt。
- `experts/conversations/queue-steer.ts`：持久化 prompt queue 与 steer。
- `experts/subagents/delegation.ts`：交互式 Main Agent 根据注入 delegation tool 的 Expert
  description，按需委派负责代码探索的 Research Agent；TUI 默认聚焦 Main，并可切换查看 Research
  独立的思考和工具流。
- `experts/teams/delegation.ts`：交互式工程评审 Team，由 Lead 根据 description 按需委派实现研究、
  架构审查和测试分析成员，并综合团队结论；TUI 默认聚焦 Lead，同时显示成员状态，并允许切换查看
  每个 Agent 独立的思考、工具和回答流。
- `experts/teams/invocation-tree.ts`：读取团队 InvocationTree。

Getting Started 与两个 delegation 入口共用 Expert TUI 的事件和 Human-in-the-loop 处理。
多 Agent 模式在顶部成员栏展示各 Agent 状态，`Tab` / `Shift+Tab` 或
`F1` - `F4` 切换成员，`Esc` 返回 Main Agent / Lead，`PgUp` / `PgDn` 滚动当前日志。所有 TUI
都会按 Agent 隔离并解析思考、工具调用、工具输出、进度和回答；`askUserQuestion` 触发的
`human.requested` 会进入 TUI 答题模式，并通过 `respondToHumanInteraction()` 将答案交还当前 Turn。

## Capabilities

- `capabilities/context.ts`：Context preload、检索、CRUD 与角色授权；无需模型配置。
- `capabilities/mcp.ts`：in-process MCP Server、工具白名单和资源释放。
- `capabilities/skills.ts`：本地 `SKILL.md` 装配。
- `capabilities/plugin.ts`：Plugin 配置、Context、Tool 与生命周期 Hooks。
- `capabilities/tool-approval.ts`：Plugin 审批策略与 `ExpertTurn` 人工响应。

## Interpreter bundle

- `bundles/export-load.ts`：导出包含 Skill、MCP、Markdown 知识库的 Expert，随后从 `.pragma`
  文件加载、绑定目标 Host 的 Runtime/MCP，并编译恢复 Expert。
- `../projects/bundle-transfer/`：示例使用的 portable DSL 与随 bundle 传输的资产。

对应的教学资产位于：

- `../plugins/learning-plugin/`：贡献 Context、Tool 和 Hooks 的完整 Plugin。
- `../plugins/tool-approval-policy/`：为宿主 Tool 追加审批策略的 Plugin。
- `../skills/code-review/SKILL.md`：本地代码审查 Skill。

## Runtime

- `runtimes/codex/console-chat.ts`：Codex CLI Runtime 的单 Expert 全屏 TUI。
- `runtimes/claude-code/console-chat.ts`：Claude Code CLI Runtime 的单 Expert 全屏 TUI。
- `runtimes/shared/console-runtime-chat.ts`：两个本地 Runtime 共用的探测、模型选择与 TUI 流程。

## Flow

- `flows/basic.ts`：内联 Task 与 `compose()`。
- `flows/experts.ts`：Flow 调用 Expert 和 ExpertTeam。
- `flows/human.ts`：HumanTask 响应。
- `flows/recovery.ts`：打开并观察既有 Flow Execution。
- `flows/invocation-tree.ts`：Flow InvocationTree 与输出流。
- `flows/product-requirement-review.ts`：包含 Task、Expert、ExpertTeam、HumanTask 和条件回边的
  产品需求评审 Flow；`revise` 会携带人工修订信息重新进入跨职能评审，只有 `approve` 与
  `reject` 会结束 Flow。全屏 TUI 展示节点状态、输入输出、Agent 思考与工具流，并接收人工决策。

## 示例支撑

- `support/example-kit.ts`：示例共用的 Expert、Runtime Registry 和 Pragma App 装配。
- `console/execution-output-accumulator.ts`：统一把 Runtime 输出解析成 Answer、Thinking、Tool、
  Tool output 和 Progress 活动，处理完成消息回退、结构化 Tool delta 与累积快照去重。
- `console/human-interaction-parser.ts`：统一校验 `human.requested`，解析单选、多选、文本和审批输入，
  并构造类型安全的 Human response。
- `console/human-interaction-controller.ts`：管理多问题、多个等待交互、选项状态和已完成响应。
- `console/expert-console-tui.ts`：单 Expert 与多 Expert 共用的状态、Turn 生命周期和全屏 TUI。
- `console/flow-console-tui.ts`：可复用的 Flow 节点图、详情面板、Team 子树和 Human-in-the-loop
  全屏控制台；与 Expert TUI 共用上述输出和人工交互协议层。
