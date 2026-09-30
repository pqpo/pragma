# Antigravity CLI Runtime

`@pragma/runtime-antigravity` 是独立 Node-only Runtime Adapter，由 Desktop 或 CLI composition root 装配。
Runtime id 为 `antigravity`，kind 为 `antigravity-local`，最低支持 **agy 1.2.13**。

## 原生接入与配置边界

System prompt 使用官方 custom Agent；Skills 与 MCP 使用官方 plugin discovery；多轮输入输出使用
`--input-format stream-json --output-format stream-json`。不生成 always-on system rule，不将全量 MCP
Schema 写入提示词，不使用 PTY 或 SQLite 包装器。Google 的 ACP 是独立 `agy_acp_server`，本次不接入。
原生探针及 ACP 调研见 [研究记录](../research/antigravity-acp/README.md)。

每个 Runtime Session 的私有布局为：

```text
runtime/antigravity/
├── home/                            # isolated-environment 的私有 HOME
├── managed-customizations/.agents/
│   ├── agents/<unique-agent-name>.md # Core 完整 system prompt
│   ├── hooks.json                   # Session 唯一 namespace 的权限 Hook
│   ├── plugins.json
│   └── plugins/pragma-<session-hash>/
│       ├── plugin.json
│       ├── mcp_config.json          # Session HTTP Gateway
│       └── skills/<namespaced-name>/ # 完整 Skill bundle
├── hooks/pragma-pre-tool-use.mjs     # relay URL 和凭据仅存在私有文件
├── logs/stream-<uuid>.log
└── tmp/
```

配置、插件副本和原生运行状态不进入 Expert workspace。`PragmaPaths` 与 Core 管理 Session ownership
和恢复引用。Session namespace 和 MCP server identity 保持稳定，以便恢复已有 conversation。
Session 首次访问重建受管配置，只移除该 namespace 的旧 rule 与重复 Agent，不全量扫描其他 Session。
本次不改变持久化 Schema。

认证有两个显式模式：

- `isolated-environment`：完整私有 HOME，使用官方 `AGY_ADC_AUTH` 或可在私有环境工作的认证。
- `host-keyring`：保留宿主 HOME，支持交互式 OAuth 登录。`auto` 在启用 ADC 时选择前者，否则选择后者。

host-keyring 模式下 Pragma 不读取、复制或物化宿主 `.gemini` 配置，但 agy 会按原生语义共享宿主
settings、全局 customization、MCP Schema 缓存及 native conversation 存储。这是明确的兼容边界；恢复
只读取已拥有的 conversation，不扫描宿主 Session 树。两种模式均使用私有额外 customization workspace。
relay 凭据不进入 agy 进程环境或子 shell；原生自动更新禁用。

## System prompt、startup 与 Skills

Agent 正文逐字承载 Core system prompt，声明 `mainAgent: true`、`subagent: false`、
`inheritCustomizations: true`、`permissionMode: acceptEdits`，并显式声明经过原生目录核对的文件读取、
创建、编辑、命令执行、命令状态、MCP 与用户问答工具。CLI 的 `--mode accept-edits` 不能代替 custom Agent
自身的工具与模式声明；缺少这些字段可能使模型只获得读取能力，MCP 写入成功也不能证明原生文件写入可用。
`tools` 填写的是 custom Agent component 名称，不能复制 `init.tools` 的完整展示目录：例如
`command_status`、`send_command_input` 由 `run_command` 带入，MCP 由 customization 继承。
将这些内部工具名直接写入列表会导致 `unknown component`；该明确配置错误不得被启动期间的临时认证
日志误分类为未登录。
非 full-access 的 `commandExecutionPolicy` 使用 `sandbox`，full-access 使用 `eager`；审批模式不再使用
`off`，让命令调用能够到达 Host Hook。工具可见性与调用授权分别处理，auto-approve 的 shell 拒绝策略仍由
relay 执行。启动使用注册名称 `--agent <name>`，而非绝对文件路径；init 参数回显
不等于 Agent 真正加载，真实测试必须验证 system marker。继承宿主 customization 的行为仍受上述认证边界约束。

Startup 生命周期完全使用 Core driver：fresh conversation 首次消费，普通后续请求不重放；恢复
conversation、CLI 重启或配置切换不视为首次对话。只有经确认的压缩 completed 事件才使 Core 在下一次
用户请求重注入一次；重复完成事件合并，started、failed、状态不明与历史回放不触发注入。
输出格式修复重试不重复注入。Core 的重注入预算及诊断继续有效。

