# 首 token 延迟优化第三阶段实施报告

日期：2026-10-01。架构决策见 [ADR 064](../adr/064-mission-durable-delivery-and-capacity-accounting.md)。

## 2026-10-01 页面加载回归与止损

真实 Desktop 反馈：12 条聊天记录加载约 31.2 秒，Mission activity 两个读取源超过 250 ms。
运行主进程采样 CPU 接近 100%，大量时间位于 stat 回调和同步 SQLite 查询。
只读检查实际容量账本约 12,515 条路径；计量的 `substr(path, ...)` 子树查询触发全表扫描，
同一查询 100 次平均约 8.64 ms，索引范围查询约 0.023 ms。这是局部查询证据，不是页面恢复结果。
文件锁的创建、写入、移动与删除均经过全局计量，读取路径也因此承担新增写入与查询成本。

Desktop 与 Local Host 已撤下增量容量账本接入，保留原有按需容量门禁；移除新增的 Desktop 启动容量校准。
随后按用户要求彻底回滚容量计量：恢复全部生产文件系统 import，删除 adapter、账本实现、
Runtime 钩子及相关测试/基准脚本。已有容量数据库不删除、不再读取；Mission/Usage 投递数据库继续保留。
索引修复实验不作为保留实现。同步容量扫描/清理门禁随后也已从 Mission、Local Host、Project 与插件写入入口移除。
后台统计仅在启动至少五分钟、系统空闲至少五分钟且无保留 Mission Session 时进行，每六小时最多一次。
一分钟活动检查只读取 OS/内存状态，不访问存储。扫描在独立 worker 内按目录项限速，用户恢复操作或退出时取消，
单次最多十分钟。超限只记录手动清理建议，不阻止发送；CLI 不启动容量轮询，手动设置清理仍保留。
回滚后的文件锁、原有容量检查与存储诊断 33 项测试，以及 controller/Usage/lifetime 48 项测试通过。
同步门禁移除后的验证包括：Core 清理 9 项、Desktop 闲时统计 5 项（含真实编译 worker）、
Mission 创建 4 项、Local Host 读取/应用 6 项，以及 Mission 队列、时间记录和压缩专项。
额外用逻辑大小 7 GiB 的稀疏文件验证 Mission 启动与后续发送不因旧配额阻断、不自动删除文件。
应用重启加载修复后仍需实际复测 Mission 和工作室页面，当前不能宣称端到端恢复。

第三阶段当前保留接入读取复用、Usage 耐久源事件、有限的 Host 投递队列，以及接入与产品收尾屏障分离。
Execution、ExpertSession 与 controller 的 JSON 存储引擎仍保留；替换它们属于后续独立工程。
**当前局部基准不能证明 Pi/Desktop 首 token 的端到端目标已经达成。**

## 已实现的路径

- 创建前使用 requestId 关联 Home 点击、Main 创建 IPC、创建分段、耐久 Mission ID 和 Renderer 返回。
  controller 恢复按 journal 家族记录阶段；正常 append 复用锁内 state/command 读取。
- Bundle readiness 在一次请求内复用 Project snapshot 和 Runtime availability，并记录这三个读取阶段。
  每轮继续验证当前配置，不保留跨轮 readiness 缓存。
- Runtime Usage 与 Invocation 用量在一个 Core commit 中提交。Desktop 预览直接发布，最终归属读取与入账由源事件消费者完成。
  CLI 通过 durable receipt 接收相同源事实；退出前只在最后一个 Mission 释放后 drain。
- Mission 投递将 Usage、terminal、metadata、Memory、history 和 archive 分别持久化。
  Feed cursor 与任务接收原子提交；事务内旧水位检查处理竞争消费。一个 Memory 故障不会阻断历史和归档。
  archive 等待 history，任务有 claim/heartbeat/retry，非法事实保留 `needs_attention` 和稳定错误码。
