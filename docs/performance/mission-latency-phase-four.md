# Mission 延迟优化第四阶段实施记录

更新时间：2026-10-02。状态：实现与集成验证进行中；**尚未完成端到端验收，不能宣布第四阶段完成**。

## 核心路径与已落地改动

耐久 Inbox、幂等、owner fencing、当前目标权限与绑定、Runtime submit、实时输出、必要恢复事实、终态提交和 Session active 释放继续构成完成条件。Usage 入账、Memory 提炼、归档和历史投影由原有耐久消费者完成。

- `stream-controller` 删除逐 delta tokenizer、Usage preview timer、预览队列和窗口占用预估。精确上报优先；缺少上报时只在 Runtime attempt 结束计数一次。保留提交前真实容量检查和显式压缩。已完成的 hook Promise 从集合移除。
- Core 将原始 Usage observation 加入下一次必要事务，不单独提交 `invocation-usage`，不等待外部 UsageSink。稳定 observation ID 和 `runtime.usage.observed` 源事实保留。Desktop 删除预览 SQL/广播链，只展示已结算累计结果。
- 执行 readiness 只遍历当前目标的传递依赖并探测实际 Runtime，不调用全量 Runtime list 或无关模型发现。相同绑定和环境合并探测，成功后有效期 30 秒；失败、配置变化和手动刷新使结果失效。权威权限、绑定和身份检查继续执行。
- Memory activity 保留当前 conversation 的持久失效与 abort 屏障；pipeline 唤醒和后续消费退出该等待链。
- 普通 Runtime 耐久事实进入有序队列，条数和字节同时限制在 256 条/1 MiB，包含进行中的批次。普通工具通知不触发 flush；人工确认和结束等真实边界仍等待耐久屏障。实时文本先发布。
- standalone Expert 根 turn 的最终消息、Invocation 成功与 Execution 成功合并提交；Team、Flow 和子 Invocation 继续由原执行器裁决。恢复 snapshot 变化才同步。终态记录稳定 Session-release 意图，释放仍按原 Execution/request 条件提交；重启遇到已成功终态不再误记为中断。
- Host Execution SQLite adapter 已供 Desktop/CLI 注入。Core 保留状态规则、签名、CAS 和恢复合约；数据库位于每 Execution 的 owner 目录，WAL/FULL 耐久提交。两个 Host worker 处理 SQL，前台优先且同 owner 有序，连接在操作结束关闭。后台 outbox 每批 64 条并让出调度；SQLite 锁竞争有界重试。
- 每次 commit 只读取受影响记录，原子写变更行、新事件、幂等 receipt 和增量 canonical outbox。事件按 cursor/limit 索引分页；`StoredExecutionView` 也按有界页面读取，不先取完整历史；完整树与导出使用显式查询和一致读事务。重复 commit 不重复发布 live 事件。
- JSON→SQLite 首次访问按 owner 转换，不在启动扫描。原始文件和待投递 handoff 保留备份，重放旧事务和静态相邻迁移后导入临时数据库，验证 cursor/记录/receipt，最后切换 authority marker。旧 JSON 随后只是备份，业务入口不再提供 File adapter；旧格式只由迁移模块恢复。初始化/转换 journal 可重放，未来格式拒绝。
- 历史 handoff 内嵌 transaction 同样走已注册的升级链；真实历史写入器 fixture 覆盖 v10→v13，保留 canonical 身份和原始备份。迁移 journal 与替换文件均同步到磁盘。
- 删除继续使用既有 owner 删除 journal、canonical barrier 和 ownership pending catalog；移动根目录前关闭连接，数据库与 WAL/SHM 一起移动。SQLite 归档只接受终态，并使用 WAL checkpoint 保留单一索引历史权威。导出包含当前记录、事件、receipt 和未投递 canonical 事实。
- 页面每类后台读取保留一个进行中请求和一个 dirty 后续读取；历史非紧急失效 500 ms 合并，Context 按 revision 刷新。250 ms 展示超时不会释放底层读取槽位。保留 entry 级输出更新、首屏分页和六小时闲时容量统计。
- 统计/投递数据库遇锁立即报告后台重试，避免 Electron Main 同步等锁。Local Host Usage 消费最多 64 条，批次之间让步，失败逐步退避至 30 秒。

存储决策及恢复边界见 [ADR 065](../adr/065-incremental-execution-storage.md)。

## 验证记录

