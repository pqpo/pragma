# Antigravity CLI Runtime

本文记录 `@pragma/runtime-antigravity` 的协议基线、适配决策与验证边界。实现目标是让 Antigravity CLI
成为可替换的本地 Runtime Adapter，同时保持 Core、Desktop Host 与供应商 CLI 的职责边界。

## 结论

- Runtime id 为 `antigravity`，kind 为 `antigravity-local`，最低支持 `agy 1.1.11`。
- Adapter 只依赖 `@pragma/core`、`@pragma/shared` 与运行时中立依赖，不依赖其他 Runtime。
- 认证使用双模式：ADC 使用 Session 私有 HOME；交互式 OAuth 使用显式 `host-keyring` 兼容模式。
- 两种模式都不由 Pragma 向宿主 `~/.gemini` 复制或物化配置；兼容模式由 agy 原生读取宿主 settings、
  全局 customization，并使用宿主 native conversation 存储，Pragma 自己的配置仍保持 Session 私有。
- 系统提示词通过 Session plugin 的 always-on rule 注入；startup messages 只在 fresh conversation 的首轮注入。
- Pragma 工具通过私有 HTTP MCP session 暴露；native tool 权限通过 fail-closed `PreToolUse` Hook
  回接 Core human interaction。
- MCP 与 Skill 打包为 Session 私有 plugin，完整保留 Skill 的 scripts、references、resources 等支持文件。
- 执行使用官方 `stream-json` 协议，并保留纯文本 stdout、transcript 和日志恢复路径。

## 版本基线

`stream-json`、`init` / `step_update` / `result`、`tool_info`、`subagent_info` 和 usage 是 1.1.8
引入的协议。1.1.10 修复了 `--model` 与 `--effort` 在 headless `-p` 中被忽略的问题；1.1.11 是当前
global customization 路径与认证行为的已验证基线，因此 Adapter 拒绝更早版本。开发时使用官方
macOS x64 `agy 1.1.11` 验证了版本探测、参数面、配置发现、私有 HOME、宿主钥匙串登录、managed
plugin/rule/Skill 发现和真实 `stream-json` 成功响应。

可执行文件解析顺序为：显式 `executablePath`、`AGY_PATH`、`PATH`、官方用户安装目录，最后回退到
`agy`/`agy.exe` 交给进程错误处理。Windows 必须指向原生 `.exe`，不接受无法直接 spawn 的 `.cmd`
shim。版本探测与模型目录刷新都有有界缓存，并按 executable、environment 与 spawn implementation
隔离。

## 认证模式与 Session 布局

Desktop 使用 `auto` 策略：`AGY_ADC_AUTH=true` 时选择 `isolated-environment`，否则选择
`host-keyring`。前者适合官方 ADC；后者用于用户已通过交互式 `agy` 完成的 OAuth 登录。agy 1.1.11
会在 `HOME` 被替换后跳过宿主系统钥匙串，因此 OAuth 模式必须保留真实 `HOME`/`USERPROFILE`。这是
供应商 CLI 的认证约束，不是网络 fallback。

`isolated-environment` 在 owned Runtime Session 中生成完整私有 HOME：

```text
<runtime-session>/
├── home/
│   └── .gemini/
│       ├── config/
│       │   ├── hooks.json
│       │   ├── plugins.json
│       │   └── plugins/pragma-<session-hash>/
│       │       ├── plugin.json
│       │       ├── mcp_config.json
│       │       ├── agents/pragma-<expert-id>-<session-hash>/agent.md
│       │       ├── rules/pragma-system.md
│       │       └── skills/pragma-<session-hash>-<skill>/SKILL.md
│       └── antigravity-cli/
│           ├── settings.json
│           └── ... agy session/cache state
├── hooks/pragma-pre-tool-use.mjs
├── logs/turn-<run-id>.log
└── tmp/
```

`host-keyring` 不写宿主配置，而是在同一个 Runtime Session 中生成官方 workspace customization：

```text
<runtime-session>/
├── managed-customizations/
│   └── .agents/
│       ├── hooks.json
│       ├── plugins.json
│       └── plugins/pragma-<session-hash>/
│           ├── plugin.json
│           ├── mcp_config.json
│           ├── agents/pragma-<expert-id>-<session-hash>/agent.md
│           ├── rules/pragma-system.md
│           └── skills/pragma-<session-hash>-<skill>/SKILL.md
├── hooks/pragma-pre-tool-use.mjs
├── logs/turn-<run-id>.log
└── tmp/
```

