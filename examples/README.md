# Pragma Examples

示例按功能目录组织，每个文件聚焦验证一个能力。建议从 `experts/getting-started`
开始，再逐步阅读会话、团队和 Flow 示例。

## 1. Expert 入门：控制台聊天

这个示例会创建一个最小 Expert 和一个 `ExpertSession`，然后在同一个 Session 中持续
接收控制台输入，因此 Expert 可以使用之前轮次的对话内容。控制台会像 Codex CLI 一样
区分并流式展示 `Thinking`、工具调用、工具结果和最终 `Expert` 回答。

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

输入 `/exit` 或按 `Ctrl+C` 结束聊天。

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

再输入“现在几点？”，Expert 应调用 `get_current_time`，控制台会展示：

```text
• Running get_current_time
  ↳ {}
  ↳ 2026-07-12T10:00:00.000Z
  ✓ get_current_time completed
• Expert
...
```

`Thinking` 只会在模型和提供商实际返回 reasoning delta 时出现；renderer 不会伪造思考内容。

流事件只监听订阅后的未来事件，并在 Execution 结束后自动关闭：

```ts
for await (const event of turn.events()) {
  renderer.render(event);
}

const result = await turn.result;
const turnUsage = await turn.usage;
```

需要读取既有对话时使用 Session 的 message history，而不是重放执行事件：

```ts
const messages = await session.getMessageHistory();
const sessionUsage = await session.getUsage();
```

Usage 随 Execution 持久化。`turn.usage` 读取单轮汇总，`session.getUsage()` 汇总 Session
内所有已完成 Turn；三个控制台聊天示例会在输入 `/exit` 时打印 Session 总 Usage。

模型输出并非确定性结果；这个检查验证的是调用链与多轮上下文，不代表对任意事实问题的
答案都准确。业务准确性应为具体 Expert 准备固定输入、期望标准和自动化评测。

## 2. 本地 Runtime：Codex 与 Claude Code 控制台聊天

两个示例分别验证已安装并已登录的 Codex CLI 和 Claude Code CLI。启动后会依次：

1. 通过 Runtime 的 `canUse()` 检查 CLI 是否可用；
2. 通过 `listModels()` 探测当前环境支持的模型；
3. 让你输入编号选择模型，或直接回车沿用 CLI 默认模型；
4. 根据所选模型展示支持的思考深度，选择编号或回车沿用 CLI 默认深度；
5. 创建带测试用 In-memory Context Store 的 ExpertSession 并进入流式聊天。

```bash
pnpm --filter @pragma/examples example:runtime-codex
pnpm --filter @pragma/examples example:runtime-claude-code
```

这两个本地 Runtime 使用各自 CLI 已有的认证和模型配置，不读取 `PRAGMA_MODEL_*`。
Context Store 同时准备了 `always_on`、`model_decision`、`manual` 三类内容。进入聊天后可依次输入：

```text
你 > always-on marker 是什么？
你 > 请加载 model-decision 测试上下文，告诉我 marker 和支持频道
你 > 请列出测试上下文，再读取验证码和发布代号，并说明信息来源
```

回答应分别包含 `AO-2048`、`MD-4096`、`7319` 和 `Aurora Finch`。`always_on` 内容会自动
预加载；后两类验证中，流式输出应出现 `list_expert_context` 或 `read_expert_context` 等
上下文工具调用。测试上下文只存在于当前 example 进程的内存中，不会写入 workspace。

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

## 源码目录

```text
src/
  capabilities/         # Context、MCP、Skills、Plugin 与 Tool 审批
  experts/
    getting-started/
      console-chat.ts
    conversations/      # 单轮、多轮、恢复、queue 与 steer
    subagents/          # 普通 Expert 手动注入 delegate_expert
    teams/              # defineExpertTeam、委派与 InvocationTree
  flows/                # Task、Expert、HumanTask、恢复与树
  runtimes/             # 不同 Runtime
    codex/
      console-chat.ts
    claude-code/
      console-chat.ts
  support/              # 示例共用装配

plugins/                 # 示例 Plugin 与 manifest
skills/                  # 示例 SKILL.md
```

完整入口索引见 [`src/README.md`](./src/README.md)。

进阶示例均已按功能归档，可直接运行：

- `experts/conversations/single-multi.ts`：单专家单轮与多轮。
- `experts/conversations/resume.ts`：恢复 ExpertSession 后通过新 prompt 继续对话。
- `experts/conversations/queue-steer.ts`：持久化 prompt queue 与 steer。
- `experts/subagents/delegation.ts`：普通 Expert 通过 `createAgentLauncher().tool` 委派子专家。
- `experts/teams/delegation.ts`：用 `defineExpertTeam()` 声明专家团，协调专家按 allowlist 委派成员。
- `experts/teams/invocation-tree.ts`：读取团队 InvocationTree 与成员节点。
- `flows/basic.ts`：内联 Task 与 `compose()`。
- `flows/experts.ts`：Flow 调用 Expert 和 ExpertTeam。
- `flows/human.ts`：HumanTask 响应。
- `flows/recovery.ts`：`flows.open()` 只读观察执行状态。
- `flows/invocation-tree.ts`：Flow InvocationTree 与总输出流。

例如：

```bash
pnpm --filter @pragma/examples dev src/experts/conversations/single-multi.ts
```

专家团委派示例也提供了快捷命令：

```bash
pnpm --filter @pragma/examples example:expert-subagent
pnpm --filter @pragma/examples example:expert-team
```

所有外部 prompt 必须提交给 `ExpertSession`；Flow 只能通过 `app.flows` 启动、打开或恢复。
