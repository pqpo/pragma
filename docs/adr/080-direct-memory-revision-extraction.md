# ADR 080: Revision Agent 直接提炼 Memory 草稿

日期：2026-10-26。对应 #434，阶段 1/3。部分取代 ADR 075 Incremental Memory Learning 中的独立规划与计划交接。

## 决策

新 Knowledge/Skill 学习任务直接运行现有 Revision Agent。来源读取、资产发现、判断、编辑和提交待审草稿共用一个 Mission/ExpertSession；不创建 Planner Mission，不解析模型聊天中的 JSON 计划，也不发送格式纠错或 inspection 续聊。Curator 和两个独立学习调度器保持各自 authority。

Memory 仅声明 `MemoryRevisionExecutor` Host 端口。Built-in Agents 拥有无人值守提示词；Desktop 装配授权读取与既有 Revision 工具。最终草稿继续由既有 Revision 服务拥有，正式发布必须人工批准。模型只选择和编辑；来源身份、资格、读取预算、目标版本、草稿所有权、幂等和提交校验由 Host 执行。

任务专用读取提供来源分页、目标检索、Knowledge 正文及 Skill 文件读取。来源句柄固定到具体 revision；每次调用重新检查当前来源、策略和任务存在性。读取目标后固定其版本，变化需要重新读取。Skill 至少引用一个成功 Episode；新 Knowledge 保留跨 conversation 或成功产物资格。提交后的回执持久化，重复提交复用原回执。

自动执行创建不可变 `system-memory` Mission，编译前禁止托管提问，并拒绝 Runtime 原生问题/审批；该 origin 同时排除自动草稿执行的 Evidence 捕获。交互式 Revision 保留原行为。旧计划交接所创建的 Revision 也使用后台 origin；历史旧 origin 的 Mission 在执行资源层通过其原 Revision job 的 source 恢复无人值守约束。

## 持久状态与恢复

新增 `state/memory-direct-revisions-v1/`，记录 admission、Mission 身份、预算消耗、具体来源句柄、逐草稿回执、结果与幂等 continuation 命令。只保存有界元数据，不复制来源正文。任务/Expert/来源摘要共同确定执行身份。投递前先写意图；未知创建或投递结果禁止重新创建模型会话。只有 Local Host 一次性的未执行准备失败证明允许撤回 admission，随后重试原 Mission。

观察超时排队观察同一 Mission，保持预算。过期 lease 的恢复须有该任务的持久执行索引和原 Mission 所有权证明；缺少证明保持 needs-attention。明确可重试的终态 Runtime 失败沿用现有有界尝试预算；显式重试在原 Native Context 通过 Local Host 的幂等 continuation 恢复未完成工作，不重新生成已提交草稿。待审依赖结算也继续原上下文。结果先持久化；无草稿的 Mission 才可清理，草稿 owner 保留供审批和返工。

观察资格要求任务索引中的执行记录完整，不能用某个 Expert 的已完成回执掩盖另一个缺失的 admission。具体 admission 仍按任务、Expert 和来源摘要查询；已确认的原执行完成后，job 级观察标记不禁止其他 Expert 首次执行。索引或原 owner 缺失时继续禁止自动重投。

自动失败重试同样按具体 Expert/来源确认。job 的 `lastFailure` 不能直接把后续 Expert 的首次执行变成重试：当前 key 明确没有 admission，且原任务完整执行索引可证时，按首次执行处理；否则保留重试标志，由 executor 的缺失 owner 检查拒绝不确定的重投。

删除失败输入撤销其工具授权；闲时按保留任务索引回收无草稿执行元数据和专用 workspace。有草稿的执行保留有界来源/回执 provenance。维护不参与启动扫描。

既有 job、binding、Episode/Fact、草稿及 decision Schema 均未改写，既有迁移链保持。新执行使用独立命名空间；旧数据不被当成新协议。观察恢复仅在存在新命名空间所有权证明时改变调度，不放宽旧未知执行的重放规则。

## 兼容与退役

- 未启动且没有缓存计划/已注册 Planner Mission 的旧任务进入直接 Revision 路径。
- 有持久失败历史证明的显式重试可转入新路径：只有旧 Planner 已终态或不存在时才结算其标记并丢弃旧计划缓存；运行中和未知 owner 不转移。
- 已有缓存计划仍由隔离的旧交接逻辑完成；已注册 Planner 仅观察原执行并读取该 execution 的终态输出，不投递、不纠错，不删除结果未知的 Mission。
- 旧计划交接成功后，先保存业务 decision，再写 `pragma.memory-legacy-plan-settlement/v1` 标记，最后尝试清理 Planner。清理失败不撤销结算，不重新规划。
- 首次访问仍存在的旧 Planner 时，在独立的 `state/memory-legacy-planner-identities-v1/` 原子保存 Mission、提炼种类和来源摘要；历史空注册标记原样保留。已记录身份的 owner 删除后，仅对应来源失败。身份写入中断可由原 Mission 重建，未来版本或身份冲突拒绝读取且保留原文件。
- 已删除且没有任何来源身份的历史空标记无法反推出原任务，不能猜测归属或直接删除。调度器传入任务创建时间及执行历史：创建晚于标记的任务，以及能证明从未尝试的首次 claim，不可能拥有该旧 Mission，可以继续；可能已执行的较早任务仍以 `memory_legacy_revision_owner_missing` 保持关注状态，显式重试也不绕过保护。此保守限制只适用于无法归属的历史任务；它不构成对新学习任务的全局门禁。
- 历史 `KnowledgeLearningPlan`/`SkillLearningPlan`、计划缓存读写和规划专用资源仅服务该兼容路径。新任务不写计划缓存。
- 支持窗口结束，且旧 Planner、缓存计划交接和待审绑定全部结算后，才能移除兼容业务路径；历史 Schema、writer fixture 与支持中的升级链继续保留。未知 owner 或损坏结果不能以自动新建会话代替恢复。

## 验证

覆盖真实 Interpreter 编译后的 Host binding、引用拒绝与同执行修正、目标实际读取和复用、重复提交、原上下文手动重试、预算恢复、未知投递、旧 Planner 只读观察、Native 交互拒绝，以及 Knowledge/Skill 调度观察不重置尝试预算。执行 Revision、Memory、Local Host kernel 和快速门禁；真实 Runtime 记录单独保存验收结论。
