# Pragma CLI Mission 控制

机器调用、stdout/stderr 协议、cursor 续传和 input_required 状态机见
[Pragma CLI Agent / automation guide](./cli-agent.md)。

`pragma` 是与 Desktop Main 共用 `@pragma/local-host` 的 Node.js 22+ 命令行入口。CLI 与
Desktop 不共享进程内 owner；同一个 Mission 由当前 owner 消费持久化 Inbox，另一个端只提交
命令或只读事件。因此关闭 Desktop 后，CLI 仍可恢复已被证明可恢复的 Mission；CLI 退出也不会
让 Desktop 的 owner 被中断。

## 使用 Desktop 已保存的配置

先在 Desktop 配置 Runtime Environment、模型连接和凭据，导入需要运行的资源；两端使用同一
操作系统用户和同一 `PRAGMA_HOME`（默认 `~/.pragma`）。关闭 Desktop 后，CLI 仍可用这些配置
运行已导入的 Expert、ExpertTeam 或 Flow，再通过 `mission get --view result` 查询终态。

CLI 与 Desktop 共用 Environment Store 和模型连接 Store。PI 从连接的 SecretRef 读取现有
SecretStore；Harness 保持原生登录方式，进程环境继续受已保存的环境变量策略过滤。CLI 不会
继承全部宿主变量，也不会因模型、连接或凭据缺失静默切换 Runtime/模型。迁移前的 Electron
凭据必须先由当前 Desktop 完成升级；CLI 报告迁移要求。钥匙串不可用、锁定、Runtime 不可用和
模型配置不匹配应按返回诊断处理，再重试原请求。既有 Session 按原 Runtime identity、Environment
revision 和 fingerprint 恢复；更新 Environment head 不会改写旧 Session。
PI 同时读取 Desktop 保存的工作上下文窗口预算；预算更新后重新装配 adapter，已有 binding 保持不变。
历史 RuntimeProfile 的 `codex-local` 在新建绑定时指向共享 `codex` Environment；若同名 Environment
已经注册，则以该配置为准，已删除的配置不会触发别名回退。旧 Session 仍按原 binding 精确恢复。

新建项目任务可省略 `--project` / `--revision`，Host 将解析结果中的精确 Revision 传给执行链路并
持久 pin；显式参数仍受一致性检查。历史 Mission 缺少 pin 时仍须按下文显式恢复，不能以新建任务
的默认选择替代历史身份。

本轮不提供 CLI 独立环境配置、Bundle 导入/修复命令或 Linux 支持。Memory 的 Evidence 采集、
持久提炼任务入队和已有记忆召回继续保留；提炼、索引维护和 Learning 由同一 home 下存活且满足
配置条件的 Desktop 处理。入队不等于生成记忆，`pragma run` 退出后不会持续消费这些后台任务，
Knowledge/Skill 发布仍需人工批准。

## 命令

```text
pragma team discover [SELECTOR] [--query TEXT] [--status STATUS]
pragma expert discover [SELECTOR] [--query TEXT] [--status STATUS]
pragma flow discover [SELECTOR] [--query TEXT] [--status STATUS]
pragma team describe <REF> [--revision N]
pragma expert describe <REF> [--revision N]
pragma flow describe <REF> [--revision N]
pragma team run <REF> --workspace ABSOLUTE_PATH (--prompt TEXT | --input FILE|-)
pragma expert run <REF> --workspace ABSOLUTE_PATH (--prompt TEXT | --input FILE|-)
pragma flow run <REF> --workspace ABSOLUTE_PATH --input-json FILE|-
pragma mission list [--status STATUS] [--executor REF] [--limit N] [--cursor CURSOR]
pragma mission get <MISSION_ID> [--view summary|result|events] [--limit N] [--cursor CURSOR]
pragma mission watch <MISSION_ID> [--after CURSOR | --replay COUNT]
  [--until terminal|input-required]
pragma mission send <MISSION_ID> (--prompt TEXT | --input FILE|-)
  [--request-id UUID] [--wait | --detach] [--ack-timeout SECONDS]
pragma mission steer <MISSION_ID> (--prompt TEXT | --input FILE|-)
  [--expected-execution EXECUTION_ID] [--request-id UUID]
  [--wait | --detach] [--ack-timeout SECONDS]
pragma mission resume <MISSION_ID> [--project PROJECT_ID --revision N]
  [--expected-fingerprint SHA256] [--request-id UUID] [--detach]
pragma mission respond <MISSION_ID> --interaction INTERACTION_ID
  (--answer TEXT | --choice VALUE... | --answers-json FILE|-)
  [--request-id UUID] [--wait | --detach] [--ack-timeout SECONDS]
pragma mission interrupt <MISSION_ID> [--expected-execution EXECUTION_ID]
  [--reason TEXT] [--request-id UUID] [--wait | --detach] [--ack-timeout SECONDS]
pragma mission board list <MISSION_ID> [--limit N] [--cursor CURSOR]
pragma mission board read <MISSION_ID> <CONTEXT_ID> [--start BYTE] [--max-bytes MAX_BYTES]（--offset 为兼容别名）
pragma mission board search <MISSION_ID> QUERY [--case-sensitive] [--context-lines N] [--max-results N]
pragma mission queue list <MISSION_ID> [--limit N] [--cursor CURSOR]
pragma mission queue remove <MISSION_ID> --request REQUEST_ID
pragma mission queue resume <MISSION_ID>
pragma mission queue steer <MISSION_ID> --request REQUEST_ID [--expected-execution EXECUTION_ID]
```

