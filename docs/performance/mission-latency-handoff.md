# Mission 延迟优化交接

更新时间：2026-10-01。阶段一代码：`ef107172`，PR [#347](https://github.com/pqpo/pragma/pull/347)。
本文件整理当前实现与剩余任务，不代表阶段二、三已实现。阶段划分如下：二是持久化热路径，三是收尾投递、容量检查及链路收敛。

## 当前问题与完成范围

用户使用内置 Pi Runtime + DeepSeek v4 flash，反馈创建 Mission 首 token 慢、后续轮次仍慢，
第二轮曾出现 `Mission controller lease was lost or superseded`；输出结束后约 5 秒才结束 loading，
排队约 5 秒才出现 steer，点击 steer 约 10 秒才真正发出。这些数字是用户观察，未形成统计基线。

阶段一完成：

- PR 评论复核追加：投递 worker 最后 dirty 检查与退出在同一同步段完成；相同 revision 的完整状态不能覆盖队列 patch，完整状态水位在读取开始时捕获。
- Desktop 默认五分钟空闲 TTL；保留活跃/排队/人工等待，空闲检查最多每分钟一次。按接入串行边界释放瞬态 Session/Runtime 后再释放 owner/poller；释放期间 Inbox 命令定向恢复。资源计数和累计平均 poll rate 进入诊断，见 ADR 063。

- Desktop attached run 使用 Host 级 Mission owner，首轮结束保留 Session、Runtime 和 guard；CLI 单轮运行仍释放 owner。
- Inbox 落盘后立即唤醒本进程 owner，重复唤醒合并且同一 Mission 不并发消费；跨进程轮询最大间隔为 500 ms。
- operation waiter 先订阅状态通知再读耐久状态，跨进程用轮询兜底。
- Runtime 元数据按 50 ms 或 64 条批量提交；工具、人工确认及结束 flush 保留耐久屏障。
- Desktop canonical handoff 后台投递，同一 Execution 的工作与错误观察者合并，故障保留 handoff，关闭前 drain。
- Core 耐久终态可立即发布 UI status，按当前 handle 身份拒绝旧回调覆盖下一轮。
- ExpertTurn.settled 表示 Session 已耐久释放该 turn 的 active 绑定，取代 Desktop 重复读盘判断。
- queue.update 单独推送，独立 queueRevision 防止加载标记和乱序覆盖问题；steer 不再等待聊天历史刷新才解除 loading。
- 阶段日志覆盖创建、准备、容量、SDK steer；复用 Runtime 时日志使用当前 Execution。
- CR 修复历史完整结果缓存增长、后台投递 Promise 积压、写入失败漏注销 submission、失去 lease 后新 settlement 永久等待等问题。

阶段一未实现：每 owner SQLite 引擎、对应旧状态迁移、索引分页、Usage/terminal projection outbox、容量账本。
真实 Pi + DeepSeek 修改前后对比未完成。不能把测试通过视为实测性能收益。

## 接手必须保留的行为

1. Mission owner 与 ExpertSession owner 是不同边界；Desktop 保留前者，不得靠关闭 guard 检查解决后续轮次报错。
2. Lease 过期允许接管，不等于自动取消任务。旧 owner 被释放、撤销或接管后必须拒绝写入与后续 Host 工具入口。
3. CLI 仍在底层资源释放后释放 Mission owner。长任务心跳、sleep 后续租、锁竞争重试继续遵守 ADR 062。
4. 原生流结束不等于 Core 终态；子任务、工具、Usage 和人工确认仍由执行层裁决。
5. 人工确认 checkpoint 可关闭内存流并保留 waiting Execution；恢复不得被误判为失败或重复执行副作用。
6. prompt/steer 必须经过耐久 Inbox、Session 接入与 fencing；减少 I/O 不能绕过权限和 idempotency。
7. canonical 删除屏障、删除 journal 和 ownership catalog 事务必须与新的投递/存储机制一起验证。
8. 队列、完整控制状态、历史和 Context 的版本边界独立；读取不得顺带修复或回写业务投影。

Lease 历史：PR #209 的共享 Local Host run 提取引入了单轮释放语义，PR #344 增强所有权检查后暴露 Desktop 保留旧 guard 的问题。
本次修复生命周期归属，不撤销 #344 为长任务和接管增加的保护。

## 阶段二：缩短持久化热路径

目标：让运行状态提交和分页读取的成本主要取决于本次增量，而不是整个历史大小。先测量，再按 owner 分批替换。

### 交付顺序

1. 先补存储分段计时：锁等待、journal/replay、读取/解析、状态计算、写入/原子替换、handoff 创建；区分 Execution、ExpertSession、Mission controller。
2. 写 ADR 定稿 owner 粒度、SQLite 事务、连接/worker 生命周期、删除与跨进程锁协调。优先复用既有 feed/catalog SQLite 经验；不新增通用 readiness registry 或全局升级 coordinator。
3. 优先替换 Execution 热路径，再改 ExpertSession prompt queue 和 Mission controller。按事实归属维护表、索引及稳定 cursor，避免在一个事务里耦合所有 Mission。
4. 去掉全量事件和 commit 历史读取；为恢复、事件分页、队列状态和 idempotency 查询建立必要索引。保留有界 live bus，文本 delta 不新增逐条 SQLite 提交。
5. 每个 owner 首次访问前执行必要迁移；业务代码只读当前 Schema。完成一个 family 的迁移与恢复验证后再切换下一 family。

### 迁移要求

遵守 AGENTS.md 和 ADR 019：真实历史代码生成的 fixture、历史 Schema 快照、静态相邻迁移注册、
原子 owner 锁、稳定 journal、升级前备份、崩溃重放、未来版本拒绝及链式升级。
JSON 到 SQLite 属于存储转换，必须明确事务中断后的权威选择，不能只增加 SQLite 文件或升级版本号。
若现有 migration family 不能表达该转换，先在 ADR 中定义可执行转换协议。
禁止启动时扫描全部 owner，单个 owner 迁移失败只影响该 owner；不得自动删除旧数据。

### 验收

- 当前版本 no-op、历史迁移、每个 journal 中断点、未来版本拒绝、升级后启动/执行均有测试。
- 跨进程竞争、takeover fencing、重复提交、断尾恢复、人工确认恢复、删除重放均通过。
- 在多个历史规模下记录锁等待和提交 P50/P95，确认普通增量操作不再全量解析历史。
- 同配置 Pi 冷启动、暖 Mission、暖 Session 三组实测通过；不能仅用 mock 吞吐替代。

## 阶段三：收尾投递、容量检查与链路收敛

目标：用户接入与可恢复执行只等待必要耐久事实，其余工作由明确 owner 的可重放队列完成。

### 终态与 Usage outbox

- 将 Usage observation、Mission terminal event、产品元数据和归档投影的外部投递设计为耐久 outbox。
  outbox 必须与对应权威提交原子关联；不能把 await 改成 void 后依赖进程存活。
- 按稳定 observation/Execution ID 幂等投递，记录消费位置、失败码和可重试状态。
- 当前 canonical handoff 只覆盖 canonical feed，不等于以上所有 outbox 已存在。
- 清楚拆分 Core 终态、Session active 绑定释放、Runtime 可复用、投影完成四个时刻。
  下一轮只等待其必需的屏障；旧投影通过 Execution ID 条件写入，不能覆盖新一轮。
- 明确投递失败、退出与恢复的规则；保留必要 drain 和删除屏障，不能无限积累 Promise。

重点入口：`awaitTerminalLifecycleSettlement()` 目前仍最多等待 5 秒，
`trackMissionExecution()` 的投影、Memory、归档和清理仍参与 settlement。
先追踪真实阻塞来源，再让耐久 outbox 承接非接入必需的工作；不能直接删除等待破坏资源释放。

### 容量账本

- 写入闸门使用事务维护的字节增量/预留和可靠快照，避免普通发送重新扫描完整存储树。
- 清理、删除、迁移、崩溃恢复均调整账本；计数漂移必须能通过显式 reconciliation 修复。
- 冷启动无快照、软/硬上限、并发写入及失败回滚须有可验证策略，不得仅取消容量检查。
- 必要修复定向执行或在窗口创建后后台进行，不回到启动全量 maintenance。

### 可并发与必须串行

| 工作                                                        | 原则                                                |
| ----------------------------------------------------------- | --------------------------------------------------- |
| 同一 Mission 的 prompt 接入、owner claim、steer target 校验 | 保持必要串行/原子性                                 |
| 不同 Mission 的准备与执行                                   | 独立并发，避免全局锁                                |
| 同一不可变 revision 的编译/能力解析                         | 合并相同请求；身份改变时重验                        |
| 不相关只读配置/绑定读取                                     | 确认依赖后并发，不扩大启动扫描                      |
| canonical/Usage/终态投影与归档                              | 必需事实落盘后由有界 outbox worker 消费             |
| Runtime 复用                                                | 仅匹配 immutable binding；不为速度跳过权限/身份变化 |
| UI 队列控制与聊天历史                                       | 控制先发布，历史独立刷新                            |

不要再增加一层通用调度器、通用缓存总线或额外状态镜像。每个屏障应写清保护的事实与 owner；没有必要事实的重复等待应删除。

空闲释放已经补入阶段一，不再作为阶段三未实现任务。阶段三继续测量最近活跃 Mission 的成本，
必要时制定 warm cache 数量上限和 active/idle 轮询策略；不能回退到每轮释放 owner。

## 阶段一收益：能推导什么，不能推导什么

| 环节           | 已改变的成本                              | 可合理预期的收益与限制                                                      |
| -------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| 同进程 Inbox   | 原 500–2000 ms 基础轮询改为立即唤醒       | 避免等待下一次 timer；空闲时通常可省数百毫秒至约 2 秒，但锁与命令应用仍耗时 |
| 跨进程 Inbox   | 最大基础间隔 2000 ms 改为硬上限 500 ms    | 最大基础 timer 等待缩短 1500 ms；不是整个操作的 500 ms 延迟保证             |
| Core 终态到 UI | status 不再等待 Mission event 投影        | 可移除投影阻塞部分；用户观察的约 5 秒不保证全部属于此段                     |
| 排队/steer UI  | 独立 queue patch，loading 不等历史刷新    | 可省历史加载部分；后台真正 steer 发出仍需耐久接入与 SDK 调用                |
| 事件泵         | 多个元数据事件合并一次提交，feed 后台投递 | 减少串行 I/O 和 feed 阻塞；收益取决于事件数、历史规模、磁盘与 feed 压力     |
| 首 token       | 未移除所有存储、准备或 SDK 成本           | 不能给出可信固定秒数/百分比；模型服务耗时基本不受本次改动影响               |

以上成本常在同一路径重叠，不能把每行收益相加。轮询不是固定 sleep，2 秒上限也不是每次必省 2 秒。
50 ms batching deadline 是刷新触发时间，不是磁盘提交的延迟上限。
原先 5 秒的轮询 settlement helper 是超时预算，不代表之前每轮都固定等待 5 秒。
阶段一主要优化控制响应与尾部等待；首次首 token 最大改善幅度需要实测才能判断。

## 性能复测与验收记录

首先在阶段一产物上重测，避免在没有基线时直接实施阶段二。每组至少 20 次，报告 P50/P95 和样本数量：

1. 新建 Mission，发送“只回复 OK”；分别测试应用冷启动与缓存已热。
2. 同一 Mission 连续至少三轮；明确测试下一轮在收尾期间立即发送的情形。
3. 活跃回复中排队，记录队列控件出现；点击 steer，区分 IPC 返回、SDK 接受和实际消费。
4. 长历史与多个并发 Mission；再测人工确认、取消、接管与重启恢复。
5. 原生 Pi 对照：匹配模型、thinking、system prompt、工具、Context/历史及连接状态。短裸 prompt 的 CLI 结果只能作参考，不能直接归因于 Pragma。

建议分段记录：

| 指标          | 起止                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ |
| 创建耗时      | create 请求进入 → Mission 耐久创建                                                   |
| Host 准备     | message_accepted → model_request_dispatched                                          |
| 模型/SDK 等待 | dispatched → first_reasoning_delta / first_text_delta                                |
| UI 首 token   | first_text_delta → first_ui_token_painted                                            |
| UI 收尾       | 最后可见 delta → Core 终态 → terminal_status_published → renderer 终态绘制，分别计时 |
| 队列就绪      | enqueue 耐久接受 → queue.update 发出 → steer 控件可用                                |
| Steer         | 点击 → steer_dispatched → steer_acknowledged → 实际消费/receipt，分别计时            |
| 下一轮阻塞    | 发送 → 生命周期屏障释放 → prompt 接受 → dispatched                                   |

阶段一日志不一定包含 renderer 终态绘制、队列控件出现或 SDK 实际消费的全部时间点，缺失处补日志或性能标记。
SDK acknowledged 只证明接受，不证明已消费。各进程耗时优先用本地 monotonic 时间；跨进程绝对时间需说明时钟和关联误差。
只记录关联 ID、阶段、大小与耗时，不公开本地原始日志、prompt、输出、凭据或私人路径。

建议验收目标（尚非已达到结果）：暖 Session 接入额外开销 P95 < 250 ms，Core 终态到 renderer 终态 P95 < 200 ms；
排队控制投影 P95 < 200 ms。目标需绑定历史规模、硬件和并发量；大规模 I/O 压力另外报告。
SDK 等待与模型 TTFT 单列，不用 Host 目标掩盖它们。

## 接手入口与验证

- Desktop：`apps/desktop/src/main/features/missions/mission-runner-composition.ts`、`mission-creator.ts`。
- Core：`packages/core/src/execution/expert-session.ts`、`expert-runner.ts`、`execution-commit.ts`、`execution-store.ts`。
- Local Host：`packages/local-host/src/run.ts`、`missions/controller/mission-controller-store.ts`、`owner-scope.ts`、`mission-control.ts`。
- UI：`apps/desktop/src/renderer/src/pages/missions/mission-conversation-model.ts`、`use-mission-conversation.ts`。
- 容量：`packages/core/src/storage/storage-maintenance.ts`。

阶段一验证：145 项相关测试通过；全仓 `pnpm check`、Desktop/workspace 依赖构建、main/preload/styles 验证通过。
详细命令见 PR #347。Desktop/Local Host 测试使用 workspace dist，修改 Core 后先重建依赖，避免测试旧产物。
磁盘密集的 Mission 集成测试与 heartbeat 测试建议顺序运行，避免并行 I/O 干扰短 deadline。

关键回归集：execution-event-writer、canonical-event-feed、execution-system、Local Host run/controller/prompt-queue、
Desktop mission-runner 与 mission-conversation-model。后续存储版本变化必须另外补齐迁移 fixture 与恢复集，不能只复用这些功能测试。

相关规则：[会话读模型](../architecture/mission-conversation-read-model.md)、
[ADR 019](../adr/019-versioned-persistent-state-migrations.md)、
[ADR 027](../adr/027-mission-latency-cache-and-runtime-warmup.md)、
[ADR 032](../adr/032-durable-canonical-event-feed.md)、
[ADR 043](../adr/043-mission-controller-lease-and-command-inbox.md)、
[ADR 062](../adr/062-long-running-mission-heartbeats.md)。
