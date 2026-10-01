# 首 token 延迟优化：阶段二实施报告

日期：2026-10-01。修改前基线：`bad15b562b954df50020c2effdb3a52cf18fb8b0`。

12:12–12:13 的用户三轮实测和准备消息误显示排队的修复见
[真实复测与第三阶段调整](mission-latency-phase-two-live-retest.md)。暖轮点击到首 token 仍为 7.18/9.78 秒，
阶段二总体性能目标未达成；局部结构和文件基准不能替代这项结论。

## 交付判定

本轮 CR 确认并修复五项问题：旧 Context 读取覆盖新流式用量；首次 Context 未就绪阻塞同批聊天；
Context 单独失败漏显示降级提示；锁获取超时漏记等待耗时；只读 Context 展示查询创建执行 App 并加载 Host 挂载。
Context patch 现在维护自己的真实 revision，缺少完整 Context 时继续应用聊天并独立补读；
锁等待在成功和失败时均记录，业务 operation 耗时不计入锁等待。
Context 展示检查直接使用当前权限模式的 Runtime resolver，不创建执行上下文；执行与压缩路径仍保留原有准备和校验。
新增回归先复现旧用量覆盖、聊天阻塞与超时观测缺失，再验证修复；这些修复不代表端到端性能达标。
CR 验证：Desktop 展示/读取/命令回归 191 项、排队输出集成 6 项、Context 检查与压缩集成 1 项、
Core 锁/诊断 22 项、Execution/Session 事务 31 项、Local Host 控制/队列 8 项通过。
最终 `pnpm check` 和 Desktop 构建通过。

热路径收敛已经实现：一次 Session 控制快照、请求局部 Revision 复用、相同进行中展示读取合并、
Renderer 各种读取独立刷新，以及正常 Execution commit 不重复读取 events/commits。
持久化 Schema 和耐久提交语义保持原有版本。SQLite、Usage/终态 outbox、容量账本和收尾屏障调整未纳入本次。

**第二阶段总体性能目标尚未验收。** 以下文件存储基准不是 Pi/Desktop 端到端首 token 基准。
没有匹配修改前后的冷启动、暖 Mission、暖 Session、收尾期间立即发送等每组 20 次真实样本，
因此不能声明暖 Session 接入额外开销 P95 < 250 ms 已达成，也不能以扣除 settlement 的数字替代验收。

## 实施与边界

- admission 仍按 Mission 串行，不同 Mission 独立；owner/fencing、幂等判断、权限和耐久 Inbox 不绕过。
  apply 内无实际 terminal settlement 等待时复用第一次 Mission 读取；等待后重新读取。
  发送入口的 capacity await 之后重新获取 Mission，不能跨该等待复用可变事实。
- 请求局部 Revision Promise 共享给 Capability 依赖、系统专家依赖与编译，只活到本次准备结束。
  每次接入重新解析 active revision、凭据 fingerprint、当前系统 fingerprint 和 Runtime binding；
  编译 miss 继续保留前后 Capability 稳定性检查。模型、权限、挂载变化仍通过编译身份与 successor 判定处理。
- `ExpertSessionStore.readSnapshot` 一把 aggregate lock 内 prepare 一次，再读 Session、prompts、events。
  Desktop 控制状态与 Local Host 队列投影使用该接口，根 Context 来自同一 Session。
  保留 Execution 终态复查和已响应人工确认过滤；不宣称三个 owner 的跨 owner 原子快照。
- Main singleflight 只保留进行中 Promise，key 包含 Mission、audience、读取种类、query、代次与读取开始水位。
  完成或失败立即移除；失效后的新请求不共享旧水位。控制器关闭/删除撤销旧代次，晚到结果不能安装状态；
  idle 瞬态释放保留耐久展示读取。
- Renderer 历史、control、Context 各自一个 active request 和 dirty 标记，重复触发只安排一次后续读取。
  独立应用、独立降级；不再在历史绘制后无条件重读 control/Context。新 Mission 的 revision 0 基底可直接
  应用 revision 1 开始的连续 patch；gap 仍请求重同步。保留同 revision queue patch 优先与历史分页水位规则。
- 正常 Execution commit 向事务应用传入锁内已读 events/commits。崩溃重放从磁盘读取；
  expectedVersion、event/commit 幂等冲突、sequence、journal/handoff、删除屏障和耐久后发布保持不变。
  **events/commits 仍全量读取、解析和重写**；没有新增逐文本 delta 耐久提交。