`send`、`respond`、`interrupt` 和 queue mutation 通过 durable Inbox 路由；`--wait` 等待执行
结果，`--detach` 在 Inbox 持久化后立即返回（operation 可能仍为 queued），后续用 query/watch
观察。CLI 不启动常驻 daemon；支持分离的入口使用一次调用专属的 owner 子进程，复用共享 Kernel。queued 仍表示尚未完成的持久回执，需要观察实际执行状态。所有 mutation 使用 `requestId + payloadHash` 幂等。默认
ack timeout 为 30 秒，可用 `--ack-timeout` 调整。

`steer` 与 `queue steer` 是 strict target 操作，要求 execution、turn 和 fencing target 仍然
一致。目标失效时返回稳定错误，不会降级成 send/enqueue。queue steer 在 Runtime 确认前保留
原 queued item。

Desktop UI 的队列引导使用独立的 best-effort `queue.try-steer`：没有活动 turn、正在等待人工
回答、Runtime 不支持 steer 或消息带附件时，消息继续留在原队列中。CLI 的 `queue steer` 仍保持上述
严格语义。若 Host 在 Runtime steer 调用边界崩溃且无法确认投递结果，队列会暂停并报告
`delivery_uncertain`；`queue resume` 核对投递结果，仅在确认未投递后才执行原消息，确认已投递则移除队列副本。
无法核对时保持暂停。可显式使用 `queue resume MISSION_ID --abandon-uncertain` 跳过不确定消息，
停止旧对话并在新对话中继续其他排队消息；这不会重放不确定消息，也不会撤销可能已经发生的操作。

`queue list` 展示 Core ExpertSession prompt queue，不是 Inbox operation list。`watch` 是只读
watcher，不 claim lease，也不 interrupt Mission；输出只支持 `text` 与 `jsonl`。jsonl 每行是
一个事件，并以唯一的 `stream.end` 结束；Ctrl-C 是本地 detach，退出码为 0。watcher 的
`stream.end.data.status` 表示 watcher 命令成功/失败，`observedStatus` 表示它实际观察到的
Mission 状态，`stopReason` 表示停止原因；后三者可分别区分 `succeeded`、`failed`、
`interrupted`、`input_required` 和本地 `detached`。

`discover` 可以接收一个 positional selector：canonical `kind:ID` 做精确匹配，其他文本按
名称或描述做不区分大小写的 substring 匹配；selector 与 `--query` 不能同时使用。canonical
selector 跨 kind 会立即返回 `INVALID_ARGUMENT`，canonical selector 无结果返回
`EXECUTOR_NOT_FOUND`。即使只有一个结果，JSON 结果的 `items` 仍然是数组。

`mission get` 的 `summary` 是不含完整事件的紧凑摘要，`result` 只表示最新一次
`run.started`/`execution.started` 对应的执行状态，`events` 按 durable sequence 分页。事件页的
`nextCursor` 可直接复制到下一次 `--cursor`；cursor 由 Local Host controller 校验，过期或跨
Mission cursor 会返回 `CURSOR_EXPIRED`/`CURSOR_INVALID`。安装版本支持的 view 以
`pragma mission get --help` 为准。

文本模式的 `mission list` 列出 `MISSION ID/TITLE/STATUS/EXECUTOR/UPDATED/WORKSPACE`；`queue list`
先列出 `state/pendingCount/supportsSteer`，再列出完整 REQUEST ID 和内容预览。所有文本分页
支持 cursor 的文本分页结果都会打印可复制的 continuation 命令。

`mission list` 遇到无法读取的单个 Mission、且仍有可读 Mission 时，通过共享 Local Host 诊断入口返回可读条目。
文本模式在 stderr 报告 Mission ID、缺失或异常文件及原因；JSON/JSONL 的结果包含
`partial: true`、`diagnostics`，结果信封同时包含 `warnings`。只有待完成的语义事务、且主状态
仍可读取时，保留该 Mission 并报告 `MISSION_TRANSACTION_PENDING`，`partial` 为 false。
调用方应检查这些字段，不能把部分结果当成完整清单；未知异常仍使命令失败。
如果所有候选 Mission 都不可读，CLI 继续返回非零错误状态，并在错误 details 中包含完整诊断；
正常首次使用、没有任何 Mission 时仍返回成功的空清单。
列表不会删除日志或重放事务。缺少 `aggregate.json` 的 journal-only 目录需要保留证据后调查，
不能通过补空状态或重新 claim 来恢复。

