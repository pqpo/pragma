# ADR 058: Mission Memory Attention

- Status: Accepted
- Partially superseded by: [ADR 061](./061-memory-vector-retrieval-and-task-attention.md)，候选检索、预算、Lens 和状态升级以 ADR 061 为准。
- Date: 2026-09-28
- Supersedes in part: [ADR 035](./035-agent-driven-memory-recall-and-governance.md)
- Related: [Issue #319](https://github.com/pqpo/pragma/issues/319)、[ADR 042](./042-local-host-and-cli-boundary.md)

## Context

仅在开场加载导航会遗漏执行途中出现的新错误、观察与子任务结果。需要随着任务变化发现相关历史，
同时保持系统提示词和工具定义稳定，避免向用户对话插入消息或中断正在运行的模型。
Desktop 与 CLI 必须使用相同的 Memory 数据、授权和待提取任务，Desktop 负责配置与模型提炼。

## Decision

`@pragma/memory` 拥有通用 `MemoryAttentionController`、`MemoryDecisionProvider`、有界状态与手动 Lens。
Jev 是可替换 Provider，使用 TypeSafe 官方 System One API，仅输出相关性、召回和变化判断。
Host 组合 Episodic/Semantic 文字与向量检索，具体 generation 和迭代判断见 ADR 061；Knowledge、Skill 不进入 Attention。

`@pragma/local-host` 统一数据管线、安装级主体、RecallScope、凭据与执行事件适配。Desktop 注入学习端口和
后台提炼能力；CLI 只捕获 Evidence、提交待提取任务、读取已有记忆与 Attention。CLI 不运行提炼模型或 daemon，
也不提供配置写入命令。Core 仅提供通用的工具结果观察与短提示回调，不依赖 Memory。

显式配置 Jev Key 后，Host 可以从有界任务增量派生 query，在当前 RecallScope 内筛选并排序候选。
该决策仅更新 `memory/mission-attention.md` 手动 Context；guide、overview 与系统提示词不包含动态条目。
显著变化在下一次普通托管工具结果中提示一次，读取后或已经提示的版本不重复提示。没有 Key 时不请求 Provider。

状态按 Mission 与 Runtime Context 隔离，并绑定 root、当前 Expert、principal scope digest 和配置 generation。
每次发送摘要、提交结果和读取 Lens 都复用现有 RecallScope 与模块读取权限；restricted 内容不发送给 Jev。
忘记、失效、修订或权限变化立即使引用不可读取。Mission 停止先取消并等待判断，再执行 owner 删除事务；
Attention 目录进入既有 Mission 删除 journal，不另建删除流程。

Key 通过现有加密 SecretStore 保存，设置文件只存 SecretRef。轮换先验证，再以文件锁、稳定 journal 与原子替换
提交配置；恢复重放会清理旧 Key。停用与轮换阻止旧 generation 发布。审计只保存 digest、引用、时间与稳定错误码，
不保存任务文本、query、摘要、Key 或上游响应。

网络/限流失败保留已有有效 Attention，短期退避后可重试；认证或响应协议错误保持 needs_attention，直到重新配置。
故障归入 Memory degraded，不阻断工具执行。原 v1 状态通过有备份和 journal 的相邻迁移升级到 v2，版本边界见 ADR 061。

## Consequences

- Agent 仍通过通用 ContextStore 自主读取和核验，Attention 提供可见的历史线索。
- Desktop 关闭时，CLI 产生的提炼任务保留，后续 Desktop 可以继续消费。
- 脱敏并有界的观察与许可内摘要会发送至 TypeSafe；界面说明这一行为，Key 配置代表启用。
- 多 Context 的本地判断不会互相污染；团队成员按原权限读取历史。
- 候选池和迭代判断有固定预算；原有手动检索与只读 Context 路径继续有效。

实现、预算及验证见 [Memory Attention 架构](../architecture/memory-attention.md)。
