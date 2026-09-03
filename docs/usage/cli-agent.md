# Pragma CLI Agent / automation guide

> 人类操作请先看 [Pragma CLI Mission 控制](./cli.md)。本页描述机器调用的稳定约定。

## 使用范围

`pragma` 是本机 Pragma Host 的命令行入口。Agent、CI 或其他自动化程序可以用它发现 Expert、
ExpertTeam 和 Flow，创建或继续 Mission，读取事件与 Mission Board，并处理 HumanTask。

CLI 与 Desktop 使用相同的 `PRAGMA_HOME` 和 Local Host 语义，不要求 Desktop 进程持续运行。调用方负责
自己的 workspace 隔离、mutation 授权、超时和用户确认；CLI 负责协议校验、持久提交与状态观察。

## 协议基线

| 项目 | 契约 |
| --- | --- |
| Node.js | 22 或更高版本 |
| 支持 OS | macOS Apple Silicon、macOS Intel、Windows x64 |
| 单次结果 | `pragma.cli-result/v2`，由 `--format=json` 输出一个 JSON object |
| 事件流 | `pragma.cli-event/v2`，由 `--format=jsonl` 或 `--stream-json` 逐行输出 |
| 错误对象 | `pragma.integration-error/v1`，位于 result 或 `stream.end.data.error` |
| 协议版本 | `meta.protocolVersion` 为 `pragma.integration/v2` |

实际调用前执行 `pragma version`，并以该版本的 `pragma --help` 和子命令 `--help` 为能力契约。发布版本
不可覆盖；升级后应重新读取命令能力和协议版本。

## 推荐调用方式

- 单次结果使用 `--format=json`；实时事件和续传使用 `--format=jsonl`；
- 显式设置 `--interactive=never --color=never`，避免 TTY 改变输出；
- 每个新 run 或 mutation 生成并持久化 UUID；只有重试同一 durable request 且 payload 完全一致时才
  复用 request ID；
- run 使用 `--detach` 先取得持久 Mission/Execution 回执，再用 `mission watch` 跟踪；
- watcher 显式设置 `--until terminal` 或 `--until input-required`；
- 调用方为每个子进程设置总 deadline 或 idle deadline；终止 watcher 只会 detach，不等于 interrupt
  Mission；
- 输入优先走 stdin，避免把长 Prompt 或敏感内容放入 argv。

最小调用示例：

```bash
RUN_REQUEST_ID=11111111-1111-4111-8111-111111111111

printf '%s' '只回复 OK' |
  pragma expert run expert:0000000000pragma \
    --workspace "$PWD" \
    --input - \
    --request-id "$RUN_REQUEST_ID" \
    --detach \
    --format=json \
    --interactive=never \
    --color=never

pragma mission watch "$MISSION_ID" \
  --replay 50 \
  --until input-required \
  --format=jsonl \
  --interactive=never \
  --color=never
```

## 发现与固定资源

```bash
pragma expert discover "review" --format=json --interactive=never --color=never
pragma team discover --query "delivery" --format=json --interactive=never --color=never
pragma flow describe flow:<16-char-id> --format=json --interactive=never --color=never
```

canonical `kind:ID` selector 做精确匹配；普通文本按名称与描述搜索。自动化程序应保存最终选择的 canonical
ref，并在运行前使用 `describe` 检查 input schema、Runtime binding 与 workspace 要求。

## 运行与观察

Expert、Team 与 Flow 使用一致的 run 结构：

```bash
pragma expert run expert:<16-char-id> --workspace "$WORKSPACE" --input - --detach --format=json
pragma team run team:<16-char-id> --workspace "$WORKSPACE" --input - --detach --format=json
pragma flow run flow:<16-char-id> --workspace "$WORKSPACE" --input - --detach --format=json
```

`--detach` 的成功边界是请求已经持久提交。返回的 `missionId`、`executionId` 与 `requestId` 应立即保存。
后续使用：

```bash
pragma mission get "$MISSION_ID" --view summary --format=json
pragma mission get "$MISSION_ID" --view result --format=json
pragma mission get "$MISSION_ID" --view events --limit 100 --format=json
pragma mission watch "$MISSION_ID" --until terminal --format=jsonl
```

