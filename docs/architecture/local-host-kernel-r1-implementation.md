# Issue #348 R1 实施与验证

状态：R1 代码实施已交付，阶段验收未通过，未标记第一阶段完成。起点为 fetch 后的 `origin/main@8fdbd4526d0f62d0b36891165539ed9ec47dc603`；独立 worktree 为 `/Users/linminqiu/.codex/worktrees/issue-348-r1/expert-mesh`。本报告只覆盖[技术方案 R1](local-host-application-kernel-refactor.md)。

PR #353 后续评论核验与追加修复见[补充报告](local-host-kernel-r1-pr-review-followup.md)；以下验证与性能记录保留原测量时点及源码身份。

方案与[实施前基线](../performance/local-host-kernel-baseline.md)及其引用数据从原工作区复制。实施未覆盖、撤销或提交原工作区改动。期间原工作区由其他操作提交了仅含方案、概览和基线的 `ceb29c9c516828ba1735de23c4904a609d1e1dc5`，最终原工作区 clean；与起点的差异只有文档。后续交替测量的 main HEAD 因此是 `ceb29c9`，生产源码仍与 `8fdbd45` 等价；本 worktree 保持原起点，测量时的候选修改尚未提交。

## 范围与持久边界

本阶段统一命令和进程内 active owner 访问。编译、首轮启动、Session recovery 完整生命周期以及内部调用收敛仍依照 R2/R3/R4 实施。保留既有持久 envelope、historical Schema、DSL/compiler/storage/wire 版本、SQLite WAL/FULL、journal、fencing 与 semantic write。

## 实施内容与删除路径

并行实现按文件边界分工，最终接线修复顺序整合；性能测量开始前停止所有实现、构建与测试任务：

| 分工      | 文件责任                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| control   | Local Host control/admission/controller 接受链；Desktop Runner composition/contracts、application-container 与对应接线测试。              |
| owner     | Local Host execution-owner/core-run；Core strict target CAS/receipt；Desktop 原 Session/Lifecycle 服务删除及 owner/人工答复业务测试迁移。 |
| contracts | Shared Mission values 与 Desktop contract extraction；E2E benchmark 场景/结果 helpers 和 helper 测试。                                    |
| 主 Agent  | 公共 command/admission 契约测试、根验证脚本、最终接线整合、串行工程/性能测量与文档状态。                                                  |

- `MissionExecutionOwner` 统一 retained Session、compilation identity、successor/context binding 状态、run generation、active/recovered handle 与 admission。Desktop 原 Session/Lifecycle 两个服务和对应业务测试删除；presentation metadata cache 仍由 Desktop 管理。Local Host 首轮 Core run 与控制恢复使用同一 owner access，避免暖 owner 二次恢复；并发恢复、live publication 与删除后的迟到回调受同一 generation 约束。
- Local Host `core-control-adapter` 统一 send、strict steer、human respond、interrupt 和四种 queue command。Desktop `createLocalHostMissionControlAdapter`、重复 handler、target resolver 和 queue mutation 删除。Desktop/CLI 都装配工厂创建的同一 adapter；Desktop IPC 保留 DTO、request correlation、事件通知，旧 Runner 方法暂作 durable submit/wait 转发，按 R4 删除。
- `mission-command-admission` 统一 readiness、context/successor fencing、准备等待后的 strict target 复查、Core prompt 接受与投影失败重放。编译和 Session 构造通过实际使用的窄端口提供；端口不接受完整 MissionCommand，也不负责发送 prompt。任意 send callback 注入改为工厂品牌类型。
- Core strict steer/queued steer 在现有 Session transaction 中原子校验 active Execution 与根 prompt requestId，消除等待期间目标切换的 TOCTOU。确认过的 receipt 可以在目标结束后重放，不再次投递；未增加持久字段或迁移版本。人工答复映射归并到 Local Host，保留审批、多问题答案和附注格式。
- Shared 提取浏览器安全 Mission identity/workspace/model override/execution binding/Context mount/lifecycle 值对象；Desktop 持久 envelope 和历史 parser 留在原处。真实历史 v8/v9 fixture 与当前输出用于提取等价校验。
- E2E harness 增加四 Mission、最后可见输出/terminal projection/paint 后立即发送、active enqueue/try-steer，以及隔离的真实 Memory/Automation 合成负载观测。保留失败与部分轮次；缺失指标输出 null。`immediate-core` 在临时 unpackaged production harness 中观察既有同步 `execution.terminal_committed` 日志，分别记录 Core 事实时间、relay 和 renderer 接收时间；支持退出后的 gzip 日志与去重。该实时接线尚未取得真实模型运行证据。CR 前背景 curator 只按 `lane=running` 计入观测；CR 已改为逐轮验证完整身份关联的 Native 调用与前台时间重叠，缺证据不计有效后台模型负载。详见[CR 与复核](local-host-kernel-r1-code-review.md)。

