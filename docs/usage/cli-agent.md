# Pragma CLI Agent / automation guide

> 人类操作请先看 [Pragma CLI Mission 控制](./cli.md)。本页是机器消费指南。

本页定义如何让 Agent、CI 或其他自动化程序调用 pragma，以及如何解析结果、恢复
断线和处理需要人工输入的 Mission。它是通用 CLI 的机器消费说明，不是 Codex
skill，也不是权限 wrapper；它不会替调用方做 workspace 隔离、mutation 授权或
安全确认。需要把 CLI 暴露为 Agent tool 时，调用方仍须在外层提供这些边界。

## 1. 定位与适用范围

pragma 是本机 Pragma Host 的命令行入口。它可发现 Expert、ExpertTeam 和 Flow，
创建或继续 Mission，并读取 Mission 的事件与白板。CLI 与 Desktop 共用
PRAGMA_HOME，但不要求 Desktop 进程正在运行。

本页针对“另一个程序启动 pragma 子进程并消费 stdout/stderr”的场景。shell 中人手
操作、交互式审批、补全和完整的安装/路径诊断见
[人类 CLI 指南](./cli.md)。本页中的 --format=json、--format=jsonl 和事件字段
是机器接口；不要把人类 text renderer 当作稳定数据接口。

## 2. Contract snapshot

| 项目             | 契约                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| CLI 基线         | @pqpo/pragma 0.1.0-next.13 P0 基线及后续版本；实际使用前先执行 pragma version，再以该版本的 pragma --help 为准 |
| Node.js          | 22 或更高版本                                                                                                  |
| 支持 OS          | macOS Apple Silicon、macOS Intel、Windows x64；Linux 不在发行包支持范围内                                      |
| 单次结果         | pragma.cli-result/v2，通常由 --format=json 输出一个 JSON object                                                |
| 事件流           | pragma.cli-event/v2，通常由 --format=jsonl 或 --stream-json 逐行输出                                           |
| 错误对象         | pragma.integration-error/v1，嵌入 v2 result 或 stream.end.data.error                                           |
| Recovery hints   | pragma.integration-recovery/v1，位于 error.details.recovery                                                    |
| v2 meta protocol | meta.protocolVersion 为 pragma.integration/v2                                                                  |

details.recovery 与 --log-level / PRAGMA_LOG_LEVEL 是 P1 设计契约，对应代码
尚未合入；当前发布版本可能尚未包含。下文会完整描述定稿后的目标语义，但调用方
必须允许它们缺失，并在当前版本先使用已有的 retryable、错误码、状态和 cursor。
P1 不改变 pragma.cli-result/v2、pragma.cli-event/v2 或
pragma.integration-error/v1 的顶层版本。

已发布 CLI 版本不可覆盖。版本、构建身份或协议能力发生变化时，调用方应重新读取
pragma version，不要仅按包名或一个旧版本号推断所有行为。

## 3. Canonical invocation profile

自动化调用推荐固定使用以下 profile：

- 单次结果使用 --format=json；需要实时事件或续传使用 --format=jsonl
  （--stream-json 是别名）。
- 显式使用 --interactive=never --color=never，不要让 TTY 状态改变协议。
- P1 目标 profile 还使用 --log-level=error。该选项当前尚未落地；在尚未包含
  P1 的版本中省略它，否则当前 parser 可能把它视为未知选项。
- 调用方为每一个新的 run 或 mutation 生成 UUID 并持久化。重试同一 durable 请求
  时，只有契约明确要求复用 ID 且 payload 完全相同才复用旧 UUID。
- 新的 expert run、team run 或 flow run 显式使用 --detach，先取得已持久化的
  Mission/Execution 回执，再用 mission watch 跟踪；回执返回时任务可能仍在队列中。
- mission watch 必须显式给出 --until terminal 或 --until input-required；
  省略时会持续 follow，即使 Mission 已经终态也不会自动退出。
- 每一个子进程都设置调用方自己的总 deadline 或 idle deadline。CLI 当前没有通用的
  --timeout / --idle-timeout；外部终止 watcher 不等于 interrupt Mission。

当前版本可直接执行的最小模板如下；P1 代码落地后可在这些命令中增加
--log-level=error：

```bash
RUN_REQUEST_ID=11111111-1111-4111-8111-111111111111
printf '%s' '只回复 OK' |
  pragma expert run expert:0000000000pragma \
    --workspace "$PWD" --input - \
    --request-id "$RUN_REQUEST_ID" --detach \
    --format=json --interactive=never --color=never

pragma mission watch "$MISSION_ID" \
  --replay 50 --until input-required \
  --format=jsonl --interactive=never --color=never
```

--detach 只改变等待策略，不改变 run 会创建 Mission 的语义。--request-id 在当前
CLI 中可以省略（CLI 会生成 UUID），但自动化 profile 不应依赖这一点，因为调用方
必须在超时和重试时知道原请求的身份。watch 本身没有用来替代 run request ID 的
参数；它的恢复依据是 Mission ID 和 durable cursor。

## 4. 命令速查与副作用

### 4.1 命令集合

下面的 <...> 是占位符；命令名和选项可以直接复制，值请替换为实际 ID。

