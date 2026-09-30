# Mission conversation read model

阶段一完成范围、阶段二/三交接与性能复测要求见[Mission 延迟优化交接](../performance/mission-latency-handoff.md)。

Mission 会话读取遵循“事实、投影、展示”三层边界，读取路径不得承担修复任务。

## 权威边界

- Core Execution 是执行事实，负责运行、等待、取消与终态。
- Local Host Mission event feed 是 Mission activity 的耐久读取权威。`MissionActivityReader`
  统一解释事件；当事件仍是活动态时，它会有界回查 Core Execution，避免已完成任务继续显示为工作中。
- Desktop Mission 文件保存标题、工作区、执行引用和产品生命周期元数据。它不是执行状态裁决者。
- Desktop conversation projection 是已归档 Execution 的不可变读取来源。Renderer 只消费分页结果、
  控制状态和实时 patch，不从数组到达顺序推断执行生命周期。
- Core terminal commit 可直接发布 Desktop status 通知。通知按当前 handle 身份检查，不能让上一轮
  的延迟回调覆盖新一轮；Mission event、产品元数据和归档投影随后仍按原有耐久规则落盘。
  原生 Runtime 流结束不是 terminal commit；子任务、工具和人工确认仍由 Core 裁决。

```text
Core Execution ──terminal fact──▶ Local Host Mission events
       │                              │
       └──bounded terminal fallback──▶ MissionActivityReader
                                      │
Desktop product metadata ─────────────┴──▶ Desktop UI adapter ──▶ Renderer
```

## 读取规则

1. Chat page、pending/control state、context window 独立读取并独立降级；控制状态失败不得隐藏已读到的消息。
2. 历史分页使用稳定 entry key cursor。旧 byte-offset cursor 只作为升级输入，不能继续定位可替换文件。
3. 加载历史页不推进实时 `revision`；该水位只表示连续应用的 live change sequence。
4. pending interaction 只属于当前 waiting Execution。Execution 进入非 waiting 或终态后立即为空，缓存不得复活它。
5. archived projection 在内存中按当前规则规范化；读取不会重写文件、创建备份或调度 timer。
6. archived projection 仍受明确的条目、字节和字段长度上限约束；省略条目数和截断字段数进入读取协议并在
   UI 展示，禁止把有损归档伪装成完整历史。
7. Renderer 按权威条目顺序合并，且只挂载可视区域附近的会话块。

## 消息接入与首 token 前的排队

- Mission controller lease 保证跨进程归属；同一 Host 内，初始运行与后续消息必须共用按 Mission
  串行的 prompt admission。接入从启动准备前开始，直到 Session、Core prompt 和 Execution 引用完成
  安装后释放，不等待首 token 或整个 Runtime turn。不同 Mission 独立接入，失败也必须释放后续请求。
- Desktop 直接发送与 Local Host Inbox 消费共用该入口，避免初始运行准备时创建竞争的 ExpertSession。
  若 Inbox 比 Desktop attached-run 准备更早到达，新 Mission 必须先建立已持久化的 initial prompt；
  branch Mission 仍从用户的新消息开始。已安装 Session 的消息由 Core 持久 prompt queue 调度。
- Desktop 的 attached-run handle 声明 `missionOwnerLifetime: "host"`：单轮结果完成后，Mission owner、
  ExpertSession、Runtime 与收尾投影继续由 Desktop 持有。共享 Local Host run 不得释放这个 owner，
  否则收尾写入和后续 prompt 会使用失效 guard。CLI 默认仍在单次 run 完成并释放底层资源后释放 owner。
  Host 生命周期不改变 fencing：撤销或接管后，旧 guard 的写入仍必须被拒绝。
- Renderer 在请求已提交、Execution 投影尚未到达时保留本地等待标记；这段时间发送的后续消息立即
  展示为待排队消息。`command.applied` 只证明命令已应用，不能单独释放等待标记；会话输出、终态
  或命令拒绝负责结束等待。已有 pending 和 paused queue 状态也参与排队展示判定。
- Inbox 落盘后唤醒本进程 owner。连续唤醒合并到当前 poll 完成之后，不并发消费同一 Mission；
  跨进程无通知时使用 500 ms 上限轮询。operation waiter 先注册通知再读耐久状态，避免提交丢唤醒。
- `queue.update` 只更新排队控制投影，不读取聊天历史、不生成未读提醒、不覆盖已流式展示的文本。
  队列使用独立 `queueRevision`，不能声明完整控制状态已加载；较旧的控制状态仍补齐其他字段，
  但不覆盖较新的队列，较旧的队列 patch 同样被忽略。
  Main、Preload 和 Renderer 随同一 Desktop 包升级；该 IPC patch 不落盘，不改变历史数据 Schema。
- `ExpertTurn.settled` 在 Session prompt 绑定耐久释放后完成，Desktop 不再以重复读取 Session 代替
  这一屏障。human checkpoint 会关闭内存流但保留 waiting Execution，不能据此发布失败终态。
  Session 仅合并尚未完成的观察 Promise，完成后移除缓存，避免长期保留每轮完整输出。

## Runtime 事件持久化与投递

文本 delta 走有界 live bus；耐久元数据由单写入队列按 50 ms 或 64 条批量提交。工具/人工控制事件
和收尾 flush 是提交屏障，提交失败必须传播给运行结果。这里没有把成功定义为“数据已放入内存队列”。

Desktop Memory data plane 使用现有 canonical handoff 作为持久 outbox。Execution commit 不等待
canonical feed 投递完成；删除继续遵循 canonical deletion barrier，Host 关闭 feed 前 drain 本进程投递。
失败 handoff 保留供原有恢复入口重放。CLI 单次进程的默认 inline 投递语义保持不变。
每个 Execution 的后台投递请求合并成一个 worker 与一个错误观察者；新增提交只标记再次投递，
积压存于耐久 handoff。事件批量提交失败也必须注销 Runtime submission，然后传播错误。

上述改动尚未替换 Execution、ExpertSession 和 Mission controller 的 JSON/journal 持久化引擎。
每 owner SQLite 引擎、版本化惰性迁移、索引分页、Usage/terminal projection outbox，以及容量账本
仍属于后续持久化改造，不能把当前批量提交当成这些工作已经完成。

## 删除的后台修复

以下机制已经删除：

- Mission 列表/详情读取后异步回写终态的 terminal reconciler；
- 读取旧 conversation projection 后异步重排并替换文件的 projection repair；
- pending interaction 的异步重建 timer。

这些任务把读取变成写入，制造了 revision、cursor、通知和文件代次竞态。现在错误通过明确的
`syncIssues` 或 degraded 日志暴露，读取返回同一时刻可证明的数据。

以下不属于后台修复，必须保留：

- command/event/semantic-write journal 的崩溃重放；
- append-only 文件的 torn-tail 恢复；
- 用户明确触发的 orphan recovery / force interrupt；
- terminal Mission event 的同步、有界重试。

它们分别保证原子提交或执行控制，并不在普通读取后偷偷改写业务投影。

## 回归要求

- Core 已终态而 Mission event 或 Desktop 元数据仍为活动态时，列表与详情必须显示终态。
- askUserQuestion 被中断后，pending 立即关闭，刷新和任务切换不得复活。
- history page 与 live patch 交错时，历史 revision 不得吞掉尚未应用的 patch。
- 旧 projection cursor 不得按新文件字节偏移继续读取。
- 单个控制状态读取失败时，可读消息仍然展示。
- 元数据 upsert 不产生未读提醒；只有用户可见内容变化推进提醒边界。