R2 编译编排、R3 首轮 run/recovery 完整生命周期、R4 内部消费者和旧薄接口清理未实施。显式 force interrupt、Context mount、压缩和删除的 Host 编排仍保留，未扩展本阶段范围。

## 关键 await、耐久写与 owner/锁

| 路径                    | 本阶段改变                                                                                                                                                              | 保留的必要边界                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| send/strict steer       | 删除 Desktop handler 转发和独立 admission map；共用 admission 等待同一 owner。prepare 后复查 target，Core 同事务 CAS；暖 Session 不重新 open/compile/probe 全 Runtime。 | 同进程 submit 的 FIFO 等待仅覆盖耐久接受，不等待 applied；入口 marker 包含该等待。Inbox append → Core prompt acceptance → queue/timeline semantic projection → operation outcome。Core 接受后投影失败保留待重放，不把 accepted/applied/terminal 合成成功。 |
| respond/queue/interrupt | 从 retained owner 直接取句柄；暖路径移除按 Mission ID 查不存在 Execution 的额外读取。Desktop human response 优先当前 handle，避免构造全部历史 turn。                    | Session/Execution 自身锁、原有 controller fencing 与 human checkpoint。独立 controller 在 Core teardown 完成前保留 lease，迟到释放按 Session、claimId/fencingToken 身份判断，续租不造成漏释放。queue mutation 只在 Core 执行，Host 发布投影。              |
| strict/queued steer     | Core 在既有 transaction 中增加比较；confirmed receipt 重放无需 native 二次投递。                                                                                        | 原 requestId/receipt/uncertain delivery 持久事实，保留 failed-closed 和暂停恢复策略。                                                                                                                                                                      |
| interrupt               | 共用 Stop 清空队列规则；保留 native 停止、observer settlement、强制 Core cancel fallback 和 `MISSION_INTERRUPT_UNCERTAIN` 诊断。                                        | 原有 5s/30s 界限；未通过延长超时降低验收要求。                                                                                                                                                                                                             |
| owner/recovery          | 两份 Desktop maps 与 Local Host recovered/live 分离访问改为同一服务；失败 admission 不污染下一条命令。                                                                  | 耐久 Mission lease、ExpertSession ownership 与 SQLite/journal authority 不下沉为内存权威；Runtime 操作仍在 aggregate lock 外。                                                                                                                             |

这是调用关系核对，不是完整真实请求 I/O/写次数测量。必要提交次数未作优化或合并；真实模型计时和逐请求读写计数仍在后面的验收缺口中记录。

## 保护契约与测试位置

表中记录验证责任，不把“存在测试”当成此次已经运行通过。