每轮只写一个 NDJSON user event。startup 按顺序成为 `message.content` 中的 text blocks，当前请求为
最后一个 block；不添加角色/字符数文本帧，不把 startup 分拆成额外模型轮次。准备失败不消费 startup；
确认未 dispatch 的失败使用 `RuntimeTurnNotDispatchedError`，由 Core 保存已消费内容供下次 submission
重试。已发送或发送结果不确定时不自动重放。Core 的待注入状态在同一 RuntimeSession 内跨 CLI 重启保留；
本次没有新增跨应用重启的注入状态持久化协议。

实现与回归参考 Qoder、Codex、OpenCode 的 fresh-only 挂载与一次消费，以及 Pi 的压缩时序和失败处理。
不照搬共享 ACP driver 每次新连接 bootstrap 的策略。

Skills 保留完整目录、引用文件和可执行权限，过滤 `node_modules`。名称按 Session namespace 改写。
agy 可通过自然语言按需读取 Skill，也支持显式 slash；Adapter 只将当前请求的首个已注册 slash 映射
为 namespaced 名称，包括 Core 附件路径上下文中的受控 `# My request` 区段。startup 不参与该映射。

## MCP 与权限

Session HTTP Gateway 只注册当前 Expert 的工具白名单；工具别名遵守 agy 64 字符完整名称预算。
插件的本地 server key 为 `p`，原生身份为 `pragma-<hash>_p`。Gateway 的工具目录用于注册与诊断，
不再注入 system prompt。agy 原生会将单工具定义缓存为 JSON，并让模型按需读取；这是原生实现行为。

PreToolUse relay 是三种模式共同的权限闸门。headless stream-json 尚无已验证的交互审批控制通道，
因此保留官方 Hook 入口与 `--dangerously-skip-permissions`，避免原生第二次非交互审批阻塞：

- request-approval：受管 MCP 与安全读取通过；其他受支持操作交由 Host 审批，无 handler 则拒绝。
- auto-approve：受管 MCP、已知 workspace 文件工具通过；shell、网络和未受管操作不自动通过。
- full-access：通过合法 workspace identity 校验后允许操作。

额外读取范围仅包含完整受管 Skills 根，以及当前受管 server 的
`<native-home>/.gemini/antigravity-cli/mcp/<native-server-name>/`。这些路径仅供读取，使用 realpath
和路径 containment 校验，阻止相邻 server、符号链接越界及写入；不开放整个 `.gemini` 或受管 workspace。
Hook workspacePaths 可包含 Expert workspace 与私有 customization workspace，但它们不等于模型文件读取授权。
relay 关闭、请求损坏和审批失败均 fail closed。

用户 workspace 的 `.agents`、`.agent`、`_agents`、`_agent` 可能在 relay 前启动额外 Hook、stdio MCP 或
插件，因此 Session 准备与每轮请求前均拒绝包含这些根的 workspace。Core 的 AGENTS.md 与显式 Skills
仍通过受管路径提供。需要原生 workspace customization 的项目使用隔离 workspace。

## 多轮进程、事件与用量

每个 Runtime Session 常驻一个进程：

```text
agy --input-format stream-json --output-format stream-json
    --agent <registered-name>
    --add-dir <expert-workspace> --add-dir <private-customization-workspace>
    --log-file <session-log> --mode accept-edits
    [--sandbox] --dangerously-skip-permissions
    [--conversation <owned-id>] [--model <selector>] [--effort <level>]
```

每轮以 `result` 收尾，stdin 保持开放；正文、thought、工具 snapshot 与错误状态按轮清空。
compaction operation ID 在连接内去重，不将缺少状态的信息推断为 completed。
模型或 effort 变化时关闭空闲进程，再使用同一 conversation ID 启动。取消和异常停止进程，后续请求按
已拥有 ID 恢复；identity 不匹配拒绝执行，不静默 fresh。关闭先结束 stdin，再使用 Core 有界 TERM/KILL，
进程清理后才释放 relay、MCP registration 和 registry lease。异步回调绑定具体连接与请求，旧连接不得修改
新连接的 identity 或取消后续请求；stdout EOF 和退出后的管道 drain 均有界等待，停止过程由 Supervisor 去重。

