# Qoder CLI ACP 切换调研

日期：2026-09-29。基线：`origin/main`，`533200afc677764053c7ed6a3dcf8fa1cc918d5d`。

## 最新版 1.1.64 复验

2026-09-29 已按用户要求，将本机 Homebrew cask `qoderai/qoder/qodercli` 从 1.1.6
升级到 **1.1.64**。`qodercli --version` 和 `qoder --version` 均确认 1.1.64。
官方 native channel manifest、npm `latest` 与官方 Homebrew tap 均指向此版本。
Homebrew 全局 update 等待较久，已停止该次更新，改为定向 fetch、fast-forward 官方 Qoder tap
并执行 `HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew upgrade --cask qoderai/qoder/qodercli`。

- [官方发布清单](https://qoder-ide.oss-accelerate.aliyuncs.com/qodercli/channels/manifest.json)：
  `latest: 1.1.64`，发布时间 2026-09-25T18:53:15.367Z。
- 官方 tap commit：`61e5885592e3320437d3569f95d435f5d68d839b`。
- macOS x64 archive SHA-256：`4a597292d7ea91674fba0f17f01fd3c15edd741af54e842278667db5f6a8e409`。
- 安装 binary SHA-256：`fa0d624a4a6e87fe5f285c4aeee9b91489f39d18ff0c80e38264e1c1cfbf4a84`。

**复验结论：最新 1.1.64 的 ACP 仍未开放与 SDK `priority: next/now` 等价的 steer。**
握手仍只声明 `agentCapabilities._meta.qoder.promptQueueing: true`；
`_session/steering` 和试探性的 `session/steer` 均返回 `-32601 Method not found`。
后者不是已声明的标准 ACP 方法，其失败仅用于接口探测，不单独作为结论依据。
安装包中的 ACP prompt 仍在当前请求活动时写入 `pendingMessages`，只在当前
`executePromptQueueItem()` 结束后才执行下一条。新增 `pendingMessageRevision` 用于会话
rewind 的竞态检查，没有将队列接入当前 Agent loop；ACP session 未见消费 `priority` 的路径。

这次相同的私有 `.auth`/`.models` 快照成功建立 Session，无需调用交互认证。使用真实
`qfmodel`（Session 公布名称 Qwen3.8-Flash）完成两次模型调用，按如下顺序测试：

| 相对第一条 prompt 的时间 | 实际事件                                                     |
| ------------------------ | ------------------------------------------------------------ |
| 0 s                      | 请求输出 120 行编号句子                                      |
| 3.038 s                  | 收到第一条正文 delta，立即发送第二条「停止并改变方向」prompt |
| 25.004 s                 | 第一条仍完成全部 120 行，返回 `end_turn`                     |
| 31.064 s                 | 第二条返回自己的独立 `end_turn` 结果                         |

第一条没有因运行中的新输入停止或转向，第二条没有提供当前轮注入确认。
真实观察与排队实现一致。第二轮正文为 `FIRST_PROMPT`，并未遵守要求的
`SECOND_PROMPT_REDIRECTED` marker，因此本记录也不能声称第二轮成功完成转向；它证明的是
独立后续轮次结算与第一轮不受影响。未覆盖工具等待期间的注入场景。
两轮均返回零 token usage，尽管正文非空；后续 Adapter 必须验证统一计数器 fallback。

新版脱敏证据见 [probe-1.1.64-2026-09-29.json](./probe-1.1.64-2026-09-29.json)，包含
握手、方法错误、new/config 结果、并发请求时间线和完整合成测试输出。探测进程已退出，
私有认证副本及临时 Session 已清理。以下章节保留最初 1.1.6 的完整覆盖调研，不能将其中
「认证未完成」的历史结果误读为新版状态；其余能力尚未在 1.1.64 全量复验。

## 结论

Qoder CLI 原生支持 ACP，适合将 Pragma 的 Qoder 执行通道从 Agent SDK 切换到
`qodercli --acp`，并复用 Core 的 `defineAcpRuntimeDriver()`。但本机 1.1.6 的 ACP
接口不能直接完整覆盖现有 Qoder Adapter 的能力；现在不能把切换视为无损替换。

主要差异是：

1. `promptQueueing` 是排队执行下一轮，不是向当前轮注入指令；不满足 Pragma 的 active-turn
   steering 和确定投递语义。
2. ACP 审批只能选择供应商提供的选项，Qoder 的 ACP 路径未消费 `updatedInput`；现有 SDK
   Adapter 可以应用用户修改后的工具参数。
3. ACP 基础 token 用量可读取，但现有 SDK 的 cache read/write 分项没有透传；当前 ACP
   session 实现也未见 `usage_update` 或 compaction lifecycle 的发出路径。
4. 手动压缩没有独立 ACP RPC。可以继续研究 `/compact` 命令，但必须验证动态命令目录、
   压缩边界、摘要和 startup reinjection，不能把普通模型回答当成压缩成功。
5. ACP 的模型、思考深度、恢复、Skills 和 MCP 接口具有可行路径，但仍需要通过已认证的真实
   Runtime 验收；本次实测只完成握手和部分方法探测。

本次只新增调研和脱敏证据，没有修改 Runtime 实现、依赖、capability 声明或持久化协议。

## 证据与适用范围

### 官方资料

- [Qoder ACP 文档](https://docs.qoder.com/cli/acp)：原生 stdio ACP，默认和 bypass 模式，
  MCP、Subagent、图片和客户端文件/终端能力。文档示例使用 `qoder`；本机及官方 demo
  使用 `qodercli`，实现应继续使用现有 executable resolver。
- [Qoder CLI 参数](https://docs.qoder.com/cli/cli-reference)：system prompt、settings、工具限制、
  strict MCP 等进程配置。公开文档不保证每个参数在本机 1.1.6 的 ACP 下都生效。
- [官方 ACP demo](https://github.com/QoderAI/qoder-acp-demos)，调研快照
  `3915960f9472a6d38560d226bb2ec7ba619d986d`：使用 ACP SDK `^0.22.1`，演示
  `AskUserQuestion` form elicitation、权限及可选客户端文件 RPC。
- [官方 demo 集成说明](https://github.com/QoderAI/qoder-acp-demos/blob/3915960f9472a6d38560d226bb2ec7ba619d986d/typescript/docs/integration-guide.md)：
  new-session/authenticate/retry 的流程。
- [ACP v1 会话协议](https://agentclientprotocol.com/protocol/v1/session-setup)、
  [配置选项](https://agentclientprotocol.com/protocol/v1/session-config-options)、
  [工具审批](https://agentclientprotocol.com/protocol/v1/tool-calls)、
  [用户问答](https://agentclientprotocol.com/protocol/v1/elicitation)。
- [Qoder Hooks](https://docs.qoder.com/cli/hooks)：可以研究使用私有 Hook relay 补齐
  PreCompact/PostCompact；Hook 存在不代表 ACP 下行为已验证。
- [ACP compaction 提案](https://agentclientprotocol.com/rfds/session-compaction)：通用协议
  正在补充压缩事件，不能据此推断 Qoder 1.1.6 已实现。

### 真实进程探测

平台：Darwin x86_64，Node 23.11.0，原生 Qoder CLI 1.1.6。
安装二进制 SHA-256：`01704ca3cb3132a52545ad708a3ed1042e79d3c970c5f82271b128022a581ebe`。
这里记录的是实际安装版本，不是声明最新发布版本或最低兼容版本。

脱敏 wire 记录见 [probe-2026-09-29.json](./probe-2026-09-29.json)。

| 探测                                           | 结果                                                                              | 能证明什么                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `qodercli --version`                           | `1.1.6`                                                                           | 本机安装版本                                             |
| `qodercli --acp` + `initialize`                | ACP v1 握手成功                                                                   | 原生 stdio 通道可用；即使本机 `--help` 未显示此参数      |
| `initialize.agentCapabilities`                 | load/resume/close、HTTP/SSE MCP、image、embeddedContext、additionalDirectories 等 | Agent 的能力声明，不是完整行为验收                       |
| `agentCapabilities._meta.qoder.promptQueueing` | `true`                                                                            | Qoder 专有排队能力声明                                   |
| `_session/steering`                            | `-32601 Method not found`                                                         | 当前 Core 的 Claude steering 扩展不能复用到此 Qoder 版本 |
| `session/compact`                              | `-32601 Method not found`                                                         | 没有这个压缩 RPC；不排除 slash command 或 Hook 路径      |
| `session/set_config_option`                    | `-32000 Authentication required`                                                  | 方法被路由到认证检查；未证明模型选择成功                 |
| 私有配置 `session/new`                         | `-32000 Authentication required`                                                  | 本次环境未能建立已认证 Session                           |
| `authenticate(qodercli-login)`                 | 有界等待超时                                                                      | 认证未完成；不能把存在 `.auth` 等同于有效登录            |

认证探测仅向新建、权限受限的临时配置目录快照 `.auth` 和 `.models`，禁用 ambient
setting sources 和 ambient MCP，并限制原生工具。没有复制宿主 sessions、plugins 或完整
config；临时认证副本已随探测目录清理。没有完成模型请求，没有写入 Expert workspace。
也试过只传入宿主 `security.auth.selectedType`，结果相同。认证原因尚未定位，不能推断为
ACP 不支持登录、Host 登录失效或私有目录一定不兼容。

后续不要在后台无界重试 `authenticate`：供应商可能进入交互登录流程。优先让用户在 Pragma
外完成官方 CLI 登录，再按最终私有配置和环境重新验收；PAT 不进入 wire fixture 或日志。

### 本机安装包静态观察

为区分协议能力与实现语义，检查了本机原生二进制中的内嵌 ACP 实现。这里只记录语义观察，
不提交供应商代码副本。这些观察受二进制版本和 hash 限定，不能替代真实运行 smoke：

- ACP session 的 `prompt()` 在已有 prompt 运行时写入 `pendingMessages`；当前轮结束后才由
  `runNextQueuedPrompt()` 执行。因此排队输入会产生另一轮模型执行，而非修改当前轮。
- 配置选项具有 `mode`、`model` 和按当前模型动态生成的 `reasoning_effort`。
- prompt 结果含 `usage.inputTokens/outputTokens/totalTokens` 和 `_meta.quota`；读取的是
  当前 prompt 的 SDK 结果。未透传 cache read/write 分项，binding 应声明 turn scope，
  仍须用连续两轮真实 fixture 确认。
- SDK 的 text/thinking delta 映射为 ACP message/thought chunk，工具事件映射为 ACP tool call；
  SDK `system` 消息在该 dispatch 路径被忽略。因此不能期待 SDK compact boundary 自动透传。
- 原生权限请求用 `_meta.qoder.toolName` 保留真实工具名；响应路径读取 `outcome.optionId`，
  没有读取修改后的参数。不要按工具卡片 title 猜权限工具名。
- `loadSession()` 定向读取 transcript 并 replay history；`resumeSession()` 不 replay。
  Core 当前使用前者，适合恢复消息历史。
- 客户端 `fs` 能力未声明时保留 Qoder 自己的 filesystem service；客户端 filesystem RPC
  不是完成第一阶段适配的前置条件。

## 对照 Pragma 的全部 Runtime Feature

权威目录是 `packages/core/src/runtime/features.ts`，验收要求见
[Runtime 接入清单](../../conventions/runtime-adapter-integration-checklist.md)。
下表状态针对「计划中的 Qoder ACP Adapter」，不是现有 SDK Adapter 的验收状态。
Supported 必须具备实现、自动测试和真实 Runtime 证据，本次尚无 ACP Adapter，因此可行项
仍标 Degraded；Unsupported 表示当前接口不能直接满足指定语义，必须明确禁用或补足后验收。

| Feature             | 状态        | ACP 路径、差异与验收重点                                                                                        |
| ------------------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| availability        | Degraded    | 已验证原生启动/握手；新探针不能只检查 `--version`，还要验证 ACP v1 和关键能力                                   |
| authentication      | Degraded    | 官方支持现有登录/PAT；本次私有配置 new 被拒绝，认证未完成                                                       |
| modelDiscovery      | Degraded    | `session/new` 返回 models/configOptions；目录依赖认证，需保留 cache、force refresh 和模型默认值语义             |
| modelSelection      | Degraded    | `session/set_config_option` 的 `model`，需选择后读回、未知值拒绝、每轮覆盖和 opaque ID 测试                     |
| thinking            | Degraded    | 模型相关 `reasoning_effort`；换模型后刷新选项，禁止静态复制等级或静默丢弃覆盖                                   |
| freshSession        | Degraded    | `session/new`；原生 ID、owner/checkpoint、实际磁盘位置和首次执行未验收                                          |
| resume              | Degraded    | 声明 `loadSession` 与 resume；Core load 可用作候选，旧 SDK 写出的历史 fixture 尚未实测                          |
| systemPrompt        | Degraded    | ACP 没有标准 system role；保留进程 `--append-system-prompt` 等原生配置，不伪装成用户消息                        |
| startupMessages     | Degraded    | Core ACP Driver 已投递 startup；每次新连接（含 load）会刷新，区别于现有 Qoder resume 不重注入策略，需明确并验证 |
| textStreaming       | Degraded    | ACP message chunk；安装包有真实 delta 映射，仍需证明 delta 早于 terminal result、顺序与去重                     |
| reasoningStreaming  | Degraded    | ACP thought chunk；真实 reasoning 模型 smoke 尚缺                                                               |
| nativeToolLifecycle | Degraded    | ACP tool call/update；验证 pending/running/completed/failed、拒绝、ID/名称、工具输出与重放                      |
| mcp                 | Degraded    | 握手声明 HTTP/SSE，继续使用现有 Execution MCP gateway；必须实际发现并调用 allowlist 工具                        |
| permissions         | Degraded    | ACP request_permission 可作批准/拒绝，需映射三类 Host 策略；修改工具参数子能力当前 Unsupported                  |
| userInteraction     | Degraded    | 官方 demo 已演示 AskUserQuestion form elicitation；Core SDK 1.5.0 与 demo 0.22.1 的方法兼容要实测               |
| skills              | Degraded    | ACP 不提供通用 Skills 注册 RPC；研究私有 plugin/CLI 注入，原有 SDK `plugins`/`skills` 不能照搬为 ACP 参数       |
| attachmentImage     | Degraded    | 握手 image=true，Core ACP Driver 可传 base64；候选改善现有路径降级，未证明二进制进入模型                        |
| attachmentFile      | Degraded    | ACP resource_link/Core 路径上下文；需验证本地 URI、read 权限和受控 request 区段                                 |
| attachmentDirectory | Degraded    | 保留 Core 路径上下文；additionalDirectories 是信任根扩展，不应自动把附件目录变成授权根                          |
| usage               | Degraded    | 基础输入/输出有原生路径，cache 分项未透传；turn scope、两轮不重复计数、缺失/全零值 fallback 要测试              |
| contextWindow       | Degraded    | 当前 ACP session 未见 usage_update；不能把累计输入 token 当上下文占用，暂时返回 unknown，真实来源待确认         |
| compaction          | Degraded    | 无独立 compact RPC；动态 `/compact`、自动压缩和 Pre/PostCompact relay 候选路径都未验收                          |
| cancellation        | Degraded    | `session/cancel` + Core 有界停止；取消排队 prompt、生成、审批和工具等待均需实测                                 |
| steering            | Unsupported | `promptQueueing` 下一轮语义不能替代当前轮注入；现有 `_session/steering` 扩展明确不存在                          |
| close               | Degraded    | session close 声明存在，Core 也负责停止进程；真实会话关闭/子进程退出/幂等未验收                                 |
| cleanup             | Degraded    | 复用 Core resource scope，两阶段关闭后释放 MCP/relay/lease；异常 cleanup 和聚合错误需测试                       |

Flow、ExpertTeam、delegation、Mission Board、Memory、structured output 校验/重试属于
Core/Host。它们不需要 Qoder ACP 逐一提供 RPC；通过同一个 Execution MCP gateway 与
原有 owner/Invocation 生命周期继续组合。Qoder 的 native Subagent 支持不能证明 Pragma
ExpertTeam 的治理能力；必须真实调用 Pragma 的 managed lifecycle tools 验证边界。

## 需要先解决的差异

### 当前轮 steering

Qoder CLI 本身支持运行中追加输入。[官方 SDK 输入文档](https://docs.qoder.com/cli/sdk/input-modes)
区分 `now`（停止当前回复后立即处理）、`next`（下一个合适时机处理）与 `later`（当前回复结束后处理）。
现有 Pragma Adapter 使用 SDK `streamInput()` 加 `priority: "next"`，因此这里的缺口是
Qoder 1.1.6 的 ACP 暴露面，没有否定 CLI/SDK 的 steering 能力，也不表示 ACP 无法通过扩展支持它。

不能将第二个 `session/prompt` 当作 `steerTurn()`：请求在当前轮结束后才 settle，缺少两秒内的
投递确认，并可能创建额外 Runtime turn，与 Core 的 fallback 和 delivery-uncertain 处理冲突。

首选供应商提供可协商的 active-turn 扩展，区分 injected、not-dispatched 与 uncertain，并绑定
原 run/request ID。在没有这个接口时必须禁用 steering，使用 Core 的安全后续 prompt 路径。
这会改变现有能力，不能作为等价切换隐含落地。

### 审批修改参数

标准 ACP 的选项响应和 Qoder 1.1.6 的解析路径均不能表达 `updatedInput`。
Claude ACP worker 的 `pragma.updatedInput` 是自己的扩展，不能发送给 Qoder 后假设生效。

若要求保留此功能，需要 Qoder 扩展，或经真实验证的私有 Hook/relay 在最终执行前应用修改、
重新校验参数和 workspace containment。不能先批准原参数再悄悄忽略用户编辑。
没有完整路径时应明确禁用编辑；这属于能力收紧，需要切换方案明确列出。

### 用量、Context 与压缩

基础 prompt usage 可复用 Core 归一化，明确 `promptUsageScope: "turn"`。
缓存信息未知不能解释为已证实零缓存；不得以 Core 本地估算冒充缺失的原生 cache 统计。
没有可靠 Context numerator/denominator 时返回 unknown。

自动压缩事件丢失会导致 startup Context 未重注入，属于行为问题。候选方案是私有
PreCompact/PostCompact Hook relay，将事件映射到 Core，并在成功后重新启用 startup injection。
手动 `/compact` 需要实际 advertised command、成功边界和摘要证据；还要保留或明确处理
现有 `compactModelName`、context-window override，ACP 配置不能证明独立压缩模型可选择。

### 隔离、Skills 与历史数据

继续复用 `prepareManagedQoderConfig()`、`PragmaPaths`、private config 和 external-commands
共享缓存布局。认证方法与 SDK 的一次性认证注入机制不同，必须按最终环境验证，并避免把 PAT
传给 Agent 启动的 shell/MCP 子进程。

`settingSources: []`、strict MCP、managed plugin/skills 在 SDK 中的语义需要重新投影到
ACP 的原生参数/配置，且要验证这些选项确实作用于每次 `session/new/load`。
用恶意 marker Hook/plugin/MCP 验证 workspace customization 未被继承；只检查 flag 不够。
Core 当前 ACP Driver 没有注册 client filesystem/terminal handlers，因此不要声明这些能力，
若后续接入则必须补齐有界资源、权限和路径检查。

旧 `qodercli-managed-config` checkpoint 和 native transcript 必须使用旧代码实际写出的 fixture
测试恢复。本次没有证明 SDK 与 ACP transcript 可互读，不能直接沿用 Claude cutover 的结论。
如果事实证明格式与语义均不变，可以保留现有持久化格式；若需要改变 Schema、owner metadata
或拒绝既有合法数据，同一实现改动必须提交历史 Schema、相邻迁移、journal、备份、恢复与未来
版本拒绝测试，遵循 ADR 019 和仓库协议治理规则。

## 建议实施顺序

1. 在此 worktree 建立已认证、私有配置的 ACP 探针，完成 fresh、load、跨进程历史 marker、
   text/thought streaming、一个 native tool、一个 managed HTTP MCP tool、一个 Skill 和图片。
   使用真实 fixture 校验 Core ACP SDK 1.5.0 与 Qoder 的字段/方法差异。
2. 优先确定 steering、updatedInput、cache/context/compaction 的可保留方案。只有排队能力
   不能宣布 steering 完成；只有 `/compact` 文本结果不能宣布压缩事件完成。
3. 在 `packages/runtime/qodercli` 内改用 `defineAcpRuntimeDriver()`，保留 Runtime identity、
   public factory、Core feature preparation、MCP registry 和 owner persistence。
   供应商专用配置及扩展留在 Qoder Adapter，Core 只承载供应商中立的协议行为。
4. 用 ACP session config 替换 SDK 模型/思考深度发现，补缓存与 force refresh。
   完成后删除 SDK query/options/event parser 等旧通道和对应冗余测试，不保留双执行通道。
5. 同一改动写正式 ADR、能力验收记录和需要的迁移，再运行 Qoder 定向测试、相关 Core ACP
   测试、lint、typecheck、CLI/Desktop build 和真实 Desktop 交互验收。

若供应商不能补齐 steering 或审批参数修改，可单独提出明确的能力降级方案；在维护者确认
产品接受前，不能按「完整覆盖 Pragma」推进等价切换。
