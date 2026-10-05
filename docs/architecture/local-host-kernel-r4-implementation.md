# Issue #348 R4 实施与验收

2026-10-04；基线 `origin/main`：`cc1103ecae55c5ec28d98f7e4e54f1165c4bfc8a`（#353/#354/#355 已合入）。独立 worktree 实施。
**状态：工程实现与共享门禁已交付；产品验收仍有缺口，R4 与整体重构尚未标记完成，issue #348 保持开放。**

## 实施边界

Desktop 与 Node/CLI 均用 `createLocalHostMissionApplication` 构造 execution、control 与 run。
删除旧 Desktop MissionRunner、composition/contracts、23 个纯业务转发出口（41 个调用文件直连 package import）和 Node `application` override；通用 facade
只接受共享 factory 的 canonical application，运行时拒绝完整替代 command/run 内核。
Desktop 资源 factory 仅返回资源配置；审批、私有 Context、运行权限和产品展示仍由实际资源端提供。
Automation、Pragma、Memory Curator、Store/Skill Revision、Evaluation、IPC recovery/options/mount/
compact/force interrupt/delete 均依赖 Local Host Mission 用例。

terminal、history custody、claim/retry、metadata 与 archive 编排归 Local Host；Desktop 提供产品 payload、
Memory/Usage 与通知端口，CLI 接相同 receipt consumer。历史必须先取得 custody 才 archive。
Node request lifetime 不能因后台投递重新占有已释放 Mission，也不能在 admission 中等待 history observer。
共享 application 提供幂等 dispose，关闭 owner、Native 资源、receipt、Usage 与事件源；不删除持久数据。
快速 Runtime 的 Human 等待可能早于 Host 句柄建立：先订阅、每页 200 条重建未回答交互并去重，
避免漏掉 checkpoint；不重放历史 output 或已回答交互。
释放后 receipt 保留原步骤与 attempt 并 defer，供下次显式 owner 访问或 Desktop host consumer 继续。
普通 pause 停调度不等 active receipt；shutdown 锁外 settle 后重新检查 Memory idle，再关闭 source。
持久协议、路径、历史 Schema/升级链、事务 journal 与 WAL/FULL 未改变；没有新 worker、总线或容量写门禁。

## Issue 完成标准逐项核对

| #348 标准                                 | 实现与验证位置                                                    | 状态   |
| ----------------------------------------- | ----------------------------------------------------------------- | ------ |
| command 单实现                            | Local Host command dispatcher/control；共享业务门禁               | 已验证 |
| run/recovery/session 单实现               | application/execution kernel；三 executor/两持久格式恢复回归      | 已验证 |
| compile orchestration 单实现              | compile service/readiness；具体 resolver 保持 Host adapter        | 已验证 |
| Desktop 无完整 Runner kernel              | 旧 Runner 三文件删除；resources factory 不构造执行服务            | 已验证 |
| 两端以 ApplicationPort 为应用边界         | 同 factory canonical application；共享 factory 与实际两端接管测试 | 已验证 |
| Desktop 保留 UI/Electron/Host adapter     | 内部 Mission 调用与 IPC mutation 接共享用例                       | 已验证 |
| CLI 保留解析/TTY/presentation/composition | CLI 入口依赖与安装产物验证                                        | 已验证 |
| Core/Interpreter Host-neutral             | ESLint/manifest guards；无反向依赖                                | 已验证 |
| 大部分业务测试集中 Local Host             | delivery 和 8 项纯 command/history 断言迁入；两端留平台资源契约   | 已验证 |

## CR 修复复审

[CR 与修复复审](local-host-kernel-r4-cr-followup.md) 确认可复现的六项缺陷全部修复；
补齐 catch-up 实时事件与错误传播、关闭故障隔离/定向重试、未确认 Native stop 的 lease/资源保护以及 CI 契约文件遗漏。
最终复验以该 followup 的修复后源码与门禁记录为准。

## 门禁与测试归属

