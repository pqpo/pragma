# 阶段二真实复测与阶段三调整

2026-10-01，Desktop 开发进程 0.2.49，boot `1bde4503-adda-4404-a01e-972252ddfc99`。
采样窗口为北京时间 12:12:30–12:13:30；Mission `baa945eb-646d-4065-a29a-e980f8e07ddf`。
三轮复用同一 ExpertSession、根 Context 和 Pi Runtime Session。两次后续发送时，上轮 Session active binding 已释放，observer 仍在收尾。
本报告检查用户复测日志，未再次调用模型；不是固定后台负载的受控 A/B，也不是 20 次 P50/P95 验收。

## 发送展示修复

Core 接受 foreground prompt 后，调度启动前存在真实的 `queued` 窗口。
控制状态独立刷新更早暴露该窗口；Renderer 原先把所有持久 queued prompt 都移入排队区，
导致当前消息从 loading 移到排队区，启动后又移回聊天。该窗口不能证明有另一条消息在它之前执行。

Renderer 现在用已有 foreground request reservation 区分正在准备的本次发送与后续排队发送。
当前消息保留聊天位置和等待标记，不出现在队列操作区；后续消息仍显示为排队。
初始 Mission 的 initial request 与暖 Mission 的 awaiting request 使用同一规则。
paused 或 delivery uncertain 的权威状态优先，不隐藏暂停或不确定投递。
此修复不修改 Core 状态、持久格式、水位、调度顺序或独立刷新，也不缩短实际等待。

回归覆盖 queued/running 投影下的真实 MissionDetail 排队区、后续消息可见性、准备标记，
以及控制状态单独到达时的消息位置、无本地 reservation、暂停、不确定投递和首输出后释放。

验证结果：Renderer 展示、控制刷新与命令投递 181 项回归通过；Codex/Qoder 排队输出 6 项集成测试通过。
集成测试同时验证 owner 释放拒绝旧历史读取后，重新读取仍正确水合两轮输出。
`pnpm check` 和 Desktop 构建通过，main workspace 打包、preload Bridge 与样式检查通过。
这验证了代码和结构，不代表已重新跑过真实 Pi 延迟验收。

## 实测结果

| 指标                                                           |             首轮 |   第二轮 |   第三轮 |
| -------------------------------------------------------------- | ---------------: | -------: | -------: |
| Main message accepted → model dispatch                         |         10.460 s |  4.331 s |  6.026 s |
| Main message accepted → first UI token painted（转发日志时间） |         11.628 s |  5.480 s |  6.978 s |
| Renderer 点击发送 → first UI token painted（同进程 monotonic） | 缺少首轮发送标记 |  7.184 s |  9.783 s |
| 模型请求耗时                                                   |          1.159 s |  1.100 s |  1.105 s |
| 模型结束 → Execution terminal committed                        |          5.155 s |  6.028 s |  8.374 s |
| Execution terminal committed → Session active released         |          0.394 s |  0.575 s |  0.304 s |
| Execution terminal committed → observer settled                |          4.745 s |  6.527 s |  5.772 s |
| Main message accepted → observer settled                       |         21.519 s | 17.986 s | 21.277 s |

first UI token 包括 reasoning，不保证是回答正文。Main 与 Renderer 差值使用 Main 收到日志的时间，
含跨进程时钟和转发误差；后两轮点击到绘制直接相减 Renderer monotonic。
首轮由创建入口启动，未经过 MissionDetail.send 的标记，不能填造点击到首 token。
首轮 Mission persist 完成到 message accepted 另有约 7.602 s，尚未细分；不能用表中 11.628 s 表示完整创建体验。
terminal committed 与此前报告的 terminal status published 是相邻而非相同边界。

相比当天 08:46–08:48 的参考三轮，accepted→dispatch 从 12.36/8.34/14.20 s 降到 10.46/4.33/6.03 s，
存在方向上的改善。但点击发送仍等待 7–10 秒，不能说第二阶段总体目标达成，不能从三次非受控样本证明稳定收益。
暖 Session 接入额外开销 P95 <250 ms **未达标/未通过统计验收**。

| 轮次   | requestId                            | Execution ID                         |
| ------ | ------------------------------------ | ------------------------------------ |
| 首轮   | ac841b6d-5e18-4157-8fad-44848c6f5157 | cd4a8cee-e467-4685-91c0-01db4528959e |
| 第二轮 | ce856f28-c5fa-4868-bc8f-33ae82040a18 | 67517614-7bdb-4f0e-b98c-170d155a7c30 |
| 第三轮 | 0fa52a92-66ac-464e-b789-051675be00b0 | 7753ead1-c9fd-4df8-a5cb-442fc7fa79dd |