隔离模式强制重定向 `HOME`、`USERPROFILE`、XDG 目录、Windows AppData 与临时目录，并移除宿主的
`AGY_APP_DATA_DIR`、`ANTIGRAVITY_HOME`、Gemini config override、Google log override、Antigravity
conversation/project/sidecar 状态及旧的 Pragma Hook secret 变量。
显式认证环境变量与其他业务环境保持透传。`AGY_CLI_DISABLE_AUTO_UPDATE=true`，避免一个受管 Session
在执行中改写宿主安装。

`host-keyring` 保留宿主 HOME/XDG/AppData，只移除可能串扰 Session 的 Antigravity sidecar、conversation、
project、config override 和旧 Pragma secret 变量；临时目录和 Pragma turn 日志仍定向到 Runtime Session。
agy 会按原生语义读取宿主 settings、全局 customization，并把 native conversation 保存在宿主目录。
Pragma 只按当前拥有的 conversation ID 定向恢复，不扫描宿主 conversation 树；Mission 删除也不会删除
agy 拥有的宿主 native conversation。首次 OAuth 登录仍在 Pragma 外运行交互式 `agy`，Adapter 不读取、
复制或导出钥匙串凭据。模型发现同样保留宿主 HOME 和认证配置，但使用隔离 cwd/tmp 并移除 Session 变量。

## 系统提示词与 startup messages

Antigravity 没有等价的 `--system-prompt` 参数。Adapter 在 Session plugin 的 `agents/` 中保留一个
受管 custom agent：

```markdown
---
name: "pragma-...-<session-hash>"
description: "..."
mainAgent: true
subagent: false
hidden: false
inheritMcp: true
mcpServers:
  - "pragma<session-hash>"
commandExecutionPolicy: off
---

# System Prompt

<Core 组装的完整 system prompt，逐字保留>
```

agy 1.1.11 的 print mode 在附加 workspace plugin 加载前解析 `--agent`，传 plugin Agent 名称会静默回退
default Agent，因此 Adapter 不再传这个无效参数。相同的 Core system prompt 由 plugin 的 always-on
`rules/pragma-system.md` 注入，不摘要或拼接到用户消息；受管 Agent 仍随 plugin 物化供原生 Agent/子 Agent
发现。`commandExecutionPolicy` 随权限模式映射为 `off` / `sandbox` / `eager`。Skill
由显式注册的 Session plugin 自动发现；agent frontmatter 不写 `skills:` 路径，因为 agy 1.1.11 的
agent-relative 路径缺少 `AgentBasePath` 并会失效。Session 重新准备时只替换这个受管 Agent
entry，不删除 Antigravity 为已恢复 conversation 保存的动态 subagent。

agy 1.1.11 把 Skill 暴露为显式 slash command，而不是模型可自主调用的工具。用户以原始 Pragma Skill
名（例如 `/review`）开始请求时，Adapter 只重写该命令为 Session 命名空间后的注册名，再交给 agy 原生
Skill expansion；Core 在图片、文件或目录前置路径上下文时，Adapter 只从受控的 `# My request` 区段识别
这个首个 slash invocation，避免附件让 namespace 重写失效。普通自然语言请求不会隐式加载全部 Skill 正文。
Skill expansion 内部发出的只读文件工具仅可读取当前 Session plugin 的 `skills/` 根；普通文件读写仍以
Expert workspace 做 containment，managed-customizations 的 Hook、registry 和其他文件不开放给模型。

Antigravity print mode 每次只接受一个 prompt 参数，因此 startup messages 使用带角色、顺序与精确字符数
的边界帧放在当前请求之前。Driver 的 `consumeStartupMessages()` 只消费 fresh conversation 的初始消息
一次；恢复已有 `conversation_id` 时不重复首轮发送。若 Runtime 后续报告完成 context compaction，Core
仍可按统一预算规则在下一轮重注入 always-on startup messages。消息历史分别记录 startup message 和当前
user message，不把边界帧当作权威历史格式。fresh 首轮如果在产生任何 native conversation identity 前失败，
Core 会保留本次已消费的 startup messages 供下一次 submission 重试；一旦已经观察到 identity，则不重复注入。

## MCP

Adapter 从 Core 的 process-shared `McpToolRegistryPool` 获取连接，再为当前 Expert/Execution 注册独立
MCP session。Adapter 在 `.agents/plugins/pragma-<session-hash>/` 写入 `plugin.json`、`mcp_config.json`
和 Skills，并由 `.agents/plugins.json` 显式注册；不再写无效的 workspace 顶层 `mcp_config.json`。plugin
只声明一个 Session-scoped
`pragma<session-hash>` remote server：

```json
{
  "mcpServers": {
    "pragma<session-hash>": {
      "serverUrl": "http://127.0.0.1:<port>/<private-session-path>"
    }
  }
}
```

