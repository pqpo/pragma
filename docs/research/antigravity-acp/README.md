# Antigravity 接入方式与 ACP 调研

日期：2026-09-29。代码基线：`51eb5cf0`。本机：macOS x86_64，agy **1.2.13**，真实模型
`gemini-3.8-flash-low`。官方 ACP Registry 当前发行：**1.2.1**。

本次审视 system prompt、startup messages、Skills、MCP、权限和执行协议，新增调研与脱敏
探针证据，没有修改 Runtime、依赖、feature 声明或持久化协议。

## 2026-09-30 原生 CLI 重构验收

本次已实施原生 Agent、Session 私有额外 `.agents` workspace、plugin Skills/MCP 和常驻 stream-json。
最低版本提升为 1.2.13；删除全量 Schema rule 与 startup 文本帧。下文的“当前实现”表是 9 月 29 日的
调研基线，最新实现以 [架构文档](../../architecture/antigravity-cli-runtime.md) 为准。

真实环境：Darwin x86_64，agy 1.2.13，`gemini-3.8-flash-low`，host-keyring。已执行：

- 三种权限模式均完成 HTTP Gateway Context 写入/读取、独立工具调用和新 Runtime 恢复；full-access
  额外验证超长工具名的 Gateway 别名。独立工具要求的枚举值只在 inputSchema 中提供，并由工具端核验。
- 组合测试证明 Agent system marker、自然语言 Skill 发现及独立 supporting reference 读取、native view_file、managed MCP、图片路径
  降级与首个 delta 早于终态。三个用户请求复用一个真实 stream-json 进程；实际 stdin 第一轮含 always-on
  startup blocks，后两轮各只有当前请求 block。
- 自动回归覆盖 fresh/restore 一次消费、模型选择前失败、进程切换、取消、identity mismatch、Schema
  只读/相邻 server/符号链接边界、累计用量差值及恢复首轮的 step usage/Core fallback。

质量检查：Antigravity 定向单测 138 项、Core startup 回归 9 项通过；仓库 lint、typecheck、test:core、build，以及 Runtime feature / DSL version 检查通过。真实 smoke 三种权限模式 3 项通过，强化后的三轮组合测试 1 项通过。

运行命令见架构文档。真实 stdin 使用官方 `event: "user"` envelope；实现首轮 smoke 曾检测并修正了误写
`type` 的问题。此项保留真实 smoke，不只依赖与实现相同的合成输入。

压缩完成后的重注入由 Core 生命周期测试与 Antigravity 事件映射测试覆盖；没有取得真实 CLI 压缩事件
证据，仍维持 degraded。ADC 无真实凭据，本次仅验证物化和隔离，不声明 ADC end-to-end 通过。
Desktop 人工 UI 验收与 ACP 初始化协商仍未完成。没有修改持久化 Schema 或跨应用重启的 startup 状态协议。

## 结论

当前适配把原生 customization、文本补丁与工具权限 relay 混在一起。可以通过官方 CLI 接口
直接简化其中多项；ACP 值得优先验证，但还不能宣布完整替代。

必须区分两个事实：

- Pragma 把全部 MCP Schema 追加到 `pragma-system.md` 是自己的补丁。
- agy 原生会把 MCP 工具定义缓存为单工具 JSON，并允许模型按需读取。本次真实验证了
  `view_file → call_mcp_tool`。因此“模型读取工具定义文件”本身不能判定为异常。

此前认为 agy 不需要模型读取 Schema 文件的判断过于宽泛。MCP 的 `tools/list` 是客户端
获取 Schema 的协议；客户端如何把 Schema 提供给模型，仍由其实现决定。

Google 提供独立的官方 `agy_acp_server.par` / Windows `.exe`，Registry 作者为 Google LLC，
下载来自 `dl.google.com`。本机 `agy --help` 没有 ACP 开关；不能把它描述为 `agy --acp`，
也不需要采用第三方 PTY/SQLite 包装器。[官方 Registry 条目][registry]、[官方 Zed 接入][zed]

## 当前接入与建议

