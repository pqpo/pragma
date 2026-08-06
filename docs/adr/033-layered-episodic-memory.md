# ADR 033: Layered Episodic Memory and Memory Curator

- Status: Accepted
- Date: 2026-08-01
- Extends: [ADR 031](./031-extensible-memory-plane.md)

## Context

长期记忆不能把完整记录全部注入 Runtime。Codex 的本地记忆将摘要、持久条目、近期输入、支持证据和
后台任务分开；旧 `@pragma/plugin-memory` 也通过 `summary.md` 提供常驻导航，但没有把分层能力定义成
所有 Memory type 的公共协议，条目增长后还会扩大启动 Context Index。

Episodic 提炼需要模型，但模型失败不能阻塞 canonical feed checkpoint，也不能为后台任务绕过正常
ExpertSession、Runtime ownership 和 Usage 统计。

## Decision

每个可召回 Memory Module 必须实现四层 Context projection：

1. 全局使用提示 `memory/guide.md`；
2. 类型摘要与热点索引，由 `memory/overview.md` 在统一预算内合成，同时保留
   `<type>/summary.md` 与 `<type>/index.md`；
3. `<type>/items/<id>.md` 详情；
4. `<type>/evidence/<id>.md` 安全 Evidence 与 provenance。

启动时只预加载最多 2KB guide 和 6KB overview。各 Module 获得最小公平配额；超预算只截断热点索引。
`listContext` 不枚举所有详情，普通搜索不返回 Evidence，模型根据详情中的精确引用按需核验 Evidence。
INDEX 只包含当前 binding 的 hot Episode，并受 4 KiB 硬预算约束。低价值、长期未更新或未召回的 Episode
进入 archived 层，不再出现在 summary/index/overview，但仍可通过 literal Search 或精确 item Read 深度
召回；成功 Search/Read 会参与下一次热点评分。

Episodic Module 是该协议的首个生产实现。feed consumer 只聚合封闭的安全 Evidence v2 并持久入队，
随后推进 checkpoint；Module 后台 worker 独立调用 Host 注入的 extractor。一个根 Execution 对应一个
确定性 Episode，重复终态幂等，新的终态增加同一 Episode revision。
Episode 同时记录触发提炼的 terminal message；若进程在 Episode 提交后、Job 完成前崩溃，恢复只补齐
Job 状态，不重复调用模型或增加 revision。

每条 Evidence 显式记录稳定的 `rootRef` 和 `producerRefs`。Episode 的逻辑 owner 只取根 Execution asset：
独立 Expert Execution 归该 Expert，ExpertTeam Execution 归该 Team，Flow Execution 归该 Flow。producer
Expert 只保留为 provenance，不因参与 Team/Flow Execution 自动获得个人 Episode，也不把 Team/Flow
履历错误写成某个成员自己的履历。同一 Execution 的全部 Evidence 必须解析为同一个 root；缺失或冲突
时提炼 fail closed，并保留为可诊断后台任务。

Memory Module 的物理 Store 仍按类型共享，但 Context provider 必须绑定 `MemoryRecallScope`。运行时用根
Execution asset 和当前实际 Expert 组成逻辑读取视图：独立 Expert 只读取自己的 Store；Team/Flow 中的
Expert 读取“当前 Team/Flow Store + 自己的个人 Store”。其他专家、Team 或 Flow 的 Episode 不可见。
授权过滤必须在 Store 查询阶段完成，并一致覆盖 list、search、详情和 Evidence 精确读取；缺少稳定作用域
时不返回目录，并拒绝 read/search。不能靠猜测详情或 Evidence ID 绕过该边界。
同一 Episode 的 restricted Evidence 若没有共同 authorized principal，则在调用 extractor 前以 policy
reason 完成拒绝，不能降级成 `host-private`、扩大可见性，也不进入无意义的重试或 needs-attention。

Desktop 通过隐藏系统 Expert `expert:0000000000mem0ry` 运行 extractor。每个任务使用新的内部 Mission，
Mission v6 以 `origin: system-memory` 标记并从普通列表排除，但仍沿用标准 Runtime、Execution、Usage
和 ownership 链路。Evidence adapter 无条件排除 Memory Curator 作为 root Expert 的事件，避免递归记忆。

模型配置属于 Memory Settings，使用 `inherit-default` 或固定 Runtime/provider/model 的版本化 CAS
profile，不读取环境变量。配置变化唤醒 `needs_attention` 任务。

## Consequences

- 新 Memory type 必须提供摘要、索引、详情和证据层，不能把完整 Store 直接映射到启动 Context。
- Evidence、详情和索引可采用不同物理结构，但必须保留稳定 ID 和 revision。
- Episodic projection 在 capture 开启时生成；`learning` 只控制 Knowledge/Skill 候选。
- per-asset Store 是共享物理 Store 上的授权逻辑视图，不为每个资产创建数据库或目录孤岛。
- Memory Curator 无工具、无 Memory recall，且不出现在普通 Mission 或执行器目录。
- Agent 驱动召回和管理中心由 [ADR 035](./035-agent-driven-memory-recall-and-governance.md) 补齐；分享和
  跨设备同步仍由后续阶段实现。Host 主动召回排序不再是目标架构。