```text
pragma expert discover [SELECTOR] [--project PROJECT_ID] [--query TEXT]
  [--status ready|needs_attention|unavailable] [--limit N] [--cursor CURSOR]
pragma team discover [SELECTOR] [--project PROJECT_ID] [--query TEXT]
  [--status ready|needs_attention|unavailable] [--limit N] [--cursor CURSOR]
pragma flow discover [SELECTOR] [--project PROJECT_ID] [--query TEXT]
  [--status ready|needs_attention|unavailable] [--limit N] [--cursor CURSOR]

pragma expert describe REF [--revision N]
pragma team describe REF [--revision N]
pragma flow describe REF [--revision N]

pragma expert run REF --workspace ABSOLUTE_PATH (--prompt TEXT | --input FILE|-)
pragma team run REF --workspace ABSOLUTE_PATH (--prompt TEXT | --input FILE|-)
pragma flow run REF --workspace ABSOLUTE_PATH --input-json FILE|-
  [--project PROJECT_ID] [--revision N] [--expected-fingerprint SHA256]
  [--request-id UUID] [--detach]

pragma mission list [--status STATUS] [--executor REF] [--limit N] [--cursor CURSOR]
pragma mission get MISSION_ID [--view summary|result|chat|work|events]
  [--limit N] [--cursor CURSOR]
pragma mission resume MISSION_ID [--project PROJECT_ID --revision N]
  [--expected-fingerprint SHA256] [--request-id UUID] [--detach]
pragma mission watch MISSION_ID [--after CURSOR | --replay COUNT]
  [--until terminal|input-required]

pragma mission send MISSION_ID (--prompt TEXT | --input FILE|-)
  [--request-id UUID] [--wait | --detach] [--ack-timeout SECONDS]
pragma mission steer MISSION_ID (--prompt TEXT | --input FILE|-)
  [--expected-execution EXECUTION_ID] [--request-id UUID]
  [--wait | --detach] [--ack-timeout SECONDS]
pragma mission respond MISSION_ID --interaction INTERACTION_ID
  (--answer TEXT | --choice VALUE... | --answers-json FILE|-)
  [--request-id UUID] [--wait | --detach] [--ack-timeout SECONDS]
pragma mission interrupt MISSION_ID [--expected-execution EXECUTION_ID]
  [--reason TEXT] [--request-id UUID] [--wait | --detach] [--ack-timeout SECONDS]

pragma mission board list MISSION_ID [--limit N] [--cursor CURSOR]
pragma mission board read MISSION_ID CONTEXT_ID [--start BYTE] [--offset MAX_BYTES]
pragma mission board search MISSION_ID QUERY
  [--case-sensitive] [--context-lines N] [--max-results N]

pragma mission queue list MISSION_ID [--limit N] [--cursor CURSOR]
pragma mission queue remove MISSION_ID --request QUEUED_REQUEST_ID
  [--request-id COMMAND_UUID] [--ack-timeout SECONDS]
pragma mission queue resume MISSION_ID [--request-id UUID] [--ack-timeout SECONDS]
pragma mission queue steer MISSION_ID --request QUEUED_REQUEST_ID
  [--expected-execution EXECUTION_ID] [--request-id COMMAND_UUID]
  [--wait | --detach] [--ack-timeout SECONDS]
```

--revision 必须与 --project 一起使用；--expected-fingerprint 也要求
--project。run 的 REF 必须是对应 kind 的 canonical ref，--workspace 必须是绝对
路径。Flow 只接受 --input-json，Expert/Team 只接受文本 --prompt 或 --input
二选一。

### 4.2 读、创建/追加、strict target 与 destructive

| 类别              | 命令                                                                                                                              | 机器调用含义                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| read              | expert/team/flow discover、describe、mission list、mission get、mission watch、mission board list/read/search、mission queue list | 读取目录、Mission、事件、白板或队列投影；watch 不 claim lease、不改 Mission                                       |
| create            | expert/team/flow run                                                                                                              | 创建新的 Mission，并创建一次新的 Execution；结果可能是 accepted、succeeded、input_required、failed 或 interrupted |
| append / command  | mission send、respond                                                                                                             | 向已有 Mission 的 durable Inbox 追加后续 turn 或提交人工回答；通常会产生新的命令/Execution                        |
| strict target     | mission steer、mission queue steer                                                                                                | 只作用于仍有效的 active Execution/turn/fencing target；目标失效时返回错误，不降级为 send/enqueue                  |
| guarded control   | mission interrupt                                                                                                                 | 向 Inbox 提交中断请求；建议总是提供最新的 --expected-execution，防止状态读取后误伤后继 Execution                  |
| queue mutation    | mission queue remove、queue resume                                                                                                | 删除一个排队请求，或明确恢复暂停的队列；二者都改变持久状态                                                        |
| historical repair | mission resume                                                                                                                    | 只在缺少 mission.binding.pinned 时按用户明确给出的 project/revision 补回历史绑定；不能猜 head 或候选资源          |

mission queue list 展示的是 Core ExpertSession prompt queue，不是 Inbox operation
list。queue steer 的 --request 是已有 queued item 的 ID；--request-id 是本次命令
自身的幂等 ID，二者不可混用。