| 契约 | 保留路径 / 验证位置                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| P01  | Local Host MissionExecutionOwner；Mission Runner 暖 Session / idle race composition                            |
| P02  | Local Host mission-controller-store、mission-control、跨进程 integration                                       |
| P03  | Desktop 窄 compile dependency、Runner pinned/system/capability successor、runtime-availability                 |
| P04  | Desktop mission-chat-service / read-model，Core Session snapshot                                               |
| P05  | renderer mission-conversation-model 独立水位、queue patch、晚到读取                                            |
| P06  | Core execution-event-writer、runtime-stream-controller 的批量/背压/确认屏障                                    |
| P07  | Core runtime-stream-controller 10,000 delta / exact / fallback / retry 与 token-counter                        |
| P08  | Core execution-system / expert-orchestrator-recovery，Local Host execution-system                              |
| P09  | Desktop mission-execution-observer / Runner queued turn，Local Host admission                                  |
| P10  | Local Host sqlite-execution-store / execution-view-pagination                                                  |
| P11  | Local Host host-storage-pool，两 worker、33 MiB 隔离、ID-only ack                                              |
| P12  | Local Host sqlite-execution-store / canonical-event-feed                                                       |
| P13  | Local Host sqlite-execution-store / execution-state-migration 历史 fixture                                     |
| P14  | Local Host command admission / queue-steer-crash / strict-steer-fallback-crash；Desktop semantic write adapter |
| P15  | Local Host usage / canonical-event-feed / memory-plane-execution；Desktop memory-extraction-jobs               |
| P16  | Local Host owner-deletion / mission-deletion；Desktop mission-deletion                                         |
| P17  | Desktop storage-capacity-inspection / startup-sequence；CLI 不启动容量轮询                                     |

未恢复第三轮撤销的容量账本、同步扫描和全局写入门禁。P06/P07 的流式批处理/计数算法以及 P05 renderer 优化未修改。CR 对 Core receipt replay 与 cold Flow cancellation 增加控制正确性保护；P08 原恢复算法继续保留，cold stop 不调用恢复执行。

## 已发现并修复的接线回归

串行集成验证发现并修复：初始发送的 Inbox 接受顺序、模型更新后的 owner fence、冷人工 checkpoint 恢复与拒绝码、独立 controller 过早停止以及外部 fixture 的 scope 清理。新增真实续租后延迟释放测试，按稳定 claimId/fencingToken 判断，避免 guard 对象替换后漏释放。FIFO 的入口 marker 包含等待，不能以移到等待后降低统计。

canonical 测试改为等待实际后台投递启动，并按既有退避时钟验证修复；未缩短生产 coalescing/backoff。rich chat fake Runtime 改为取消感知等待并拒绝 missed-abort；原中断/删除断言与预算保留。最终完整 Runner 已无 unhandled rejection。

## 工程验证结果（CR 前记录）

各行有重复覆盖，不将其相加成唯一测试数。最终串行验证与既有失败保留在[验证记录](../performance/local-host-kernel-r1-validation.json)、[补充验证](../performance/local-host-kernel-r1-supplemental-validation.json)和[main 对照失败](../performance/local-host-kernel-r1-baseline-test-debt.json)。修复前失败和中止的尝试不作为最终通过结果。

| 验证                                                       | 结果                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                               | 最终 Node24.18 通过：Runtime/DSL、全仓 lint/typecheck、11 个 Core 测试任务（456 项 Vitest；9 个任务复用有效 Turbo 缓存，2 个实际执行）。之前 Node23.11 的检查亦通过；控制专项另有完整执行结果。 |
| 最终 Local Host/Desktop lint/typecheck                     | 通过，Node24.18。                                                                                                                                                                               |
| `pnpm test:mission-control`                                | 93 项公共控制/owner/admission/crash/replay + 3 项真实 Core CAS/receipt，96 通过。                                                                                                               |
| `pnpm test:mission-chat` / `pnpm test:revision`            | 分别 76 / 88 通过。                                                                                                                                                                             |
| Core event writer/stream/recovery                          | 19 通过，P06/P07/P08。                                                                                                                                                                          |
| SQLite/worker/pagination/Usage/canonical/deletion          | 74 通过，P10–P16。                                                                                                                                                                              |
| controller 跨进程 / 历史状态迁移                           | 8 / 12 通过；新增 FIFO 后再次跨进程 8 通过。                                                                                                                                                    |
| Shared neutral values / Desktop contract extraction        | 5 / 55 通过；Desktop 含真实 v8/v9 fixture。                                                                                                                                                     |
| Desktop deletion/fenced adapter/observer/services/capacity | 22 通过、2 个原有 skipped。                                                                                                                                                                     |
| 最终完整 Desktop Runner                                    | **79 通过、1 失败，0 unhandled**。失败为 oversized reply，原 main 相同场景也失败；不延长超时、不给失败项记通过。                                                                                |
| CLI 全套                                                   | 108 通过，13 文件；包含原并行验证时未完成的 doctor。                                                                                                                                            |
| E2E harness helpers                                        | 10 通过，覆盖精确 Core marker、gzip 去重、时间分段及可见输出/queue/steer 场景。                                                                                                                 |
| 全仓 build / 最终 Desktop production build                 | 最终 Node24 全仓 build 通过（19 个任务）；main 无外部 `@pragma/*`，preload 自包含并注入 Bridge，storage worker 可耐久打开数据库。                                                               |
| CLI pack/audit/release reports/installed positive smoke    | 通过；Node24/macOS x64，隔离 npm 安装。保存[构建包 fingerprint](../performance/local-host-kernel-r1-cli-artifact-manifest.json)，commit 为起点，候选源码另由 digest 区分。                      |

