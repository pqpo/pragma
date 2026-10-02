# Mission 延迟优化交接

更新时间：2026-10-01，已纳入当天 08:46–08:48、阶段二后 12:12–12:13，以及阶段三后 17:45–17:47 的真实复测。阶段一代码：`ef107172`，评论修复与空闲资源治理：`8bf67bd1`，PR [#347](https://github.com/pqpo/pragma/pull/347)。
本文件整理当前实现与剩余任务。阶段二读取与提交热路径收敛已落地，端到端性能目标未达成；阶段三实现见 [阶段三实施报告](mission-latency-phase-three.md)，17:45–17:47 复测确认端到端目标仍未达成。阶段四实现已进入集成验证，详见 [阶段四实施报告](mission-latency-phase-four.md)；真实模型端到端验收仍待完成，不能宣布阶段四达标。
2026-10-02 补充性能回退复核：修正后台投递确认的重复文件锁、标记同步、队列扫描和并发关闭；同条件 JSON/SQLite 存储对照及跨进程测试结果见阶段四报告。真实模型 pilot 仍待 macOS 钥匙串确认，尚无有效端到端样本。
2026-10-02 收尾：已统一 Host 两 worker、隔离 owner 准备、增加可恢复分块转换、移出 Main Usage/receipt SQL、取消健康时 500 ms 消费轮询，并移除 Core File 默认业务 authority。指定范围独立 CR 已完成，Usage 延迟初始化 cutoff 竞态已修正。迁移隔离实测、尚缺的端到端场景及 Team 投影限制见阶段四报告；模型验收尚无有效数据，第四阶段仍未验收完成。
最新并发复测暴露四 owner 投递下前台集中到一个 worker 的回退。已允许普通 ID-only ack 与前台共享第二 lane，大输出 outbox、迁移、Usage/receipt 批次及超大输入仍隔离；回归、同条件复测与剩余验收状态见阶段四报告。
收尾最终复测：canonical 唤醒在现有机制中合并 250 ms，四 owner 提交 P95 从此次 255.19 ms 降至 176.37 ms（80 样本），仍高于此前 152.50 ms 基线，未宣称完全无回退。最新 pnpm check、Desktop build 与打包 worker 启动通过，Memory 三套 19 项通过，最终独立 CR 无新阻断。受监督真实模型 pilot 仍在 native Keychain 阶段超时并退出，无有效端到端样本；不能标记阶段四完成。
PR #352 后续评论发现三个 Runtime 用量结算问题，已修正：先收集供应商精确用量再 fallback；明确未 dispatch 的 attempt 不估算，但保留此前实际 attempt 的用量；无 delta 时按最终正文估算输出。每次 attempt 独立结算并累计一次，流式期间仍不统计。验证与端到端验收限制见阶段四报告。
两阶段按实测瓶颈交错推进，不要求先完成全部 SQLite 转换，才能缩短收尾等待。
第三阶段后的真实页面加载发生严重退化；增量容量计量的全局接入已从 Desktop 与 Local Host 撤下，
并移除新增启动校准。随后彻底回滚全仓 import 替换，删除计量 adapter、账本及相关钩子/测试/基准脚本。
同步容量门禁也已移除：Mission/Local Host/Project/插件不再等待扫描或因配额超限被拒绝。
Desktop 采用六小时限频、独立 worker 的闲时统计，超限建议手动清理；详见阶段三实施报告的回归记录。

阶段二后复测：暖轮点击发送到首 token 仍为 **7.18/9.78 秒**，总体性能目标未达成。
当前消息在准备期误移入排队区已修复；这是展示状态修复，不是实际延迟消除。
第三阶段曾扩展到 Inbox/controller 接入、executor readiness 和暖路径容量扫描；容量门禁与账本方向已撤销，保留 Usage/收尾屏障优化。
数据、关联 ID、计时口径和优先级详见 [真实复测报告](mission-latency-phase-two-live-retest.md)。

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

阶段一当时未实现：每 owner SQLite 引擎、对应旧状态迁移、索引分页、Usage/terminal projection outbox、容量账本。
当前阶段三已实现耐久 Usage 源事实及 Host 投递；容量账本不再是待办。
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
终态的阻塞。上述是当时的判断；阶段三后的优先级以阶段四为准。容量扫描应退出主流程，不再以建设容量账本作为首 token 优化任务。
不得直接把所有剩余耗时归因于 JSON、SQLite 缺失、Usage 或轮询。

## 接手必须保留的行为

1. Mission owner 与 ExpertSession owner 是不同边界；Desktop 保留前者，不得靠关闭 guard 检查解决后续轮次报错。
2. Lease 过期允许接管，不等于自动取消任务。旧 owner 被释放、撤销或接管后必须拒绝写入与后续 Host 工具入口。
3. CLI 仍在底层资源释放后释放 Mission owner。长任务心跳、sleep 后续租、锁竞争重试继续遵守 ADR 062。
4. 原生流结束不等于 Core 终态；子任务、工具和人工确认仍由执行层裁决。Usage 统计不是完成条件，
   其处理失败不得改变回答成功状态，也不得阻塞 Session 释放或下一轮发送。
5. 人工确认 checkpoint 可关闭内存流并保留 waiting Execution；恢复不得被误判为失败或重复执行副作用。
6. prompt/steer 必须经过耐久 Inbox、Session 接入与 fencing；减少 I/O 不能绕过权限和 idempotency。
7. canonical 删除屏障、删除 journal 和 ownership catalog 事务必须与新的投递/存储机制一起验证。
8. 队列、完整控制状态、历史和 Context 的版本边界独立；读取不得顺带修复或回写业务投影。

Lease 历史：PR #209 的共享 Local Host run 提取引入了单轮释放语义，PR #344 增强所有权检查后暴露 Desktop 保留旧 guard 的问题。
本次修复生命周期归属，不撤销 #344 为长任务和接管增加的保护。

## 阶段二：缩短接入、读取与持久化热路径

阶段二实施及可重复基准见[阶段二实施报告](mission-latency-phase-two.md)。本次不更换存储引擎、不升级持久
Schema；当时将 Usage/终态 outbox、容量账本和收尾屏障调整划入阶段三。容量账本方案现已撤销。

### 已落地

1. Renderer 发送、Main IPC、耐久 Inbox、owner ready、命令消费、admission 和准备分段日志通过既有
   request/command/Execution ID 关联。Mission 读取、settlement、readiness、activity 与编译身份分开计时。
2. `PRAGMA_STORAGE_DIAGNOSTICS=1` 启用 Execution、ExpertSession、Mission controller 和请求汇总的详细
   存储诊断，记录锁等待、prepare/replay、读取/JSON 解析、写入/替换与 payload 字节；正常运行保留轻量阶段日志。
   模型结果、drain/flush、Usage、最终消息、终态、Session active 释放与 observer settlement 补充尾部测量。
3. 请求局部复用不可变 Project Revision，Capability/系统专家依赖遍历与编译共享该读取；active revision、
   credentials、权限、当前系统 fingerprint 与 Runtime binding 每次接入重验。编译 miss 继续做前后稳定性检查。
   apply 接入中无实际 settlement 等待时复用首次 Mission 读取，实际等待后重新读取；原有 capacity await 已移除。
4. Session 控制读取和队列投影使用一次锁/prepare 的 `readSnapshot`。Main 合并相同进行中展示读取，
   Renderer 独立刷新历史/control/Context，保留 dirty 重读、乱序规则、终态复查和已响应人工确认过滤。
5. Execution 正常 commit 复用锁内已读取的 events/commits；崩溃重放保持重新读盘。仍然全量读取、解析和
   重写历史，未声称普通增量提交已与历史规模无关。

### 尚未达成与下一步

暖 Session 接入额外开销 P95 < 250 ms 尚未通过真实 Pi/Desktop 受控 A/B 验收。存储局部基准不能替代
冷启动、暖 Mission、暖 Session、收尾期间立即发送和 SDK 首 token 的每组至少 20 次实测。
阶段二当时保留 settlement/activity/Usage 等等待；阶段四必须重新审查其必要性，不能以既有 await
作为保留依据。验收报告仍包含真实等待，不通过扣除等待宣布达标。

优化后的真实关键路径满足下列任一条件，再进入存储专项定稿：读取、解析、重放或原子写入贡献至少 30%
且 P95 超过 100 ms；或十倍历史规模使普通增量提交 P95 增长超过两倍。按 family 贡献排序，接近时优先 Execution。
下一份方案必须同时定稿 owner、事务、索引/cursor、连接生命周期、删除协调、真实 fixture、备份、转换 journal、
权威切换和恢复。不能仅凭本地小历史基准未触发门槛排除生产规模瓶颈。

### 迁移要求

遵守 AGENTS.md 和 ADR 019：真实历史代码生成的 fixture、历史 Schema 快照、静态相邻迁移注册、
原子 owner 锁、稳定 journal、升级前备份、崩溃重放、未来版本拒绝及链式升级。
JSON 到 SQLite 属于存储转换，必须明确事务中断后的权威选择，不能只增加 SQLite 文件或升级版本号。
若现有 migration family 不能表达该转换，先在 ADR 中定义可执行转换协议。
禁止启动时扫描全部 owner，单个 owner 迁移失败只影响该 owner；不得自动删除旧数据。

### 验收

- 当前版本 no-op、历史迁移、每个 journal 中断点、未来版本拒绝、升级后启动/执行均有测试。
- 跨进程竞争、takeover fencing、重复提交、断尾恢复、人工确认恢复、删除重放均通过。
- 在多个历史规模下记录锁等待和提交 P50/P95；本次仍全量解析与重写历史，后续增量存储专项再验收规模独立性。
- 对比每轮接入与刷新读/写次数、总字节数、相同请求合并率；warm cache 命中必须体现为关键路径缩短。
- 立即发送下一轮与上轮已完成收尾两种情况分别验收，不能通过人为等待掩盖 admission/settlement 成本。
- 同配置 Pi 冷启动、暖 Mission、暖 Session 三组实测通过；不能仅用 mock 吞吐替代。

## 阶段三：耐久接入、容量、Core 终态与后台投递收敛

实现、局部容量基准与验证边界见 [第三阶段实施报告](mission-latency-phase-three.md)。下文保留原始验收约束；
耐久源事件与 Host 投递已经实现；容量账本已撤回，17:45–17:47 的真实 Pi/Desktop 复测仍未达标。

目标：缩短接入到 dispatch、模型请求结束到 Core 终态，以及 terminal 后 observer 收尾。
阶段二后后三轮的模型结束→terminal commit 仍为 5.16–8.37 秒，terminal commit→observer 为 4.75–6.53 秒。
用户接入与可恢复执行只等待必要耐久事实，其余工作由明确 owner 的可重放队列完成。

12:12–12:13 的实测要求先补齐接入瓶颈：Inbox durable 等待 1.23–1.36 秒，
executor readiness 1.17–1.73 秒，暖轮容量扫描 3.01 秒；admission 锁等待接近零。
先细分 controller 恢复/提交/handoff 与 Bundle/Project/Runtime readiness，结合真实历史诊断再优化。
从 Renderer 点击到模型 dispatch 全程验收，不能用 accepted 起点隐藏这些等待。

### 先确定终态之前与之后的阻塞

- 给 Runtime result、事件泵 drain、eventWriter.flush、Usage preview/record、最终消息与 Invocation 提交、
  Context 持久化、Execution 终态提交、Session active 绑定释放分别计时。
  12:12 复测已有 Usage 两段合计 1.44/2.56/4.34 秒、event pump drain 1.69/0.96/1.29 秒；
  flush 嵌套于 pump，不能重复相加。详细存储诊断未启用，仍需分摊文件锁、账本和各次提交。
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

重点入口：发送的 `awaitTerminalLifecycleSettlement()` 已使用 admissionReady，其他需要完整收尾的路径保留 settlement。
`trackMissionExecution()` 在启用耐久投递后不等待成功/失败的产品投影；取消仍保留输出快照屏障。
先追踪真实阻塞来源，再让耐久 outbox 承接非接入必需的工作；不能直接删除等待破坏资源释放。
这部分可以在阶段二存储转换完成前独立交付，不新增跨所有子系统的通用任务编排层。

### 容量治理：旧方案撤销，退出交互主流程

原同步扫描把低概率的应用配额超限当作所有读取/发送必须等待的前置条件，这是优先级与架构错误。
将扫描包装为异步 Promise，或用全仓文件系统 adapter 维护精确账本，仍未回答“为什么普通用户必须等待容量治理”。
不能继续修补这一门禁，必须删除它与调用方；本次已完成撤销。

- 页面加载、Mission 创建/发送、Project 和插件正常写入均不等待容量统计，不设置应用配额硬拒绝。
- 统计只作闲时建议：Desktop 启动至少五分钟、系统空闲至少五分钟且无暖 Session，独立 worker 执行；
  自动尝试间隔至少六小时，失败/取消同样限频；用户恢复活动时取消，单次预算十分钟。
- 超限建议用户手动清理；设置中的显式查看/清理保留。首次启动也不扫描全树阻塞窗口。
- 实际磁盘写入失败仍由具体写入事务报告并保留恢复能力，不能与应用自定容量配额混为一谈。
- 不再建设全局容量账本、预留机制或替换全仓 `node:fs/promises` import。

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

## 阶段四：先重审必要性，再重构交互关键路径（方案，未实施）

### 实测依据与归因边界

2026-10-01 17:45–17:47，同一 Mission 五轮短回答，一轮新建、四轮暖 Session。
下面使用 Renderer 点击、Main 接收、Runtime dispatch/finished、Core terminal 和 Session release 的关联记录；
不公开原始 prompt、输出、凭据及私人路径。

| 指标                                         |    新建轮 |   暖轮一 |   暖轮二 |    暖轮三 |    暖轮四 |
| -------------------------------------------- | --------: | -------: | -------: | --------: | --------: |
| 点击 → Main message_accepted                 |  7.826 秒 | 0.920 秒 | 0.947 秒 |  3.153 秒 |  4.136 秒 |
| message_accepted → model_request_dispatched  |  7.686 秒 | 3.867 秒 | 4.802 秒 |  5.575 秒 |  5.276 秒 |
| 点击 → first_ui_token_painted                | 16.831 秒 | 5.956 秒 | 6.586 秒 | 10.191 秒 | 10.332 秒 |
| dispatched → model_request_finished          |  1.365 秒 | 1.146 秒 | 0.784 秒 |  0.732 秒 |  0.702 秒 |
| model_request_finished → Core terminal       |  5.075 秒 | 8.578 秒 | 7.053 秒 |  6.762 秒 |  7.997 秒 |
| Core terminal → Session active 绑定释放      |  0.415 秒 | 0.167 秒 | 0.153 秒 |  0.146 秒 |  0.207 秒 |
| terminal_status_published → observer settled |  1.085 秒 | 1.890 秒 | 1.763 秒 |  2.305 秒 |  3.200 秒 |

结论：需要阶段四，不需要让用户继续重复手工测试才能确认方向。模型请求已在约一秒内结束，
Core 终态之前仍有 6.76–8.58 秒暖轮本地尾部等待；继续只后台化 terminal 之后的产品投影收益有限。
输出结束时 Execution 仍活跃，下一条 prompt 按现有治理进入队列；应缩短真实终态等待，不能提前伪造成功。
本批下一轮发送未落在上轮模型结束到 Core 终态的窗口内，因此未直接复现用户所述尾部排队，需专门验证。

其他证据与限制：

- 暖轮 Runtime 可用性检查每次约 1.11–1.69 秒；编译缓存命中约 0–0.08 ms，Session open 近零，
  Runtime acquire 约 0.26–0.38 ms。重复探测比继续优化缓存命中的编译更值得处理。
- 暖轮最后一批 Runtime event 提交约 0.91–1.34 秒；Usage record/commit 约 1.12–1.36 秒；
  final message commit 约 0.50–0.68 秒。event pump drain 包含相应 flush，不能重复相加。
  这些分段尚未解释全部尾部，Invocation/Context 等间隙、锁等待与竞争仍需细分。
- 本 boot 未见容量检查触发日志；不能继续把当前慢归因于已退出主流程的容量门禁。
- 记录 24 次 250 ms 权威读取超时（Execution 13 次、Mission events 11 次），另有 5 次历史终态投影缺失警告。
  超时说明读路径退化，不能据此判定全部由存储引擎、锁或主线程中的某一项导致。
- `mission.chat_page_received.elapsedMs` 当前是导航开始到收页的累计时间，刷新日志不是每次查询耗时。
  无 request ID 的后台 admission 等待不能归到某次前台发送；Core 终态也不能当成 renderer 终态绘制。
- 五轮不足以报告可信 P95；与阶段二不是受控 A/B。部分暖轮首 token 缩短，但整体仍慢且不稳定。

### 重要性判断：每个 await 必须说明保护什么

优化顺序是：删除无必要的前置工作 → 缩小必要工作的范围 → 合并重复事务/请求 → 替换不适合的存储结构。
不得从“已有函数很慢”直接跳到“把它异步化或增加缓存”。先判断该功能是否应该进入该用户操作。

| 工作                                                                | 对当前操作的重要性         | 阶段四决策                                            |
| ------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------- |
| 当前目标权限、active revision、凭据、Runtime binding、owner fencing | 正确执行必需               | 保留，限定当前目标及依赖闭包，避免无关资源全量检查    |
| prompt 耐久接受、幂等、执行源事实、恢复边界                         | 防重复执行/丢失必需        | 保留事实，重构低效事务；不能用内存成功替代落盘        |
| 工具/子任务/人工确认/取消裁决、Runtime 安全复用                     | 正确结束必需               | 等待实际工作；与存储等待分别计时                      |
| 最终输出、恢复所需 Runtime 引用、Invocation/Execution 终态          | 终态必需                   | 收敛事务与重复读取，避免每个事实重写完整历史          |
| 全局容量扫描、应用配额精确账本                                      | 当前发送/页面展示不需要    | 从主流程删除；闲时低频提示，手动清理                  |
| 无关 Runtime/Bundle/Project 全量探测                                | 当前目标通常不需要         | 定向检查；配置版本驱动失效，不每轮枚举和重探测        |
| Usage 预览、聚合、账本、成本和报表                                  | 不是执行完成条件           | 不新增独立前置提交；后台处理，失败只影响统计模块      |
| Memory 提炼、归档、产品投影                                         | 最小源事实后可恢复执行     | 有界耐久后台消费；故障报告 degraded，不占用下一轮屏障 |
| 聊天全历史、Context 明细、统计面板水合                              | 首屏/首 token 只需局部数据 | 索引分页与按需加载；控制状态先展示，详情独立刷新      |
| 已接近零耗时的暖编译、Session open、Runtime acquire                 | 功能重要，当前优化收益很小 | 保留现有复用，本阶段不继续投入                        |

“重要”不等于必须执行一次昂贵的全局操作。例如恢复能力需要可靠事务，不需要每次提交扫描整个历史；
权限需要当前权威校验，不需要枚举全部安装 Runtime；页面需要当前状态，不需要先完成所有历史投影。
对每个候选工作写清：不做会破坏哪个当前承诺、谁拥有事实、数据是否已变、是否可按需/后台处理、成本是否随总历史增长。
不能说明当前操作为何需要的前置等待应移除，而不是为它继续建设通用基础设施。

### 2026-10-01 代码审查补充：实际阻塞与可失败工作

本节为阶段四方案审查，不表示已经实施。代码依据为 PR #350 所在分支的实现；耗时来自上文
17:45–17:47 的五轮样本，早于随后 CR 和 steer 丢失修复，不能视为最新构建的耗时或 P95。
区间存在包含关系，不能相加；未测量的路径只确认结构问题，不推算节省时间。

| 环节                      | 已观察耗时   | 是否必须阻塞及优化方向                                      |
| ------------------------- | ------------ | ----------------------------------------------------------- |
| 暖轮点击 → Main 接收      | 0.92–4.14 秒 | 耐久 Inbox、幂等和 ownership 保留；拆分落盘、消费和准备等待 |
| Main 接收 → 模型发出      | 3.87–5.58 秒 | 当前目标权限、绑定和输入准备保留；无关探测和重复读取退出    |
| Runtime 可用性检查        | 1.11–1.69 秒 | 当前绑定定向检查；不依赖全量 Runtime 健康展示               |
| 模型请求                  | 0.70–1.15 秒 | 必须等待；单列供应商/SDK 耗时                               |
| 最后一批 Runtime 事件提交 | 0.91–1.34 秒 | 必要恢复事实保留；展示与诊断不统一充当完成屏障              |
| Usage record/commit       | 1.12–1.36 秒 | 不作为回答完成条件，不新增独立前置提交                      |
| 最终消息提交              | 0.50–0.68 秒 | 可靠保存必需，合并必要状态变更                              |
| 模型完成 → Core 终态      | 6.76–8.58 秒 | 首要优化区间；现有分段尚未解释全部等待                      |
| Core 终态 → Session 释放  | 0.15–0.21 秒 | 安全复用所需，不是数秒延迟主因                              |
| 终态通知 → observer 收尾  | 1.76–3.20 秒 | 产品投影后台执行，不加入下一轮屏障                          |

#### 1. 已确认：Usage 仍在 Core 收尾等待链上

`packages/core/src/execution/expert-runner.ts` 的 `submitRuntimeTurn` 先等待事件 drain 和
`usagePreview`，再等待 `settleRuntimeTurnUsage`，之后才返回结果。settlement 单独读取
Invocation、提交用量及 `runtime.usage.observed`，并等待 Host sink 与预览清除。
Host sink 错误虽被捕获，等待仍存在；前面的 Usage 存储提交失败会传播到执行失败路径。
Desktop 已后台化外部统计投递，并未消除 Core 的独立 Usage 提交。

阶段四调整：

- 预览合并为最新值，不在结束时等待整条预览 Promise 队列。
- 原始 Runtime 用量能附带到已有必要消息、checkpoint 或终态提交中时顺带保存，
  不为统计增加独立前置事务。按 run/observation ID 后台聚合及去重，不重复累计。
- 聚合、账本、成本计算、报表和预览清除不参与回答成功裁决，不阻塞下一轮。
  失败仅使统计模块 degraded、数据暂缺或等待重试，不能使 Mission 执行失败。
- 当前阶段三的耐久 observation 是既有承诺，调整事件来源或持久化边界时须同步更新消费者、
  恢复与删除测试；不能简单丢弃源事实或无约束地启动 Promise。后台入账应能从已保存的原始事实恢复。
- 下一轮输入的 Context 容量判断与历史成本统计分开。前者可能影响模型调用；
  后者不能成为发送门禁。不要为了展示 token 数等待整份账本。

#### 2. 已确认：发送入口与全量 Runtime 健康展示耦合

`apps/desktop/src/main/bootstrap/application-container.ts` 的 `assertBundleExecutorReady`
调用完整 `getRuntimeAvailability`。`runtime-availability.ts` 即使探测缓存命中，也调用
`runtimes.list()`；`runtime-environment-service.ts` 的 `list()` 枚举所有 head 并尝试物化
所有有效 Runtime。探测缓存失效时还调用 `canUse` 与 `listModels`。

发送 Pi 消息不应等待未使用的 Runtime。拆开当前目标/依赖闭包的执行校验与工作室健康列表；
暖 Session 重验必要权限、当前绑定和配置变化，全量健康及模型发现按需刷新。
已有 1.11–1.69 秒只证明整个检查阶段耗时，不能全部归因于原生探测。

#### 3. 已确认：单个 Execution 访问会枚举全局 handoff 目录

`packages/core/src/execution/execution-store.ts` 的 `prepareExecutionUnmeasured` 在配置
canonical feed 时检查隔离记录并恢复 handoff；`listCanonicalHandoffFilesForExecution`
先枚举全局 handoff 目录，再按 Execution 前缀过滤，隔离目录也有同类路径。
正常读取和提交因此受其他 owner 积压影响；具体耗时尚未测量。

这是与容量扫描同类的职责错误，优先改为 owner 定向定位。全局发现归后台消费/恢复，
正常访问仅检查当前 owner 的恢复状态。保留崩溃恢复与隔离拒绝，不能用跳过 journal、
永久缓存或忽略损坏文件替代正确定位。存储布局变化同步定义转换与旧数据恢复方式。

#### 4. 已确认：必要事实被拆成多次全量事务

`execution-store.ts` 的 `commit` 读取全部 commit records、Invocation、Agent、Context 和
events；`applyTransaction` 重写完整状态文件与事件历史。handoff 还携带完整事务状态。
Usage、Context snapshot、最终消息、Invocation 成功、Execution 终态分别触发提交，放大成本。

必须保留可靠输出、恢复引用和状态裁决，不必保留每项事实独立提交的顺序。
先合并合法的必要提交，缩小恢复与状态校验读取，再实现只写新增事件及受影响记录的存储。
不能只更换数据库后继续序列化/重写整个 aggregate。Context 引用关系和跨 owner 恢复需要明确
事务协议，不因减少重复 snapshot 写入而牺牲重启后的 Runtime 恢复。

#### 5. 已确认：流式显示仍可能被耐久事件消费连带阻塞

`expert-runner.ts` 在同一个 Runtime 事件消费循环中发布 live output 并追加耐久事件。
`execution-commit.ts` 在工具/人工事件边界或缓冲达到 64 条时返回需等待的 flush，
消费循环暂停会拖住后续文本。文本 delta 不落盘不等于文本消费永远独立于磁盘。

分开实时显示、必要执行事实和诊断记录。工具副作用、人工确认及恢复边界逐项说明屏障目的；
普通进度、诊断元数据不因属于 Runtime 事件就一律要求即时耐久。队列有界，保留排序、取消
和安全边界测试；不能把磁盘压力变成无限制内存积压。最终输出仍须可靠保存。

#### 6. 重构候选：可失败的 Memory 通知仍被发送等待

`mission-runner-composition.ts` 的 `notifyMissionActivity` 捕获错误后继续执行，但仍 await
通知；Desktop 实现等待 `setMemoryConversationState` 并唤醒 pipeline。
需要拆出立即生效的最小活跃状态与持久化/后台唤醒。若通知保护旧 generation 或阻止旧 Memory
写入，保留最小 cancellation/fencing 屏障，不等待整个 Memory 收尾，也不直接丢弃保护。
此项尚需核对依赖与耗时，不能把捕获错误视为可以直接 fire-and-forget 的充分证据。

### 优先级与实施顺序

**P0：先排除错误的主流程依赖。** 审计启动、Mission/Studio 页面读取、发送接入和收尾的 await 链。
查找全树扫描、全资源健康检查、查询顺带维护/回写、每轮重复探测、为报表/归档/提炼等待完整投影、
全局锁与无关 owner 串行化。逐项分类为删除、定向、闲时或必须保留，并记录调用点和依据。
容量门禁已撤销，不再重建。异步文件 I/O 仍可能竞争 libuv 线程池、磁盘或产生大量 JSON/Schema CPU 工作；
独立 worker 也不能消除磁盘争用。后台工作必须限频、有界、可暂停，不在每次页面访问时重启。
首批明确处理 Usage 完成依赖、全量 Runtime readiness 和全局 handoff 发现；Memory 通知先核对
最小安全屏障。禁止把本节再次变成泛泛的诊断任务，具体候选和源码依据见上节。

**P1：Core 终态事务与 Execution 存储，最高收益的重构重点。**

1. 用已有 `PRAGMA_STORAGE_DIAGNOSTICS=1` 在代表性数据上分解锁等待、prepare/replay、读取/解析、
   state compute、journal/handoff、写入/替换；补齐 Invocation 成功、Context 持久化与终态之间的未计时区间。
   诊断服务于重构，不以缺少二十轮用户手工记录为理由无限延后。
2. 绘制成功/失败/取消/checkpoint/子任务的提交依赖。当前 final message、Invocation 成功、Execution 终态
   分属多次提交；重审这一边界，允许在根 turn 已满足完成条件时合并必要源事实与状态变更。
   原始 Usage 可附带到已有必要事实中，取消为统计新增的独立前置提交；聚合与外部账本后台执行，
   统计失败不改变成功状态。通用 Invocation 不能提前宣告整个 Execution 完成。
3. 根本替换“每次小提交读取全部 commits/events/Invocation/Agent/Context，再写完整状态及 journal/handoff”的成本模型。
   现有 `execution-store.ts` 的锁内复用只少读一次，没有解决提交成本随累计历史增长。
   50 ms batching、更多缓存或更大的超时都不能作为最终修复；目标是按新增事件及受影响记录执行增量事务。
4. 首选评估 Execution 的 SQLite 事务实现：追加事件、cursor 索引、commitId/signature 唯一约束、
   aggregate version CAS、受影响状态行与耐久 outbox 同事务；不同时迁移所有 JSON 存储。
   数据库产品本身不是收益保证，验证事务次数、读写字节、锁持有时间及历史增长曲线。
5. Core 保持执行/存储合约与状态裁决；具体 SQLite 实现与连接生命周期由允许的 Node Host 层承接并注入。
   仓库现有 Core 规则禁止数据库实现，定稿时必须明确接口、实现和装配边界，不把 SQLite 依赖直接塞入 Core，
   不为单一实现预建新 package。如需调整现有边界，先以 ADR 明确理由及规则变更。
6. Execution 终态与 ExpertSession active 释放属于不同 owner，不能假定一个 SQL transaction 天然覆盖两者。
   设计稳定关联与崩溃重放：终态后重启可完成释放，Session 未释放前拒绝并发复用；旧回调不能清掉新绑定。
   Session/controller 是否迁移，按剩余贡献另行决定，当前 release 约 0.15–0.21 秒不是数秒尾部的主因。

**P1：发送入口去除重复准备，与终态专项分开验收。**

- `assertBundleExecutorReady` 当前读取 Project 并获取 Runtime availability；确认具体探测范围，
  将当前执行目标及依赖闭包与工作室全量健康展示分开。不得让未使用 Runtime 的慢探测阻塞发送。
- 为昂贵可用性探测使用配置/revision/environment 身份、单个进行中请求和有界有效期；配置变化、失效及执行错误使结果失效。
  复用健康的现有 Runtime 时重验必要身份/权限，不每轮重新发现所有 Runtime。
  外部安装或认证变化无法完全由配置事件覆盖，因此保留明确刷新和目标运行失败后的重新诊断，不用永久缓存掩盖变化。
- 分解点击 → IPC → Inbox durable → owner/command → accepted。暖轮 Inbox durable 约 0.39–1.76 秒，
  定位 controller 恢复、重复 snapshot、提交/handoff；只合并确实重复的工作，耐久接受与 fencing 不删除。
- 不要再次优化已有暖编译的微秒成本来解释几秒准备时间，也不把无关联后台锁等待算作发送等待。

**P2：页面读取与后台竞争，作为交付门禁。**

- 独立测 Mission 首屏、Studio 首屏、控制状态、聊天分页和 Context 明细；不等待全历史/全资源投影才展示可用部分。
- 查询只读当前 owner 的必要数据；禁止读取触发全局维护、容量统计、索引全量重建或投影回写。
  明确索引初始化/恢复 owner，避免换成 SQLite 后每次查询仍扫描或全表聚合。
- 相同进行中请求合并，按 Execution/revision/cursor 失效；活跃控制优先、历史按 dirty 合并，空闲停止高频读取。
  250 ms 超时不是取消底层读取；检查是否超时后继续运行并叠加重试，改为单个进行中读取和有界重试。
  不能只把超时调大或压低警告等级掩盖阻塞。
- 收尾后台任务不得形成无界队列或持续抢占前台磁盘。真实对照保持 Memory/Automation 正常启用，
  若发现页面仍被明显拖慢，立即提升其优先级并停止交付，不能以“发送变快”接受页面退化。

### 可推翻的架构与不可丢失的事实

允许删除容量门禁、全局发现式 readiness、查询维护耦合、全历史重写、重复的终态事务和不必要的跨 owner 等待。
重构后删除废弃调用方、适配层和重复测试，不长期保留两套业务 authority 或通用缓存/调度中间层。
必须保留权限、owner/fencing、幂等、durable Inbox、必要源事实、人工确认、取消、恢复和删除的一致性。
不能把“保持正确性”解释成“保留全部现有函数调用顺序”；也不能把“敢于推翻”解释成丢弃历史数据或绕过执行裁决。

Execution JSON → SQLite 转换必须先定稿 ADR：按首次访问最小 owner 升级，真实历史 fixture、备份、稳定转换 journal、
单一权威切换点、连接/锁生命周期、断电重放、未来版本拒绝、canonical custody、删除 journal/catalog 协调与回退/导出路径。
转换过程中只允许一份业务 authority；旧文件作保留备份，不靠长期双写维护两套真相，不启动扫描全部 owner。
Schema 变化同步提交历史 Schema、静态相邻迁移及 journal 迁移；存储转换无法由现有 family 表达时遵循阶段二的 ADR 要求。

### 交付与验收

按三批交付可运行结果：

1. 去掉非必要等待：Usage 全链路脱离完成条件、Runtime 定向校验、全局 handoff 扫描退出正常
   读取、Memory 通知拆分。保留各自最小正确性屏障。
2. 收敛完成屏障：合并必要最终输出与状态提交、减少 Context 重复保存，验证最后输出后立即
   发送；后台历史不得长期占用前台准备所需的锁。不能撤销 semantic write 串行化来换取速度，
   应缩短锁内工作、减少投影 journal 体积，并在后台领取之间给前台写入机会。
3. 实现 Execution 增量存储：定稿 SQLite、迁移和恢复机制；Session/controller 是否迁移取决于
   剩余耗时，不为统一技术栈同时迁移所有存储。

每批同步检查页面与后台 I/O；不能等全仓改写完成后才验证用户收益。具体事务/表结构由诊断与 ADR 定稿。
容量检查已退出主流程；暖编译、Session open、Runtime acquire 接近零；Session 释放约两百毫秒。
这些不作为本阶段主要投入。最高收益来自取消错误依赖和消除重复全量事务，而非继续仅后台化终态之后的工作。

- 同构建、硬件、模型/thinking、历史、日志等级、并发及正常后台能力下，对比新建/暖 Mission/暖 Session，
  每组至少二十轮报告 P50/P95；可自动化采集，不再要求用户反复手工发送。
- 补齐 renderer 终态绘制与最后可见 delta 标记。分别报告模型等待、本地接入、Core 尾部、Session 释放和 observer，
  不把未测到的 UI 终态替换成 Core 日志，也不重复累加嵌套区间。
- 无工具/子任务/人工等待的短回答：模型结束 → Core 终态 P95 < 500 ms；Core 终态 → renderer 终态 P95 < 200 ms。
  暖 Session 接入额外开销 P95 < 250 ms，排队控制投影 P95 < 200 ms；均是目标，尚未达到。
- 在最后可见输出后立即发送、Core 终态后立即发送、正常活跃输出中排队三种场景分别测试。
  前者不能被数秒持久化尾部拖住；后者仍应遵守真实执行队列和 steer 语义，不能一律强行并发。
- 用小历史、十倍历史与多 Mission 并发验证提交成本和页面查询成本，报告读写次数/字节、锁时间及后台积压。
  普通增量提交不得继续随全部历史线性放大；Mission/Studio 首屏不退化，自动容量统计不进入交互调用链。
- 验证跨进程重复提交/竞争、takeover fencing、崩溃重放、终态已提交但 Session 未释放、
  工具/子任务/人工确认、取消、Usage 幂等投递和删除重放；SQLite 转换补齐真实历史迁移集。
- 注入 Usage preview、聚合、账本及消费者失败，验证回答仍成功、Session 正常释放、下一轮
  不等待统计重试；源事实可恢复后不重复入账，统计未知不能展示为零。
- 在无关 Runtime 慢探测/不可用、其他 owner 大量 handoff 积压、后台历史写入竞争及工具事件
  密集场景下验证当前目标发送和文本消费；不能仅以正常小数据下测试通过判定隔离有效。
- 未达到收益或出现页面退化时，根据证据缩小/撤回不合理实现，不再用更多 adapter、缓存层或增加超时补救错误职责。

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