NDJSON 使用 UTF-8 decoder、4 MiB 单行上限和官方 `event` envelope。保留真实增量、snapshot 去重、
thought、工具 lifecycle、session、compaction 与脱敏的未知事件；移除旧 `type` envelope 和纯文本 stdout
兼容模式。显式 native failure 始终失败，不从日志推断成功。

成功退出但缺少 result 时，只允许已完成的 assistant step，或已拥有 conversation 的当前轮 transcript
恢复。读取前记录 inode/size checkpoint；恢复须出现本轮 USER_INPUT 后的 settled model response。
rotate、truncate、无法 checkpoint 或缺失边界不接受旧答案。不会扫描最近 conversation。每个进程使用独立
日志文件，每轮记录日志 checkpoint 并清空 stderr tail，错误分类不得读取上一轮的诊断。无已拥有 conversation
ID 的输出不能作为成功结果。异步 OS spawn 失败在写入 stdin 前识别，以允许 Core 重试 startup。

原生 `result.usage` 在常驻进程中是累计值；Adapter 按进程基线求差，只通过一个 native usage 事件提交。
恢复进程首轮累计基线不确定时，不把历史用量记为本轮；采用可归属的 step usage，否则调用 Core
RuntimeTokenCounter 并标记 estimated。step snapshot 按 ID 去重，不能与终态差值重复相加；累计值回退
或缺失时不制造负数和历史计费。startup 在 fallback 输入中只计算一次。
没有可靠 context-window denominator，不伪造占用率；压缩能力在真实事件证据不足时继续 degraded。

模型目录来自 `agy models`，selector 作为 opaque ID 使用；无假模型目录。图片、文件与目录目前通过
Core 受控路径上下文提供，图片标记 degraded，不伪造原生媒体上传。

## 验证

定向测试覆盖原生配置、fresh/restore startup、Core 压缩重注入、常驻多轮、累计 usage、权限路径与取消。
真实 smoke 验证三种权限模式的 HTTP Gateway、Context 写入/读取、长工具别名、Agent marker、Skills、
streaming 和 conversation 恢复：

```bash
PRAGMA_ANTIGRAVITY_REAL_SMOKE=1 \
PRAGMA_ANTIGRAVITY_SMOKE_AUTH_MODE=host-keyring \
PRAGMA_ANTIGRAVITY_SMOKE_MODEL=gemini-3.8-flash-low \
pnpm --filter @pragma/runtime-antigravity exec vitest run test/real-smoke.test.ts --reporter=verbose
```

真实执行记录与未验证边界见研究记录；合成 compaction fixture 不等于真实压缩验收。无 ADC 凭据时不宣称
ADC end-to-end 通过；Desktop 人工审批和 UI 验收也需独立记录。

## 原生写入回归与其他 Runtime 检查

`test/real-smoke.test.ts` 的原生写入场景分别覆盖三种权限模式：使用 `write_to_file` 创建文件、
`replace_file_content` 编辑文件，并由测试直接读取磁盘核对内容；释放并恢复 Session 后再次编辑。
request-approval 必须收到并通过 Host 审批，full-access 直接执行；两者还使用 `run_command` 实际创建
第二个文件。auto-approve 保持不自动批准 shell，权限拒绝由 `permission-hooks.test.ts` 验证。

2026-09-30，Darwin x86_64、agy 1.2.13、host-keyring、gemini-3.8-flash-low：上述真实原生写入场景
3/3 通过（256.97 s）。磁盘内容与原生工具完成事件均核对，request-approval 收到文件和命令的 Host
审批，恢复后的文件编辑与 shell 写入通过。单独对照验证：只设置 acceptEdits 而省略 tools 的 custom
Agent 明确报告缺少 write_to_file/run_command，两个文件均未创建；显式组件配置下两个文件实际创建成功。
配置还保留此前默认提供的 generate_image、schedule、manage_task 与 send_message，未调用它们产生副作用。
原有真实回归场景 4/4 通过（159.94 s），覆盖三种模式的 MCP 与新 Runtime 恢复，以及 Skills、
流式输出、图片路径降级和连续多轮输入。此记录覆盖 Runtime 执行与 Host 审批协议，未执行 Desktop UI 人工验收。

## Assistant 分段与 Mission 实时投影