- 完整 Desktop Mission 集成测试：79/79 通过；性能复核最终代码于 2026-10-02 再跑 79/79 通过（289.88 秒），覆盖真实 SQLite Host 路径、排队、steer、取消、接管、权限、恢复和删除。
- Core 执行/流式/事件队列/迁移/分页完整集成集：146/146 通过。旧测试已按真实 Session 释放语义等待 `turn.settled`，未放宽实现屏障。
- Host Storage/Activity/Core Run 集成：最终四个文件 36/36 通过；随后 Storage 单独 16/16 通过，包含历史 handoff 转换、数据库锁竞争、跨进程 CAS 和未来数据库格式拒绝。
- 历史 handoff 与通用迁移最后复验 18/18 通过，包括链式升级、当前 no-op、未完成 journal 重放和未来事务拒绝。
- Desktop Runtime/Usage/Delivery/页面后台读取最后复验 40/40 通过。
- 流式 10,000 delta 测试确认期间计数器调用为零；缺少精确上报的结束计数幂等，精确上报无需 fallback。慢/永不返回的 UsageSink 不阻止当前结果、Session 释放及下一轮。
- 性能复核最终代码的 `pnpm check` 与 Desktop production build 均通过；lint/typecheck 各 19 项任务、规定的核心测试 11 项任务成功。主进程无外部 `@pragma/*` import，preload 自包含且暴露 `pragmaDesktop`。

## 新增性能回退复核

按用户追加要求，对带 canonical 投递的真实存储路径与旧 JSON 路径做同条件对照。检查发现并修正：worker 队列选择的平方级扫描、重复空确认/空写事务、同事务重复读取 Invocation、worker 消息发送失败后保留请求、端到端采集使用错误日志时间字段。采集现在标记缺失或负值指标，缺失样本不计入百分位。

初次对照显示 SQLite 在四 owner 并发下改善，但短历史提交因后台确认和重复待投递标记同步而回退。标记改为 owner 内闲置记录与 pending 目录之间原子移动；新增事实提交前仍同步 pending 目录，闲置记录可重建，不增加同步屏障。确认沿用 canonical 投递/删除 fence，借助 SQLite 写事务和提交后复查避免注册/清理竞态，退出重复 Execution 文件锁。21 项存储测试通过，覆盖注册后 SQL 提交前崩溃、批次期间新增事实、另一个进程提交后退出、去重重放、owner 删除及同时关闭不影响其他 owner。

最终独立运行的同条件对照，在本次样本中未观察到提交/控制读取回退。两种存储均启用真实 canonical 后台投递；单 owner 各 20 次，四 owner 共 80 次。以下为提交 P95（ms）：

| 历史事件 / owner |   JSON | SQLite |
| ---------------- | -----: | -----: |
| 0 / 1            |  93.46 |  32.54 |
| 50 / 1           |  76.73 |  53.11 |
| 500 / 1          |  77.76 |  52.11 |
| 5,000 / 1        |  92.49 |  51.59 |
| 5,000 / 4        | 348.88 | 152.50 |

SQLite 控制读取 P95 为单 owner 3.71–5.87 ms、四 owner 88.25 ms；对应 JSON 为 43.68–73.16 ms、163.89 ms。原始结果包含无投递对照及序列化字节，见 [同条件新旧存储对照](mission-latency-phase-four-storage-comparison.json)。这些是存储局部证据，不能代替真实模型/正常后台负载的端到端验收，也不能把序列化字节当成实际磁盘 I/O。

## 局部性能证据与限制

### 首次 JSON 转换成本

2026-10-02 追加小样本实测，每规模 3 次，由 FileExecutionStore 实际写出当前 JSON 格式后触发首次读取。500 事件（约 0.2 MB）转换 354–398 ms；5,000 事件（约 2.0 MB）468–492 ms；50,000 事件（约 20.7 MB）1,693–1,787 ms。空历史冷 worker 样本约 738–739 ms，已启动 worker 的空历史样本约 325 ms。转换后的再次控制读取约 1.4–1.9 ms。原始结果见 [首次转换测量](mission-latency-phase-four-migration.json)。3 次样本不报告 P95，不包含压缩归档、待投递 handoff 或历史领域 Schema 升级的额外成本。