把 interrupt、queue remove、queue resume、steer 和 respond 暴露给 Agent 前，应由
外层逐项授权。通用 CLI 不提供 machine-readable 的
readOnly/destructive/openWorld 权限边界。

## 5. 输入与 stdin

### 5.1 输入类型与边界

- Expert/Team 的任务文本优先使用 --input -；--input FILE 读取文件。
- Flow 使用 --input-json - 或 --input-json FILE，内容必须是 JSON object，不
  接受 --prompt / --input。
- mission send 与 mission steer 同样优先使用 --input -。
- mission respond 的 --answers-json - 是完整的 HumanInteractionResponse object，
  不是任意外层包装的 answers map；可包含 decision、selection、answers、approved、
  notes 或 data。
- 文件和 stdin 输入都必须是非空 UTF-8，大小上限为 4 MiB。JSON 输入还必须能够
  解析为 object，并且 Flow 输入随后要通过 Flow 自己的 input schema。
- 写入完整内容后立即关闭 stdin，让 CLI 收到 EOF。不要让 stdin 在等待 runtime
  或 command acknowledgement 期间保持打开。

可执行的 stdin 形态：

```bash
printf '%s' '只回复 OK' |
  pragma expert run expert:0000000000pragma \
    --workspace "$PWD" --input - \
    --format=json --interactive=never --color=never

printf '%s' '{"question":"只回复 OK"}' |
  pragma flow run flow:0123456789abcdef \
    --workspace "$PWD" --input-json - \
    --format=json --interactive=never --color=never
```

上例中的 Flow ID 只是符合 ID 形状的占位符，实际执行前必须从 flow discover 得到
真实 ref。若要给回答使用 stdin：

```bash
printf '%s' '{"approved":true,"notes":"继续"}' |
  pragma mission respond "$MISSION_ID" \
    --interaction "$INTERACTION_ID" --answers-json - \
    --request-id "$RESPONSE_REQUEST_ID" \
    --format=json --interactive=never --color=never
```

--prompt 和 --answer 适合短、非敏感文本。长文本、可能含 secret 的内容或机器生成
的回答不要放在 argv；argv 可能出现在进程列表、shell tracing 或 history 中。
--choice 适合少量非敏感选项值，但多选时仍应考虑使用 --answers-json -。

在 --interactive=never 下，CLI 不会自行从 controlling TTY 读取回答；只有显式的

- 输入才会消费 stdin。通用 CLI 仍允许文件路径输入，外层 tool wrapper 必须自行
  限制可读路径。

## 6. Machine output contract

### 6.1 stdout 的形态

- --format=json 输出一个 pragma.cli-result/v2 JSON object。调用方应把 stdout
  作为一个整体解析，拒绝混入的普通文本。
- --format=jsonl 输出独立 JSON object 行；--stream-json 是同一模式的别名。每行
  的 schemaVersion 为 pragma.cli-event/v2，调用方应逐行解析并保留顺序。
- mission watch 只支持 text 和 jsonl，不接受 json；需要一次性读取请用
  mission get --view events，但增量跟踪应优先使用 watch。
- JSONL 中 sequence 必须递增，同一 stream 使用同一个 requestId。可重放事件
  replayable=true 时必须携带 opaque cursor；临时事件 replayable=false 不承诺
  cursor。
- 一个完整 JSONL stream 恰好有一个 type=stream.end，且它必须是最后一行。没有
  stream.end 的进程输出只能当作未完成或 bootstrap 异常处理。

每个 envelope 可能携带 requestId、missionId 和 executionId。不要假设查询命令一定
有 Mission/Execution ID；run 和 Mission control 命令通常会提供它们。requestId
标识本次 CLI 调用或 durable command；missionId 标识可恢复的 Mission；
executionId 标识其中一次 Execution。

### 6.2 status、watch 与 stream.end

v2 run outcome 的 status 为：

- accepted：请求已接受，通常是 run --detach 或 mutation detach 的结果；
- succeeded：本次 CLI 操作成功完成；
- input_required：run 需要回答人工交互，退出码为 3；
- failed：带 error，退出码由错误码映射；
- interrupted：本地运行被中断，退出码为 130。

mission watch 的 stream.end.data.status 表示 watcher 命令自身的结果，不等于
Mission 的最终状态。P0 已增加成对的 observedStatus 与 stopReason，可取
input_required、succeeded、failed、interrupted 或 detached。因此
watch --until input-required 正常结束时，最终行通常是
data.status=succeeded、data.observedStatus=input_required、
data.stopReason=input_required。

对直接的 run，stream.end.data.status=input_required 时可以带 data.interaction。
对 watch，interaction 位于此前的 human.interaction.requested 或
run.input_required 可重放事件中；watch 的 stream.end 本身不自带 interaction。
若之前没有保存该事件，使用 mission get --view result 定向读取 waiting 状态和
interaction。

### 6.3 退出码