| 能力             | 当前 Pragma 实现                                                                                       | 官方路径及本次结论                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| system prompt    | 同时写 custom Agent 与 always-on rule；启动不传 `--agent`，实际依赖 rule                               | Markdown Agent 正文承载 system prompt；通过 `--agent <注册名称>` 选择。1.2.13 中直接 workspace Agent、额外目录中的直接 Agent 均通过真实 marker 验证                                  |
| startup messages | 角色、字符数和边界标记拼成一个 `-p` 用户字符串                                                         | Core 当前消息角色只有 `user`。native stream-json 可在同一个 user 消息内按顺序发送 text blocks，无需模拟消息协议；两轮实测通过                                                        |
| Skills           | Session plugin 复制完整目录，改写名称；rule 只列 slash 调用，adapter 重写首个 slash                    | plugin 和完整 Skill bundle 是原生支持；自然语言任务可触发模型按需读取 Skill，本次实测通过。不能继续宣称 CLI Skills 只能显式 slash 使用                                               |
| MCP              | Session HTTP Gateway + plugin `mcp_config.json`，再把全量目录与 Schema 写入 rule                       | 保留真实 Gateway 注册、名称预算与 allowlist；让 agy 负责发现和单工具 Schema 读取，删除全量 Schema rule 补丁。原生 stdio 探针验证了完整读取和调用路径；实际 Gateway HTTP 路径仍需回归 |
| 多轮             | 每轮启动新 `agy -p`，通过 conversation ID 恢复                                                         | 官方 `--input-format stream-json --output-format stream-json` 支持一个进程多轮。不是 ACP，但可以先减少逐轮进程装配成本                                                               |
| 权限             | 所有模式均传 `--dangerously-skip-permissions`，以 `PreToolUse → Node script → HTTP relay` 替代原生审批 | ACP 的 `session/request_permission` 可直接对接 Host。headless stream-json 不支持 control request/response，不能单独解决交互审批；未验证 ACP 前不能直接删除现有闸门                   |

代码依据：

- [`managed-home.ts`](../../../packages/runtime/antigravity/src/managed-home.ts)：
  `managedAgentMarkdown()`、`managedSystemRuleMarkdown()`、`materializeAntigravitySkills()`。
- [`session.ts`](../../../packages/runtime/antigravity/src/session.ts)：
  `createAntigravityArgs()`、`formatAntigravityPrompt()`、`expandAntigravitySkillInvocation()`。
- [`adapter.ts`](../../../packages/runtime/antigravity/src/adapter.ts)：permissions feature
  只把受管 Skills 根加入模型额外只读范围。
- [`permission-hooks.ts`](../../../packages/runtime/antigravity/src/permission-hooks.ts)：
  request/auto 模式的只读 containment 没有包括当前受管 MCP 的原生 Schema 缓存根。
- [`context-manager.ts`](../../../packages/core/src/agent/context-manager.ts)：
  `ExpertAgentStartupMessage.role` 当前固定为 `"user"`。

## 真实 CLI 探针

脱敏原生事件和 MCP 请求见 [probe-2026-09-29.json](./probe-2026-09-29.json)。探针全部使用新建
临时 workspace；没有写宿主全局配置，没有安装到用户 PATH，没有操作原有 Session。OAuth
测试保留宿主 HOME，因此 agy 按原生语义创建了测试 conversation、日志和 MCP 缓存；这些
合成 Session ID 保存在证据中。探测进程已停止。ACP 下载与临时 workspace 留在探针临时目录。

### System prompt

在 `<customization-workspace>/.agents/agents/pragma-probe.md` 中声明 `mainAgent: true`、
`subagent: false`、`inheritCustomizations: false`，正文只指定合成 marker。

1. 同 workspace 下用 `--agent pragma-probe` 启动，返回正确 marker。
2. 在另一个空 workspace 下，增加 `--add-dir <customization-workspace>` 并按名称选择 Agent，
   同样返回正确 marker。这提供了无需修改用户 repository 的受管 sidecar 路径。
3. 把 `--agent` 值改成 Markdown 文件绝对路径，返回 `NO_MARKER`。值得注意的是 init 仍回显
   这个参数值，因此不能仅凭 init 的 `agent` 字段证明真实 Agent 已加载。

本次验证的是 `.agents/agents/` 直接注册；旧实现所述 plugin Agent 的早期解析问题没有在同一
layout 上复验，不能据此断言该 plugin 缺陷已修复。后续实现应采用已验证的直接注册路径。
生产还需验证长 prompt、继承控制、恢复和 config 隔离，而不只验证 marker。
[官方 Agent 定义][agents]

### Startup messages 与多轮

直接启动常驻 stream-json，第一轮 `message.content` 是两个 text blocks：首个是 Host startup
context，第二个是当前请求；第二轮只发送当前请求。两轮均返回 startup marker，同一个
conversation ID，只有一个 init、两个 result。