上述首次转换数据来自收尾前实现。收尾实现将当前 owner 准备与 ready store 操作分离：一条后台 lane 串行准备，一条前台 lane 处理已就绪 owner。迁移仍阻塞当前旧 owner 的必要准备，同一旧 Mission 多个 Execution 的准备成本可能叠加；不能保证所有后台任务在转换期间都有相同延迟。Node 主线程 10 ms 定时器观测间隔约 10.5–15.1 ms，仅说明本次主线程未出现秒级停顿，不代表页面或其他 Mission 无等待。现有稳态提交对照不包含这一冷路径；这是需要继续处理和验收的性能风险。

真实 Electron 绘制基准每组 40 样本，静态/流式各覆盖 100、1,000、5,000 entries。流式 input→paint P95 分别为 35.2、34.2、34.9 ms，未观察到长任务。原始结果见 [绘制基准](mission-latency-phase-four-stream-ui.json)。这是 renderer 局部基准，不包含真实模型、发送 admission、磁盘和终态完整链路。

`packages/local-host/scripts/benchmark-execution-storage.mjs` 比较 500/5,000 历史事件及四并发 owner 的固定增量提交，每 owner 20 样本。P50/P95：500 条历史 26.35/40.82 ms，5,000 条历史 25.48/28.75 ms，四 owner 并发 50.27/91.41 ms（80 个样本）。单 owner 的 20 次提交均增长 28 KiB；序列化请求约 5.7 KiB、响应约 15.9 KiB，没有十倍历史的线性放大。原始结果见 [存储基准](mission-latency-phase-four-storage.json)。脚本的请求/响应字节是 worker 边界序列化，不能冒充实际磁盘读写字节或锁持有时间。

`apps/desktop/scripts/benchmark-mission-end-to-end.mjs` 使用 production Desktop、真实 provider、隔离测试 owner，采集冷进程/新 Mission/暖 Session、正文/reasoning 绘制、终态绘制、Session 释放及 observer 收尾。SDK 首文本等待单列。暖轮从实际发送按钮开始；首轮现由 renderer 实际 Run 按钮触发，三组口径统一为 UI 操作。测试数据不复制用户的 Automations，因此不能将空业务负载的结果称为正常 Memory/Automation 负载验收。

真实模型 pilot 当前等待 **macOS 钥匙串访问确认**，尚无有效样本。没有解密内容或凭据写入日志/报告，也没有修改源 Mission 数据。

仍需完成用户方案要求的三组各至少 20 次实测、耐久接受→控制投影、三种立即发送/排队场景、正常后台负载、首屏、四 Mission 并发、实际 I/O/锁与读取次数，并对未达指标的分段继续修正。局部测试和缓存命中不替代这些验收。

## 收尾实现与核对（2026-10-02）

- Host 统一两个存储 worker：前台 Execution/短 receipt 与后台 Usage/receipt 批次/owner 转换分 lane；后台无迁移、Usage/receipt 批次、大输出 outbox、归档或超大输入时按两 lane 当前负载分配前台；普通 ID-only ack 可以与前台共享后台 lane。每 owner 的控制操作有序，outbox/ack 使用独立顺序和 64 条/8 MiB 容量，不阻塞后续必要提交；archive 仍保留真实控制屏障。普通 worker 请求最多保留 128 条/32 MiB。无权威单事实大小上限，因此合法超大单条只在后台 lane 空时独占；其他 owner 的小请求仍可使用前台 lane。普通队列满时报告 `HOST_STORAGE_BACKPRESSURE`。后台 canonical 页在背压时按前缀拆分，cursor 仅随耐久批次推进，不丢事实。关闭等待已接受 RPC；故障 worker 退出后才创建替代，generation 防止旧 Usage 代理关闭新连接。
- 转换 journal v2 有静态 v1→v2 迁移、源指纹、导入进度和 publish 阶段；事件流式读取，每 4,096 条或 1 MiB 提交进度。原始备份经临时文件同步后原子发布。重启可续导入，publish 已完成数据库可校验后直接切 authority，不必重复全量导入。覆盖首次 chunk 回滚与 rename 前后恢复。
- Desktop Usage SQL 全部移至 Host worker，Mission 累计结果按观察增量维护索引表。每次 observation 仅传递当前祖先链，缓存复用稳定归属，不重新枚举全 Invocation 树。延迟初始化后恢复先读取耐久 tracking cutoff，避免误跳旧数据。Local Host JSON Usage 有 owner 级备份/journal/SQLite authority 转换。
- MissionDelivery SQL 退出 Electron Main。正常通知唤醒有单任务/dirty 合并和 30 秒恢复兜底；blocked/needs_attention receipt 不导致 10 ms 空转。续租单任务，投递错误保留耐久来源并退避。Usage 与 Mission 通知回调失败不能撤销成功提交。
- Core 不再默认创建 FileExecutionStore；createPragma 必须注入 store。旧格式恢复仅在迁移模块。持久集成测试移入 Host 使用真实 SQLite；Core/Runtime 边界测试使用中立内存 store。三个 examples Host composition root 可注入 Host adapter，其余 example 领域代码继续禁止 Host 依赖。
- 首屏先显示已有有界投影并标记 source verification，当前可见页至多准备 50 个 owner；源错误保留投影并允许退避后重试。**Team 源尚未就绪时，缺少可信 root 身份的投影正文暂缺**，保留子任务过滤；不能把该情形称为完整即时展示。

