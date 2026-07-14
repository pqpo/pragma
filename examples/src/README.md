# Examples 源码索引

示例按能力边界组织。每个入口直接展示关键装配步骤，不通过辅助层隐藏 Expert、Session 或
Flow 的公共 API。

## Expert、Subagent 与团队

- `experts/getting-started/console-chat.ts`：最小控制台聊天、多轮消息与 Usage。
- `experts/conversations/single-multi.ts`：单 Expert 的单轮和多轮执行。
- `experts/conversations/resume.ts`：恢复 `ExpertSession` 后继续提交 prompt。
- `experts/conversations/queue-steer.ts`：持久化 prompt queue 与 steer。
- `experts/subagents/delegation.ts`：普通 Expert 注入 `createAgentLauncher().tool` 后按需委派子专家。
- `experts/teams/delegation.ts`：用 `defineExpertTeam()` 声明团队，由协调 Expert 按 allowlist 委派成员。
- `experts/teams/invocation-tree.ts`：读取团队 InvocationTree。

两个 delegation 入口支持 `--stream=main|all`；默认 `main` 只显示主 Agent，`all` 会按
`executorId` 标注并显示所有委派 Agent 的流式输出。

## Capabilities

- `capabilities/context.ts`：Context preload、检索、CRUD 与角色授权；无需模型配置。
- `capabilities/mcp.ts`：in-process MCP Server、工具白名单和资源释放。
- `capabilities/skills.ts`：本地 `SKILL.md` 装配。
- `capabilities/plugin.ts`：Plugin 配置、Context、Tool 与生命周期 Hooks。
- `capabilities/tool-approval.ts`：Plugin 审批策略与 `ExpertTurn` 人工响应。

对应的教学资产位于：

- `../plugins/learning-plugin/`：贡献 Context、Tool 和 Hooks 的完整 Plugin。
- `../plugins/tool-approval-policy/`：为宿主 Tool 追加审批策略的 Plugin。
- `../skills/code-review/SKILL.md`：本地代码审查 Skill。

## Runtime

- `runtimes/codex/console-chat.ts`：Codex CLI Runtime。
- `runtimes/claude-code/console-chat.ts`：Claude Code CLI Runtime。
- `runtimes/shared/console-runtime-chat.ts`：两个本地 Runtime 共用的控制台流程。

## Flow

- `flows/basic.ts`：内联 Task 与 `compose()`。
- `flows/experts.ts`：Flow 调用 Expert 和 ExpertTeam。
- `flows/human.ts`：HumanTask 响应。
- `flows/recovery.ts`：打开并观察既有 Flow Execution。
- `flows/invocation-tree.ts`：Flow InvocationTree 与输出流。

## 示例支撑

- `support/example-kit.ts`：示例共用的 Expert、Runtime Registry 和 Pragma App 装配。
