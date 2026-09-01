# ADR 047: Durable Mission command receipts and owner lifecycle

## 状态

Accepted

## 背景

Desktop 曾在 IPC mutation 内等待 durable Mission command 的终态，并把固定等待期限称为
acknowledgement timeout。命令可能已经持久化、被 owner 接收并继续执行，但 renderer 仍收到失败；
同时 lease renewal、Inbox poller 和 Host command switch 可以分别启动，造成“有 owner、无消费者”
以及 Desktop/Core 结果语义漂移。

## 决策

- Desktop `missions:message:send` 在 command 成功写入 Inbox 后立即返回版本化 receipt，不等待 Runtime
  或 command 终态。终态通过 `missions:command:outcome` 通知。
- request ID 是提交、乐观消息、队列项和 outcome 的稳定关联键。不确定提交只能使用同一 request ID 和
  同一 payload 重试；明确 rejected 的 operation 不会被当作不确定提交重放。
- acceptance timeout 与 result timeout 使用不同错误码和恢复动作。前者允许同 ID 精确重试；后者查询原
  operation。
- Mission owner scope 同时拥有 lease renewal 与 Inbox poller。绑定 consumer 后 acquisition 必须启动
  poller；连续 poll failure 会报告 degraded、停止不健康 owner，并在 lease 到期且仍有 durable 工作时
  尝试重新获取。
- `@pragma/local-host` 的 command dispatcher 是唯一命令路由表。Desktop 与 Core 只提供各自的底层端口，
  不复制 command-kind switch。
- Core Execution event 是执行状态和结果的权威来源；Desktop 初始和后续 turn 都写入同一 Mission event
  projection，Desktop/CLI query 读取同一投影语义。
- 当前 Mission storage 仍是 v10。本次重构没有改变合法 v10 数据语义，因此不虚增版本。v3-v9 历史
  Schema 和相邻转换移入静态 migrations 目录；历史数据、备份和旧 journal replay 均继续支持。

## 后果

- 长 Runtime turn 不再制造“命令已生效但 Desktop 显示发送失败”的假阴性。
- UI 必须处理 receipt 与 outcome 两个阶段，附件草稿只能在 applied 后清理。
- owner/poller 故障变得可观测并可以恢复，代价是 owner scope 需要维护有界 backoff 和 lease-expiry
  recovery timer。
- 历史 Mission 不被删除或启动时全量迁移；首次访问单个 Mission 时在锁内逐步升级。