宽范围 Local Host execution-system 曾为 118 通过、1 失败；原 main 同一 Team Session restart fixture 亦失败（预期旧 cleanup 文本，实际 Runtime stop 未确认诊断）。因此不能写成全仓所有业务测试通过。两项既有失败均未删除或放宽断言。

## 局部性能对照（CR 前候选）

Node24.18 / Electron43.7.6，同一 Intel i7-9750H、16 GiB、macOS x64 主机。每种基准串行执行 `main1 → candidate1 → main2 → candidate2`，无同时进行的任务 build/test/benchmark，不关闭用户其他应用。原始数据与负载、时间、来源 digest 见[对照环境](../performance/local-host-kernel-r1-comparison-environment.json)、[完整指标差值](../performance/local-host-kernel-r1-local-comparison.json)、[源码快照](../performance/local-host-kernel-r1-source-snapshots.json)。main 的源码 digest 为 `bfba71f5b8cdb29fff47cf4d117ac1f2aed40e97fa727483ee8e392b0b55043a`；候选未提交，commit 仍是起点。digest 覆盖文件清单见源码快照，不代表未列入范围的全仓构建身份。候选生产源码 digest 为 `3e0794988f11084df4d0678b233ca058421fa1a54c09a66abfd22c29b54a8380`，测量前后相同。

下表每格分别列两轮值，不合并 P95，不将波动归因于重构收益。存储 canonical 开启，单 owner 每轮20样本、四 owner 每轮80样本；renderer 每模式/规模40样本；准备隔离中的前台读是四 owner batch，不是单个 Mission admission。

| 指标                                     | main（第1 / 第2轮，ms） | R1 候选（第1 / 第2轮，ms） |
| ---------------------------------------- | ----------------------- | -------------------------- |
| 500 历史，单 owner commit P95            | 6.86 / 7.49             | 6.93 / 7.28                |
| 5,000 历史，单 owner commit P95          | 7.47 / 8.60             | 7.04 / 7.18                |
| 5,000 历史，四 owner commit P95          | 47.16 / 54.51           | 60.56 / 34.70              |
| 5,000 历史转换期间，前台 batch read P95  | 80.58 / 141.29          | 84.74 / 65.41              |
| 50,000 历史转换期间，前台 batch read P95 | 45.96 / 46.98           | 45.92 / 45.52              |
| streaming 100 entries，input→paint P95   | 35.30 / 35.40           | 33.50 / 35.20              |
| streaming 1,000 entries，input→paint P95 | 33.80 / 35.60           | 33.70 / 35.30              |
| streaming 5,000 entries，input→paint P95 | 34.30 / 35.70           | 35.70 / 34.30              |

500 历史准备阶段前台每轮只有11个 batch，P50/P95 保留 null；max 为 main142.39/161.30、候选142.95/159.65ms。renderer 全部有效场景 Long Task 为0。提交没有随500→5,000历史线性增长。对 commit/read、准备、paint、worker queue 和 file lock 最大等待/持有时间逐项比较，未出现“>10% 且 >20ms”的双阈值触发；这只适用于已测局部指标。

I/O 对照没有把序列化 bytes 当磁盘 bytes。5,000历史单 owner 两轮、双方都为22次 worker writes/42次请求（含canonical后台），payload request/response 总量5960/16670 bytes，数据库增长0、进程磁盘写3,411,968 bytes。四 owner 请求/写次数受canonical批次时序影响：main188/188请求、108/103写，候选198/178请求、113/96写；最大worker收件等待main71.75/72.06、候选85.85/58.86ms，最大锁持有main28.96/47.83、候选44.53/25.42ms。进程磁盘counter包含worker与后台及延迟写，不能归因为每次真实请求I/O。