事件分页返回 opaque cursor。继续读取时必须保持相同 Mission、命令和过滤条件；先持久化已经成功处理的
cursor，再请求下一页。`stream.end` 是每个 JSONL stream 的唯一结束事件，其中 `observedStatus` 表示
观察到的 Mission 状态，`stopReason` 表示 watcher 停止原因。

## HumanTask

watch 返回 `input_required` 时，从事件或 result 中读取 `interactionId`、Prompt 和输入约束，再提交：

```bash
printf '%s' "$ANSWER" |
  pragma mission respond "$MISSION_ID" \
    --interaction "$INTERACTION_ID" \
    --input - \
    --request-id "$RESPOND_REQUEST_ID" \
    --format=json \
    --interactive=never \
    --color=never
```

回答必须按 `interactionId` 寻址。提交后从回答前保存的 cursor 继续 watch；不要重复回答已经关闭的
interaction。

## Mission mutation 与队列

`steer`、`respond`、`interrupt` 和 queue mutation 都是有副作用的命令。strict target 操作应使用最新
Execution identity；目标变化时先刷新 Mission 状态再重新决策。

```bash
pragma mission queue list "$MISSION_ID" --format=json
pragma mission queue steer "$MISSION_ID" "$REQUEST_ID" \
  --expected-execution "$EXECUTION_ID" --input - --format=json
pragma mission queue remove "$MISSION_ID" "$REQUEST_ID" --format=json
pragma mission interrupt "$MISSION_ID" \
  --expected-execution "$EXECUTION_ID" --request-id "$INTERRUPT_REQUEST_ID" --format=json
```

`queue list` 展示 ExpertSession prompt queue，不是 Mission Inbox operation list。Runtime 无法确认一次 steer
投递是否发生时，队列进入 `delivery_uncertain`；调用 `queue resume` 表示由调用方确认按原消息继续。

## 输出处理

机器模式下，stdout 只承载 JSON/JSONL 协议，stderr 承载诊断。调用方必须同时检查：

1. 进程退出码；
2. result `status` 或 `stream.end`；
3. `error.code`、`error.category` 与 `error.retryable`；
4. 最新 Mission / Execution identity 与 cursor。

主要退出码：

| 退出码 | 含义 |
| ---: | --- |
| 0 | accepted 或 succeeded |
| 2 | 参数、格式、输入或 bootstrap 版本错误 |
| 3 | input required，或资源、Mission、Workspace 不存在 |
| 4 | cursor、幂等、lease、fencing 或 strict target 冲突 |
| 5 | Runtime、依赖、keychain 或 SecretStore 不可用 |
| 6 | workspace 或其他权限被拒绝 |
| 7 | 协议、持久版本或数据完整性错误 |
| 10 | Execution 或内部错误 |
| 130 | interrupted |

具体恢复动作以 `error.code` 和最新状态为准，不能只依赖退出码。`retryable=true` 表示错误具有可恢复路径，
不代表可以原样重复副作用命令。幂等冲突、cursor 变化、Execution target 变化和权限拒绝都应先刷新状态或
交给用户策略。

Node 版本不满足要求或 CLI bundle 无法加载时，主 machine envelope 尚未建立；这类 bootstrap error 只在
stderr 输出文本。启动前可用 `node --version` 与 `pragma version` 预检。

## 安全边界

- 固定可信的 `PRAGMA_HOME`、Project 与 workspace；
- 对 workspace 做 `realpath` 和 containment 校验；
- 不允许模型自由选择 workspace 外路径；
- 将只读、创建/追加、strict target 与 destructive mutation 分成不同授权面；
- 由外层 policy 决定 interrupt、queue remove、resume、steer 与 respond 是否需要用户确认；
- 不把 stdout/stderr、Prompt、环境变量或 SecretStore 内容写入不受控日志。

CLI 不替代调用方的 sandbox 或 Agent tool permission wrapper。需要生成 tool manifest、JSON input schema、
side-effect annotation 或平台审计记录时，应由集成层基于当前 `pragma --help` 和本页协议显式定义。

返回入口：[人类 CLI 指南](./cli.md) · [CLI 分发与发布运维手册](./cli-release.md)。
