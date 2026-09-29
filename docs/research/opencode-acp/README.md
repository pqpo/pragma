# OpenCode ACP 切换调研

日期：2026-09-29。Pragma 基线：最新 `origin/main`，
`d995fce49f2562bf4169954d6d114815d535fd8c`。
本次先完成 ACP 与原生 steer 调研，随后实现 OpenCode 2.x 的 SDK steer、队列投递确认与恢复。
运行时继续使用私有 HTTP 服务，没有切换 ACP；steering 保持 Degraded，1.x 明确 Unsupported。

## 结论

OpenCode 原生支持 `opencode acp`。Pragma 可以复用 Core 的
`defineAcpRuntimeDriver()`，将执行通道从两套 HTTP SDK 切换到 stdio ACP。
但**当前不能认为纯 ACP 可以完全覆盖 Pragma，或无损替换现有 OpenCode Adapter**。

用户进一步明确 steer 是迁移的必要条件。stock ACP 目前缺少运行中注入入口，不能以
`after_current` 或取消后重跑冒充 steer。2.0.16 SDK 存在原生 steer，但只绑定 Session，
真实进程已复现结束后接收并进入以后一次 prompt 的竞态；详见末尾的结束边界探针。

另一主要阻碍是原生用户问答：1.18.33 默认 ACP 不暴露 `question` 工具，强制开启后也没有
问答请求发给 Client，调用保持等待；2.0.16 的 ACP 则直接取消 `form.created`。
此外，系统提示词需要受管 Agent 配置，模型完整元数据需要额外发现路径，自动压缩缺少可靠
通知，用量需要处理零值、思考 token 和多步工具调用统计。

当前决定保留 SDK 与私有服务。ACP 迁移须先补齐运行中 steer 与原生问答，再重新评估；
本次原生 SDK steer 及结束边界已有实现与真实进程验证。若要求保留原生问答，应补 OpenCode ACP 的问答桥接或等待上游支持；
如果改为 Pragma 管理的 MCP 问答工具，则属于明确的产品入口变化，需要列出范围并验证，
不能把它描述为原生问答等价支持。

## 资料与版本边界

官方说明：