| 退出码 | 含义                                                        |
| -----: | ----------------------------------------------------------- |
|      0 | accepted 或 succeeded                                       |
|      2 | 参数/格式/输入边界错误，或 bootstrap 的 Node 版本错误       |
|      3 | input_required，或资源/Mission/Workspace 不存在             |
|      4 | cursor 过期、幂等冲突、Inbox/lease/strict target 命令冲突   |
|      5 | runtime、依赖、keychain 或 SecretStore 依赖不可用           |
|      6 | workspace 或其他权限被拒绝                                  |
|      7 | 协议版本或持久化版本/数据损坏                               |
|     10 | Execution 或内部错误；bundle bootstrap import 失败也使用 10 |
|    130 | interrupted                                                 |

具体失败必须以 error.code 为准，不要只按退出码推断恢复动作。JSON/JSONL 的业务
失败仍然应有 v2 envelope；退出码是同一结果的进程级摘要。

### 6.4 stderr 与日志

stdout 只用于机器结果或事件；stderr 的运行诊断使用 pragma.log/v1 结构化行，
不应并入 stdout。bootstrap 异常是例外，见第 10 章。

--log-level 与 PRAGMA_LOG_LEVEL 是 P1 设计契约，当前代码尚未合入，当前发布版本
可能尚未支持。落地后的值域和优先级为：

- 值域：silent、fatal、error、warn、info、debug；
- 优先级：CLI --log-level > 环境变量 PRAGMA_LOG_LEVEL > 默认 info；
- silent 只过滤 pragma.log/v1，不吞掉 stdout envelope、业务错误、text renderer
  的必要输出或 bootstrap 纯文本异常；
- format 与 interactive 不会自动改变日志级别。

当前版本不要把“没有 stderr 行”当成“没有错误”；始终先解析 stdout 和退出码。

## 7. 错误码与 recovery

### 7.1 P1 状态说明与基础规则

下表是定稿的 P1 recovery 设计。details.recovery 随 P1 代码落地后生效，当前
发布版本可能没有该字段。它是提示，不是会替 Agent 执行动作的 workflow engine；
不会携带 shell command、payload、retryAfter 或任意 action 字符串。

pragma.integration-error/v1 的核心字段是 code、message、retryable、category 和
可选 details。P1 的 recovery object 包含 schemaVersion 以及以下六个 true-only
动作字段：

- reuseRequestId：重试时复用原 request ID；
- retryWithSamePayload：只能用完全相同的语义 payload 重试；
- refreshExecution：先读取最新 Mission/Execution 状态；
- continueFromCursor：从已保存的 cursor 继续 watch；
- needsRespond：需要回答 pending interaction；
- noRetry：不要原样重放当前失败操作，先执行指定的恢复步骤。

动作字段均为可选的 literal true，至少出现一个。reuseRequestId 必须同时有
retryWithSamePayload；noRetry 不得与这两个原样重放动作同时出现。未知
schemaVersion 或不符合 recovery schema 的对象按“缺失”处理，不能猜测动作。

retryable=true 只表示存在某种恢复路径，不表示可以原样重放；例如 CURSOR_EXPIRED
可以 retry，但旧 cursor 不能 retry。noRetry=true 也不表示永远没有下一步，而是
表示不能自动重复当前相同操作。

### 7.2 错误码与退出码分组

| 分组               | 错误码                                                                                                                                                                                                                                            | 退出码 | 默认 retryable                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | -------------------------------------------------------------------- |
| usage              | INVALID_ARGUMENT、INVALID_FORMAT、CURSOR_INVALID、WORKSPACE_REQUIRED、INTERACTIVE_TTY_REQUIRED、INPUT_SCHEMA_INVALID                                                                                                                              |      2 | false                                                                |
| lookup             | NOT_FOUND、EXECUTOR_NOT_FOUND、MISSION_NOT_FOUND、BOARD_ITEM_NOT_FOUND、WORKSPACE_NOT_FOUND                                                                                                                                                       |      3 | false                                                                |
| conflict / command | CURSOR_EXPIRED、IDEMPOTENCY_CONFLICT、MISSION_LEASE_HELD、MISSION_FENCING_REJECTED、COMMAND_REJECTED、COMMAND_EXPIRED、COMMAND_ACCEPTANCE_TIMEOUT、COMMAND_RESULT_TIMEOUT、STEER_TARGET_NOT_ACTIVE、STEER_TARGET_CHANGED、INTERACTION_NOT_PENDING |      4 | 按 code 固定；CURSOR_EXPIRED、lease/fencing、command timeout 为 true |
| dependency         | DEPENDENCY_UNAVAILABLE、RUNTIME_UNAVAILABLE、KEYCHAIN_UNAVAILABLE、SECRET_MIGRATION_REQUIRED、SECRET_STORE_LOCKED                                                                                                                                 |      5 | migration false，其余 true                                           |
| permission         | WORKSPACE_ACCESS_DENIED、PERMISSION_DENIED                                                                                                                                                                                                        |      6 | false                                                                |
| protocol / storage | PROTOCOL_VERSION_UNSUPPORTED、STORAGE_VERSION_UNSUPPORTED、STORAGE_CORRUPTED                                                                                                                                                                      |      7 | false                                                                |
| execution          | EXECUTION_FAILED、INTERNAL_ERROR                                                                                                                                                                                                                  |     10 | cause-dependent                                                      |
| interrupted        | INTERRUPTED                                                                                                                                                                                                                                       |    130 | false                                                                |