`run` 默认等待终态，`--detach` 在 durable Mission/Execution receipt 持久化后返回；回执返回时
任务可能仍在队列中。`--request-id` 可选；省略时
CLI 自动生成 UUID。文本模式会在副作用前显示 Request ID，并在获得 handle 后显示 Mission ID
和 Execution ID；JSON/JSONL 不增加旁路文本，仍分别使用 `pragma.cli-result/v2` 与
`pragma.cli-event/v2`。

## 历史 Mission 恢复

M7 project Mission 如果缺少 `mission.binding.pinned`，不能猜测 revision、读取 head 或选择
当前候选。用户必须显式提供完整的 `--project` 与 `--revision`；Host 只在 catalog exact
resolve 后重建旧 canonical payload，并要求重新计算的 hash 与历史值逐字节一致。无法证明时
返回 `STORAGE_VERSION_UNSUPPORTED`，不启动 Runtime、不写 Inbox、不改变旧 Mission。

## 输出与补全

机器消费使用 `--format=json`（单个 `pragma.cli-result/v2`）或 `--format=jsonl`（事件流）。
watch 不接受 `json`，会返回 `INVALID_FORMAT`。可通过以下命令生成 bash、zsh、fish 或
PowerShell 的嵌套命令补全：

```bash
pragma completion bash
pragma completion zsh
pragma completion fish
pragma completion powershell
```

CLI 不会把 secret、Runtime 环境或 Desktop 私有状态写入 stdout；诊断和错误信息按协议输出，
并将人类可读错误写入 stderr。

## 脚本与 Agent

脚本或 Agent 只需先固定 `--format=json`（单体结果）或 `--format=jsonl`（事件流），并
显式指定 `--interactive=never --color=never`。完整的机器输入、cursor、错误恢复、
input_required 状态机和 bootstrap exception 见
[Pragma CLI Agent / automation guide](./cli-agent.md)。

## 安装与运行环境

发行包名为 `@pqpo/pragma`，命令名为 `pragma`。当前发行包要求 Node.js 22+，支持 macOS
Apple Silicon、macOS Intel 和 Windows x64；Linux 安装会被 npm 的 `os` 元数据拒绝。
发行包只包含编译后的 ESM 产物和 OS keychain 原生依赖，不在安装期下载 payload，也不携带
第二份 Node.js。

```bash
node --version
npm install --global @pqpo/pragma@latest
pragma version
pragma doctor
```

预发行版本使用 `@next`，升级或回滚时使用不可变的显式版本号：

```bash
npm install --global @pqpo/pragma@next
npm install --global @pqpo/pragma@0.1.0
npm uninstall --global @pqpo/pragma
```

不要用 `--force` 绕过 Node 版本、操作系统或命令冲突。降级就是安装一个已经发布的旧
版本；已发布版本不可覆盖，也不通过移动 dist-tag 改写历史版本。

## PATH 与 binary 冲突诊断

npm 的 global prefix 决定 `pragma` shim 的位置。先记录 prefix 和实际命令，不要先修改
shell 配置：

```bash
npm prefix --global
npm root --global
command -v pragma
type -a pragma
ls -l "$(npm prefix --global)/bin/pragma"
```

PowerShell 使用：

```powershell
npm prefix --global
npm root --global
Get-Command pragma -All
where.exe pragma
Get-Item "$(npm prefix --global)\pragma.cmd"
```

如果 `command -v`、`type -a`、`Get-Command -All` 或 `where.exe` 显示了另一个目录在
npm prefix 之前，当前执行的不是本次安装的 binary。检查旧 npm prefix、Homebrew/Chocolatey
副本、仓库的 `node_modules/.bin` 和 shell hash；清理或调整 PATH 后重新打开 shell，再运行
`pragma version`。在 Windows 上也检查同名的 `pragma.exe`、`pragma.cmd` 和 PowerShell
function/alias。诊断时不要删除不明文件，也不要把整个用户 PATH 覆盖成单一路径。

`doctor` 负责 SecretStore/凭据迁移状态；它不会替代上述 PATH 检查。需要确认某个 prefix
的 binary 时，可以直接调用它：

```bash
"$(npm prefix --global)/bin/pragma" version
```

Windows：

```powershell
& "$(npm prefix --global)\pragma.cmd" version
```

