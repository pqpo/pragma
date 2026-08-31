# Pragma CLI Mission 控制

`pragma` 是与 Desktop Main 共用 `@pragma/local-host` 的 Node.js 22+ 命令行入口。CLI 与
Desktop 不共享进程内 owner；同一个 Mission 由当前 owner 消费持久化 Inbox，另一个端只提交
命令或只读事件。因此关闭 Desktop 后，CLI 仍可恢复已被证明可恢复的 Mission；CLI 退出也不会
让 Desktop 的 owner 被中断。

## 命令

```text
pragma team|expert|flow discover [SELECTOR] [--query TEXT] [--status STATUS]
pragma team|expert|flow describe <REF> [--revision N]
pragma team|expert run <REF> --workspace ABSOLUTE_PATH (--prompt TEXT | --input FILE|-)
pragma flow run <REF> --workspace ABSOLUTE_PATH --input-json FILE|-
pragma mission list [--status STATUS] [--executor REF] [--limit N] [--cursor CURSOR]
pragma mission get <MISSION_ID> [--view summary|result|events] [--limit N] [--cursor CURSOR]
pragma mission watch <MISSION_ID> [--after CURSOR | --replay COUNT]
pragma mission send <MISSION_ID> --prompt TEXT [--wait | --detach]
pragma mission steer <MISSION_ID> --prompt TEXT [--expected-execution EXECUTION_ID]
pragma mission resume <MISSION_ID> [--project PROJECT_ID --revision N]
pragma mission respond <MISSION_ID> --interaction INTERACTION_ID (--answer TEXT | --choice VALUE | --answers-json FILE|-)
pragma mission interrupt <MISSION_ID> [--expected-execution EXECUTION_ID]
pragma mission queue list <MISSION_ID>
pragma mission queue remove <MISSION_ID> --request REQUEST_ID
pragma mission queue resume <MISSION_ID>
pragma mission queue steer <MISSION_ID> --request REQUEST_ID [--expected-execution EXECUTION_ID]
```

`send`、`respond`、`interrupt` 和 queue mutation 通过 durable Inbox 路由；`--wait` 等待执行
结果，`--detach` 只等待命令已接受。所有 mutation 使用 `requestId + payloadHash` 幂等。默认
ack timeout 为 30 秒，可用 `--ack-timeout` 调整。

`steer` 与 `queue steer` 是 strict target 操作，要求 execution、turn 和 fencing target 仍然
一致。目标失效时返回稳定错误，不会降级成 send/enqueue。queue steer 在 Runtime 确认前保留
原 queued item。

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
Mission cursor 会返回 `CURSOR_EXPIRED`/`CURSOR_INVALID`。`chat` 与 `work` 尚未就绪，会明确
提示使用 `--view events` 或 `mission watch`。

文本模式的 `mission list` 列出 `MISSION ID/STATUS/EXECUTOR/UPDATED/WORKSPACE`；`queue list`
先列出 `state/pendingCount/supportsSteer`，再列出完整 REQUEST ID 和内容预览。所有文本分页
支持 cursor 的文本分页结果都会打印可复制的 continuation 命令。

`run` 默认等待终态，`--detach` 在 Mission handle 接受后返回。`--request-id` 可选；省略时
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

## Agent canonical invocation profile

Agent 或 Codex 调用 CLI 时固定使用 `--format=json`（单次结果）或 `--format=jsonl`（事件流），
并显式指定 `--interactive=never --color=never`。调用方应先生成并持久化一个 UUID，作为
`--request-id` 传入；Agent profile 对新的 `run` 默认显式使用 `--detach`，随后用
`mission watch` 跟踪，而不是把一个长时间的 Runtime 执行绑定在单个 subprocess 上。这是
调用方约定，不改变 CLI 省略 `--detach` 时默认等待终态的行为。`watch` 必须带
`--until`，建议使用 `--until input-required`。

对 JSONL，消费并持久化每一条 `replayable=true` 事件的 `cursor` 后，才推进本地的
`lastCursor`；也要保存最终结果中的 cursor。断线后使用原 Mission ID 和
`mission watch --after "$lastCursor"` 续传。cursor 是不透明值，只能原样保存和传回。

推荐的 Codex/skills 调用状态机如下：

1. `expert|team|flow discover`、`describe`：单次 JSON 调用，严格校验 v2 envelope 和首批
   输出。
2. `expert|team|flow run`：调用方生成 UUID，使用 `--input -`（Flow 使用 `--input-json -`）、
   `--detach --format=json`，保存返回的 `requestId`、`missionId` 和 `executionId`。
3. `mission watch`：使用 `--after "$lastCursor" --until input-required --format=jsonl`；
   每确认写入一条可重放事件后再更新 cursor。
4. `observedStatus=input_required`：读取事件中的 `interactionId`，用新的命令
   `request-id` 调用 `mission respond`，再从保存的 cursor 继续 watch。
5. `steer`/`interrupt`：先用 `mission get --view summary` 或 `result` 读取最新
   `executionId`，再带 `--expected-execution`。若目标 stale/changed，重新读取状态，不能
   盲目重试到新的 Execution。
6. 调用方必须在 CLI subprocess 外部设置总 timeout。暂时性失败或超时按错误码和
   `retryable` 处理；使用同一个 request ID 和完全相同的语义 payload 重试。终止本地
   subprocess 只停止本地 watcher，不等于中断 Mission；恢复时使用原 request ID/cursor。

### Agent 输入与 bootstrap exception

Agent 输入默认走 stdin：文本使用 `--input -`，Flow 的 JSON 使用 `--input-json -`，交互回答
使用 `--answers-json -`。写入完整 UTF-8 内容后应立即关闭 stdin，让 CLI 收到 EOF；不要让
stdin 长时间保持打开。`--prompt` 仅适合短的、非敏感文本，因为参数会出现在 argv、进程列表，
并可能进入 shell tracing 或 history。

机器模式的 stdout 只能是 `pragma.cli-result/v2` 或 `pragma.cli-event/v2`；stderr 中的
`pragma.log/v1` 是结构化诊断。Node 版本不满足要求或 CLI bundle import 失败时，bootstrap
只写纯文本 stderr，不会生成 v2 envelope，这是协议例外路径（分别使用退出码 2/10）。
tool/skill 层应先检查 Node 与 CLI 版本，再按“无 stdout envelope + 非零退出码”的方式处理
bootstrap 失败。

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

Node.js 20 即使 npm 发出 `EBADENGINE` 警告也不满足运行要求：bootstrap 会在主 bundle
加载前以退出码 2 拒绝。启用 `engine-strict` 时安装本身应失败。