该不透明 namespace 只暴露当前 Expert allowlist 投影后的工具。私有 HOME 不继承宿主个人 MCP 配置；
`host-keyring` 会按 agy 原生规则同时加载宿主全局配置，因此属于显式兼容性取舍。
受管 custom agent 保留 `inheritMcp: true` 并用 `mcpServers` 显式选择上述受管 server；实际 print mode
通过 plugin 自身的 MCP 配置发现工具。MCP 的验收标准是 agy 真实发现并
成功完成一次工具调用，而不是文件存在。Antigravity 仍会按其原生语义发现
workspace 内显式提交的 `.agents`、`.agent`、`_agents` 或 `_agent` customization；这些根可以在 Pragma
`PreToolUse` relay 之前启动任意 shell Hook、stdio MCP 或第三方 Plugin，不能被名称 namespace 或同一个
Hook 接管。因此 Runtime 会在 Session 创建和每次 native turn 的 spawn 前 fail closed：只要发现任一根就拒绝
执行。Core 已加载的 `AGENTS.md`、系统提示词和显式 Expert Skill 仍会通过受管路径提供；需要 Antigravity
workspace customization 的项目必须使用不含这些根的隔离/overlay workspace，并将必要配置显式物化到 Expert。
同一 OS 用户在预检后并发改写 workspace 仍属于 Host 无法原子消除的 TOCTOU 风险；对抗该威胁的最终边界是
Host 提供的隔离 workspace，而不是放宽预检。Agent、Skill、MCP server 与 Hook 名称都带同一个由 Runtime
Session 目录派生的 16 位哈希 namespace，防止受管配置相互遮蔽。Session 关闭时按独立生命周期释放 MCP
registration、registry lease 与权限 relay；任一释放失败会聚合上报。

## Skills

Core 已解析的每个 local Skill 都复制到受管 plugin 的
`plugins/pragma-<session-hash>/skills/pragma-<session-hash>-<normalized-name>/`。该根在隔离模式位于私有 HOME，在兼容模式位于 Session
额外 workspace。复制规则为：

- 复制整个 Skill 目录并解引用已选择的链接，保留 `scripts/`、`references/`、`resources/` 与其他文件；
- 排除任何 `node_modules` 子树；
- 强制把 frontmatter `name` 归一为最多 64 字符的小写连字符标识，缺少 `description` 时从 Expert Skill 定义补齐；
- 多个同名 Skill 使用稳定后缀避免覆盖；
- 每次 materialize 前替换受管 skills 根，删除已经解绑的旧 Skill。
- 复制后的目录收紧为 `0700`；普通文件为 `0600`，原本可执行的脚本为 `0700`。

Adapter 不链接或扫描宿主全局 Skills，也不把 Runtime 自己的 builtin Skills 复制进 workspace。
Antigravity workspace customization 根同样不被加载；它们会触发上述 fail-closed 预检，而不是作为隐式 Skill
来源。

## 权限与 Hook

Desktop 的三种权限模式映射为：

| Pragma mode      | Hook policy                  | terminal sandbox | workspace 外访问 | CLI flag                                   |
| ---------------- | ---------------------------- | ---------------- | ---------------- | ------------------------------------------ |
| request-approval | 只读直通，其他进入 Core 审批 | 开启             | 禁止             | `--sandbox --dangerously-skip-permissions` |
| auto-approve     | 受管 MCP 与文件 allowlist    | 开启             | 禁止             | `--sandbox --dangerously-skip-permissions` |
| full-access      | Hook 明确 allow              | 关闭             | 允许             | `--dangerously-skip-permissions`           |

受管 `hooks.json` 以 Session-scoped 名称注册匹配全部 native tools 的 `PreToolUse` command Hook。Hook runner 与本机
loopback relay 使用每 Session 随机 bearer；URL 和 bearer 只写入权限为 `0600` 的私有脚本，不放入 agy
进程环境，避免被 Agent 的 shell 子进程读取。Windows command Hook 的 node/script 路径若包含会被
`cmd.exe` 展开的 `%`、`!` 或换行，prepare 会给出明确错误并 fail closed，而不是生成指向错误目标的命令。