COMMAND_REJECTED 的 recovery 还要读取 details.reason；不能只根据 category 做动作。
EXECUTION_FAILED 与 INTERNAL_ERROR 的 retryable 由生产者按原因决定。

### 7.3 Recovery matrix

| 错误码或状态                                                                                            | recovery 动作                                          | Agent 应做什么                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| COMMAND_ACCEPTANCE_TIMEOUT                                                                              | reuseRequestId + retryWithSamePayload                  | 命令已 durable，但 owner 尚未确认接收；短退避后以相同 request ID 和完全相同 payload 重发             |
| COMMAND_RESULT_TIMEOUT                                                                                  | queryOperation                                         | owner 已接收命令但结果尚未完成；查询同一 operation，不能据此重复产生新语义命令                       |
| MISSION_LEASE_HELD、MISSION_FENCING_REJECTED                                                            | reuseRequestId + retryWithSamePayload                  | 等待 owner/lease 竞争缓解后精确重试                                                                  |
| DEPENDENCY_UNAVAILABLE、RUNTIME_UNAVAILABLE、KEYCHAIN_UNAVAILABLE、SECRET_STORE_LOCKED                  | retryWithSamePayload；run/mutation 另加 reuseRequestId | 依赖恢复后重试；副作用命令必须保留原 request ID                                                      |
| INTERNAL_ERROR 且 retryable=true                                                                        | retryWithSamePayload；run/mutation 另加 reuseRequestId | 只有生产者明确判定为暂时性时才精确重试                                                               |
| watch 的暂时性 failure，且已有已持久化 cursor                                                           | continueFromCursor                                     | 重新启动 watcher，从 stream.end.lastCursor 或最后确认的 durable cursor 使用 --after                  |
| CURSOR_INVALID                                                                                          | noRetry                                                | 不要原样重试；重新执行同一查询以取得匹配 command/filter 的新 cursor                                  |
| CURSOR_EXPIRED                                                                                          | noRetry                                                | retryable 不代表旧 cursor 可用；从 retained window、summary 或 events 重新建立起点                   |
| IDEMPOTENCY_CONFLICT                                                                                    | noRetry                                                | 同一个 request ID 已绑定不同 payload；核对原 payload，只有明确产生新语义时才新建 ID                  |
| STEER_TARGET_NOT_ACTIVE、STEER_TARGET_CHANGED                                                           | refreshExecution + noRetry                             | 先 mission get --view summary 或 result，读取当前 Execution，再决定新的 steer/interrupt              |
| COMMAND_REJECTED 且 details.reason=execution_target_changed                                             | refreshExecution + noRetry                             | 与 strict target stale 相同；不能把旧命令盲打到新的 Execution                                        |
| INTERACTION_NOT_PENDING                                                                                 | refreshExecution + noRetry                             | 重新读取 result/events，确认 interaction 是否已回答或 Execution 是否变化；不要重复回答旧 interaction |
| 其他 COMMAND_REJECTED、COMMAND_EXPIRED                                                                  | noRetry                                                | 读取 details.reason 后重新决策；原命令重放不会自动修复                                               |
| INVALID_ARGUMENT、INVALID_FORMAT、WORKSPACE_REQUIRED、INTERACTIVE_TTY_REQUIRED、INPUT_SCHEMA_INVALID    | noRetry                                                | 修正参数/输入后形成新请求                                                                            |
| NOT_FOUND、EXECUTOR_NOT_FOUND、MISSION_NOT_FOUND、BOARD_ITEM_NOT_FOUND、WORKSPACE_NOT_FOUND             | noRetry                                                | 重新 discover/list 或核对标识；不要重复同一查询                                                      |
| WORKSPACE_ACCESS_DENIED、PERMISSION_DENIED                                                              | noRetry                                                | 等待用户/Host 授权或调整范围，禁止自动循环                                                           |
| SECRET_MIGRATION_REQUIRED、PROTOCOL_VERSION_UNSUPPORTED、STORAGE_VERSION_UNSUPPORTED、STORAGE_CORRUPTED | noRetry                                                | 先升级、迁移或修复数据；不要自动重试                                                                 |
| EXECUTION_FAILED 且 retryable=false                                                                     | noRetry                                                | 结束并报告失败；不要重放                                                                             |
| EXECUTION_FAILED 且 retryable=true                                                                      | 不自动给 reuseRequestId                                | 同一 run request ID 会复用已失败 Mission，不会创建一次新的 Execution；是否新建 run 由上层按原因决定  |
| INTERRUPTED                                                                                             | noRetry                                                | 这是已观察到的中断结果，不自动重启 Mission                                                           |
| input_required 非错误状态                                                                               | 文档派生 needsRespond                                  | 读取 interaction，执行 mission respond，再从回答前保存的 cursor 续看；不要伪造 error                 |

### 7.4 缺失 recovery 的兼容行为

旧客户端可以忽略 error.details.recovery。新客户端遇到字段缺失、不认识的
schemaVersion 或 schema 校验失败时，回退到：

1. 先看 status、error.code 和 error.retryable；
2. retryable=false 时不自动重试；
3. retryable=true 但没有合法 recovery 时，不猜新 request ID、cursor 或
   execution target；先刷新状态或交给用户/上层策略。

## 8. 推荐调用状态机

