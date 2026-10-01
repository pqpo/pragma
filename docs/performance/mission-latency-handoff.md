# Mission 延迟优化交接

更新时间：2026-10-01，已纳入当天 08:46–08:48 的真实三轮复测。阶段一代码：`ef107172`，评论修复与空闲资源治理：`8bf67bd1`，PR [#347](https://github.com/pqpo/pragma/pull/347)。
本文件整理当前实现与剩余任务，不代表阶段二、三已实现。阶段二调整为接入、读取与持久化热路径，阶段三调整为 Core 终态、下一轮接入和后台投递收敛。
两阶段按实测瓶颈交错推进，不要求先完成全部 SQLite 转换，才能缩短收尾等待。

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
已有真实三轮样本，但受控修改前后对比与 P50/P95 尚未完成。不能把测试通过或缓存命中视为端到端性能达标。

## 2026-10-01 复测：方向调整依据

用户在同一个 Mission 连续发送三次“只回复ok”，使用内置 Pi Runtime；三轮均成功，
后两轮复用同一个 ExpertSession、Context 和 Runtime Session。日志来自包含最新修复的 Desktop 开发进程。
测试期间未发生 idle TTL 释放，因此本次慢不能归因为五分钟空闲后恢复 Runtime。

| 指标                                               |   第一轮 |   第二轮 |   第三轮 |
| -------------------------------------------------- | -------: | -------: | -------: |
| Main message_accepted → model_request_dispatched   | 12.36 秒 |  8.34 秒 | 14.20 秒 |
| model_request_dispatched → model_request_finished  |  1.12 秒 |  0.96 秒 |  0.92 秒 |
| Main message_accepted → first_ui_token_painted     | 17.13 秒 |  9.43 秒 | 15.83 秒 |
| model_request_finished → terminal_status_published |  8.55 秒 |  7.34 秒 | 11.47 秒 |
| terminal_status_published → final_result           |  5.30 秒 |  8.21 秒 |  7.01 秒 |
| Main message_accepted → final_result               | 27.33 秒 | 24.85 秒 | 33.60 秒 |

口径限制：first_ui_token_painted 表示首个 UI 可见文本，包括 reasoning，不保证就是回答正文；
final_result 是 Main observer 收尾完成，不是 renderer 成功状态绘制。model_request_finished 是 Runtime/SDK
观察到模型请求完成，不是供应商内部纯推理时间。上述起点尚未覆盖点击、IPC、Inbox 和 admission 的等待。
首轮 Mission 耐久创建到 message_accepted 之间另有约 9.50 秒未细分；创建与接入必须串起完整时间线。

已确认的局部收益与剩余成本：

- 后两轮编译命中缓存，编译本身低于 0.1 ms；Session open 近零，Runtime acquire 约 0.2 ms。继续优化这些命中后的操作收益很小。
- 后续轮 mission_load_and_executor_ready 仍需 4.12–5.22 秒，compilation_identity 需 0.61–1.80 秒。
  前者包含多次读取、上轮 settlement、executor readiness 和 activity 通知，现有计时不能证明其中任何单项独占耗时。
- Runtime event 单次提交约 0.18–1.47 秒。50 ms batching 只改变提交次数，不能解决每次提交的成本。
- 模型请求约一秒完成，但到终态通知仍隔 7.34–11.47 秒。Core 已提交终态后提前通知 UI 的改动没有覆盖这段阻塞。
- 本次 Mission 日志中记录 38 次 conversation state 读取、19 次 chat page 读取、14 次 Context Window 读取；
  多次读取耗时数秒。计数覆盖该 Mission 本次日志窗口，不能解释为每个 token 都触发读取，也不能全部相加为关键路径。
- 首轮 first_ui_token_received 到 painted 约 3.88 秒，后两轮约 36/43 ms。
  需分辨历史水合、React 工作和窗口可见性；不能仅凭绘制标记断定 renderer CPU 阻塞。

昨天 22:16 的同样三轮参考样本，first_ui_projection 为 13.70 / 8.43 / 11.04 秒，
本次为 13.25 / 9.39 / 15.78 秒；final_result 从 20.75 / 18.26 / 24.34 秒变为
27.33 / 24.85 / 33.60 秒。两次不是受控 A/B，不能断定哪个改动导致退化，但没有证据支持稳定的整体性能提升。

实施优先级据此调整：先定位接入前盲区和读放大，收敛暖 Session 的重复工作；同时定位模型完成到 Core
终态的阻塞。存储引擎、Usage outbox 和容量账本仍是候选实现，分别由测得的提交、投递和扫描成本决定落地顺序。
不得直接把所有剩余耗时归因于 JSON、SQLite 缺失、Usage 或轮询。

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

## 阶段二：缩短接入、读取与持久化热路径

目标：先减少暖 Session 请求模型之前的 8–14 秒本地开销和重复读取，再让增量提交成本不随历史增长。
以减少必经工作和读取次数为先，不以替换存储引擎作为完成标准。

### 交付顺序

1. 补齐点击/IPC → Inbox 落盘 → owner 获取 → admission → message_accepted 的时间线。
   拆开 mission_load_and_executor_ready 中的 Mission 读取、terminal settlement、executor readiness、activity 通知；
   拆开 compilation_identity 中的 Capability、Project Revision、Runtime binding 查询。
   记录每请求的读/写次数、字节数、缓存/并发合并命中、等待原因及历史规模。
2. 同时补存储分段计时：锁等待、journal/replay、读取/解析、状态计算、写入/原子替换、handoff 创建；
   区分 Execution、ExpertSession、Mission controller。阶段三同步测量模型完成后的关键路径，避免遗漏尾部瓶颈。
3. 优先收敛读取与准备：同一读取范围内复用快照，合并相同的进行中请求，合并 renderer 重复刷新；
   历史、Context Window 和完整状态加载不阻塞 live delta 与控制 patch。
   不可变 Revision 的解析/编译可复用；Capability active revision、权限、凭据和 Runtime binding 的变化
   必须有明确失效依据。不得用长期缓存跳过动态安全校验或构造另一份权威状态。
4. 去掉普通请求的全量事件/commit 历史读取，采用增量查询、稳定 cursor 和必要索引。
   先比较最小读取/查询改动的收益；如果文件解析、重放或原子提交仍占主要成本，再按测量排序实施 SQLite。
   Execution event/commit 是当前优先候选，ExpertSession prompt queue 和 Mission controller 的顺序由分段结果决定。
5. 涉及存储转换时先写 ADR，定稿 owner 粒度、SQLite 事务、连接/worker 生命周期、删除与跨进程锁协调。
   复用既有 feed/catalog SQLite 经验；不新增 readiness registry、全局升级 coordinator 或统一缓存总线。
   按事实归属维护表与索引，不在一个事务里耦合所有 Mission，不新增逐文本 delta 提交。
6. 每个 owner 首次访问前执行必要迁移；业务代码只读当前 Schema。
   一个 family 的迁移、恢复、性能和业务回归验证完成后，再切换下一 family。

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
- 对比每轮接入与刷新读/写次数、总字节数、相同请求合并率；warm cache 命中必须体现为关键路径缩短。
- 立即发送下一轮与上轮已完成收尾两种情况分别验收，不能通过人为等待掩盖 admission/settlement 成本。
- 同配置 Pi 冷启动、暖 Mission、暖 Session 三组实测通过；不能仅用 mock 吞吐替代。

## 阶段三：Core 终态、下一轮接入与后台投递收敛

目标：同时缩短模型请求结束到 Core 终态的 7–11 秒，以及终态后 observer 收尾的 5–8 秒。
用户接入与可恢复执行只等待必要耐久事实，其余工作由明确 owner 的可重放队列完成。

### 先确定终态之前与之后的阻塞

- 给 Runtime result、事件泵 drain、eventWriter.flush、Usage preview/record、最终消息与 Invocation 提交、
  Context 持久化、Execution 终态提交、Session active 绑定释放分别计时。
  当前日志只能确认整体本地尾部慢，尚不能分摊 Usage、文件锁和各次提交的责任。
- 记录 terminal_status_published、Mission 投影、Memory/Evidence 投递、历史刷新、归档、observer settlement
  的耗时与依赖。Core 终态之前与之后分别优化，不能只继续提前 UI 通知。
- 下一轮以必要的 ExpertTurn.settled 和 Runtime 复用条件为屏障；
  awaitTerminalLifecycleSettlement 的整个产品投影收尾不应自然成为全部后续请求的前置条件。
  去除该等待前必须证明所保护的事实已由明确的耐久/释放屏障承接。
- 输出、队列和成功状态直接消费相应 live/控制通知，历史刷新可合并、独立完成。
  保留同 revision queue patch 优先规则；当前 queueRevision 是独立合并字段，仍借用 chat revision，
  不代表已经拥有独立 durable queue watermark。需要独立水位时按协议规则设计并同步调用方。

### 终态与 Usage outbox

- 将 Usage observation、Mission terminal event、产品元数据和归档投影的外部投递设计为耐久 outbox。
  outbox 必须与对应权威提交原子关联；不能把 await 改成 void 后依赖进程存活。
- 按稳定 observation/Execution ID 幂等投递，记录消费位置、失败码和可重试状态。
- 当前 canonical handoff 只覆盖 canonical feed，不等于以上所有 outbox 已存在。
- Usage 的可靠 observation 接收与外部账本/产品投影完成须分开：前者保留必要耐久事实，后者可由 outbox 承接。
  成本/预算治理、工具、子任务、人工确认和最终输出的必要工作不能后台化后直接宣告成功。
- 清楚拆分 Core 终态、Session active 绑定释放、Runtime 可复用、投影完成四个时刻。
  下一轮只等待其必需的屏障；旧投影通过 Execution ID 条件写入，不能覆盖新一轮。
- 明确投递失败、退出与恢复的规则；保留必要 drain 和删除屏障，不能无限积累 Promise。

重点入口：`awaitTerminalLifecycleSettlement()` 目前仍最多等待 5 秒，
`trackMissionExecution()` 的投影、Memory、归档和清理仍参与 settlement。
先追踪真实阻塞来源，再让耐久 outbox 承接非接入必需的工作；不能直接删除等待破坏资源释放。
这部分可以在阶段二存储转换完成前独立交付，不新增跨所有子系统的通用任务编排层。

### 容量账本

- 本次首轮 storage_capacity_check 为 1.55 秒，后两轮约 0.01 ms；容量账本应解决首轮/扫描成本，
  不能解释或承诺消除暖 Session 的 8–14 秒接入开销。先区分容量扫描与接入前约 9.50 秒盲区。
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
阶段一主要优化控制响应与尾部等待；本次样本确认缓存复用，但端到端性能未达标，部分参考指标退化。
不能继续用理论节省或正确性测试代替真实改善记录。

## 性能复测与验收记录

已有上述三轮初始样本。下一步补齐分段盲区并建立可重复基线；每组至少 20 次，报告 P50/P95 和样本数量：

1. 新建 Mission，发送“只回复 OK”；分别测试应用冷启动与缓存已热。
2. 同一 Mission 连续至少三轮；明确测试下一轮在收尾期间立即发送的情形。
3. 活跃回复中排队，记录队列控件出现；点击 steer，区分 IPC 返回、SDK 接受和实际消费。
4. 长历史与多个并发 Mission；再测人工确认、取消、接管与重启恢复。
5. 原生 Pi 对照：匹配模型、thinking、system prompt、工具、Context/历史及连接状态。短裸 prompt 的 CLI 结果只能作参考，不能直接归因于 Pragma。
6. 固定相同构建、硬件、数据规模、日志等级和后台负载。后台 Memory/Automation 正常启用与隔离诊断分别测量；
   不能将关闭正常后台能力后的速度作为产品优化结果。主动操作的 owner 并发数和 poll rate 一并记录。

建议分段记录：

| 指标          | 起止                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ |
| 创建耗时      | create 请求进入 → Mission 耐久创建                                                   |
| 接入前等待    | 点击/IPC → Inbox 耐久接受 → owner/admission → message_accepted，分别计时             |
| Host 准备     | message_accepted → model_request_dispatched                                          |
| 模型/SDK 等待 | dispatched → first_reasoning_delta / first_text_delta                                |
| UI 首 token   | first_text_delta → first_ui_token_painted                                            |
| UI 收尾       | 最后可见 delta → Core 终态 → terminal_status_published → renderer 终态绘制，分别计时 |
| Core 尾部     | model_request_finished → result/drain/Usage/最终提交 → Core 终态，分别计时           |
| observer 收尾 | terminal_status_published → projection/cleanup → final_result，与 UI 结束分开        |
| 队列就绪      | enqueue 耐久接受 → queue.update 发出 → steer 控件可用                                |
| Steer         | 点击 → steer_dispatched → steer_acknowledged → 实际消费/receipt，分别计时            |
| 下一轮阻塞    | 发送 → 生命周期屏障释放 → prompt 接受 → dispatched                                   |

阶段一日志不一定包含 renderer 终态绘制、队列控件出现或 SDK 实际消费的全部时间点，缺失处补日志或性能标记。
SDK acknowledged 只证明接受，不证明已消费。各进程耗时优先用本地 monotonic 时间；跨进程绝对时间需说明时钟和关联误差。
只记录关联 ID、阶段、大小与耗时，不公开本地原始日志、prompt、输出、凭据或私人路径。

建议验收目标（尚非已达到结果）：暖 Session 接入额外开销 P95 < 250 ms，Core 终态到 renderer 终态 P95 < 200 ms；
排队控制投影 P95 < 200 ms。目标需绑定历史规模、硬件和并发量；大规模 I/O 压力另外报告。
SDK 等待与模型 TTFT 单列，不用 Host 目标掩盖它们。
另建议针对无工具、无子任务、无人工等待的短回答，模型完成到 Core 终态的本地开销 P95 < 500 ms；
这同样是待验证目标。涉及必要的子任务/治理等待时单列实际工作，禁止用提前成功满足指标。
每个交付必须同时报告接入、首 token、Core 尾部、下一轮接入和后台 I/O；不能一段变快、另一段退化后只公布局部数字。

## 接手入口与验证

- Desktop：`apps/desktop/src/main/features/missions/mission-runner-composition.ts`、`mission-creator.ts`。
- Core：`packages/core/src/execution/expert-session.ts`、`expert-runner.ts`、`execution-commit.ts`、`execution-store.ts`。
- Local Host：`packages/local-host/src/run.ts`、`missions/controller/mission-controller-store.ts`、`owner-scope.ts`、`mission-control.ts`。
- UI：`apps/desktop/src/renderer/src/pages/missions/mission-conversation-model.ts`、`use-mission-conversation.ts`。
- 容量：`packages/core/src/storage/storage-maintenance.ts`。

阶段一最初验证：145 项相关测试通过。评论修复另验证 Core worker/feed/writer、Local Host owner/controller、
Desktop 释放期间接入、人工确认及压缩/Context 恢复；全仓 `pnpm check`、Desktop/workspace 依赖构建、main/preload/styles 验证通过。
详细命令见 PR #347。Desktop/Local Host 测试使用 workspace dist，修改 Core 后先重建依赖，避免测试旧产物。
磁盘密集的 Mission 集成测试与 heartbeat 测试建议顺序运行，避免并行 I/O 干扰短 deadline。

关键回归集：execution-event-writer、canonical-event-feed、execution-system、Local Host run/controller/prompt-queue、
Desktop mission-runner 与 mission-conversation-model。后续存储版本变化必须另外补齐迁移 fixture 与恢复集，不能只复用这些功能测试。

相关规则：[会话读模型](../architecture/mission-conversation-read-model.md)、
[ADR 019](../adr/019-versioned-persistent-state-migrations.md)、
[ADR 027](../adr/027-mission-latency-cache-and-runtime-warmup.md)、
[ADR 032](../adr/032-durable-canonical-event-feed.md)、
[ADR 043](../adr/043-mission-controller-lease-and-command-inbox.md)、
[ADR 062](../adr/062-long-running-mission-heartbeats.md)、
[ADR 063](../adr/063-idle-mission-resource-release.md)。