一次候选 renderer launch exit0却没有JSON，未生成有效样本；保留失败与随后单独pilot记录，并重新执行四次完整交替对照。局部 benchmark 不含真实模型、完整 Mission control admission 或正常产品 Memory/Automation 负载，不以这些数据宣称产品目标达标。

复现局部测量：在原工作区和本worktree交替运行 `node packages/local-host/scripts/benchmark-execution-storage.mjs`、`node packages/local-host/scripts/benchmark-storage-preparation.mjs`、`node apps/desktop/scripts/benchmark-mission-stream-ui.mjs`，显式选用 Node24.18 并保留每次完整JSON。

## 性能与验收缺口

未改源码的 main 与最终候选 production 都尝试 Pi + `deepseek-v4-flash` / thinking `medium` 的 warm pilot（每侧请求1轮）。两侧均在 Keychain 准备阶段120秒超时，`MISSION_BENCHMARK_KEYCHAIN_TIMEOUT`、exit1、有效样本0。保留 [main 重试状态](../performance/local-host-kernel-r1-baseline-model-retry-status.json)及[候选与 native 原始状态](../performance/local-host-kernel-r1-model-probes.json)。无法进行 cold/new/warm 各20个有效样本的对照；没有将缺失分段填0或从失败轮计算百分位。

另使用已安装 `codex-cli 0.159.0`，以既有 `@pragma/examples runtime:probe` 在私有临时 workspace/state 顺序执行 native Core smoke：

| probe    | 输出断言                                                                                                                                                                              | 进程结束与结论                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| resume   | 两项断言通过：首轮与 refresh 后按 native Session identity 继续执行；[脱敏证据](../performance/local-host-kernel-r1-native-resume-evidence.json)。                                     | 输出 summary 后未自行退出，240秒上限终止；只记功能断言通过，完整 smoke 未通过。 |
| steering | 既有 probe 的 active-turn 观测窗口内未观察到 tool.started/message.delta，在实际发送 steer 前断言失败；[脱敏证据](../performance/local-host-kernel-r1-native-steering-evidence.json)。 | 同样240秒上限终止；未获得实际 steer consumed 证据。                             |

终止只针对本次 probe 自己的进程组，未停止用户已有 Runtime 进程。尚未定位 probe 收尾挂起和 steering 触发失败的根因，未因此改动 R1 之外的 Runtime 算法。native probe 不经过 Mission Inbox，不替代产品队列、接管与恢复场景，也不能用于真实模型延迟对照。

四项产品目标（warm admission P95<250ms、model end→Core terminal P95<500ms、Core→真实 renderer paint P95<200ms、enqueue→queue control P95<200ms）仍待真实样本，均为未验证。缺失完整背景负载、四 Mission 并发与立即发送等有效测量不能记为通过。局部基准与架构收敛不替代真实模型门禁。

## 实施环境