以下十步覆盖 discover/describe → run --detach → watch、人工输入、strict target
刷新和进程超时。它是调用方状态机，不是 CLI 内置的后台任务。

1. **发现并固定定义。** 用 expert/team/flow discover --format=json
   --interactive=never --color=never，严格解析 pragma.cli-result/v2，从结果取
   canonical ref、source、project revision、fingerprint 和 availability；再用
   describe 校验要执行的资源。若固定 project/revision，必须一并传入。
2. **提交 detached run。** 调用方生成并持久化新的 UUID；Expert/Team 使用
   --input -，Flow 使用 --input-json -，执行 run --detach --format=json。保存
   response 中的 requestId、missionId、executionId。accepted 只代表已接受并可追踪。
3. **启动 watch。** 首次没有 cursor 时使用有限 --replay N；有 cursor 时使用
   --after LAST_CURSOR，二者不能同时出现。固定 --until input-required 或
   --until terminal、--format=jsonl、--interactive=never 和 --color=never。
4. **先保存事件，再推进 cursor。** 对每个 replayable=true 事件，先持久化整个
   事件（至少 eventId 和 cursor），成功后才把 cursor 写成 LAST_CURSOR。不要用
   transient 的 mission.snapshot、watch.ready 或 stream.end 伪造 durable continuation
   cursor。
5. **只用最后一行判定 watcher 完成。** 验证只有一个最终 stream.end，先确认
   data.status=succeeded，再读取成对的 data.observedStatus 和 data.stopReason。
   不要把 watcher 的 succeeded 直接当成 Mission succeeded。
6. **处理 input_required。** 当 observedStatus=input_required 时，从此前保存的
   human.interaction.requested.data 或 run.input_required.data.interaction 取得
   完整 interaction envelope 和 interactionId。watch 的 stream.end 本身没有
   interaction。
7. **缺失事件时定向读取。** 如果本地没有 interaction envelope，执行
   mission get MISSION_ID --view result --format=json；只有确认 result.status 为
   waiting 且 result.interaction 存在时才可回答。否则刷新 summary/events，不猜
   interactionId。
8. **respond 后续看。** 为 mission respond 生成新的 command request ID，使用
   --answers-json - 写入完整 response 并关闭 stdin。默认只等待 operation
   acknowledgement，不必让 respond 吞掉整个后续 Execution；回答成功后从第 4 步
   保存的 LAST_CURSOR 执行 mission watch --after LAST_CURSOR
   --until input-required，以便看到 resolved 和后续 durable events。
9. **处理 terminal、strict target 与恢复。** observedStatus=succeeded 收尾；
   failed 读取 Mission result/error；interrupted 收尾且不自动重启；detached 只表示
   本地 watcher 停止、Mission 仍可继续。Steer/interrupt/queue steer 先读取最新
   Execution 并带 --expected-execution；若 stale/changed，执行 refresh，不要盲目
   重试到新的 Execution。COMMAND_ACCEPTANCE_TIMEOUT 复用原命令 ID 和 payload；
   COMMAND_RESULT_TIMEOUT 查询原 operation；
   INTERACTION_NOT_PENDING 不重复回答。
10. **处理 subprocess deadline。** 外部 timeout 只终止本地 CLI 进程；它不等价于
    mission interrupt，也不代表 Mission 已取消。恢复时使用已持久化的原 request
    ID 和完全相同 payload，或使用最后确认的 cursor；只有用户/上层明确授权时才另发
    interrupt。

## 9. Cursor 续传

Cursor 是不透明字符串。调用方只能原样保存和传回，不应 decode、拼接或按 offset
自行构造。P0 cursor 已绑定命令以及规范化后的 filter/query；因此必须在同一个
command、同一组 filter 和同一 Mission 上续传。

推荐持久化顺序：

1. 读取一条 JSONL 事件；
2. 检查 requestId、sequence、replayable 和 cursor；
3. 把事件或至少 eventId/cursor 写入调用方的 durable store；
4. durable store 成功后再更新 LAST_CURSOR；
5. 进程恢复时从 --after LAST_CURSOR 继续。

首次 watch 没有 cursor 时用有限 --replay N；已有 cursor 时：

```bash
pragma mission watch "$MISSION_ID" \
  --after "$LAST_CURSOR" --until input-required \
  --format=jsonl --interactive=never --color=never
```

--after 与 --replay 互斥。跨 command、跨 filter 或不属于该 Mission 的 cursor 应得到
CURSOR_INVALID；不再保留的 cursor 应得到 CURSOR_EXPIRED。两者都不应原样循环重试：
前者重新建立正确 query cursor，后者从当前 retained window 或 summary/events
重新找起点。

当收到 watch.detached 或本地 Ctrl-C 时，含义是“本地 watcher 已停止，Mission
继续”，不是 interrupt。最终 JSONL 仍应有唯一 stream.end；其 watcher status、
result.status=detached、observedStatus、stopReason 和 lastCursor 要分别读取。
外部 subprocess timeout 也按同样的本地停止处理，先保存此前确认的 cursor 再重新
启动 watch。

## 10. Bootstrap exception

以下异常发生在主 CLI machine envelope 能够建立之前：