如果直接调用成功、裸 `pragma` 失败，问题在 PATH 顺序或 shell 缓存；如果两者都失败，
再查看 `pragma doctor` 和 npm 安装输出。

凭据迁移完成后，`doctor` 会只读检查当前配置中的 SecretRef，验证后立即释放凭据句柄，
不会输出凭据值、重放迁移或改写配置。历史备份丢失会输出
`LEGACY_CREDENTIAL_BACKUP_MISSING` warning；若当前凭据可用，命令仍成功退出。
需要历史恢复时应从归档找回备份，重新打开 Desktop 不会重建它。
迁移确实未完成时仍报告 `SECRET_MIGRATION_REQUIRED` 并提示打开升级后的 Desktop。
当前凭据故障在 finding 的 `reasonCode` 中区分主密钥缺失、Secret 不存在、引用版本冲突和
SecretStore 损坏；文本与 JSON 输出均保留该原因，故障仍以非零状态退出。
主密钥丢失时需恢复原钥匙串密钥；Desktop 不会为已有 SecretStore 重建替代密钥。
引用或 SecretStore 数据异常时，应恢复配置、凭据数据及钥匙串密钥相互匹配的备份。

Node.js 20 即使 npm 发出 `EBADENGINE` 警告也不满足运行要求：bootstrap 会在主 bundle
加载前以退出码 2 拒绝。启用 `engine-strict` 时安装本身应失败。

机器调用入口：[Pragma CLI Agent / automation guide](./cli-agent.md)。

## Memory

CLI 与 Desktop 共用同一 Pragma home 的 Memory 策略、RecallScope、已有记忆与可选 Attention。CLI 捕获 Evidence 并提交待提取任务；实际模型提炼由后续 Desktop 执行。CLI 不启动 Memory daemon，不提供 Jev Key 写入命令。Attention 配置和诊断见 [Memory 使用指南](./memory.md)。

## Agent 查询与有限等待（#398）

```bash
pragma mission list --query "review" --workspace "$PWD" --limit 10
pragma mission get "$MISSION_ID" --recent-input --json --output-view compact
pragma expert run "$EXPERT_REF" --workspace "$PWD" --input prompt.txt \
  --request-id "$RUN_REQUEST_ID" --wait-timeout 30 --interactive never --json --output-view compact
pragma mission watch "$MISSION_ID" --until terminal --wait-timeout 30 --format jsonl --output-view compact
pragma mission board read "$MISSION_ID" report.md --start 0 --max-bytes 8000
```

列表由 Host 筛选、稳定排序和分页，limit 为 1..200。--query 搜索标题，--workspace 精确匹配 canonical path。
文本只给出一份可执行 Continue 命令。匹配结果变化时 cursor 过期，重新查询；列表不是持久快照。
旧 CLI v2 列表 cursor 无结果指纹，升级后明确过期；事件分页和 watch/replay cursor 不受影响。
Executor/Queue 的列表 cursor 同时绑定 full/有界投影及正文预算，续页必须保持原输出模式；切换模式或预算返回 CURSOR_INVALID。

GET 默认返回带 title 的语义 v2；严格 v1 消费者可以加 --query-version 1。历史 title 为 null 时明确展示不可用。
最近输入来自持久 timeline，可能仍排队；不要把它当作当前 execution 已开始的证明。

--output-view full 默认使用 v2 envelope；compact 使用 result/event v3。full 的 JSONL 保留历史重复 result；
compact 的完整结果只出现一次，结束行保留退出码和恢复字段。成功查询到 failed Mission 的退出码仍为 0，
必须读取任务 status。大正文返回 resultContent/dataContent/contentReference，不用预览冒充完整结果。
按引用中的 source/id/fingerprint 读取 --view content；字节偏移由返回的 nextStart 指定。文本带范围说明，
需要逐字节重建时使用 JSON 的 content 字段；utf8-json 必须合并后再 JSON.parse。队列被消费或内容被清理后
返回 NOT_FOUND；内容改变返回 CURSOR_EXPIRED。

默认 CLI 的 run 和支持分离的 mutation 使用每次调用专属的 owner 子进程；超时不会隐式取消。
wait-timeout 为 1..86400 秒，mutation 中隐含 --wait，与 --detach/--interactive always 互斥。
到期返回 accepted/exit 0、waitExpired、当前观测及继续入口；任务仍可能排队、需要回答或失败。
watch 超时文本分别显示最后观测的 Mission 状态和 stopReason=timed_out。
有限等待的 mutation 收到 Ctrl-C 时调用方退出，owner 继续处理已持久化命令；executor run 的 Ctrl-C 则请求取消执行。
--ack-timeout 继续表示命令确认。问题/选项与完整回答格式直接展示；审批须依据用户授权，不自动批准。

完整协议与兼容决策见 [ADR 071](../adr/071-agent-friendly-cli-queries-and-owner-waiting.md)。