每个输入 user event 都执行一次模型 turn。不能将每条 startup message 分别作为独立 event
发送来“加载历史”，否则会增加模型执行轮次。这里采用同一 event 的多个 blocks。

native result 的 usage / num_turns 是 Session 累计值；切换常驻通道后必须按原生 step 用量或
累计差值结算，不能把每次累计 usage 当成逐轮值重复入账。实际两轮 input totals 为 13,100 和
26,300。首次失败重试、resume 不重复注入、compaction 后重注入仍属于 Core 生命周期验收。
[官方 headless 协议][headless]

### MCP：原生就有 Schema 文件

探针 plugin 只包含 `plugin.json` 和 `mcp_config.json`；没有 rule、没有额外 Schema 提示。
stdio server 的 `tools/list` 返回一个工具，唯一必填参数的值只出现在 `inputSchema.enum` 中，
不在用户请求中。server 自己校验参数，避免把模型口头声称成功当成调用成功。

- 禁止文件读取的对照：工具已发现，模型调用时传 `{}`，server 返回
  `INVALID_SCHEMA_ARGUMENT`。
- 允许读取原生工具定义：模型 `view_file` 读取
  `<HOST_HOME>/.gemini/antigravity-cli/mcp/pragma-research_p/pragma_schema_probe.json`，
  再传入正确的 `sentinel_value`，server 返回 `PRAGMA_MCP_SCHEMA_VERIFIED`。

本次工具只有一个，因此结果直接反驳了“必须把全部 Schema 放到 rule 才能调用”的假设。
对照失败不证明所有模型每次都必须读文件；它证明应兼容 agy 原生按需读取路径。

MCP 探针使用 sandbox 与 skip-permissions 排除无 UI 审批干扰；这只是工具发现/参数传递验证，
**没有验证生产权限闸门**，也不能作为无 Hook 权限已安全替代的依据。

用户提供的 Pragma rule 文件实际为 57,863 bytes，包含 48 个工具；而官方 rules 限制为单文件
24,000 bytes，所有 always-on rules 总计 20,000 tokens，超限可截断或降为文件指针。
这支持“当前全量追加方式不可可靠注入”的结论；没有该原始 Session 的展开证据，不能确认
它实际触发哪一种限制。[官方 Rules 限制][rules]

权限设计同时存在冲突：当前 Pragma 非 full-access 模式没有开放受管 MCP 的原生 Schema
缓存目录，却在 rule 中禁止模型读取工具定义。正确修复应允许精确的当前 Session/server
Schema 只读范围；不能开放整个 `~/.gemini`，也不能把额外 customization workspace 整体开放
给模型。host-keyring 模式的原生缓存仍位于宿主 HOME，必须披露这个边界。

### Skills

在 plugin `skills/pragma-research-skill/SKILL.md` 定义独立 marker。使用普通自然语言任务，
没有 slash，没有 rule 中的 Skills 列表。模型主动读取该文件并返回正确 marker。

当前完整复制 bundle 的做法有价值；需要去掉“只能 slash”的提示及过时能力说明。
名称映射只负责用户显式 slash 与 Session namespace 的映射，不应承担 Skill 激活。
[官方 Skills 机制][skills]

## ACP 能减少什么成本

仓库已有 [`defineAcpRuntimeDriver()`](../../../packages/core/src/runtime/acp-driver.ts)，使用标准
NDJSON JSON-RPC、session/update、permission、cancel、load 和 config options。
Antigravity 可以复用这层，不需要新建跨 Runtime package，也不应复制 another ACP driver。

| 边界                    | ACP 的价值                                                                          | Antigravity 本次证据 / 待验证                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 流与工具 lifecycle      | 统一 session/update，减少 1,801 行 native session 模块中的供应商事件处理            | 官方发行确认；实际握手未完成                                                                |
| 权限                    | session/request_permission 直接接 Host，可能移除 756 行 Hook/relay 模块的大部分职责 | 需验证所有权限模式与实际工具覆盖；协议只说 Agent MAY 请求，不能假定每个工具都回调           |
| MCP 注册                | session/new/load 的 mcpServers 可以直接提供 HTTP Gateway                            | 需握手确认 mcpCapabilities.http，实际 tools/list/call 与恢复重新绑定                        |
| 会话恢复                | 标准 session/load                                                                   | 必须声明 loadSession 并能恢复拥有的 Session；CLI 与 ACP Session ID/存储不一定可互换         |
| 图片与文件              | 标准 content blocks，可减少 CLI 路径降级                                            | 按 promptCapabilities 协商，实际图片与文件验证                                              |
| system prompt           | 没有标准 system prompt 参数                                                         | 仍需官方 provider 配置、Agent/mode 或明确公布的扩展；不能塞 `_meta.systemPrompt` 并假定生效 |
| startup context         | 同一 prompt 的 text blocks 可以满足当前全部为 user 的契约                           | 不是导入任意 user/assistant/system 历史，也不是在无模型执行情况下追加历史                   |
| Skills                  | 标准 ACP 没有 skills 注册参数                                                       | 仍需原生 customization 或官方 provider 配置；验证受管目录隔离和按需读取                     |
| steer / compact / usage | 部分来自可选 capability / 扩展                                                      | 逐项探测，不能从 ACP 名称推导 active-turn steer、手动压缩或精确 cache token 分项            |