Relay 校验 bearer、请求大小和 `workspacePaths` 身份后执行策略。workspace identity 只接受绝对路径或
严格 `file://` URI，并只允许 Expert workspace 与当前 Session 的 `managed-customizations` 根；普通文件工具的
参数 containment 仍以 Expert workspace 为界，只有 agy 原生 Skill expansion 的只读工具可进入当前
Session plugin 的 `skills/` 根。仅精确匹配受管 Session namespace 的
Pragma MCP tool 自动允许，包括 Antigravity 当前的 `call_mcp_tool` +
`ServerName: "pragma<session-hash>"` dispatcher 格式；`ToolName` 还必须是合法的完整工具标识。直接工具名的
namespace 前缀不作为受管身份依据，避免继承 MCP server 的前缀碰撞或伪造。问题工具映射
到 Core `user_question`；request-approval 下只读且 workspace 内的工具可直接执行，其他工具进入 Core
approval；auto-approve 只允许受管 MCP 和显式 allowlist 中的 workspace 文件工具，原生 shell/terminal、
非受管 MCP、网络/调度/未知工具一律拒绝，要求切换到 request-approval 或 full-access。路径检查覆盖绝对路径、相对 `..` 和现有
祖先的 realpath，避免 workspace 内 symlink 指向外部后被误判；CLI sandbox 继续作为执行时边界。
full-access 直接允许。用户修改 tool input 时，只在 Antigravity 的浅层 `overwrite` 能精确复现新对象时
放行，否则拒绝原调用。所有已知文件工具在审批前和修改后都重新校验最终路径；需要路径却没有可识别字段、
非法 `file://` 或非 file URI 一律拒绝，不能因参数 schema 漂移而自动放行。relay、schema 或网络异常全部
fail closed。

agy 1.1.11 在 `PreToolUse` 已返回 `allow` 和精确 MCP permission override 后，仍会执行第二次原生
non-interactive confirmation 并 soft-deny。Adapter 因此对三个模式都关闭这层无法交互的原生确认，由
Session 私有、匹配全部工具的 Hook 成为权威权限闸门；request/auto 模式仍保留 CLI sandbox。Hook runner
无法连接 relay 时固定返回 deny，workspace 中其他 customization 又会在 spawn 前被拒绝，因此该 flag
不改变三种 Pragma 权限语义。

该 Hook 闭合的是 Antigravity Adapter 的 native tool 路径，不代表项目已经拥有跨 Runtime 的统一
`LocalPermissionGuard`。

## 启动、流与恢复

进程 cwd 就是 Expert workspace，并用公开的 `--add-dir <workspace>` 把同一路径显式钉为 workspace；
不使用未公开的 `--app_data_dir`，也不使用不存在的 `--cwd`。主要参数为：

```text
agy
  --output-format stream-json
  --print-timeout 24h
  --add-dir <workspace>
  [--add-dir <session-managed-customizations>]
  --log-file <private-turn-log>
  --mode accept-edits
  [permission flags]
  [--conversation <conversation-id>]
  [--model <discovered-slug>]
  [--effort low|medium|high]
  -p <prompt>
```

不得传 `--disable-slash-commands`，因为 agy 1.1.11 会同时禁用 Skill expansion，导致 plugin Skill
只有元数据可见、正文不能激活。`-p` 与值保持相邻并放在最后。取消先发 `SIGTERM`，一秒内不退出再发
`SIGKILL`，强杀后的等待同样有界。Session close 先等待该 native 关闭流程，再释放 Hook relay、MCP
registration 与 registry lease，避免仍存活的进程失去控制面。恢复只使用当前 Runtime Session 持久化的
`conversation_id`，绝不使用机器级“最近一次 conversation”。

NDJSON reader 有 UTF-8 边界处理、4 MiB 单行上限与严格的结构化模式切换。1.1.11 的 wire shape 使用
顶层 `event` 判别字段，并把 payload 放在同名的 `init`、`step_update` 或 `result` 对象中；Adapter 同时
读取 1.1.8-era/兼容包装器使用的顶层 `type` shape。事件归一化覆盖：

- `init`：conversation identity、model、tools 与 MCP 状态；
- `step_update`：1.1.11 的 `agent_response` ACTIVE/DONE `text_delta` assistant 增量，以及兼容的
  `PLANNER_RESPONSE`/model response、thought 增量、tool lifecycle、`error_message`、
  subagent progress 与 compaction；
- `result`：最终文本、conversation identity、usage 或 terminal error；
- 未知 typed event：经过递归 secret redaction 后保留为 progress，便于前向兼容诊断。

