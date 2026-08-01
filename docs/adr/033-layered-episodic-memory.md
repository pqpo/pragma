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

Episodic Module 是该协议的首个生产实现。feed consumer 只聚合封闭的安全 Evidence v2 并持久入队，
随后推进 checkpoint；Module 后台 worker 独立调用 Host 注入的 extractor。一个根 Execution 对应一个
确定性 Episode，重复终态幂等，新的终态增加同一 Episode revision。
Episode 同时记录触发提炼的 terminal message；若进程在 Episode 提交后、Job 完成前崩溃，恢复只补齐
Job 状态，不重复调用模型或增加 revision。

Desktop 通过隐藏系统 Expert `expert:0000000000memory` 运行 extractor。每个任务使用新的内部 Mission，
Mission v6 以 `origin: system-memory` 标记并从普通列表排除，但仍沿用标准 Runtime、Execution、Usage
和 ownership 链路。Evidence adapter 无条件排除 Memory Curator 作为 root Expert 的事件，避免递归记忆。

模型配置属于 Memory Settings，使用 `inherit-default` 或固定 Runtime/provider/model 的版本化 CAS
profile，不读取环境变量。配置变化唤醒 `needs_attention` 任务。

## Consequences

- 新 Memory type 必须提供摘要、索引、详情和证据层，不能把完整 Store 直接映射到启动 Context。
- Evidence、详情和索引可采用不同物理结构，但必须保留稳定 ID 和 revision。
- Episodic projection 在 capture 开启时生成；`learning` 只控制 Knowledge/Skill 候选。
- Memory Curator 无工具、无 Memory recall，且不出现在普通 Mission 或执行器目录。
- 主动召回排序、管理中心、分享和跨设备同步仍由后续阶段实现。
