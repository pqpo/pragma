# Antigravity CLI Runtime

本文记录 `@pragma/runtime-antigravity` 的协议基线、适配决策与验证边界。实现目标是让 Antigravity CLI
成为可替换的本地 Runtime Adapter，同时保持 Core、Desktop Host 与供应商 CLI 的职责边界。

## 结论

- Runtime id 为 `antigravity`，kind 为 `antigravity-local`，最低支持 `agy 1.1.11`。
- Adapter 只依赖 `@pragma/core`、`@pragma/shared` 与运行时中立依赖，不依赖其他 Runtime。
- 每个 Runtime Session 使用独立、可 checkpoint 的 HOME；不扫描、复制或修改宿主 `~/.gemini`。
- 系统提示词通过 Markdown custom agent 注入；startup messages 只在 fresh conversation 的首轮注入。
- Pragma 工具通过私有 HTTP MCP session 暴露；native tool 权限通过 fail-closed `PreToolUse` Hook
  回接 Core human interaction。
- Skill 以完整目录复制进私有 HOME，保留 scripts、references、resources 等支持文件。
- 执行使用官方 `stream-json` 协议，并保留纯文本 stdout、transcript 和日志恢复路径。

## 版本基线

`stream-json`、`init` / `step_update` / `result`、`tool_info`、`subagent_info` 和 usage 是 1.1.8
引入的协议。1.1.10 修复了 `--model` 与 `--effort` 在 headless `-p` 中被忽略的问题；1.1.11 是当前
global customization 路径与私有 HOME 的已验证基线，因此 Adapter 拒绝更早版本。开发时使用官方
macOS x64 `agy 1.1.11` 验证了版本探测、参数面、配置发现、私有
HOME 写入位置和未登录错误路径；当前开发机没有 Antigravity 登录态，因此真实模型成功响应仍由
协议 fixture 覆盖，而不是宣称完成了账号侧在线调用。

可执行文件解析顺序为：显式 `executablePath`、`AGY_PATH`、`PATH`、官方用户安装目录，最后回退到
`agy`/`agy.exe` 交给进程错误处理。Windows 必须指向原生 `.exe`，不接受无法直接 spawn 的 `.cmd`
shim。版本探测与模型目录刷新都有有界缓存，并按 executable、environment 与 spawn implementation
隔离。

## Session 私有 HOME

每个 owned Runtime Session 在自己的持久目录中生成：

```text
<runtime-session>/
├── home/
│   └── .gemini/
│       ├── config/
│       │   ├── agents/pragma-<expert-id>-<session-hash>/agent.md
│       │   ├── hooks.json
│       │   ├── mcp_config.json
│       │   └── skills/pragma-<session-hash>-<skill>/SKILL.md
│       └── antigravity-cli/
│           ├── settings.json
│           └── ... agy session/cache state
├── hooks/pragma-pre-tool-use.mjs
├── logs/turn-<run-id>.log
└── tmp/
```

启动环境强制重定向 `HOME`、`USERPROFILE`、XDG 目录、Windows AppData 与临时目录，并移除宿主的
`AGY_APP_DATA_DIR`、`ANTIGRAVITY_HOME`、Gemini config override、Google log override、Antigravity
conversation/project/sidecar 状态及旧的 Pragma Hook secret 变量。
显式认证环境变量与其他业务环境保持透传。`AGY_CLI_DISABLE_AUTO_UPDATE=true`，避免一个受管 Session
在执行中改写宿主安装。OAuth 登录态由 Antigravity 使用操作系统安全钥匙串管理；首次登录应在 Pragma
外运行交互式 `agy`，Adapter 不复制凭据文件。

同一策略也用于 `agy models`，但模型发现使用一次性临时 HOME，结束后立即删除，避免目录发现污染
Runtime Session 或宿主配置。

## 系统提示词与 startup messages

Antigravity 没有等价的 `--system-prompt` 参数。Adapter 在私有
`~/.gemini/config/agents/pragma-<expert-id>-<session-hash>/agent.md` 写入一个 main custom agent：

```markdown
---
name: "pragma-...-<session-hash>"
description: "..."
mainAgent: true
subagent: false
hidden: false
inheritMcp: true
commandExecutionPolicy: off
skills:
  - "skills/pragma-<session-hash>-<managed-skill>"
---

# System Prompt

<Core 组装的完整 system prompt，逐字保留>
```

进程用 `--agent pragma-<expert-id>-<session-hash>` 显式选择它。Core 已完成的系统提示词组装不会再次被 Runtime
摘要或拼接到用户消息。`commandExecutionPolicy` 随权限模式映射为 `off` / `sandbox` / `eager`；已物化
Skill 也通过 frontmatter 显式绑定，避免只依赖全局自动发现。Session 重新准备时只替换这个受管 Agent
entry，不删除 Antigravity 为已恢复 conversation 保存的动态 subagent。

Antigravity print mode 每次只接受一个 prompt 参数，因此 startup messages 使用带角色、顺序与精确字符数
的边界帧放在当前请求之前。Driver 的 `consumeStartupMessages()` 只消费 fresh conversation 的初始消息
一次；恢复已有 `conversation_id` 时不重复首轮发送。若 Runtime 后续报告完成 context compaction，Core
仍可按统一预算规则在下一轮重注入 always-on startup messages。消息历史分别记录 startup message 和当前
user message，不把边界帧当作权威历史格式。

## MCP

Adapter 从 Core 的 process-shared `McpToolRegistryPool` 获取连接，再为当前 Expert/Execution 注册独立
MCP session。私有 `~/.gemini/config/mcp_config.json` 只写一个 Session-scoped
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

