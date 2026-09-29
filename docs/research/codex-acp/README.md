# Codex ACP 切换调研

日期：2026-09-29。Pragma 基线：最新 `origin/main`，
`d995fce49f2562bf4169954d6d114815d535fd8c`。
工作分支：`codex/codex-acp`。

## 结论

**Codex 当前提供自己的 App Server 协议；ACP 通过独立的 `codex-acp` 适配器提供。
切换可行，但现成适配器不能直接无损覆盖 Pragma 当前 Codex Runtime。**

建议复用 Core 的 `defineAcpRuntimeDriver()`，保留 `@pragma/runtime-codex` 的供应商装配和
私有 Home 管理。切换的收益是统一 Pragma 侧 transport 和生命周期，不是移除底层 App Server。

目前必须解决或验证的重点：

1. **Steering 投递语义不兼容**：上游允许在 idle 时自动创建新 turn，Pragma 要求 Core
   控制 fallback，避免未经追踪的新 turn。现有 `steerAcpSession()` 不能直接接上游。
2. **权限预设覆盖不完整**：Desktop/CLI 当前常用两组配置有对应预设，但 Adapter 公开的独立
   sandbox/approval 组合不能全部映射；必须保留其语义，不能悄悄改成 auto review。
3. **Context window 口径不同**：上游 `usage_update.used` 包含 reasoning output，Pragma
   当前实现扣除此项。用量结算还需验证多次模型请求的整轮合计，不能把最后一次请求当成整轮。
4. **Compaction 与原生子 Agent 需要新增映射**：上游已有接口，但 Core 当前没有直接映射
   `compaction_update`，也会过滤不同 session ID 的通知。
5. **MCP 必需性、私有隔离、历史恢复和发行包需重新验收**：不能只把 HTTP URL 交给 ACP
   就假定现有配置、发现、审批和恢复行为等价。

初始调研阶段只添加调研及脱敏握手证据；后续补齐下文记录的 Steer 与排队轮投影修复。
没有切换 Runtime transport、依赖、feature readiness 或持久化协议。
下文的“可映射”是源码层面的可行性，**不等于已经满足 Runtime 接入清单的 Supported**。

## 讨论补充：允许自动开启下一轮

用户已明确表示 steering 赶不上当前轮时，自动开启下一轮可以接受。产品要求是页面和执行状态必须
完整承接，不能显示完成后仍有不可见的后台执行。因此“不得开启新轮”不是本任务必须维持的产品约束；
前述差异应按新轮接管能力评估，而非仅按 idleBehavior 是否匹配判断。

