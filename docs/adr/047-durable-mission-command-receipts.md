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
- Desktop Mission 读取边界把产品元数据与 Local Host Mission projection 组合；如果 Mission v10 的执行
  快照或 Local Host projection 仍显示 active，而 Core 已经终态，Core 终态立即胜出，并对该 Mission
  定向、幂等补写 terminal event。v10 `execution` 仅作为恢复链接和兼容快照，不再是列表状态事实源。
- terminal event、Mission 状态通知和 chat materialization 是三个独立阶段。聊天投影与 Execution 归档
  属于可重建派生工作，其失败必须报告 degraded 并允许重试，不能阻止终态可见或让 Mission 继续显示运行中。
- Mission rail 只消费独立状态通知；chat/work invalidation 只刷新各自视图，禁止再次用聊天刷新作为状态
  更新的隐式传输通道。状态通知携带 Core-backed execution id/status；即使读取派生投影暂时失败，Desktop
  也可以把同一 Execution 的旧 active 快照覆盖为终态，并对完整摘要读取执行有界重试。
- terminal repair 必须同时检查 Local Host event projection 与 v10 recovery snapshot。缺失 `run.started`
  anchor 时，在同一 Mission owner fence 下先幂等补齐 anchor，再补 terminal event；任一派生写入失败不得
  阻断另一写入，也不得记录虚假的 repair success。
- 当前 Mission storage 仍是 v10。本次重构没有改变合法 v10 数据语义，因此不虚增版本。v3-v9 历史
  Schema 和相邻转换移入静态 migrations 目录；历史数据、备份和旧 journal replay 均继续支持。

## 后果

- 长 Runtime turn 不再制造“命令已生效但 Desktop 显示发送失败”的假阴性。
- UI 必须处理 receipt 与 outcome 两个阶段，附件草稿只能在 applied 后清理。
- owner/poller 故障变得可观测并可以恢复，代价是 owner scope 需要维护有界 backoff 和 lease-expiry
  recovery timer。
- 历史 Mission 不被删除或启动时全量迁移；首次访问单个 Mission 时在锁内逐步升级。
- Core 终态与 Mission projection 短暂不一致时，Desktop 仍返回正确终态，并在单 Mission 范围修复事件；
  不执行启动期全量扫描。