`pnpm --filter @pqpo/pragma test` 先构建 CLI/依赖，执行 Local Host 完整 `test:business`，再执行 CLI adapter tests。
`pnpm test:local-host-kernel` 是同一共享门禁，覆盖控制、编译、运行、恢复、持久化、Memory/Usage/投递与内部调用。
唯一排除为 macOS 真实 Keychain 平台 adapter，单列 `pnpm --filter @pragma/local-host test:platform`；
排除不代表 OS 凭据通过。CI/Release 使用该共享门禁与独立 Desktop adapter gate，保留 chat/Revision/packaging。

Desktop 余下的 Mission adapter 测试验证实际 Capability、Secret、Plugin、ContextStore、产品投影、删除与 UI 接线，
不复制 command/kernel 实现。迁移保留真实历史 fixture、成功/失败断言和 request/Context/Runtime identity。
共享 factory 测试验证两 surface 相同 Session、同 request 不重复 Native 副作用、stop 与完整内核注入拒绝；
Desktop 实际资源回归验证 CLI→Desktop→CLI 接管，不能只靠 import 搜索证明接入。

下表记录 CR 前验证；修复后最终验证见上述 followup。使用 Node 24.18.0 / pnpm 10.12.1，串行执行：

| 门禁                                                    | 最终结果                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm check` / `pnpm build`                             | 均通过；19 个构建任务，Desktop main/preload/Bridge/storage worker 产物检查通过                   |
| CLI 完整测试入口                                        | Local Host 98 文件：893 passed、1 skipped；CLI 13 文件：108 passed                               |
| Desktop Mission adapter gate                            | 86 passed、2 skipped；原生 Codex 删除项另行启用后通过，另一个为五样本删除基准                    |
| Desktop 内部调用/platform adapters                      | 8 文件、37 passed                                                                                |
| Desktop IPC/error/Host adapter 契约                     | 6 文件、28 passed；mutation、删除映射、list/read 与 Runtime availability                         |
| Mission chat                                            | Core 2、Memory 3、Local Host 94、renderer 66、Desktop 6 passed；名称筛选产生的其他 skip 不算验收 |
| Revision                                                | Built-in Agents 13、Desktop 69、Mission adapter 6 passed                                         |
| CLI pack / release reports / isolated npm install smoke | 均通过；实际 tarball 审计与安装后执行通过                                                        |
| 真实 Codex app-server 挂起删除                          | 通过：首次 stop 未确认保留数据，恢复进程后重试确认退出并删除 owner 图                            |

共享门禁唯一实际 skip 是需显式启用的真实 M7 模型场景；macOS Keychain 平台测试单独排除，均不能算通过。
测试 collector 显式关闭 Vitest 5 静态解析，以验证 SIGKILL 测试的真实注册名称与次数。
原生 Codex 专项使用 `PRAGMA_MISSION_DELETE_NATIVE=1`、模型 `gpt-6.1-sol`；不推导模型执行成功。
CLI 安装产物为 `apps/cli/.release/pqpo-pragma-0.1.0-next.18.tgz`；原始日志和采样保存在仓库外。

## 四轮优化与 P01–P17

| 保护项 | 保留机制与主要验证                                                                        |
| ------ | ----------------------------------------------------------------------------------------- |
| P01    | Desktop 暖 owner/五分钟 idle；CLI request Native/lease release；owner/successor/接管回归  |
| P02    | Inbox 本地唤醒、单 consumer 与 waiter 先订阅再读；controller/process tests                |
| P03    | pinned Revision 局部复用、active binding/fingerprint/readiness/cache；compile tests/probe |
| P04    | Session snapshot、展示读取合并；historical reads、read-model 与 Desktop page adapter      |
| P05    | history/control/queue/Context 独立水位；queued chat 与 renderer regression                |
| P06    | 实时文本先发布、有界 Runtime 批量事件；Core Runtime queue 合约不改                        |
| P07    | 流式零 Usage preview；attempt 精确值优先/统一 fallback；Core/Memory 大输出专项            |
| P08    | 必要 terminal 提交与真实 Session active release；execution kernel/Flow 拒绝跟进回归       |
| P09    | admission 与 observer settlement 分离；暂停投递不等待 history、关闭才 settle；故障回归    |
| P10    | SQLite WAL/FULL 增量 authority、索引分页；SQLite/canonical tests与存储基准                |
| P11    | 共用最多两 storage worker；准备/大 outbox/Usage lane 隔离；pool/preparation tests         |
| P12    | canonical 合并唤醒、有限后台任务、drain/close；receipt/Memory/Usage tests                 |
| P13    | owner 首访迁移、源损坏局部隔离；真实历史 fixtures/migration/crash tests                   |
| P14    | accepted 后 timeline 失败 applying 重放；semantic write 完整锁/fencing；control tests     |
| P15    | Usage/Memory/投递失败保留事实、retry/degraded/module/code；delivery故障回归               |
| P16    | 删除 freeze→Native stop→journal/catalog→定向后处理；删除/owner tests与Native smoke        |
| P17    | 先窗口后后台，闲时容量 worker，超限仅提示；startup/packaging 不改                         |

R1/R2/R3 最新 followup 的 Flow rejection、successor lease、初轮 admission、queued steer 投影及Memory generation
修复保留原实现和断言；未重建被撤销的容量账本、同步扫描或全局写门禁。

新增等待仅涉及后台 receipt 独立 claim、必要投影与 shutdown settle；前台不等待完整 history/Usage/提炼。
receipt cursor/custody 与 claim/defer/retry 继续使用原 SQLite worker/事务，Mission semantic write 与 Native ownership
仍由原锁/guard/CAS裁决。文件迁移和代码减少不作为性能收益。

## 性能及遗留缺口

性能对照在停止 Agent、测试与构建后串行执行；只保存精简核心结果，原始采样与完整日志留在仓库外。
[完整精简对照](../performance/local-host-kernel-r4-comparison.md)：双方八场景各两组 20 次，
640 次运行；冷启动 terminal 首组触发后，追加双方各两组 40 次，未复现稳定阈值回退。
存储/准备路径未触发既定阈值；500 历史单次样本不足，追加每组三次隔离准备，
双方各 32–34 次前台读取，两组汇总 P95 均未触发阈值。原始低样本结果与汇总口径保留。
暖运行零 DSL 编译、请求内 pinned Revision 只读一次等断言全部通过。
生产源码 1159 文件 SHA-256 为 `42919e9181cc0ccab79d62d9284b7749975995813203c2fd36f3a3965a920492`，
CR 前门禁及性能对照前后不变。该摘要不代表 CR 修复后源码；fixture 结果不宣称产品首 Token 达标。

有界真实接线尝试：监督运行 `run-mission-latency-benchmark.mjs`，warm 1 样本、
`deepseek-v4-flash`、medium thinking、`--background-load`，使用现有 provider 配置。
在 `credentials-read` 阶段 120.11 秒退出：`MISSION_BENCHMARK_KEYCHAIN_TIMEOUT`。
没有有效模型/renderer/后台重叠样本，未计算百分位；没有绕过 Keychain 或以 fixture 替代。

| 产品性能目标                       | 本次结果与剩余验收                                     |
| ---------------------------------- | ------------------------------------------------------ |
| 暖接入 P95 <250ms                  | 未验证；先解决 OS 凭据读取，再取得真实暖运行样本       |
| 模型完成→Core terminal P95 <500ms  | 未验证；fixture lifecycle 有采样，但无真实模型完成事实 |
| terminal→renderer paint P95 <200ms | 未验证；Host status 不能证明 renderer paint            |
| queue 控件可用 P95 <200ms          | 未验证；需要实际 Electron UI 与正常后台负载样本        |

四项产品目标均不得由 fixture/Host status 代替。原生 stop smoke 也不等于真实模型成功或全类 Native 恢复验收。
R1–R3 的这些缺口继续跟踪；适用门禁和产品验收未全部通过前，不关闭 #348、不标记 R4 或整体完成。
后续须在凭据可用环境跑真实 M7、OS adapter 与上述产品场景，补齐完整模型/Native 类型恢复证据；
工程门禁的通过不能抵销这些缺口。

最新 PR 评论修复与验证见 [PR #356 followup](local-host-kernel-r4-pr-review-followup.md)。