[准备隔离测量](mission-latency-phase-four-preparation.json)基于真实 v12 writer fixture 的合成扩展，不含模型/renderer。500/5,000/50,000 事件转换分别 557/668/1,820 ms；转换期间四个已准备 owner 的读取批次分别有 11/24/139 个样本。5,000 与 50,000 事件组读取 P95 为 84.0/46.5 ms；11 个样本不报告百分位。转换后单 owner 20 个读取样本 P95 约 1.79–2.11 ms。数据说明前台不再串在转换 RPC 后，不能推导真实 Mission 达标。

正常 benchmark 以环境变量显式启用 SQLite 写锁和 worker 收件队列计时；产品运行不收集。队列时间仅覆盖 worker 收到→执行，不包含 Host owner 队列、槽位等待和消息克隆。内核进程磁盘字节覆盖整个 Node 进程及 worker，可能包含延迟刷盘；不是逐事务归因。失败 COMMIT 的样本延续至成功 ROLLBACK；进程崩溃没有完整释放样本。

独立只读 CR 已覆盖 worker 生命周期/容量、转换恢复、Usage、MissionDelivery 与 prepared 投影。指出的 Usage cutoff、超大输入全局拒绝普通 owner、以及 outbox 共用控制 Promise 链问题已修正；最终复核未发现新的阻断问题。CR 不替代功能故障与性能验收。

## 仍未完成的验收

真实模型 pilot 未取得有效样本，旧的无限挂起 Keychain 试跑已停止。`run-mission-latency-benchmark.mjs` 用独立监督进程限制 native credential 准备为 120 秒；超时明确失败，不生成达标结论。源凭据和源 Mission 不修改，测试使用隔离目录。

仍需正常 Memory/Automation 负载下冷启动/新 Mission/暖 Session 各至少 20 轮，三种立即发送/活跃排队场景、五项 P95、四个实际 Mission 并发、首屏与正文/reasoning/终态绘制，以及实际磁盘 I/O、锁占用和页面读取次数。当前脚本已统一 UI 触发并采集耐久接受→控制通知，尚未补齐所有负载/场景。固定增量与准备隔离测量是局部证据；此前存储对照属于收尾前基线，不能冒充收尾后的完整验收。

## 收尾验证流水

完整存储回归中的 SQLite 21 项通过；最新 worker/容量/后台 lane、receipt 投影、v2 转换与 Usage 恢复四组共 24 项通过。包含真实 SQLite 33 MiB 提交挂起时另一暖 owner 读取和终态提交、旧 owner 准备及 outbox 同时挂起时暖 owner 终态先提交。首次合跑的两项转换测试遇默认五秒测试超时；未延长阈值，单独和后续顺序运行通过。新增隔离测试的 fixture 字段错误已修正。

调度最终修正后的全仓 pnpm check 已通过；production Desktop build 已通过（含打包后 worker 实际启动及耐久打开 receipt 数据库）。Desktop Usage/历史/投递 31 项回归通过。来源读取失败的退避已与耐久任务完成唤醒分开，来源离线时已有任务继续排空，不反复读取失败来源。两个 Runtime examples 退出时也释放新注入的存储 lease，独立 lint/typecheck 通过。旧模型 pilot 已结束，真实端到端验收仍未完成。

收尾再次测量时发现 WAL metadata 首次读取可能在 busy_timeout 设置前遭遇锁竞争；已将原有 100 ms 锁策略移到连接首次读取之前，并在打开失败时关闭连接。未提高锁等待政策，相关故障/并发回归及存储基准重新运行；失败测量不计入性能结果。