[ACP session setup][session-setup]、[ACP prompt/permission][prompt-turn]、[ACP capability 协商][initialize]

### 本机官方 ACP 探针的限制

从官方 Registry 下载 macOS x86_64 1.2.1，archive 117,493,869 bytes，包含
`agy_acp_server.par` 和 `localharness_external`。下载完整且解压成功；没有替换本机 agy。
以私有 HOME、空 client capabilities 发送标准 initialize，在两次独立启动中分别等待约
45 和 120 秒，均未收到 initialize response；较长尝试没有 stdout/stderr，随后定向终止。

因此未能实测其 authMethods、HTTP MCP、loadSession、model options、permission 或 prompt。
这不是“不支持 ACP”的证据；也没有证据定位启动失败原因。不能用第三方包装器的能力、
CLI 的成功或 Registry 上架代替官方 server 的本机验收。Core 当前握手 deadline 为 15 秒，
正式接入还需要确认冷启动时间与错误诊断。

## 建议实施顺序

1. 先采用本机已验证的原生 CLI 能力：受管 sidecar 的直接 Agent + `--agent`、有序 user text
   blocks、原生 Skills、原生 MCP Schema；删除全量目录 rule 和与其绑定的禁止读取提示。
   system prompt 不降为 user prompt，不通过拆分 Schema rules 延续同一种补丁。
2. 改成官方常驻 stream-json 通道，补累计 usage 结算、取消/退出、同一 Session 多轮与恢复
   回归。最低支持版本必须按这些实际能力重新评估，不能只保留 `>= 1.1.11` 声明。
3. 独立完成官方 ACP Server 的启动、认证、provider customization 和 permission 探针；如果
   满足需求，复用 Core ACP driver，移除 native stream parser 与权限 relay。标准 ACP 没有
   覆盖的能力需明确实现依据，不能增加猜测性扩展。
4. 切换前验收三种权限模式、精确 Schema 只读隔离、Expert MCP allowlist、长工具名称、长
   system prompt、Skill resources、startup fresh/retry/resume、Runtime 重建、异常退出和
   future-version 拒绝。确认 CLI 与 ACP 的存储与 Session ID 关系后再设计升级机制；已有
   Session 不静默切换、不删除旧数据、不用空白 fresh Session 伪装恢复。

若 ACP 缺少可靠的 system prompt/Skills 控制，官方 Python SDK 是另一条可评估的路径：
`LocalAgentConfig.system_instructions` 和 `skills_paths` 有显式支持，权限也有官方 policy
handler；但会引入 Python worker/SDK 生命周期与分发成本。它不应被称为“CLI 的 ACP 模式”，
本次仅做文档核对，没有 SDK 执行验收。[官方 Personas][personas]、[SDK Tools][sdk-tools]、[SDK Policies][policies]

[registry]: https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
[zed]: https://antigravity.google/docs/ide/extensions/zed/
[agents]: https://antigravity.google/docs/subagents/
[headless]: https://antigravity.google/docs/cli/headless/
[rules]: https://antigravity.google/docs/rules/#size-limits-and-token-budgets
[skills]: https://antigravity.google/docs/skills/
[session-setup]: https://agentclientprotocol.com/protocol/v1/session-setup
[prompt-turn]: https://agentclientprotocol.com/protocol/v1/prompt-turn
[initialize]: https://agentclientprotocol.com/protocol/v1/initialization
[personas]: https://antigravity.google/docs/sdk/personas
[sdk-tools]: https://antigravity.google/docs/sdk/tools
[policies]: https://antigravity.google/docs/sdk/policies