- Node.js 版本低于 22：退出码 2；
- CLI bundle import 失败：退出码 10。

这两条路径没有 stdout envelope，也没有 pragma.cli-result/v2 或
pragma.cli-event/v2；只在 stderr 写纯文本诊断。调用方不能把这类 stderr 当作
pragma.log/v1，也不能等待一个不存在的 stream.end。

启动前可用 node --version、pragma version 做预检。若子进程返回非零且 stdout
为空，按“bootstrap exception + exit code + 纯文本 stderr”处理；不要把纯文本误
解析为业务 INTERNAL_ERROR。bundle import 失败应报告安装/构建问题，升级或重新
安装后再重试，不要循环启动同一坏包。

## 11. Machine examples

以下 JSON 使用真实 UUID 形状、有效的协议版本和可由现有 v2 schema 解释的字段。
其中 recovery example 明确是 P1 目标输出；当前尚未合入 P1 的版本可能不会产生
同样的 details.recovery。

### 11.1 JSON success

```json
{
  "schemaVersion": "pragma.cli-result/v2",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "command": "expert.run",
  "status": "succeeded",
  "missionId": "22222222-2222-4222-8222-222222222222",
  "executionId": "33333333-3333-4333-8333-333333333333",
  "executor": {
    "kind": "expert",
    "id": "0000000000pragma"
  },
  "workspace": {
    "schemaVersion": "pragma.integration-workspace/v1",
    "requestedPath": "/tmp/pragma-agent-example",
    "canonicalPath": "/tmp/pragma-agent-example",
    "displayName": "pragma-agent-example",
    "identityHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "access": {
      "exists": true,
      "readable": true,
      "writable": true
    },
    "source": "explicit"
  },
  "result": "CLI_RUN_OK",
  "warnings": [],
  "meta": {
    "startedAt": "2026-08-31T10:00:00+08:00",
    "completedAt": "2026-08-31T10:00:42+08:00",
    "durationMs": 42,
    "cliVersion": "0.1.0-next.13",
    "protocolVersion": "pragma.integration/v2"
  }
}
```

### 11.2 JSON failure with recovery hint

下面的结果对应进程退出码 4。COMMAND_ACCEPTANCE_TIMEOUT 的 retryable=true 与两个
recovery flag 组合表示“同 ID、同 payload 重发”；它不表示创建新 Mission。

```json
{
  "schemaVersion": "pragma.cli-result/v2",
  "requestId": "44444444-4444-4444-8444-444444444444",
  "command": "mission.respond",
  "status": "failed",
  "missionId": "22222222-2222-4222-8222-222222222222",
  "error": {
    "schemaVersion": "pragma.integration-error/v1",
    "code": "COMMAND_ACCEPTANCE_TIMEOUT",
    "message": "The command acceptance timed out.",
    "retryable": true,
    "category": "conflict",
    "details": {
      "missionId": "22222222-2222-4222-8222-222222222222",
      "requestId": "44444444-4444-4444-8444-444444444444",
      "timeoutMs": 30000,
      "recovery": {
        "schemaVersion": "pragma.integration-recovery/v1",
        "reuseRequestId": true,
        "retryWithSamePayload": true
      }
    }
  },
  "warnings": [],
  "meta": {
    "startedAt": "2026-08-31T10:01:00+08:00",
    "completedAt": "2026-08-31T10:01:30+08:00",
    "durationMs": 30000,
    "cliVersion": "0.1.0-next.13",
    "protocolVersion": "pragma.integration/v2"
  }
}
```

### 11.3 JSONL interaction event

单行事件可以独立按 pragma.cli-event/v2 解析。它是可重放的 interaction request，
因此必须有 cursor；data 内的 envelope 使用 pragma.human-interaction/v1。

```jsonl
{
  "schemaVersion": "pragma.cli-event/v2",
  "requestId": "66666666-6666-4666-8666-666666666666",
  "eventId": "77777777-7777-4777-8777-777777777777",
  "sequence": 4,
  "emittedAt": "2026-08-31T10:02:04+08:00",
  "missionId": "22222222-2222-4222-8222-222222222222",
  "executionId": "33333333-3333-4333-8333-333333333333",
  "replayable": true,
  "cursor": "cursor-v2-interaction-0004",
  "type": "human.interaction.requested",
  "data": {
    "schemaVersion": "pragma.human-interaction/v1",
    "kind": "request",
    "missionId": "22222222-2222-4222-8222-222222222222",
    "executionId": "33333333-3333-4333-8333-333333333333",
    "interactionId": "approval-001",
    "sensitive": false,
    "interaction": {
      "kind": "approval",
      "title": "继续执行",
      "prompt": "是否继续执行当前 Mission？",
      "options": [
        {
          "value": "approve",
          "label": "批准",
          "description": "继续执行"
        },
        {
          "value": "reject",
          "label": "拒绝",
          "description": "停止当前流程"
        }
      ],
      "approveOption": "批准"
    }
  }
}
```

### 11.4 input_required stream.end

这是直接 run 的完整两行 JSONL stream。注意它的最终 status 是 input_required、
退出码是 3，并且直接 run 的 stream.end.data 可以带 interaction。