## 可归因的剩余成本

- 第二/三轮 IPC→controller request 约 0.091/0.819 s；controller request→Inbox durable 为
  1.234/1.360 s；Inbox durable→command consuming 为 0.312/0.503 s。
  admission 锁等待约 0.02/0.01 ms，不能将前面的数秒等待归因为 admission 排队。
- executor readiness 为 1.726/1.169 s。当前组合依次检查 Bundle readiness、Project snapshot 和
  Runtime availability；需要拆分这三个来源，保留动态安全与 Runtime 可用性重验。
- capacity check 为 2.062/0.00002/3.011 s。第三轮理由为 `expired_snapshot`，快照年龄约 36.078 s，
  不是冷启动；扫描与上一轮 observer 收尾重叠，不能把两者相加。
  存储规模约 1.08 GB，其中 state 约 1.04 GB。容量扫描必须进入暖路径优化优先项。
- 暖轮编译约 0.06/0.01 ms，Runtime acquire 约 0.33/0.29 ms；重复优化缓存命中后的操作收益极小。
  compilation identity 约 0.117 s，root Context read 约 0.041/0.063 s，activity 通知约 1 ms。
- 首 UI token received→painted 为约 40/50/34 ms。本次没有出现早期样本首轮 3.88 s 的绘制间隔，
  主要可见等待发生在 token 到达之前；仍不能仅凭三次日志归因 renderer CPU 或证明稳定绘制收益。
- 首轮 Runtime acquisition 3.729 s，其中 Context preparation 2.469 s，原生 Pi session 创建约 0.243 s。
  还需要分解 Context preparation，不能把这段全部解释成 Pi SDK 启动。
- event pump drain 为 1.688/0.962/1.291 s，其内部 event writer flush 是同一个等待的一部分，不能重复相加。
  Usage preview drain 为 0.473/0.294/2.717 s，Usage record and commit 为 0.964/2.267/1.619 s。
  Usage 两段合计 1.437/2.561/4.335 s，仍需区分账本落盘、Execution commit、排队及外部投递。
- 本 Mission 两次 canonical Execution 展示读取超时（250 ms）。同一 boot 还有其他 Mission 的降级读取，
  只能确认存在并行背景活动，不能据此认定其造成此 Mission 的延迟。
- 本 boot 没有 `storage.operation_measured`。因此不能填写本次读写字节、跨进程锁等待、解析贡献，
  也不能判断 JSON/SQLite 是这些秒级开销的唯一原因。

## 第三阶段调整

第三阶段同时负责接入和收尾，不能只优化 Usage outbox：

1. 优先补齐 Inbox/controller 同锁内恢复、读取、提交与 handoff 的诊断，和 readiness 三个子段。
   首轮创建后自动 run 的 IPC 进入和准备前等待也须补齐，不保留 7.602 s 的盲区。
   固定真实历史规模，开启详细存储诊断；从点击到 dispatch 全程计入验收，禁止从 accepted 起点隐藏接入成本。
2. 容量账本提前：暖请求也会因短 TTL 触发全树扫描。使用可靠快照和事务增量/预留；
   reconciliation 修复漂移，保留硬上限和失败回滚，不用延长 TTL 代替账本正确性。
3. Usage 必要耐久接收与账本/产品投影消费分离，以权威提交原子关联的 outbox 承接投递。
   event flush、最终消息、Invocation 和 Context 的必要事实仍必须完成。event commit 的真实负载成本另做诊断。
4. 分开 Session settled、Runtime 可复用、Mission 投影和 observer 完成的屏障。
   下一轮仅等待必要事实；旧 observer 按 Execution ID 条件更新，防止覆盖新轮次。
   第二轮 settlement 实际只等 0.407 s，第三轮没有单独等待：不能承诺移除它就消除本次 7–10 s。
5. SQLite 专项仍按既定门槛决定，先取得真实历史与存储诊断。
   Inbox/controller 也需要纳入 family 排序，贡献接近仍优先 Execution。
   100/1000 条局部 benchmark 无法代表本次 1 GB state 与后台活动，不足以排除或确认转换必要性。

复现时重建同一版本，固定模型、thinking、工具、Context、日志等级与后台负载，每场景至少 20 次。
以 `PRAGMA_STORAGE_DIAGNOSTICS=1` 启动 Desktop，按上表 request/Execution ID 串联日志，分别统计
冷、暖、上轮完全收尾后、收尾期间发送、容量快照有效与过期。记录 monotonic 和读写汇总，
不合并嵌套区间，不记录内容或私人路径。阶段二结构收敛与总体性能目标分别报告。