同一 step 的 snapshot 会去重为 delta。成功退出但缺少 terminal event 时，优先尝试私有
`brain/<conversation-id>/.system_generated/logs/transcript.jsonl` 的 settled `PLANNER_RESPONSE`，其次才接受
明确已完成的 assistant step、历史纯文本模式输出或受管日志中的最终响应；单独的 ACTIVE delta 不能作为完整
成功结果。每次恢复 conversation 前，Adapter 会先记录 transcript 的 inode/size checkpoint；退化恢复只能
读取本次 spawn 后新增的字节，并且其中必须出现本轮 `USER_INPUT` 后才接受 settled model response。文件 rotate、
truncate、无法 checkpoint 或超过 4 MiB 的尾部里缺少该边界时，transcript fallback 会失败而不会把上一轮答案
冒充本轮结果。为兼容 1.1.8 以前及第三方包装器观察到的退化行为，首行不是 typed JSON 时会切换为有界纯
文本 stdout；一旦识别为 typed stream，后续 malformed NDJSON 必须失败，不能静默吞掉协议损坏。
纯文本模式的 `Error: timed out waiting for response`、日志 `Print mode: timed out` 与最后一个
`agent executor error` 会提升为 Runtime error，不能以空白或错误文本冒充成功结果。

## 模型与 Usage

模型目录来自账号态 `agy models`，不维护可能过期的假 fallback catalog。1.1.5 起 `--model` 使用稳定的
user-facing slug；Adapter 把 `agy models` 输出的精确 selector 当作 opaque model id 保存和传递，不从
显示名称中臆造 provider slug。Parser 同时兼容旧版本或第三方包装器输出的
`Gemini 3.5 Flash (High)` 人类可读值，以及“machine id + display name + advertised effort”列式格式。
`--effort` 可独立作用于默认模型；有模型级 advertised effort 时进一步按其约束验证。未登录、空目录或
命令失败均作为可操作错误返回。

终态 `result.usage` 是当前 turn snapshot，不能与 step usage 相加。Adapter 优先使用 reported input、
response output、独立的 `thinking_tokens` 和 cache read/write；`thinking_tokens` 计入 Pragma output。
若同时存在 `total_tokens`，Adapter 用它判断 `input_tokens` 是否已包含 cache read，避免二次计数。
兼容 shape 中直接 output total 优先于 `thinking_output_tokens` / `response_output_tokens` 两个组成字段，
避免重复计数。reported usage 只通过 native usage event 进入 Core，不再同时放入 `RuntimeTurnResult`，避免
Driver 合并同一个 snapshot 两次。无 usage 或全零时只调用 Core 的 `RuntimeTokenCounter` 估算受管输入和输出，并标记为
`estimated`。Antigravity 当前没有在 print stream 中提供可靠的 context-window denominator，因此不伪造
occupancy。

## Attachments 与多模态

agy 1.1.11 的公开 CLI 没有原生媒体输入参数，因此 Antigravity 模型目录明确声明
`inputModalities: ["text"]`，即使底层模型本身可能具备视觉能力也不声称 CLI 已接通图片上传。Core 会把
图片从 native attachments 中移除，将可观察的本地路径上下文加入当前 query，并记录
`runtime.image_input_degraded`；文件与目录引用同样通过受控路径文本进入 prompt。Adapter 不读取图片后
私自 base64 内联，也不使用私有 language-server 协议。未来只有在公开 CLI/SDK 参数和真实媒体 smoke
同时具备时才能把模型 capability 提升为 `image`。

## 参考资料

可显式运行真实 CLI smoke（默认测试不会依赖开发者登录态）：

```bash
PRAGMA_ANTIGRAVITY_REAL_SMOKE=1 \
  PRAGMA_ANTIGRAVITY_SMOKE_AUTH_MODE=host-keyring \
  pnpm --filter @pragma/runtime-antigravity test -- real-smoke.test.ts
```

该 suite 验证首个 delta 与 result settle 之间存在可观察时间差、`list_dir` lifecycle、managed
`list_expert_context` MCP、always-on system marker、plugin Skill、图片路径降级和同一 conversation 的续轮恢复。
运行前必须已完成对应认证模式的官方 agy 登录；未实际运行该命令和 Desktop 人工验收时，不得仅凭 suite
存在声明 end-to-end Supported。

- [Antigravity CLI 安装与认证](https://antigravity.google/docs/cli/install)
- [Antigravity CLI 参数与 settings](https://antigravity.google/docs/cli/reference)
- [Antigravity CLI permissions](https://antigravity.google/docs/cli/permissions)
- [Antigravity CLI sandbox](https://antigravity.google/docs/cli/sandbox)
- [Antigravity Hooks](https://antigravity.google/docs/hooks)
- [Antigravity MCP](https://antigravity.google/docs/mcp)
- [Antigravity Skills](https://antigravity.google/docs/skills)
- [Antigravity custom agents / subagents](https://antigravity.google/docs/subagents)
- [Gemini CLI migration 与 customization 路径](https://antigravity.google/docs/cli/gcli-migration)
- [Antigravity CLI changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)