## 观测与口径

轻量日志关联既有 requestId、commandId、Execution ID：Renderer send、Main IPC、controller request、
Inbox durable、owner ready、command consuming、admission wait、message accepted、prepare、Runtime dispatch、首 token。
Renderer 日志转发保留 request/navigation ID 及发送/首 token 收到与绘制的源进程 monotonicAtMs/timeOriginMs。IPC receive 的 monotonic 起点在 schema parse 后、
managed Mission 校验前；它不是 Electron 传输开始时间。

准备拆分为 Mission initial read、after settlement read、terminal settlement、readiness、activity、root Context、
Runtime binding、Revision、系统依赖、active Capability 与凭据 fingerprint。尾部记录 Runtime result、事件 drain、
flush、Usage preview/record、final message、Execution terminal commit、Session active binding release、observer settlement。
activity、Usage 和 terminal settlement 等待的语义保留，日志不能当作它们已后台化。

以 `PRAGMA_STORAGE_DIAGNOSTICS=1` 启动 Host 可开启详细存储日志：

```sh
PRAGMA_STORAGE_DIAGNOSTICS=1 pnpm --filter @pragma/desktop dev
```

`storage.operation_measured` 输出 family/owner/operation、requestId（有上游时继承）、spanId/parentSpanId、
monotonic startedAtMs/elapsedMs、failed、reads/writes、readBytes/writtenBytes、parsedEntries 和 phases。
分段包括进程内 lock_local_wait、跨进程 lock_cross_process_wait、prepare/recovery、read、parse、serialize、
state_compute、journal/handoff 写入、write、atomic_replace、controller sync。controller prepare 包含 journal replay。
lock_cross_process_wait 包含锁目录维护和租约发布等获取成本，不是纯竞争等待；锁内业务 operation 不计入该段。
`mission.read_completed` 记录读取种类、audience、总耗时与合并次数。

计数限于已接入诊断的文件 payload 操作和锁/迁移元数据；不包含 stat/readdir/access 等 metadata probe，
不是 OS 级块设备 I/O。reads/writes 为尝试次数，读取字节只计成功返回值，writtenBytes 为尝试写入的 payload；
失败写入不能视为已耐久字节。parsedEntries 为 JSON 顶层条目数，不是唯一业务事件数；同一条目被重复解析会重复计数。
关闭诊断不生成详细存储汇总，避免常态高日志量。

父 span 汇总已经包含子 span，不能再把父子总数相加。prepare/read/parse 等区间嵌套且并发读取可能重叠，
不能相加当作关键路径；结合 span 树和每进程 monotonic 时间判断实际依赖。
已完成请求的 detached 后台操作不会再计入该请求；有独立 store logger 的后台操作按 family 单列。
仍在请求存活期间重叠的工作需沿调用链区分，不用总量推断前台阻塞。

跨 Renderer/Main/Runtime 用关联 ID 串联；monotonic 起点不共用，不能直接相减。Renderer 的 timeOriginMs +
monotonicAtMs 可构造源端事件时间，Main 接收到转发日志的 wall timestamp 不是 Renderer 事件实际发生时刻。
本次未做跨进程时钟校准，跨进程运输/绘制差值包含时钟与日志转发误差，不宣称亚毫秒精度。
新诊断仅记录 ID、阶段、规模和耗时，不记录 prompt、输出、凭据或私人路径。

## 可重复文件存储基准

脚本：`packages/core/scripts/benchmark-mission-storage.ts`。同一硬件、Node 和 workspace 依赖；
每组 5 次预热、20 次计时，分位数采用排序后的 nearest rank。诊断 probe 在计时后另跑一次，不污染分位数。
Execution 为正常单事件 commit 与 cursor read，历史 100/1000 条；Session 为 100/1000 条 prompt/event 的
控制读取（旧实现 get/listPrompts/listEvents，对照新 readSnapshot）。临时存储独立，不使用用户 Mission 数据。
Session 从真实历史 transaction fixture 恢复后扩展当前格式的历史规模，扩展数据只用于负载，不作为迁移 fixture。

硬件：MacBookPro16,1，Intel Core i7-9750H 2.60 GHz，16 GiB RAM；Node v24.18.0。
实测期间未运行本任务的构建或回归套件；已有宿主应用继续运行，未控制整机后台负载。
这是文件存储局部顺序 A/B，不是产品端到端受控 A/B；结果不含模型、thinking、工具、Context 与后台 Memory/Automation。