- Mission 注册可以晚于 Core 事实；未关联任务保留，owner/request 冲突拒绝。
  Mission 删除先从所属 Execution 事实补齐账本，再设置 tombstone、等待该 owner 已运行投递和清除产品任务。
- admissionReady 等待 Session turn 释放和旧 observer 解绑。成功/失败的历史补全后台处理；取消仍保留必要可见输出快照。
  Human checkpoint 保留 waiting 语义；Memory 先解绑旧 generation，再在接入锁外等待取消完成。
- Health 页面展示 Host 投递模块、pending 和稳定错误码。打开 owner 可唤醒待重试任务；配置修复后的消费无需重跑原模型请求。
  完全非法的任务保留等待诊断，不自动丢弃。关闭等待最多五秒，剩余源事实与 claim 在重启后恢复。

## 已撤回方案的历史容量基准

以下是撤回前的局部实验记录，相关基准脚本已随计量实现删除，不代表当前产品路径。

同一临时 storage root，文件在启用 watcher 前写入，每个文件 512 bytes。先完成初始校准，丢弃三次预热，
再交替运行全量检查与账本检查，每组 20 个样本。计量覆盖完整目录读取；不包含模型、Renderer、
Core commit 的 adapter 成本或并发原生写入。数据量一致性由每次 dataBytes 比较验证。

| 历史文件数 | 初始校准  | 全量 P50  | 全量 P95  | 账本暖态 P50 | 账本暖态 P95 |
| ---------- | --------- | --------- | --------- | ------------ | ------------ |
| 1,000      | 65.83 ms  | 31.68 ms  | 38.59 ms  | 0.24 ms      | 0.30 ms      |
| 5,000      | 242.02 ms | 149.18 ms | 173.73 ms | 0.22 ms      | 0.28 ms      |

这验证了历史文件数增长时暖容量查询的局部收益。首次校准仍有扫描成本；实际用户目录的 SQLite/WAL、
原生 Runtime 文件和并发 I/O 会改变结果，不能用这张表推算首 token 总延迟。

还单独测量了容量 adapter 的写入代价：同样 1,000 条历史 Execution events，丢弃三次预热、每组 20 次 JSON commit。
未启用账本时 commit P50/P95 为 **35.46/38.30 ms**；启用并合并原子替换预留后为 **52.69/60.02 ms**。
这项附加成本仍存在，不能只引用容量查询收益而忽略写入成本。每文件原子替换合并计量已将此前约 81.59 ms
的 metered commit P50 降至约 52.69 ms，但这两次测量也不是固定宿主负载的严格 A/B。

## 验证与剩余验收

新增回归覆盖原子 Usage 事实、计量失败/硬链接/Trash/并发写入、source 先于 association、竞争消费旧页、
重启重试、未来协议拒绝、Memory 故障隔离和 owner 删除。Local Host 用真实 Feed 和 receipt 数据库验证
账本写入失败后 cursor 已取得 custody，而 observation 在重启修复后仍只入账一次。

已通过全仓库 `pnpm lint`、`pnpm typecheck`、`pnpm test:core`、Runtime feature 与 DSL version 检查，
以及 Desktop production build 的样式、main 与 preload 校验。专项回归包括 Desktop 投递/observer/Memory/Home/health 61 项、
队列/取消/人工等待/idle 11 项、Local Host controller/Usage/lifetime、Core 原子 Usage 与存储计量。
容量专项 13 项通过，覆盖文件符号链接、已打开文件移动、共享 guard 引用、原子写入作用域、dereference 复制和未来协议拒绝。
Local Host controller/Usage/lifetime 专项 48 项通过。

端到端验收仍需固定 Pi 模型、配置、权限、文件规模和观测口径，分别采集
冷创建、暖 Mission、暖 Session、收尾期间立即发送及排队转下一轮的修改前后每组 20 次样本。
必须同时核对 model dispatch、Core terminal、Session release、first UI token received/painted 和最终投递完成。
本次没有启动用户的真实 Desktop/模型会话，因此不声称暖 Session 接入 P95 小于 250 ms 或首 token 达标。