进一步检查上游 `startNewTurnFromExternalPrompt()`：它在新轮启动时就返回 steering 回执，
内部 `prompt()` Promise 继续运行；最终 PromptResponse 的 stopReason/usage 没有作为该 steering
RPC 的结果返回给客户端。启动后的异常在此路径记录日志。正文/工具通知仍可发送，但这些增量
不等于可靠的整轮终态。当前 Core ACP Driver 依赖自己发起的 session/prompt 的 Promise 结算，
不能只新增 startedNewTurn 分支或让 renderer 多显示 loading 就覆盖这一差异。
[上游后台新轮实现](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/src/CodexAcpServer.ts#L1710)

有两条可行设计方向，均为建议，尚未实现或验证：

- 由 Host 开启下一轮：Runtime 明确返回“未注入”，Pragma 自动登记并发出下一次 session/prompt。
  用户仍得到自动承接的体验，同时沿用现有终态、Usage、权限、取消和恢复链路。Codex ACP 仍需要
  提供不会自行开新轮的控制模式。
- 接管 Runtime 自动开的下一轮：在 steer 发出前持久化承接记录、缓冲早到事件；以关联身份区分
  当前轮注入或新轮启动，并为新轮接入 start/completed/failed/cancelled、Usage、取消、恢复和错误
  诊断。需要上游可协商扩展提供关联标识和完整终态，或稳定的等价公共接口；现有
  startedNewTurn 回执本身不足。还需处理超时但已启动的投递不确定性，避免重复 prompt。

旧轮可以保留完成事实；Mission/UI 应按尚未结算的承接操作和新轮显示“继续处理中/运行中”，
不得让旧轮完成事件盖过新轮运行状态。子 Agent 的定向 steer 还需按同一 owner/Invocation
权限边界承接，不能只修根聊天入口。

收益判断：ACP 可复用已有连接、进程监督、streaming、附件与生命周期代码，减少独立 parser 的维护。
但底层仍是 Codex App Server；模型和原生执行能力不会因为加一层 ACP 而增加，还会增加 wrapper/native/SDK
版本组合及语义映射成本。若保持 Codex 当前能力为主要目标，收益为中等且需要上述工作；若目标是
长期统一 Runtime 接入机制，收益更明确。应先证明承接终态和历史恢复，再决定是否替换旧通道。

## 原生支持与版本证据

### 当前 Pragma Codex 的 steer 与队列边界

用户进一步明确：steer 发出时当前轮恰好结束，应自动降级为排队执行。不能把 strict steer
的失败策略误当成所有用户入口的当前行为。

Desktop renderer 普通发送使用 enqueue；队列中的 steer 按钮调用
`trySteerQueuedMissionMessage()` → `attemptQueuedPromptSteer()`。Core 在发送前发现没有活动轮，
或目标发生变化并抛出 `SteerNotDispatchedError`，会保留/恢复原排队项，返回 retained。
这条路径已有“尝试当前轮注入，明确未投递则保留排队”的设计。

Codex Adapter 通过 `turn/steer` 发送 `expectedTurnId` 和 `clientUserMessageId`，
不会自行开启下一轮。原生轮结束时，本地 activeTurnId 会清空；如果请求已发出才发生轮次结束，
修复前 Codex 拒绝该请求，`createRpcError()` 将响应转为普通 Error，没有保留结构化错误类型供 Core
识别“确定未注入”。Core 因而将它记为 delivery_uncertain，保留排队项但暂停队列，
以避免潜在的重复执行。该原生竞态分支需要补齐自动排队降级。

另有显式 strict Mission steer 入口，不启用 enqueue fallback；Core 的 prompt API 可通过
`steerFallback: enqueue` 显式选择降级。实施时应围绕实际 Desktop 队列入口验证，不能只看
低层 RPC 的失败或 opt-in fallback 测试就声称端到端行为符合要求。

本 worktree 已修复这个边界：RPC error 保留 method、code、原始 message 和 data；仅将 Codex
`NotSubmitted` 路径中已知的 `-32600` 响应（无活动轮、expected turn mismatch、review/compact
不可 steer）映射为 `SteerNotDispatchedError`。本地 activeTurnId 已清空也报告确定未注入。
未知 RPC error、内部错误、timeout/disconnect 仍按投递不确定处理。

Core 在 queued steer 未决时停止启动后续排队轮，恢复排队后主动唤醒处理器；暂停后不再继续取队列。
显式 `steerFallback: enqueue` 也只对确定未注入的错误自动降级，未知投递结果保留 strict steer 记录并抛错。
Desktop 从既有 deliveryAttempt 派生可选 IPC 状态 `deliveryUncertain`，保留消息并在刷新后继续提示
投递不确定，隐藏该消息的 Steer 操作，人工重试明确显示为重新执行。没有升级持久状态 Schema。

2026-09-29 的真实 Codex 0.144.1 隔离探针创建空闲 thread 后发送 `turn/steer`，响应为
`{"code":-32600,"message":"no active turn to steer"}`。探针未发送 `turn/start`，没有触发模型调用。
确定性 stdio 集成回归经过真实 Codex Adapter、RPC Client 和 Core ExpertSession，覆盖旧轮结束后
明确拒绝、目标变化、断连、2 秒超时及迟到成功响应；Host 回归验证下一轮重新投影为 running 与
不确定消息仍处于 paused。真实模型执行中的轮末竞态尚未做网络调用验证。

后续 [CR 与修复记录](./code-review.md) 补齐了不确定投递的 API / Store 防重、缺失诊断事件时的
权威暂停状态、取消后的迟到回复与恢复保护、成功 turnId 校验及排队 Steer 的本地等待边界。

截图反馈还暴露了独立的 [排队轮实时投影承接问题](./queue-live-projection.md)：Desktop 原来等待
旧轮全部副作用结束才订阅后续轮。本 worktree 已改为按执行启动事件接入，并保护新轮免受旧清理覆盖。

OpenAI Docs 将 App Server 定义为深度集成入口，其 wire protocol 使用 `thread/start`、
`turn/start` 等自己的 JSON-RPC 方法。共享 JSON-RPC/stdio 不代表使用 ACP 的 session 协议。
本机 `codex-cli 0.144.1 --help` 也没有 ACP 子命令或 `--acp` 开关。
未找到 OpenAI 官方文档对原生 ACP 的声明；这个结论限定于当前查阅文档、上游实现和本机版本，
不声称所有未来版本都不支持。[OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)

实际可用入口是 [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)。
其 README 明确说明它启动 Codex App Server，并做 ACP 与 Codex 请求/事件转换。
旧 `zed-industries` 仓库和 npm 包已迁移，新增依赖应使用新命名空间。

调研固定上游快照 `2eebebc35441e03cd466003b40a75953b221b886`，其提交为 2026-09-28
的 `2.0.0` release。npm registry 在本次检查时 `latest = 2.0.0`；`preview` 指向
`1.13.2-preview.6`，不能假定 preview 比 latest 更新。
发布包依赖 ACP SDK `^1.5.0`、`@openai/codex ^0.158.0`，本次实际安装解析到 SDK
`1.5.1` 和 Codex `0.158.0`。Pragma 当前 ACP SDK 固定 `1.5.0`，需显式复验两端组合。
[上游 package.json](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/package.json)

上游默认通过 `@openai/codex` 的 npm launcher 启动原生进程，也支持 `CODEX_PATH`。
因此 Pragma 可继续使用现有 executable resolver 选择用户安装的 Codex；需固定并验证支持版本，
不能因旧版本握手成功就认定完整 API 兼容。
[进程启动源码](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/src/CodexJsonRpcConnection.ts)

目标链路：

```text
Desktop / CLI composition
  → @pragma/runtime-codex
  → Core defineAcpRuntimeDriver
  → bundled codex-acp worker (ACP v1 / stdio)
  → native codex app-server (Codex JSON-RPC)
  → model / native tools / Pragma Execution MCP Gateway
```

## 已执行探针

macOS、本机 Node `24.18.0`，真实 `codex-acp 2.0.0` 子进程分别搭配：

| Codex 来源                     | 版本    | initialize  | 未认证 session/new               |
| ------------------------------ | ------- | ----------- | -------------------------------- |
| 本机安装，通过 CODEX_PATH 指定 | 0.144.1 | ACP v1 成功 | `-32000 Authentication required` |
| npm 依赖默认 launcher          | 0.158.0 | ACP v1 成功 | `-32000 Authentication required` |

两次握手均声明 image、embeddedContext、loadSession、HTTP MCP、resume/list/close/delete/fork
和 steering；MCP ACP transport 与 SSE 为 false。
`subagents` 是 draft capability，实际消费还取决于 SDK 是否保留字段及双向协商。

探针使用临时、空白的 `HOME`、`CODEX_HOME` 和私有 `CODEX_SQLITE_HOME`，没有复制宿主认证、
没有读取宿主 Session、没有发起模型调用。两个进程均已退出。
证据见 [probe-2026-09-29.json](./probe-2026-09-29.json)。

可复验的安装及版本命令如下；握手 request/response 保存于上述 JSON：

```sh
npm view @agentclientprotocol/codex-acp dist-tags version dependencies --json
npm install --prefix /tmp/pragma-codex-acp-probe --ignore-scripts --no-audit --no-fund @agentclientprotocol/codex-acp@2.0.0
node /tmp/pragma-codex-acp-probe/node_modules/@agentclientprotocol/codex-acp/dist/index.js --version
```

这只证明真实协议连接及明确的认证失败边界；不证明已认证 fresh/resume、MCP 执行、Skill 行为、
streaming、steering 或其他模型能力已通过验收。

## 对照 Pragma Feature Catalog

基线来自 [Codex Adapter](../../../packages/runtime/codex/src/adapter.ts)、
[Core ACP Driver](../../../packages/core/src/runtime/acp-driver.ts) 和
[Runtime 接入清单](../../conventions/runtime-adapter-integration-checklist.md)。
当前 Codex Adapter 自身仍将这些实现声明为 Degraded，不能把现有布尔 capability 当成真实验收记录。

| Feature slot        | ACP / 上游路径                                 | 覆盖判断与实施要求                                                               |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| availability        | 启动 worker + initialize                       | 可映射；探针已通过，但还要区分 native executable 与 worker 缺失                  |
| authentication      | 现有 Codex auth + ACP authenticate             | 可映射；本次只验证未认证错误；保留私有 Home 认证投影                             |
| modelDiscovery      | new/load 的 configOptions 与 native model/list | 可映射；保留现有模型缓存/forceRefresh/provider/input modality 数据               |
| modelSelection      | session/set_config_option，category model      | 可映射；必须在 prompt 前设置，校验真实选中模型                                   |
| thinking            | reasoning_effort / thought_level               | 可映射；模型变化后刷新允许的 reasoning levels                                    |
| freshSession        | session/new → thread/start                     | 可映射；保持 Core 原子 owner claim，不接受上游管理替代                           |
| resume              | session/load → thread/resume + 历史 replay     | 可映射；必须使用真实旧 Adapter Session fixture，确认 ID 和存储不变               |
| systemPrompt        | CODEX_CONFIG developer_instructions            | 需供应商配置；ACP 没有通用 system role；验证 fresh/load 和每轮生效               |
| startupMessages     | Core ACP Driver 首次 prompt bootstrap          | 已有通用实现；恢复时会刷新 startup，与当前 Codex skip-on-resume 不同             |
| textStreaming       | agent_message_chunk                            | 可映射；增量必须早于 terminal，验证 commentary/final 不丢失                      |
| reasoningStreaming  | agent_thought_chunk                            | 可映射；核实原生 summary/raw 事件顺序                                            |
| nativeToolLifecycle | tool_call / tool_call_update                   | 可映射；验证失败、拒绝、输出增量、native name 和嵌套来源                         |
| mcp                 | HTTP / stdio mcpServers                        | 需适配；保留 required/enabled/default_tools_approval_mode 和 ready/failure 判断  |
| permissions         | session/request_permission + mode              | 常用模式可映射，完整公开配置组合阻塞；不能静默降级                               |
| userInteraction     | elicitation/create，form / URL                 | 可适配；问答需接 Pragma durable handler；当前 Codex Adapter 拒绝 MCP elicitation |
| skills              | 私有 CODEX_HOME/skills + 上游原生发现/命令     | 可映射；保留受管 Skill 物化，并验证真实发现/调用与 repo discovery 边界           |
| attachmentImage     | ACP image → Codex image                        | 可映射；Core 已读取受管附件并转 base64；验证 MIME、模型 modality                 |
| attachmentFile      | resource_link → 文本 URI 引用                  | 可映射；这是路径引用，实际读取仍需 native 工具和权限                             |
| attachmentDirectory | resource_link；额外目录另有配置                | 可映射；附件不自动获得额外可写权限                                               |
| usage               | PromptResponse.usage                           | 需核对 scope；保留 cache 分项和精确上报优先；多次模型请求合计待验证              |
| contextWindow       | usage_update used/size                         | 有接口，但 used 口径与当前 Pragma 不同，见下文                                   |
| compaction          | /compact + compaction_update                   | 需绑定 lifecycle、失败、operationId、trigger、checkpoint 和 startup 重注入       |
| cancellation        | session/cancel → turn/interrupt                | 可映射；验证审批等待、启动竞态、断连和子进程退出                                 |
| steering            | _session/steering                              | 有扩展但语义阻塞；上游 idle 会 startedNewTurn                                    |
| close               | session/close → thread/unsubscribe             | 可映射；还必须有界停止 wrapper 和 native 两层进程                                |
| cleanup             | Core resource cleanup + native stop            | 可映射；native 停止后才释放 MCP registration、清理私有诊断                       |

结构化输出不在上述 Feature Catalog 中，但仍是 Pragma 重要能力：Core `driver.ts` 已拥有
schema prompt、解析/校验和 retry loop，切换 ACP 可以继续复用。当前 Codex `startTurn`
也没有使用 native `outputSchema`，因此不是现有 native schema enforcement 的回退。
仍应实测内置修订/测评 Agent 的合法输出、非法输出重试和重试 Usage 合并。

Pragma ExpertTeam、Flow、Context、Mission Board、Memory 与 managed tools 的治理属于 Core/Host。
它们可继续通过 Execution MCP Gateway 使用；ACP 子 Agent 协议不应替代 Pragma Invocation 模型。

## 关键语义差异

### Steering：当前不能安全直连

Core `steerAcpSession()` 发送 `_meta.steering.idleBehavior = promptRequired`，只接受
`injected` 或 `promptRequired`。上游 `SessionSteerRequest` 没有该控制语义，执行路径也不消费
它；无活动 turn 或注入时原 turn 已结束，都会调用 `startNewTurnFromSteering()`，返回
`startedNewTurn`。[请求与结果类型](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/src/AcpExtensions.ts)

这意味着 Core 即使将结果标记为 delivery-uncertain，也可能已有新 turn 开始，且未绑定新的
Pragma Invocation、预算和 Usage 生命周期。事后拒绝响应无法撤销这个副作用。
不得通过先查询 active 状态再调用来解决，因为查询和投递之间仍有竞态。
[上游 steering 实现](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/src/CodexAcpServer.ts#L1609)

优先推动上游支持显式 idleBehavior（并在能力协商中区分是否支持），再验证 active 注入、idle、
turn 边界竞态、超时、断连和幂等投递。若选用本地受控扩展，需要稳定可调用入口及固定版本；
上游发布包只有 bundled `dist/index.js`，不是可直接 import 的 Server class 公共 API。
只把 steering 改成 queued followup 会减少现有能力，不能当作完整切换。

### 权限：常用配置可映射，任意组合不行

Pragma 当前 CLI 默认和 Desktop 非 bypass 为 workspace-write/on-request；Desktop bypass
为 danger-full-access/never。分别对应上游 workspace-write 和 agent-full-access。

上游四个 mode 预设把 sandbox、approvalPolicy 和 approvalsReviewer 绑定在一起，其中默认
agent 使用 auto_review。Pragma 公开 API 还允许 untrusted，以及 read-only/never 等组合，
没有相应 preset。上游每次 `sendPrompt()` 都显式写入 mode 的这些字段，单纯传
`CODEX_CONFIG.approval_policy` 不能保证覆盖该 per-turn 设置。
[AgentMode](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/src/AgentMode.ts)、
[sendPrompt](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/src/CodexAcpClient.ts#L1040)

ACP 审批选择供应商提供的 optionId，不直接支持 edited tool input。当前 Codex Adapter
也没有应用 humanInteraction 返回的 edited input，不能将此写成切换导致的能力损失；
但也不能因 Claude worker 有 `pragma.updatedInput` 就声称 Codex 同样支持。

### Usage 与 Context window：分别验证

上游 `TokenCount` 把 cached input 从 input 中扣除，分别返回 cachedReadTokens 与 thoughtTokens；
Core ACP 正好按非缓存 input 消费，因此这部分可映射，不应再次扣缓存。
必须明确设置/验证 `promptUsageScope`，避免 Core 默认以 session 累积快照求差造成错账。
[TokenCount 转换](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/src/TokenCount.ts)

上游 PromptResponse 当前使用最终 `lastTokenUsage`；真实一次 ACP prompt 可能含多个模型
请求/工具循环，需验证整轮 accounting，不能仅依据字段注释认定是整轮合计。错误/取消/断连路径
也要保留已消费用量。上游自动测试本身断言多次更新采用最后 snapshot，这不是 Pragma 整轮
合计已经正确的证据；应同时审计旧路径的相同风险。
[上游用量测试](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/src/__tests__/CodexACPAgent/token-usage-events.test.ts)

Context window 是另一边界：上游 `usage_update.used = last.totalTokens`；Pragma 当前
`readCodexContextTokenCount()` 使用 `last.totalTokens - reasoningOutputTokens`。
直接接受 ACP used 会改变 context 压力和 startup budget 决策。标准 usage_update 没有该
reasoning 分项，需要供应商扩展或修正上游定义；不能用累计 Usage 替代当前 Context 占用。
[上游事件处理](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/src/CodexEventHandler.ts#L1151)

### Compaction 与原生子 Agent

上游支持通过 clientCapabilities.session.compaction 协商 `compaction_update` 生命周期，
`/compact` 是原生命令路径。未协商时退化为合成工具事件。Pragma 需映射压缩事件、区分 replay/live、
去重并验证失败与取消；不得把 `/compact` 的普通文本回复视为成功。
[上游压缩协议说明](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/docs/session-compaction.md)

原生 child sessions 需要双向 draft 协商。上游支持独立 child history 和 root-routed permission，
但不支持 targeted child cancel/close。Core 当前过滤不同 sessionId 的 update，且没有映射
spawn/state；现有 Codex Adapter 有 child thread source/nickname/role 归一化，因此必须保留
这种可观测性。选择 legacy fallback 也需证明 child 内容及来源不丢失。
[上游子 Agent 说明](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/docs/subagent-sessions.md)

### MCP、隔离与恢复

现有 `appendCodexExecutionMcpConfig()` 还设置 enabled、required 和 default_tools_approval_mode；
ACP HTTP server 描述只携带 URL/headers。实现时需在供应商受管配置中保留这些额外约束，
验证配置 merge 和恢复路径，以及 ready/failed/cancelled 的 Host 诊断。上游 MCP startup wait
扩展不能代替 mandatory server failure 闸门，尤其 session/load 不等待 startup。
[MCP startup 行为](https://github.com/agentclientprotocol/codex-acp/blob/2eebebc35441e03cd466003b40a75953b221b886/docs/mcp-startup-await-timeout.md)

上游会将 cwd/额外目录设为 trusted，并刷新原生 Skills。因此最小私有 Home 不自动等价于 repo
customization 隔离；现有 Codex repo `.codex` 隔离本来就未被接入清单认定通过。切换必须用
marker hook/plugin 验证发现边界，不得顺势扩大 ambient 配置/MCP/Skills。
APP_SERVER_LOGS 可写完整 wire/config，必须由 Host 定向管理、脱敏并限制保留，不能进入 workspace。

上游 ACP sessionId 使用 native thread ID，并通过 thread/resume 恢复，存储继续由 native Codex
维护；这是保留 `codex-managed-home` 和 RuntimeSessionRef 的可行依据，但不是已验证的兼容性。
必须先由旧版本实际写出 Session fixture，再用新 worker/native 组合加载并继续执行。
若变更会拒绝或改变已有合法持久数据语义，需同一改动中的版本升级、相邻迁移及恢复测试；
不能因 transport 改成 ACP 就跳过仓库的协议治理要求。

## 建议实施顺序与验收

1. **先解决语义闸门**：固定 wrapper/native/SDK 版本，验证 steering idle contract、权限组合和
   context window/Usage 口径，确定能否通过上游公开接口补齐。未经这些条件不能承诺无损替换。
2. **替换供应商执行通道**：在 runtime-codex 使用 Core ACP Driver，复用 codex-home、skills、
   model discovery、Execution MCP Gateway 和 owner/checkpoint；保留供应商映射在 runtime-codex。
   Core 仅增加运行时中立的压缩/嵌套事件扩展点，不依赖 codex-acp。
3. **处理持久化行为差异**：明确 ACP Driver 在 restore 后刷新 startup 的语义，测 fresh、restore、
   自动/手动压缩后重注入，并验证旧 Session、owner claim、异常恢复、关闭和级联删除。
4. **完成真实能力探针**：至少覆盖 model/thinking、system/startup、text/reasoning streaming、
   native tool lifecycle、一次 HTTP MCP 真实发现与调用、Skill 实际行为、三类附件、structured output、
   Usage reported/fallback、多模型请求 accounting、manual/auto compaction、steering 竞态、cancel、close。
5. **完成 CLI/Desktop 发行验证**：参考已有 Claude ACP worker 打包，将 Codex worker 纳入两个入口，
   核实 Node 22、Windows native executable、ASAR unpack、无外部 workspace TS import，以及 wrapper
   崩溃后 native 子进程无泄漏。上游 CODEX_PATH Windows 分支使用 shell，必须专门审查路径转义。
6. 验收通过后删除旧 app-server-client、session parser 及冗余测试，不长期保留双执行通道；
   按 Runtime 接入清单更新每项 readiness，并提交记录 transport 与持久化决策的 ADR。

调研阶段未执行真实模型/工具回归；后续 Steer 修复执行了对应的 Runtime、Core、Host 与页面回归，
没有运行完整项目测试。ACP 完整能力覆盖的最终结论仍需要上述真实运行证据。