```sh
pnpm exec turbo run build --filter='@pragma/desktop^...'
PRAGMA_STORAGE_DIAGNOSTICS=0 node --experimental-transform-types packages/core/scripts/benchmark-mission-storage.ts
```

修改前在基线源码的临时 checkout 中执行同一脚本，链接同一安装依赖。需要 Node >=22.7 的 transform-types
或可用的 TypeScript runner。脚本输出 JSON，仅含聚合数字；诊断 probe 的老版本空数组表示无该观测能力，不能解释为零 I/O。

| 操作 / 初始历史条数            | 修改前 P50 / P95 (ms) | 修改后 P50 / P95 (ms) |
| ------------------------------ | --------------------: | --------------------: |
| Execution 单事件 commit / 100  |         30.30 / 32.17 |         31.36 / 34.09 |
| Execution cursor read / 100    |         23.28 / 23.88 |         23.75 / 26.67 |
| Execution 单事件 commit / 1000 |         35.19 / 39.93 |         36.15 / 40.02 |
| Execution cursor read / 1000   |         25.32 / 34.08 |         27.37 / 29.81 |
| Session 控制读取 / 100         |         66.88 / 67.94 |         25.46 / 27.06 |
| Session 控制读取 / 1000        |         71.96 / 75.15 |         31.60 / 35.98 |

Session P95 在这两组分别下降约 60% 与 52%；主要来自三个竞争锁的 prepare 合并为一次。
Execution commit 未显示稳定耗时改善（100 条略慢、1000 条近似相同）；消除重复读不等于净耗时保证。
本次执行顺序为修改后、修改前，整机后台负载未控制，不能对几毫秒差异作因果结论。
修改后 commit 十倍历史的 P95 比值约 1.17，未触发本地这两组的 >2 倍规模门槛；
尚未测真实 Host 关键路径贡献，不能据此决定 SQLite 不必要。

计时后独立诊断 probe（20 次采样及 5 次预热后）：

| family / 初始历史条数 | 读尝试 / 写尝试 | 成功读取 bytes / 尝试写入 bytes | JSON 顶层解析条目 |
| --------------------- | --------------: | ------------------------------: | ----------------: |
| Execution / 100       |          13 / 8 |                   39292 / 40457 |               154 |
| Execution / 1000      |          13 / 8 |                 281420 / 282587 |              1054 |
| Session / 100         |           9 / 1 |                     72199 / 187 |               202 |
| Session / 1000        |           9 / 1 |                    698600 / 187 |              2002 |

上述计数包括锁与 prepare 的元数据读取尝试；Session 的 9 次不是 9 份会话 payload，而是三个文件加恢复检查等。
Session 的一次写入来自既有锁 owner 文件，不是展示读取回写业务状态。Execution probe 历史包含预热/采样新增的 25 条事件。
旧版无诊断计数，不能提供真实修改前 byte/count 对照；每份 event/commit 正常提交仅读一次由物理 readFile spy 回归验证。
聚合原始结果见 [JSON](mission-latency-phase-two-storage.json)。

## 正确性与构建

先重建 workspace 依赖；相关磁盘回归顺序执行。以下测试存在重叠，不合计为互不重复的总数：

| 验证                                                                                 | 结果                                                                         |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Core 锁/诊断/event log/Session transaction/Execution migration/feed/execution-system | 7 文件，198 项通过                                                           |
| 最新 Core diagnostics/event log/Session transaction/event writer                     | 4 文件，37 项通过；追加后台归因边界测试后 diagnostics 单独 3 项通过          |
| Local Host control/owner/controller/prompt queue                                     | 4 文件，62 项通过；快照队列再次 5 项通过；最新 control/prompt queue 8 项通过 |
| Main display 与 Renderer model/独立读取/dirty history                                | 3 文件，59 项通过                                                            |
| Codex/Qoder queued chat 的完整流式刷新                                               | 6 项通过                                                                     |
| Desktop MissionRunner 综合回归                                                       | 78 项通过                                                                    |
| 全仓 `pnpm check`                                                                    | 通过（稳定源码再次复核通过）                                                 |
| `pnpm --filter @pragma/desktop build`                                                | 通过：styles、main 无外部 `@pragma/*`、preload 自包含并注入 Bridge           |

主要复现命令：