2026-10-02 最新独立存储复测已完成，未再次出现锁错误，原始结果见 [收尾存储测量](mission-latency-phase-four-storage-closure.json)。开启 canonical 投递时，0/50/500/5,000 历史的单 owner 提交 P95 为 46.82/46.06/46.92/45.48 ms（各 20 次）；5,000 历史四 owner 为 255.19 ms（80 次），控制读取 P95 为 68.08 ms。四 owner 提交高于此前收尾前 152.50 ms 的样本，不能宣布无回退；仍需对后台占用时前台集中到一个 worker 的调度成本继续修正和复测。四 owner 内核写入为 25,284,608 bytes，worker 收件等待最大 220.16 ms，而 BEGIN 锁等待最大 1.45 ms；这些是分段定位线索，不是 Mission 五项指标的达标证明。

真实模型监督脚本也限制 native credential 清理为 120 秒，避免测量后的清理再次无限挂起。超时以明确失败退出；不把没有有效样本的执行当成成功验收。

并发修正复测：普通 ID-only ack 不再独占后台 lane，控制读取 P95 降至 26.46 ms，但提交仍为 251.45 ms，见 [ack 路由测量](mission-latency-phase-four-storage-ack.json)。随后在现有 canonical 投递机制内合并 owner 唤醒 250 ms（从首次待投递开始，不因后续提交重置，最多 128 个 timer；drain/close 直接排空，删除保留 fence），减少逐小提交退役、重新注册和 SQL 确认。没有引入连接缓存；每 RPC 仍关闭连接，避免扩大跨进程删除风险。

[合并投递复测](mission-latency-phase-four-storage-coalesced.json)单 owner 0/50/500/5,000 历史提交 P50 为 27.27/28.29/26.80/26.96 ms，P95 为 49.82/48.93/45.01/49.03 ms（各 20 次）。四 owner 80 次提交 P50/P95 为 94.44/176.37 ms，控制读取 P95 为 26.47 ms；较此次 255.19 ms 回退减轻，但仍高于收尾前单次 152.50 ms 基线，尚不能证明完全无回退。worker 收件等待最大降至 146.10 ms。独立 CR 认可 ack 与投递合并安全边界；SQLite/pool 29 项以及新增删除 wake 回归通过，关闭与最后提交并发测试修正 canonical 身份断言后单独通过。最终全仓检查和构建继续执行；真实模型/正常后台负载验收仍欠缺。

最终源代码检查：新增测试的 `this` 别名违反 lint，已改为 Worker 集合，最新 `pnpm check` 全部通过。投递合并后 Memory 执行、Context 生命周期和 retrieval 三套共 19 项通过，未发现活跃失效或 Evidence 捕获屏障回归。四 owner 合并投递样本的进程内核写入为 17,195,008 bytes（此前回退样本为 25,284,608 bytes），仍按整体进程与延迟刷盘口径解释，不能归因到单个事务。最终 Desktop 构建及受监督模型 pilot 待核对。

最终 Desktop production build 已通过 styles、main/preload 自包含与打包 worker 启动验证；最新全仓 `pnpm check` 通过。实际调度代码的最后独立 CR 未发现新的阻断，范围包含 timer 容量、持续提交不延长窗口、关闭末次已接受提交、删除 fence 与旧回调。

重新执行受监督 warm pilot（1 个计划样本，使用上述最终构建）仍在 native Keychain 准备阶段阻塞，120 秒后以 `MISSION_BENCHMARK_KEYCHAIN_TIMEOUT` 退出；已确认监督进程及子进程退出，没有生成有效测量文件。没有绕过 macOS 权限，也没有修改源 Mission。此失败不是模型延迟样本，不能进入 P50/P95。真实模型访问授权、正常后台负载及其余场景验收仍未完成；四 owner 与旧基线差异也仍需进一步核实，阶段四不标记完成。

## PR 评论修复（2026-10-02）

读取 PR #352 全部总评、review 和行内评论后，确认总评提出的三个 Runtime 用量问题成立。原先先生成 fallback 再判断是否收集用量，会阻止 collect-only Runtime 返回精确值；明确未 dispatch 的错误仍生成输入估算；只有最终正文而无 delta 的 Runtime 漏算输出。

结算移至每次 native attempt 结束边界：先读取原生上报，缺少精确值时调用原生 collector，最后才调用统一计数器。collector 收到本次 attempt 的开始时间和原始用量，不传递此前重试的累计值；实际 attempt 仅累计一次。明确未 dispatch 时清空本次 capture，不调用 collector 或计数器，保留此前实际 attempt 的累计值。最终正文作为 fallback 的正文来源，与已捕获 reasoning 一并计数。准备失败的外层 catch 只读取已有用量，不产生估算。