```jsonl
{"schemaVersion":"pragma.cli-event/v2","requestId":"88888888-8888-4888-8888-888888888888","eventId":"99999999-9999-4999-8999-999999999999","sequence":0,"emittedAt":"2026-08-31T10:03:00+08:00","missionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","executionId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","replayable":true,"cursor":"cursor-v2-input-0000","type":"human.interaction.requested","data":{"schemaVersion":"pragma.human-interaction/v1","kind":"request","missionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","executionId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","interactionId":"approval-001","sensitive":false,"interaction":{"kind":"approval","title":"继续执行","prompt":"是否继续执行当前 Mission？","options":[{"value":"approve","label":"批准","description":"继续执行"},{"value":"reject","label":"拒绝","description":"停止当前流程"}],"approveOption":"批准"}}}
{"schemaVersion":"pragma.cli-event/v2","requestId":"88888888-8888-4888-8888-888888888888","eventId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","sequence":1,"emittedAt":"2026-08-31T10:03:01+08:00","missionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","executionId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","replayable":false,"type":"stream.end","data":{"status":"input_required","exitCode":3,"missionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","executionId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","interaction":{"schemaVersion":"pragma.human-interaction/v1","kind":"request","missionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","executionId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","interactionId":"approval-001","sensitive":false,"interaction":{"kind":"approval","title":"继续执行","prompt":"是否继续执行当前 Mission？","options":[{"value":"approve","label":"批准","description":"继续执行"},{"value":"reject","label":"拒绝","description":"停止当前流程"}],"approveOption":"批准"}},"lastCursor":"cursor-v2-input-0000","warnings":[]}}
```

相比之下，mission watch --until input-required 的最终 stream.end.data.status 是
watcher 的 succeeded，并通过 observedStatus=input_required、stopReason=input_required
表示 Mission 停在等待输入；不要从该 watch 的 stream.end 读取 interaction。

### 11.5 respond

--answers-json - 的 stdin 是完整 response object。回答命令应使用新的 command request
ID；如果 ack timeout，按第 7 章使用相同 ID 和相同 JSON 重发。

```bash
RESPONSE_REQUEST_ID=dddddddd-dddd-4ddd-8ddd-dddddddddddd
printf '%s' '{"approved":true,"notes":"继续"}' |
  pragma mission respond "$MISSION_ID" \
    --interaction "$INTERACTION_ID" --answers-json - \
    --request-id "$RESPONSE_REQUEST_ID" \
    --format=json --interactive=never --color=never
```

### 11.6 Cursor resume

只有在事件已经持久化之后才更新 LAST_CURSOR，随后用 --after 续看：

```bash
LAST_CURSOR=cursor-v2-interaction-0004
pragma mission watch "$MISSION_ID" \
  --after "$LAST_CURSOR" --until input-required \
  --format=jsonl --interactive=never --color=never
```

不要把 --after 与 --replay 同时传入；不要把另一个 discover/list 查询得到的 cursor
传给 watch。

## 12. 安全边界

通用 pragma CLI 不是 Codex tool 的权限边界，也不是 sandbox 或 approval wrapper。
它只验证自身命令需要的最低条件：

- --workspace 需要绝对路径；CLI/Host 会检查目录存在、可读写并计算 canonical
  identity，但不会替 Agent 限制到某个项目根；
- --input FILE 和其他文件参数可以读取当前进程有权限读取的路径；
- PRAGMA_HOME、PRAGMA_PROJECT_ID 可影响数据根和项目选择；
- interrupt、queue remove、queue resume、steer、respond 等 mutation 没有由 CLI
  单独提供的通用授权注解。

面向 Agent 的外层集成应固定可信的 PRAGMA_HOME 与 project，注入并 realpath 校验
workspace containment，禁止模型自由选择 workspace 外路径；输入优先通过 stdin，
避免 argv 泄露；把 read、create/append、strict target 和 destructive 命令拆成不同
的授权面。需要用户确认的 interrupt 或队列操作由外层 policy 决定，并在 strict
命令中使用最新 --expected-execution。

本页不提供 skill、不包装权限，也不新增 --agent 模式。若需要 Codex 专用 tool
manifest、JSON input/output schema、side-effect annotations 或审计策略，应在 CLI
之外单独维护。

## 13. Compatibility / changelog note

- 旧客户端可以忽略 error.details.recovery，因为它是 IntegrationError v1 的
  开放 details 中的 additive nested field；它不是新的顶层 CLI error protocol。
- 新客户端对缺失、未知 recovery schemaVersion 或非法 recovery object 按缺失处理，
  不 fail open，也不根据未知字段猜动作。
- completion 是人类 shell 辅助功能，不属于 Agent contract；不要把补全脚本当作
  machine tool schema。
- completion、Node/bootstrap、发行包版本和 PATH 冲突的发布流程见
  [CLI 分发与发布运维手册](./cli-release.md)。
- 人类语义、text renderer、Desktop 共用 Mission 以及历史恢复见
  [Pragma CLI Mission 控制](./cli.md)。
- 修改本页中的协议、状态或 recovery 语义时，应同时更新发布 runbook、版本/能力
  说明和对应 fixture；不要只改一段示例。

返回入口：[人类 CLI 指南](./cli.md) · [CLI 分发与发布运维手册](./cli-release.md)。
