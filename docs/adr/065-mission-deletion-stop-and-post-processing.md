# ADR 065: Mission 删除的停止确认与持久后处理

Status: Accepted

Date: 2026-10-01

## 问题

Mission 删除原先串行等待取消、Runtime close、observer、Usage、Memory 和修订清理。
非必要服务延迟会成为用户删除延迟，服务失败也会把已完成的删除误报为失败。
每个 owner 锁的磁盘同步、每次 rename 重写完整 journal，让历史 Execution 数量扩大存储开销。
最新 main 已修复删除 barrier 的递归锁问题，本改动复用该实现，并进一步固定批量锁顺序。

## 决策

前台冻结入口，保存准备记录，确认本进程持有的 Runtime 停止，并定向核对清单中所有 owner 的
Runtime catalog 状态，再提交 owner 文件与 ownership
catalog 删除事务。Runtime 停止使用统一 15 秒预算；未确认停止时保留文件和准备记录，返回
`MISSION_DELETE_RUNTIME_STOP_UNCONFIRMED`，继续隔离新提交，允许停止完成后重试。
`ExpertSession.freezeForDeletion()` 在收集清单前封闭派发；停止确认后重新核对清单，覆盖已受理
但仍在创建 Execution 的 turn。删除专用停止仅等待原生 Runtime，完整资源和 observer 收尾进入后台。
额外 Runtime 尚未确认停止时同样保留文件，确认后允许重试；Native 停止与后台 hook 清理错误
分别记录，不将 hook 失败解释为进程继续运行。Flow 与 ExpertSession 都提供后台资源收尾入口；正在 opening 或 invalidation 的 Runtime 同样纳入停止确认。

批量删除按 Mission、Attention owner、批量协调锁、ExpertSession、canonical delivery、Execution、
catalog 的顺序获取必要锁。每类独立 owner 锁并行获取；批量协调锁防止两个删除持有相反子集。
Memory 提炼的最终存储提交共用批量协调和 Execution 锁，长时间模型调用在锁外完成。
锁元数据是进程租约，采用关闭文件后原子发布目录，无需为每把租约执行 fsync；业务 journal 的
持久化机制不变。完整删除源清单先写入既有 journal，文件分批移动；恢复检查每个源和目标，
覆盖 rename 完成而进度尚未保存的崩溃，不在每次 rename 后重写整个清单。

`@pragma/local-host` 拥有 `pragma.mission-deletion/v1` 持久记录和后台服务，Desktop 注入五个端口：
Usage 补账、Memory transient 清理、DSL 草稿丢弃、修订 claim 释放、投递与 observer 收尾。
两个 worker 执行独立步骤，失败按 1、5、30、60 秒退避。超时回调收到 AbortSignal；不响应取消的
回调继续持有步骤的跨进程租约，防止另一 worker 重复进入，其他步骤可以继续。关闭不等待后台工作。
手动执行与定时执行共用一次 batch，进度更新与外部服务调用不共持有任务记录锁。

使用独立 `pragma.owner-deletion/v1` 标记隔离 Execution、ExpertSession 和 Mission Attention。
Core、Memory、Mission 和 DSL 最终提交均在对应存储锁内重新检查隔离。已删除 Mission ID 的
create 和重复 delete 不得重新创建目录。Usage 补账读取 trash Execution，沿用 observation ID；
Local Host Usage 提供显式批量 reconcile，保留正常运行 record 的后台投递行为。
长期 Episode/Fact 保留，晚到的提炼结果不得提交。垃圾保留仍为七天、300 MiB、十项，先达到者
淘汰，不为 Usage 延长。来源缺失记为 `MISSION_DELETE_USAGE_SOURCE_EXPIRED`，其他步骤继续。

## 恢复、协议和诊断

新记录通过 PragmaPaths 管理，使用独立命名空间和 Zod 严格校验；未知未来版本拒绝并保留诊断。
既有 Mission、Execution、ExpertSession、Runtime Context、Runtime Session、Core 删除 journal、
DSL commit/discard 和 claim release journal 的 Schema/version 不变，不进行兼容性 cutover。
准备记录通过关联 Core journal 确认事务提交后才执行后处理；准备记录没有 journal 时保持准备状态。
已持久确认 committed 的任务独立继续，不因回收站 journal 淘汰停止；进度未变化时不重复写盘。
文件已移动且 catalog 已提交后的 Host 进度失败以已提交错误分类，前台仍成功，worker 定向恢复。
重启只枚举删除任务，不扫描 Mission 或 Project。首次窗口创建后启动 worker。

DSL 未发布审批若被删除隔离拒绝，可撤销 initiated journal 并进入 discard；已经发布的结果继续
保存成功回执，不回滚 Project。删除隔离后的 restart 恢复不得创建 replacement draft。
完成任务移到 completed 子目录并清空 payload；保留紧凑 tombstone，worker 不反复扫描历史完成记录。
日志分别记录冻结、停止、清单、锁等待、文件移动、catalog 提交和后台步骤耗时。

## 验证

回归覆盖重复删除、晚到写入、跨进程 Execution fence、Session/delivery 锁顺序、opening/invalidation
停止、停止超时与重试、Host 通知失败、rename 未记进度、两个 worker、过期来源与未来版本。
测试与本机测量结果见 [验证记录](../architecture/mission-deletion-validation.md)。