```sh
pnpm exec turbo run build --filter='@pragma/desktop^...'
pnpm --filter @pragma/core exec vitest run test/file-lock.test.ts test/storage-diagnostics.test.ts test/execution-event-log.test.ts test/expert-session-transaction-migration.test.ts test/execution-state-migration.test.ts test/canonical-event-feed.test.ts test/execution-system.test.ts --maxWorkers=1
pnpm --filter @pragma/local-host exec vitest run test/mission-control.test.ts test/owner-scope.test.ts test/mission-controller-store.test.ts test/prompt-queue.test.ts --maxWorkers=1
pnpm --filter @pragma/desktop exec vitest run src/main/features/missions/mission-chat-service.test.ts src/renderer/src/pages/missions/mission-background-reads.test.ts src/renderer/src/pages/missions/mission-conversation-model.test.ts --maxWorkers=1
pnpm --filter @pragma/desktop exec vitest run src/test/mission-queued-chat-refresh.test.tsx --maxWorkers=1
pnpm --filter @pragma/desktop exec vitest run src/main/features/missions/mission-runner.test.ts --maxWorkers=1
pnpm check
pnpm --filter @pragma/desktop build
```

新增结构回归实际检查正常 commit 每份历史只读一次、Session 快照的事务交错/历史 journal 恢复/非法事件拒绝、
singleflight 水位/audience/错误/释放隔离、慢 Context 与 control 独立应用、burst dirty 重读、关闭拒绝旧回调和 revision gap。
现有综合回归继续覆盖准备期间接入、successor、Capability/权限/挂载变化、人工确认、取消、队列 steer、
失去 lease、journal/handoff、版本迁移、删除和断尾恢复。

终态交错测试现在先等待新的失效通知，再验证新请求不合并到旧水位的 stalled read；通知前相同请求本来就应合并。
不确定 steer 测试在验证保留状态后显式取消合成夹具中的 unresolved prompt，避免测试清理一直等待释放屏障；
生产屏障未放宽。磁盘密集套件后续顺序执行，避免共享磁盘竞争制造短 deadline 超时。

## 剩余瓶颈和存储决策

本次仍保留 terminal settlement、activity、Usage、capacity gate 与全量 JSON 历史读写。
局部存储基准不解释此前 Pi 三轮中的 8–14 秒 Host 准备与 7–11 秒 Core 尾部，也不提供首 token 改善秒数。
必须用新分段日志在真实 Pi 的短/长历史、并发 Mission、收尾完成后发送、收尾期间立即发送、queue/steer、
人工确认/取消和重启恢复上补齐每组至少 20 次的接入、Host、SDK、首 token、尾部、下一轮、字节与后台 I/O P50/P95。

SQLite 默认门槛：真实关键路径中读取/解析/重放/原子写入占比至少 30% 且 P95 >100 ms，
或十倍历史使普通增量 commit P95 增长超过两倍。按 family 的关键路径贡献排序，接近时 Execution 优先。
这份报告没有提前升级 Schema，也没有定稿转换协议。下一份方案须覆盖 owner、事务、索引/cursor、连接生命周期、
删除协调、真实 fixture、备份、转换 journal、权威切换和崩溃恢复。

## PR #349 评论核对

确认并修复三项问题：idle 释放不再撤销正常耐久展示读取；control 响应以独立 `controlRevision`
拒绝早于已消费 live 更新的结果；control/context reader 复用包含 dirty 后续读取的 Promise，
操作刷新等待 history + control，Context 仍独立。返回值在屏障完成后读取当前聚合快照。

新增回归覆盖 idle 释放与初始导航交错、live patch/invalidate 后旧 control 不覆盖或隐藏条目、
初始历史不阻止 control 水合，以及多个 control 调用者等待同一后续读取。旧的 queue 回归允许
revision 1 控制响应在 revision 2 live 更新后水合，此断言按审查要求改为保留当前快照，并用 revision 2
响应验证成功水合；同 revision queue patch 优先、关闭/删除撤销展示读取规则保留。

此修改仍属于 Desktop MissionRunner 热路径收敛，不代表 Desktop/CLI → Local Host kernel 收敛完成，
也不改变总体性能目标尚未达成的结论。

PR 评论修复验证：展示/读取回归 188 项、Codex/Qoder 排队集成 6 项，以及附带 idle 导航交错的
owner/Runtime 生命周期集成 1 项（同文件其余 77 项未在本次定向执行）。`pnpm check` 通过；
最后补充的刷新导航保护与 stale control 重读再次通过 ESLint 和上述 188 项回归。

Desktop 构建通过，styles、main workspace 打包与 preload Bridge 自包含检查通过。