新增五个真实 driver 边界回归，覆盖 collect-only 精确值、首次及重试后未发送、最终正文无 delta、独立收集重试并累计一次；保留原有 10,000 delta 零计数与精确上报零估算断言。Core 五套共 43 项、Host Usage/执行结算 10 项、Pi/Codex/Antigravity 相关回归 93 项通过，最新全仓 `pnpm check` 通过。流式统计没有恢复，未引入计时器、轮询或全历史读取。上述验证属于正确性和调用次数证据，真实端到端性能验收仍未完成。

Runtime Session 身份继续在可选 collector 执行前耐久保存，保留用量收集失败时的恢复边界。最终代码重新运行 Core 43 项、全仓 `pnpm check` 和 Desktop production build 均通过，包含 preload 自包含与打包存储 worker 实际启动验证。

## 后台恢复评论与主分支整合（2026-10-02）

PR #352 后续评论提出的两个恢复问题均成立：pending/handoff 名称直接解码会让单个非法来源中断整轮恢复；固定处理前 64 个 owner 会让后续正常 owner 饥饿。现在逐文件隔离非法名称，原文件原子移入 quarantine 并报告稳定错误码，不读取或暴露 payload。恢复保持每轮最多 64 个 owner、单任务执行，按 owner 轮转；失败按 500 ms 至 30 秒退避，重试状态最多保留 1,024 个。退避中的失败继续报告 degraded，不伪装成已修复。恢复后移除重试状态，不添加后台 timer 或前台全局扫描。

整合 main 的 PR #351 时保留 Mission 删除 journal、Runtime 停止确认、持久 owner fencing 和后台补偿。SQLite 写入在 owner 锁内检查 fence；删除采用 batch→Session→delivery→Execution 锁顺序。receipt fencing、删除快照读取和补偿入账使用 Host worker。SQLite Trash 只读取原始用量事件及 Invocation，历史 JSON Trash 的读取和升级留在 Core 迁移模块，不恢复 FileExecutionStore 业务 authority。删除后的 Invocation 按执行一次建索引，不对每条 observation 扫描完整数组。

扩展 Memory 集成验证还发现有效历史文件名、owner 缺失时未进入迁移校验的遗漏：恢复现仅对实际发现的历史 handoff 在缺少 SQLite owner 时准备一次，未来版本保留并隔离；普通 pending owner 不额外准备。已有未来版本 degraded 断言保留，未改为接受失败来源。

当前回归：Host SQLite、跨进程 fencing、Usage 补偿及 Mission 删除四套 50 项通过；Desktop 删除/投递/settlement/attention 四套 25 项通过，Memory 状态 11 项与 MissionRunner 删除相关 3 项通过。真实 native 删除测试未启用，仍不替代真实模型和完整端到端验收。

补充回归：后台 lane 隔离 8 项通过，覆盖 Trash 用量读取及 outbox 挂起时暖 owner 终态先提交；MissionRunner successor Session、删除 claim 与人工等待重启恢复补充 5 项通过，Core Runtime 五套 44 项通过。缺失 Trash 来源先检查存在性，再进入迁移 owner 锁，避免读取过期来源创建空 owner 目录；同一真实历史 fixture 回归同时验证这一无副作用边界。

[整合存储复测](mission-latency-phase-four-storage-merged.json)使用同一 Intel i7-9750H 主机与现有脚本。canonical 开启时，0/50/500/5,000 历史的单 owner 提交 P95 为 6.95/7.13/7.87/6.93 ms（各 20 次），四 owner P95 为 53.27 ms（80 次）。固定增量没有随十倍历史放大；本轮没有观察到此前的存储提交回退。main 的 #351 同时移除了进程租约 metadata 的 fsync，降低文件锁成本；这些数据不能归因于恢复修复，也不是单变量因果比较。SQL 业务事务的耐久要求保留。该基准不包含 renderer、模型和正常 Memory/Automation 负载，仍不能作为完整 Mission 达标证明；缺失 Trash 存在性检查仅作用于后台历史读取，不影响该提交测量。

最终整合代码的全仓 `pnpm check` 与 `pnpm build` 均通过；Desktop main/preload 自包含及打包 worker 实际启动验证通过。缺失 Trash 来源的无副作用回归在最终重建依赖后通过。九个文本冲突已解决，最新 main 为 `e17b71bb`（#351）；PR 继续保持 Draft，完整真实模型端到端验收未补齐。