agy 1.2.13 的 `result.response` 会拼接本轮全部 `agent_response`，包括工具前的说明。Adapter
必须在工具开始前或下一 assistant step 开始前完成上一段，使用 `stopReason: toolUse`，并保留该段
thinking；工具后的 delta 创建新消息。终态 completion 与 turn result 只输出尚未完成的最后一段，
不能把已经保存的前缀再次作为最终答复。最终文本与当前 step 的完整快照相同时，按仅最终段处理，
即使它重复了前文也不能裁剪。缺失 result 时，优先定向读取当前 turn 的最后一条已完成 transcript
response，不通过文本拼接或换行前缀猜测分段。

同一 step 同时携带 raw_thought 和正文 delta 时，先发 thought.delta，再发 message.delta，保持与
持久化内容顺序一致；已经完成的 step 不再向下一段转发迟到的思考快照。工具作为最后一步且没有
后续正文时仍发出空的终态 completion，阻止 Core 把已保存的说明再次生成 assistant 消息；Mission
实时投影关闭已有段，终态结果引用最后一段已有文本。

仅依赖 Core 在 tool.started 时保存消息不足以保证实时显示：Mission 实时投影通过
message.completed 关闭流式消息；缺失边界会把工具后的 delta 写入工具上方的旧消息，并在终态合并
历史时重复显示。Desktop 投影回归同时检查工具后的流式位置、终态与历史内容及消息 ID 一致性。

2026-09-30 同环境真实 smoke `assistant segments around native tools` 通过（38.83 s），经完整 Core
链路验证两次原生工具调用与三段文本的顺序、toolUse/toolUse/stop 及最终结果仅含最后一段。
`agy-1.2.13-assistant-segments.ndjson` 是依据真实 stream-json 形状扩展的两工具合成 fixture，
另外覆盖聚合 result、仅最终文本 result 和缺失 result；它不替代上述真实执行验收。

CR 补充回归覆盖重复前缀的最终答复、transcript 换行归一化、同事件 thinking/body 顺序和无工具后
正文的终态。Desktop `src/test/mission-antigravity-chat-stream.test.ts` 注入原生 NDJSON 进程输出，经过真实 Adapter、
Core 持久化及 Mission 投影，比较实时、历史与合并结果的内容、顺序和消息 ID，不手工伪造消息记录。
比较包含终态历史排序与 renderer 的实际 patch reducer；无工具后正文时也保持最终答复的位置一致。
Runtime 内部会话历史继续保留本轮全部 assistant 文本，用于后续轮次的统一 Token 估算；仅对外
turn result 返回最终段，不能因此漏计工具前的文本。

2026-09-30 CR 后复验（同上述环境）：真实 agy smoke 8/8 通过（448.53 s），覆盖三种权限模式的
原生文件创建/编辑、允许命令执行的两种模式、MCP 与恢复、三段文本、Skills、图片输入降级及多轮。
agy 自动测试 148 项、Desktop 消息回归 68 项、队列刷新门禁 56 项及定向 Mission Runner 5 项通过；
其他五个 Runtime 的相关定向测试 44 项通过。Desktop build 与 main/preload/styles 检查通过。
上述结果覆盖代码与自动执行链路，未执行 Electron UI 人工验收。

运行这些场景：

```bash
PRAGMA_ANTIGRAVITY_REAL_SMOKE=1 pnpm --filter @pragma/runtime-antigravity exec vitest run \
  test/real-smoke.test.ts -t 'workspace files with native tools' --reporter=verbose
```

2026-09-30 同类配置检查（源码与定向自动测试，不代表其他 Runtime 的真实模型执行验收）：

| Runtime     | 原生文件与 shell 路径                                                                           | 检查结果                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Codex       | Desktop/CLI 显式选择 `workspace-write`，full-access 使用 `danger-full-access`                   | 未发现工具注册遗漏；直接使用 Adapter 时仍受显式选项及原生配置影响          |
| Claude Code | ACP worker 使用原生 SDK 工具；Host 将模式映射到 `default` / `acceptEdits` / `bypassPermissions` | 未发现自定义 Agent 空工具列表                                              |
| Qoder CLI   | SDK 使用原生工具；仅禁用 `AskUserQuestion`，MCP 白名单单独配置                                  | 未发现文件与 shell 工具被整体禁用                                          |
| Pi          | 原生 coding tools 加上 Session Bash tool，managed tools 单独注入                                | 未发现读写工具注册遗漏；真实本地 Bash 环境测试通过                         |
| OpenCode    | workspace edit 使用 allow/ask；普通模式显式拒绝 shell，full-access 允许                         | shell 限制是现有凭据隔离边界，详见 [OpenCode Runtime](opencode-runtime.md) |