依赖锁未修改。`pnpm install --frozen-lockfile` 的 Qoder SDK postinstall 下载因 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` 失败；系统 CA 重试同样失败。使用 SDK 提供的 `QODER_SKIP_DOWNLOAD=1` 完成依赖安装，保留系统 qodercli 路径；本次不以此声称 SDK 原生 Worker 下载/运行验证通过。

## 阶段状态与剩余工作

- [x] R1 command 业务实现和 active owner 单份；Desktop/CLI 同一工厂 consumer 接线，旧 Desktop handler/target resolver/Session/Lifecycle 服务删除。
- [x] 中立契约保持接受集合，历史 fixture 等价；控制专项 CR 后109项、完整 Local Host execution-system120项、跨进程接管、crash/replay、queue fallback、human checkpoint、取消和暖 owner 复用验证通过。
- [x] P01–P17 对应测试位置、保留机制和覆盖边界有记录；production 构建与 CLI 包安装 smoke 通过。
- [x] 存储、准备隔离和局部 UI 完成两组串行交替对照，已测指标没有双阈值回退触发；原始数据与源码身份可查。
- [ ] 关键 control 路径的可比较真实模型前后样本：两侧 pilot 均0样本。技术方案要求关键路径切换前取得比较样本；当前实现只能作为候选交付，尚不满足阶段退出/合入依据。
- [ ] cold/new/warm、立即发送、active queue/steer、四 Mission、正常 Memory/Automation 负载各自达到方案样本量；真实 Mission/Studio 首屏、逐请求读取/写入次数与磁盘 I/O 对照仍缺。
- [ ] native 多轮/queue/steer/恢复完整 smoke：resume 仅输出断言通过，steering 失败，两者未正常退出；Mission Inbox native E2E 未补齐。
- [x] CR 已将 Team restart 的过时外层 cleanup 文本断言改为检查真实 AggregateError cause，保留全部恢复身份断言；完整 Local Host execution-system 120/120 通过。原 main 失败和首轮候选失败仍保留。
- [ ] oversized reply settlement 既有失败仍待独立整改；未删除该场景、未加长超时、未更改无关输出算法。

R2/R3/R4 未开始。后续应先修复认证环境并串行补采样，同时定位 native probe 未退出及 steering 未命中活跃 turn 的原因；不能用局部测试替代真实模型门禁。Flow recovery 在返回后遇到 generation invalidation 的 discard seam 尚无直接竞态测试；完整 executor 生命周期按 R3 继续验证，本次没有观测到该 seam 的具体生产故障。

补采样从每侧的1轮 pilot 开始，确认有效后再扩大到方案各组20轮，不在 build/test 同时执行时测量：

```bash
node apps/desktop/scripts/run-mission-latency-benchmark.mjs \
  --source-home "$HOME/.pragma" --samples 1 --groups warm \
  --model deepseek-v4-flash --thinking medium \
  --output /tmp/pragma-kernel-e2e-pilot.json
```

最终结论：代码和局部验证已交付，R1 阶段保持验收未通过；未宣称性能验收通过或第一阶段完成。工程结果摘要见[最终验证摘要](../performance/local-host-kernel-r1-verification-summary.json)。

## CR 后最终状态（2026-10-02）

[CR 与复核报告](local-host-kernel-r1-code-review.md)确认的 15 项问题已全部修复并复核，包括 owner 撤销/重跑、receipt replay、Flow 人工答复、冷停止、取消 sealing/lease loss 和 benchmark 证据口径。冷停止仅增加必要的控制边界，不激活 Flow graph 或 Runtime turn，不迁移完整 run/recovery 生命周期，不开展 R2/R3/R4。

最终 Node24.18 `pnpm check`（11 个基础任务456项）、全仓 build、控制109、完整 Local Host120、Core Flow8、stream/recovery19、存储保护74、CLI108、contracts55、adapter Host4、harness20、pack/audit/release reports/隔离安装 smoke均通过。完整 Desktop Runner80通过、1个既有 oversized reply失败、0unhandled；该套件没有记通过。Team restart的过时外层报错断言已改为检验真实cleanup cause，并完整通过后续恢复身份验证。保留原 main 和候选的所有失败尝试，未改大输出算法或延长deadline。

最终候选 digest为 `228f00277f24f0588abad69e374e713afd3790f3c42973f5b3f11c5a3563b430`。新做12次串行局部采样，source测量前后不变，无“>10% 且 >20ms”双阈值触发；全指标、I/O、样本量和边界见CR报告。前面的旧数据只代表CR前候选。

最终候选真实模型pilot再次Keychain120秒超时，有效样本0；[模型状态](../performance/local-host-kernel-r1-cr-model-pilot-status.json)绑定上述源码。真实模型/Native完整验收和大输出测试仍待完成，R1保持阶段验收未通过，未标记第一阶段完成。原工作区保留，验证记录生成时的候选未提交/推送。工程证据见[本轮验证](../performance/local-host-kernel-r1-cr-validation.json)，闭环结论见[CR摘要](../performance/local-host-kernel-r1-cr-review.json)。

最终 Core 取消改动后，跨进程 controller 与历史状态迁移再次20/20通过、0unhandled；测量后的来源复核仍与上述 digest 一致。
