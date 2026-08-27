# Pragma CLI Mission 控制

`pragma` 是与 Desktop Main 共用 `@pragma/local-host` 的 Node.js 22+ 命令行入口。CLI 与
Desktop 不共享进程内 owner；同一个 Mission 由当前 owner 消费持久化 Inbox，另一个端只提交
命令或只读事件。因此关闭 Desktop 后，CLI 仍可恢复已被证明可恢复的 Mission；CLI 退出也不会
让 Desktop 的 owner 被中断。

## 命令

```text
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
一个事件，并以唯一的 `stream.end` 结束；Ctrl-C 是本地 detach，退出码为 0。

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