该不透明 namespace 只暴露当前 Expert allowlist 投影后的工具，且私有 HOME 不会继承宿主个人 MCP 配置。
custom agent 的 `inheritMcp: true` 让上述受管 server 进入该 Agent。Antigravity 仍会按其原生语义发现
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

Core 已解析的每个 local Skill 都复制到官方 global customization 路径
`~/.gemini/config/skills/pragma-<session-hash>-<normalized-name>/`。复制规则为：

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

| Pragma mode      | `toolPermission`     | terminal sandbox | workspace 外访问 | CLI flag                         |
| ---------------- | -------------------- | ---------------- | ---------------- | -------------------------------- |
| request-approval | `request-review`     | 开启             | 禁止             | 无危险绕过                       |
| auto-approve     | `proceed-in-sandbox` | 开启             | 禁止             | `--sandbox`                      |
| full-access      | `always-proceed`     | 关闭             | 允许             | `--dangerously-skip-permissions` |

`~/.gemini/config/hooks.json` 以 Session-scoped 名称注册匹配全部 native tools 的 `PreToolUse` command Hook。Hook runner 与本机
loopback relay 使用每 Session 随机 bearer；URL 和 bearer 只写入权限为 `0600` 的私有脚本，不放入 agy
进程环境，避免被 Agent 的 shell 子进程读取。

Relay 校验 bearer、请求大小和 `workspacePaths` 身份后执行策略：仅精确匹配受管 Session namespace 的
Pragma MCP tool 自动允许，包括 Antigravity 当前的 `call_mcp_tool` +
`ServerName: "pragma<session-hash>"` dispatcher 格式；问题工具映射
到 Core `user_question`；request-approval 下只读且 workspace 内的工具可直接执行，其他工具进入 Core
approval；auto-approve 只允许受管 MCP 和显式 allowlist 中的 workspace 文件工具，原生 shell/terminal、
非受管 MCP、网络/调度/未知工具一律拒绝，要求切换到 request-approval 或 full-access。路径检查覆盖绝对路径、相对 `..` 和现有
祖先的 realpath，避免 workspace 内 symlink 指向外部后被误判；CLI sandbox 继续作为执行时边界。
full-access 直接允许。用户修改 tool input
时，只在 Antigravity 的浅层 `overwrite` 能精确复现新对象时放行，否则拒绝原调用。relay、schema 或网络
异常全部 fail closed。

该 Hook 闭合的是 Antigravity Adapter 的 native tool 路径，不代表项目已经拥有跨 Runtime 的统一
`LocalPermissionGuard`。

## 启动、流与恢复

进程 cwd 就是 Expert workspace，并用公开的 `--add-dir <workspace>` 把同一路径显式钉为 workspace；
不使用未公开的 `--app_data_dir`，也不使用不存在的 `--cwd`。主要参数为：

```text
agy
  --output-format stream-json
  --disable-slash-commands
  --print-timeout 24h
  --add-dir <workspace>
  --agent <managed-agent>
  --log-file <private-turn-log>
  --mode accept-edits
  [permission flags]
  [--conversation <conversation-id>]
  [--model <discovered-slug>]
  [--effort low|medium|high]
  -p <prompt>
```

`--disable-slash-commands` 防止外部 prompt 被解释成 `/logout` 等 TUI 命令或显式 Skill 展开；受管 Skill
仍通过 custom agent 元数据和正常模型选择加载。`-p` 与值保持相邻并放在最后。取消先发 `SIGTERM`，一秒内不退出再发 `SIGKILL`。恢复只使用当前
Runtime Session 持久化的 `conversation_id`，绝不使用机器级“最近一次 conversation”。

NDJSON reader 有 UTF-8 边界处理、4 MiB 单行上限与严格的结构化模式切换。1.1.11 的 wire shape 使用
顶层 `event` 判别字段，并把 payload 放在同名的 `init`、`step_update` 或 `result` 对象中；Adapter 同时
读取 1.1.8-era/兼容包装器使用的顶层 `type` shape。事件归一化覆盖：

- `init`：conversation identity、model、tools 与 MCP 状态；
- `step_update`：`PLANNER_RESPONSE.text_delta` assistant 增量、thought 增量、tool lifecycle、
  subagent progress 与 compaction；
- `result`：最终文本、conversation identity、usage 或 terminal error；
- 未知 typed event：经过递归 secret redaction 后保留为 progress，便于前向兼容诊断。

同一 step 的 snapshot 会去重为 delta。成功退出但缺少 terminal event 时，按顺序使用已流式文本、私有
`brain/<conversation-id>/.system_generated/logs/transcript.jsonl` 的最终 `PLANNER_RESPONSE`、受管日志中的
最终响应。每次恢复 conversation 前，Adapter 会先记录 transcript 的 inode/size checkpoint；退化恢复只能
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
避免重复计数。无 usage 或全零时只调用 Core 的 `RuntimeTokenCounter` 估算受管输入和输出，并标记为
`estimated`。Antigravity 当前没有在 print stream 中提供可靠的 context-window denominator，因此不伪造
occupancy。

## 参考资料

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
- [Multica provider notes](https://multica.ai/docs/providers)：用于核对早期 `agy -p`、
  `--conversation`、模型发现与纯文本退化路径；1.1.8 后的 structured stream 以官方 changelog 为准。
- [Multica Antigravity backend](https://github.com/multica-ai/multica/blob/main/server/pkg/agent/antigravity.go)：
  用于核对累积 transcript 的 `USER_INPUT` turn 边界、settled `PLANNER_RESPONSE` 过滤和日志恢复；其
  1.0.x plain-stdout 主路径不作为本 Adapter 的 1.1.11 stream 协议基线。