- [OpenCode 1.x ACP](https://opencode.ai/docs/acp/)：原生 stdio JSON-RPC、工具、MCP、Agent 和权限。
- [OpenCode 2.x ACP](https://opencode.ai/v2/docs/cli/acp/)：会话生命周期、model/effort/mode、
  内容输入、HTTP MCP、`/compact`；ACP 内部启动私有服务，不连接共享后台服务。
- [ACP 会话协议](https://agentclientprotocol.com/protocol/v1/session-setup)与
  [Session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)。

本次使用固定 tag 源码，避免将开发分支能力当作已发布能力：

| 版本    | 来源与范围                                                                                                                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.18.33 | [正式 Release](https://github.com/anomalyco/opencode/releases/tag/v1.18.33)，2026-09-28 发布；调研时 GitHub latest 指向它。源码 commit `51ef4be1d3c122f18fefb510dca8d778571f4f18`；已运行真实二进制探针。                                                                                                                |
| 2.0.16  | [源码 tag](https://github.com/anomalyco/opencode/tree/v2.0.16)，commit `3a103fe0aff726a4edc7492f03f7b88195d9e4c9`，对应 Pragma 当前 2.x 最低版本。已通过 npm 官方 `@opencode/cli-darwin-x64@2.0.16` 二进制执行原生 steer 探针；ACP 仍只做源码审查。GitHub Release API 查询此 tag 返回 404，不声称它是最新 2.x 正式发行。 |
| 1.18.32 | Pragma 当前 1.x 最低版本；本次没有运行此版本 ACP，不能凭 1.18.33 结果确认原版本下限。                                                                                                                                                                                                                                    |

关键源码：

- 1.x：[service](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/acp/service.ts)、
  [event](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/acp/event.ts)、
  [permission](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/acp/permission.ts)、
  [usage](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/acp/usage.ts)、
  [tool registry](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/tool/registry.ts)。
- 2.x：[service](https://github.com/anomalyco/opencode/blob/v2.0.16/packages/cli/src/acp/service.ts)、
  [event](https://github.com/anomalyco/opencode/blob/v2.0.16/packages/cli/src/acp/event.ts)、
  [permission](https://github.com/anomalyco/opencode/blob/v2.0.16/packages/cli/src/acp/permission.ts)、
  [Agent config](https://github.com/anomalyco/opencode/blob/v2.0.16/packages/schema/src/config/agent.ts)。

## 真实 ACP 探针

平台：Darwin x86_64，Node 24.18.0，OpenCode 1.18.33。
从官方 Release 下载到临时目录，没有安装或修改宿主 OpenCode。
二进制 SHA-256：`f53aae8eb68d832ab1bcd27bed88c02de910be61f4b5f90068ae8e93d5e794c9`。

使用临时 HOME、XDG config/data/cache/state 和 config-discovery home；只连接本地
OpenAI-compatible 模拟模型与无副作用 HTTP MCP。没有读取宿主认证，没有真实云模型调用。
受管 Agent 的 `prompt` 包含合成 marker；模拟 provider 直接检查 system 角色与 effort 参数，
因此证明的是协议交付，而不是模型是否服从指令。

执行链：`opencode acp --hostname 127.0.0.1 --port 0` → `initialize` → `session/new`
→ `session/set_config_option` → `session/prompt` → 关闭进程 → 新进程 `session/load`。
原生问答另用 `OPENCODE_ENABLE_QUESTION_TOOL=1` 复验。脱敏结果见
[probe-2026-09-29.json](./probe-2026-09-29.json)。

| 探测                    | 结果与证据边界                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| initialize              | protocolVersion 1；loadSession、HTTP/SSE MCP、image/embeddedContext、close/fork/list/resume 声明存在。声明本身不证明行为。                        |
| fresh/model/effort/mode | 创建成功，返回三个 config options；effort 从 low 改为 high，主模型请求实际带 `reasoning_effort: high`。只有一个模拟模型，未证明跨 provider 切换。 |
| system prompt           | 自定义 primary Agent 的 marker 实际进入 provider 的 system 消息。不是混入 user prompt。                                                           |
| streaming               | 正文 `agent_message_chunk` 在 prompt RPC 返回前收到。                                                                                             |
| MCP                     | HTTP MCP initialize、tools/list、tools/call 完成；ACP tool lifecycle 为 pending → in_progress → completed。                                       |
| 原生问答，默认模式      | provider tools 中没有 question；不是问答成功。                                                                                                    |
| 原生问答，强制开启      | question 被发现并调用，5 秒后仍在等待；Client 只有 tool updates，没有问答/elicitation RPC。取消后返回 cancelled。                                 |
| 活动生成取消            | 在收到正文 delta 且模拟模型仍保持响应流开放时发送 session/cancel，返回 cancelled，同时 usage 全零。不能把零视为精确消耗。                         |
| 跨进程 load             | 用同一私有 data home 与原 native ID 恢复，重放正文；effort high 保留。                                                                            |
| 恢复后继续、手动压缩    | 见脱敏记录的 resumedPrompt、compact、afterCompactionPrompt；不等价于自动压缩事件和 Core startup reinjection 验收。                                |
| workspace 隔离          | 探针结束 workspace 仍为空；没有写入 opencode.json 或 MCP 配置。未执行 marker plugin 的配置发现绕过攻击探针。                                      |

探针进程已关闭，本轮探针的临时 Session 已清理。二进制和上游源码仅保留在仓库外临时目录。

## Pragma 能力覆盖矩阵

以下是调研结论，**不是已实现 Adapter 的 Supported 声明**。完整接入仍遵循
[Runtime 接入清单](../../conventions/runtime-adapter-integration-checklist.md)，未经实现和验收保持
Degraded/Unsupported。现有 OpenCode 的 skills、contextWindow、steering 本来就未实现；
它们的缺口与原生问答回退应分别看待。

| Pragma feature      | ACP 覆盖与适配要求                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| availability        | 可覆盖：原 executable/version probe 加 ACP 握手；重新验证最低版本与 Windows launcher。                                                     |
| authentication      | 需适配：复用现有私有 data home/auth 机制；authenticate 不是登录成功证明，必须分类 provider auth 错误。本次无认证验收。                     |
| modelDiscovery      | 部分覆盖：configOptions 有模型选择值与名称，缺 context limit、modalities、完整模型元数据；保留独立原生 discovery 路径或验证 CLI 目录输出。 |
| modelSelection      | 可覆盖：session/set_config_option(model)，provider/model selector 原样映射；每轮选择在 dispatch 前完成。                                   |
| thinking            | 可覆盖：effort 的 category 为 thought_level；1.x ACP 支持 variants，比现有 1.x SDK Adapter 的边界更完整。                                  |
| freshSession        | 可覆盖：session/new；1.18.33 实测。                                                                                                        |
| resume              | 可覆盖：session/load 与 replay；需要原 ID、原 owner、原私有数据根、原 workspace 校验。                                                     |
| systemPrompt        | 需配置：无标准 ACP system 参数；受管 Agent 配置和 mode 选择。1.x 用 prompt，2.x 用 system；禁止降为 user 消息。                            |
| startupMessages     | 需生命周期适配：Core 可发送首轮消息；fresh/resume/manual/automatic compaction 后注入次数仍需验证。                                         |
| textStreaming       | 可覆盖：agent_message_chunk；1.18.33 实测早于 RPC 结果。                                                                                   |
| reasoningStreaming  | 源码支持 agent_thought_chunk；尚无真实 reasoning fixture。                                                                                 |
| nativeToolLifecycle | 可覆盖：tool_call/tool_call_update；真实 MCP lifecycle 已验证，native read/edit/失败/拒绝还需验收。                                        |
| mcp                 | 可覆盖：session/new/load 的 mcpServers；HTTP 与现有 gateway 匹配；注册失败与实际工具发现需 fail closed。                                   |
| permissions         | 部分覆盖：session/request_permission 可选 once/always/reject；模式、原生配置 deny、路径检查仍由 Adapter 实现。                             |
| userInteraction     | 原生问答存在明确缺口：1.x 默认禁用，强制开启无桥接；2.x 自动取消 form。不能标记已覆盖。                                                    |
| skills              | 需物化：ACP 可列出命令/Skills，但没有上传 Skill 包的 RPC；私有原生 config 下物化完整目录并证明发现/执行。                                  |
| attachmentImage     | 源码支持 base64 image，Core ACP 已有发送路径；需真实 provider request 验证二进制、模型 modality 和大小边界。                               |
| attachmentFile      | 源码支持 resource/resource_link；URI、mime、优化附件路径和无法读取时的诊断还需验证。                                                       |
| attachmentDirectory | 路径引用降级：不等于递归上传；需明确 URI/mime 以及 Core 路径上下文行为。                                                                   |
| usage               | 部分覆盖：含 input/output/cache/thought；Core 当前有作用域、thought 丢失和全零优先问题；多步工具轮次需另验累计口径。                       |
| contextWindow       | 部分覆盖：usage_update(used,size)；1.x 实测 17/128000。2.x 将 prompt usage.totalTokens 作为 used，不能直接认定跨版本口径相同。             |
| compaction          | 手动有 /compact 路径；自动压缩没有稳定 ACP lifecycle 映射，不能仅靠 usage_update 判断压缩完成。                                            |
| cancellation        | 可覆盖 session/cancel；活动文本生成已验证；工具/审批等待期间及超时强杀仍需验证。                                                           |
| steering            | 缺口：没有声明可供 Core 使用的 steering 扩展；2.x 直接拒绝同时存在的 ACP prompt。after_current 队列继续由 Host 提供。                      |
| close               | 可复用 Core process supervisor；仍须验证 EOF、close、取消中关闭、进程组和服务退出。                                                        |
| cleanup             | Host owner 事务和 PragmaPaths 继续负责；关闭进程不删除会话。需验证 Mission 删除和遗留数据路径。                                            |

结构化输出、ExpertTeam、Flow、Context、Memory、Mission Board、delegation 生命周期工具主要由
Core/Host 拥有；ACP 不必原生提供这些领域模型。它们可继续通过当前 Expert allowlist 的 MCP
工具调用，但要做真实组合验收。OpenCode 的 native task/subagent 不能替代 Pragma Team 治理。

## 需要先解决的差异

### 原生问答与审批不是同一个能力

1.x tool registry 的 questionEnabled 仅默认允许 app/cli/desktop，ACP 不在其中。
ACP event handler 只处理 session.status、permission.asked、message part 更新；强制开启
question 不会增加 Question reply 通道。真实探针确认开启后停留在 in_progress。

2.x event.ts 对 form.created 调用 form.cancel，失败则 interrupt；没有转发 form elicitation。
Core ACP driver 虽有 createElicitation 接口，也无法接收供应商根本未发出的 RPC。

目前 Pragma HTTP Adapter 已处理 1.x question.asked 和 2.x form.created。因此这项会形成
现有入口回退。MCP 托管问答是可研究的替代方案，但不能自动证明 native 问答入口保留。

两个版本的 ACP 审批 handler 都只读取 optionId，不消费 Pragma 的 updatedInput。
这是与完整 Core 审批合约的差异；现有 OpenCode HTTP handlePermission 同样未应用 updatedInput，
不要误报为本次切换新增回退。若 UI 支持编辑参数，需明确不能应用时的诊断，不能静默忽略。

### 系统提示词、Skills 与配置治理

1.x 可在私有 config 写 agent.<name>.prompt；2.x 写 agents.<name>.system，再选择对应 mode。
1.18.33 探针证明了系统角色交付与 effort 参数；恢复和压缩后的 system marker 单独记录。
还需证明未知 Agent 不静默退回 build，以及 Core 已组装的完整 prompt 不丢失、不重复。

ACP 没有自动隔离宿主配置。应继续复用 configuration.ts/data-home.ts 的白名单导入与私有 XDG
根，保留真实 shell HOME 语义。仓库 .opencode、ancestor customization、默认 plugins、外部
Skills 的治理仍须做 marker smoke；不能因为改成 stdio 就放开原来拒绝的目录。
受管 Skills 需要增加可信私有路径，而不是恢复宿主全量 customization。

### ACP 内部仍有服务

1.x acp command 调用 Server.listen；2.x 调用 Standalone.start。
Pragma 可以删除自己维护的 HTTP 控制通道，但不能假设 native shell 失去了访问内部服务或
凭据的能力。request-approval/auto-approve 的 shell/Code Mode/external_directory deny 仍保留，
full-access 的边界按原策略处理。每个 Runtime Context 使用独立 ACP 进程及私有 data home，
避免 OpenCode directory-scoped MCP 注册跨 Expert 泄漏。

最新 1.18.33 的 MCP add handler 只调用内存 MCP.add，本次传 mcpServers 后 workspace 为空；
这与现有架构文档对旧 1.x add 会写 project config 的描述不同。此结果仅适用于已查的版本，
不能据此删除 1.18.32 的隔离策略。1.x ACP 的 registerMcpServers 会忽略注册错误，2.x 也有
catch/log 路径；newSession 成功不能单独证明 Pragma 工具可调用。

### 用量与压缩

Core acp-driver.ts 的默认 promptUsageScope 是 session，会对 successive prompt usage 做差。
OpenCode promptResponse 从当前最后一个 assistant message 构造 usage，应首先设为 turn，
再验证一次含多步工具调用的完整 prompt 是否只报告最后一步。探针 MCP 轮次实际产生两次
主模型请求，RPC 只给最后一个 assistant 的 17/4；不能把它冒充完整执行的所有模型消耗。
后台 title/summary 与 compaction 用量是否进入 Host 账本，也需要定义。

OpenCode 返回 thoughtTokens；Core recordReportedUsage 当前没有将其纳入输出统计，Pragma
总量会遗漏这一分项。取消时全零 usage 已实测；Core 当前优先采用任何非空 response.usage，
不会自动退回 RuntimeTokenCounter。修正必须带 reported 优先、零值未知、cache、thought、
多轮非累计和错误/取消用量的测试，禁止新增 OpenCode 本地估算器。

/compact 需要通过 AcpRuntimeBinding.compact 以独立 control prompt 执行，不能把压缩摘要混入
用户答案。ACP event 映射没有稳定自动压缩开始/完成通知；必须找到受管原生事件桥接或保持
自动 lifecycle Unsupported/Degraded，不能靠 token 数下降猜事件，否则 Core startup reinjection
会失去可靠触发边界。

### 恢复与持久化

ACP 和 HTTP 背后都使用 native session storage；现有 native ID 有保留可能，但本次只验证
ACP → ACP，尚未证明旧 HTTP Session → ACP。需要用真实历史 Adapter 写出的 fixture 验证
恢复、模型、系统提示词、MCP 和 workspace 绑定，失败不得静默创建新会话。

2.x load 使用已有 session.location.directory，忽略不同请求 cwd；Core ACP 当前也未独立核对
这一点。Adapter 必须在原 owner 和路径绑定上 fail closed，不能仅凭 load 成功判定恢复安全。

若保留 Runtime Session checkpoint 结构、原 ID 和数据目录且语义不变，传输切换本身不要求
机械升级 storage schema；若改变 metadata、路径或恢复语义，则按 ADR 019 同步提交历史 Schema、
相邻迁移、journal/备份及真实 fixture，禁止将旧 Session 丢弃视为协议切换捷径。

## 建议的实现顺序

1. 明确 native userInteraction 的无损实现路径；补问答桥接或形成明确的产品入口变更设计。
2. 在 runtime-opencode 内准备 AcpRuntimeBinding，复用 Core ACP transport/MCP feature/process
   supervisor。供应商 config、permissions、模型目录和 error 分类仍归该 package；不跨 runtime 导入。
3. 完成 system prompt + skills 私有配置探针，验证 native Agent 选择、三种权限模式和配置隔离。
4. 将 safe steering 设为切换的验收前置条件：先闭合目标结束、并发新 prompt、断连与撤销
   对账，再实现独立原生桥接或 ACP 扩展；验收前保持 Unsupported。修正必要的 Core ACP
   用量归一化，定义自动压缩桥接与 startup reinjection 边界。
5. 用真实旧 HTTP Session 验证恢复，再验证两大版本的完整能力矩阵。模型目录先保留独立发现路径；
   若目标也包括删除所有 OpenCode SDK 依赖，必须补足 CLI discovery 元数据和缓存合约，不能只解析模型名。
6. 验收后删除替代掉的 serve/client/event mapping 与冗余测试，更新架构文档、版本下限和 capability；
   本地只跑相关模块检查与接入 smoke，再完成 Desktop 人工验收。

合入前至少覆盖：fresh、resume、长正文 delta、reasoning、native read/edit、managed MCP、问答、
审批同意/拒绝、取消审批等待、图片真实交付、Skill 发现与调用、manual/automatic compaction、
startup 注入次数、用量去重、owner 删除与两大版本配置发现攻击 marker。

## 补充：如何接入 OpenCode 2.x 原生 steer

用户追问后进一步核对 2.0.16 的公开 HTTP Schema 和 runner：

- [session API Schema](https://github.com/anomalyco/opencode/blob/v2.0.16/packages/protocol/src/groups/session.ts)
  暴露 `POST /api/session/:sessionID/prompt` 与 `/synthetic`，均接受 delivery=steer/queue、
  可选消息 id 和 resume；返回持久 inbox 记录。
- [session admission](https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/session/session.ts)
  将输入持久化；resume=false 仅跳过 wake，不阻止活跃 runner 在后续边界消费输入。
- [runner](https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/session/runner/llm.ts)
  在推进模型 step 前消费 steer 输入，执行中不提升普通 queued prompt。
- [inbox](https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/session/inbox.ts)
  在提升成功后发布 session.inbox.delivered，可按 inbox ID 跟踪投递。

因此 SDK 是可行的原生接入路径，当前 package 已依赖 `@opencode/client`。
以下只演示 admission，不是已经实现或验收的 Pragma steer：

```ts
const receipt = await client.session.synthetic({
  sessionID: nativeSessionId,
  text: instruction,
  description: "Pragma steering instruction",
  delivery: "steer",
  resume: false,
});
```

synthetic 适合编排指导；用户新消息可用 session.prompt 的相同 delivery 参数。
receipt.id 是 inbox ID；HTTP 成功只证明持久接收，不证明当前目标 Invocation 已消费。
需要订阅 delivered，并处理取消、结束、断连和超时。

CLI 的 [opencode api](https://opencode.ai/v2/docs/cli/commands/) 可对明确指定的同一私有 server
调用上述 HTTP endpoint，因此可用于独立探针；它仍是 HTTP 客户端包装，并没有额外 steer 能力。
不能使用默认共享服务或猜测 ACP 私有服务地址来控制 Pragma Session。

严格的 Pragma targetRunId 绑定仍是待解决边界：公开 endpoint 只携带 sessionID，没有
expected active execution 的原子前置条件。resume=false 可以避免主动唤醒空闲 Session，却
不能阻止已接收的输入在目标结束后留存并进入以后一次执行。仅在 Host 先检查 activeRunId
不足以关闭服务端 admission 的竞态；需要验证可原子绑定目标执行的原生桥接/扩展，以及
未消费 inbox 的撤销机制。未解决前只能称原生 steer 候选路径，不能提升 safe steering capability。

如果坚持将执行通道完全切为 ACP，stock opencode acp 当前没有并发注入入口。可研究上游新增
独立 steering RPC，或自有 ACP bridge 对接原生 client；桥接要同时提供目标核对、投递回执与
失败语义。ACP + SDK 控制侧通道需要同一个 native server/session，不能另启服务进程假定状态相同。
本补充源码路径已通过下面的真实 2.x native API 探针验证；仍未证明 1.x 等价语义，
也没有给 Pragma 当前 Adapter 增加 steerTurn。

## Steer 与当前轮结束的竞态：真实 2.0.16 探针

用户要求优先支持 steer，并特别关注“发送时当前轮恰好结束”。这必须是公开的投递语义，
不能仅靠 Adapter 在发送前读取一次 activeRunId。

本次使用 npm 官方 `@opencode/cli-darwin-x64@2.0.16` 二进制、Pragma 已锁定的
`@opencode/client@2.0.16`、临时 HOME/XDG 状态、独立 loopback 私有服务和合成 provider。
不读取宿主认证，不使用真实云模型。固定在原生 wait 返回后投递，确定性覆盖“轮已结束”一侧；
另一个案例在模型请求尚未完成时投递，覆盖活跃轮一侧。检查实际 provider 的消息内容，
不把 inbox 接收回执当作模型已消费。

| 原生调用时机与参数                                               | 实测结果                                                                        | 对 Pragma 的意义                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 空闲 Session，delivery=steer、resume=false                       | HTTP 成功；inbox 保留一项；不启动模型；下一次正常 prompt 的模型输入包含旧 steer | resume=false 不能单独防止指令串到下一轮                                    |
| 空闲 Session，delivery=steer、resume=true                        | HTTP 成功；启动一次新的原生执行；等待后 inbox 为空                              | 会主动唤醒，需要明确纳入 Pragma 的执行归属；不能宣称只作用于已结束的原生轮 |
| 空闲 Session，resume=false，撤销回执对应 inbox 项，再发新 prompt | 撤销后 inbox 为空；后续模型输入不含被撤销指令                                   | 未提升的 inbox 可撤销；本例没有覆盖撤销与 promotion 并发                   |
| 模型请求进行中，resume=false，随后模型正常结束                   | 原生 runner 消费 steer；后续模型请求包含指令；结束后 inbox 为空                 | 证明原生运行中注入入口可用，不证明目标结束的安全绑定已完成                 |

可复现脚本：[`native-steer-probe.mjs`](./native-steer-probe.mjs)。证据：
[`native-steer-2026-09-29.json`](./native-steer-2026-09-29.json)。
安装仓库依赖后，从仓库根目录运行：

```sh
node docs/research/opencode-acp/native-steer-probe.mjs /absolute/path/to/opencode-2.0.16 /tmp/native-steer-evidence.json
```

### 建议的 Pragma 公开行为与验收条件

- 以原 `targetRunId` 为目标。请求在目标已关闭后到达时，不继续调用原生注入接口。
- 明确已被原目标接收的请求返回 steer 成功，仍在工具或模型边界生效；不承诺打断正在生成的 token。
- 明确未投递，或已完成撤销并确认未提升时，建议转入 Pragma 的下一轮队列，保留 requestId，
  返回 requestedMode=steer、effectiveMode=enqueue 和可观察的原因；严格模式则拒绝。
  用户尚未选择默认策略，以上是建议，并非已生效的新行为。
- 已开始原生调用却无法判断结果时，返回 delivery_uncertain；不得自动重发或新建下一轮执行，
  以免同一指令执行两次。原生取消 endpoint 对已提升项可能返回成功的 no-op，不能以 HTTP 成功
  判定已撤销；必须结合 inbox、消息和执行归属对账。
- 在接收 steer、目标收尾与下一轮启动之间建立执行闸门。收尾必须等待已有投递完成并处理遗留项，
  新 prompt、compaction 与恢复不得绕过闸门。只检查 Core activeRunId，或只订阅 delivered，
  都不足以证明原子目标绑定；delivered 首先证明进入原生上下文，不能单独证明某个 Pragma Run 消费。
- 如果采用 resume=true 来保证边界后继续执行，须显式将新原生执行纳入原 Pragma Run 的生命周期，
  重新等待终态并处理取消；不能把它隐式解释为用户选择的下一轮队列降级。
- 不新增持久化版本即可完成时应沿用现有 ownership、requestId 和 deliveryAttempt；如果必须新增
  恢复状态，则遵循 ADR 019，不能依赖进程内锁解决跨崩溃恢复。

现有 Core 已有 SteerNotDispatchedError、SteerDeliveryUncertainError、队列 steer 的 retained
结果及 requestedMode/effectiveMode。需要额外审查 strict steerFallback：
`ExpertSession.prompt()` 基线对原生 steer 的所有异常都调用 fallbackToEnqueue；
它不能直接用于“原生调用结果不确定”的自动降级。本次已限制为明确未投递时才能回退，
并让 durable uncertain 状态阻止默认队列、重复 steer、取回编辑和清空绕过。
此处记录的是待修正的接入风险，没有修改该行为。

验证至少覆盖：投递先于结束、结束先于投递、admission 进行中结束、撤销与 promotion 并发、
下一轮同时启动、回复丢失、取消等待、进程崩溃恢复、相同 requestId 重试。
在这些边界闭合前，不能提升 safe steering capability，也不能删除现有 SDK 实现切为纯 ACP。

## 实现与验收记录

方案已实现，见 [OpenCode Runtime 架构说明](../../architecture/opencode-runtime.md)
和 [ADR 061](../../adr/061-opencode-steering-and-acp.md)。2.x 的 synthetic 注入采用
`resume: true`，并在 Adapter 内绑定 Pragma Execution、等待所有投递与唤醒步骤后才结算。
因此原生步骤刚结束时仍可归入当前 Pragma 执行；Pragma 已结算则明确拒绝并保留队列。
1.x 继续执行普通 prompt 与 FIFO 队列，Host 不显示 steer。

明确未投递保留原 requestId 与顺序；不确定投递暂停整条队列。
恢复只读取同一个私有 native Session，不重发注入。原生历史确认已投递后移除队列副本；
明确取消 pending 并确认未进入历史后回到普通队列。单独的消息不存在不足以排除宿主崩溃后
孤儿服务继续投递，因而保持暂停；这也是当前保守恢复边界。

2026-09-29，真实 OpenCode 1.18.33/2.0.16 与本地模拟供应商运行了累计 33 项 Adapter 测试，
覆盖目标结束竞态、回执丢失、重启后确认和 pending 撤销、下一轮不重放、多步骤原生用量。
另有 Core 队列状态、Host/UI 和投递恢复测试。没有使用真实供应商凭据，不能将 capability
提升为 Supported。
