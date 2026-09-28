# Mission Memory Attention

Attention 是执行途中维护的只读历史线索，决策与记忆正文分离。架构边界见 [ADR 058](../adr/058-mission-memory-attention.md)。

## 链路

Execution 的持久事件和通用工具结果 → local-host 脱敏增量 → RecallScope → Jev 召回判断 →
Episodic/Semantic 既有 search → 相关性与新颖性判断 → 每批请求前配置/权限/引用重新校验 → 原子 Attention 状态 → 手动 Lens。
原生 Runtime 的工具完成/失败、子 Invocation 完成和 `human.responded` 使用同一通道；托管工具同时可以消费短提示。
相同 toolCallId 去重；同一 Context 的密集事件合并为最新观察；尚未评估的新错误优先保留，避免被紧随其后的普通完成事件覆盖。压缩后的后续观察会重新判断，不主动操控 Runtime 压缩。

## 数据与预算

- State：`state/memory/attention/<encoded mission>/<encoded context>.json`，仅保存引用与决策状态。
- Settings：`data/memory/attention-settings.json`，只保存 SecretRef；实际路径由 PragmaPaths 生成。
- 每个 Lens 最多 8 条、8 KiB；单次脱敏增量最多 4 KiB，HTTP body 最多 24 KiB。
- 最多 3 个 query、8 个新候选；现有项与新项合计最多 16 个判断候选。
- 250 ms debounce、每 Context 最小间隔 5 秒；Host 并发 2，跨进程文件账本每分钟最多 60 请求。
- 召回/新颖性阈值 0.65，激活相关度 0.7，淘汰阈值 0.35；30 分钟半衰期，只在新事件时维护。
- 每次 HTTP 请求超时 3 秒，瞬时故障至多重试一次；连续 3 次失败冷却 60 秒。
- 审计最多 100 项/7 天。状态锁内 CAS；跨进程冲突丢弃过时结果，下次观察可继续。

旧版本读写边界保持不变；新状态与配置严格拒绝未知版本。后续升级需要相邻迁移与真实历史 fixture。
Mission 删除复用 owner journal；恢复窗口内既有 Attention 可继续手动读取。重新绑定 scope 或配置 generation 时重新判断。

## 配置与诊断

Desktop Memory 设置中验证并保存/替换/移除 Jev API Key。CLI 读取同一个 Pragma home，不能写配置。
全局 Memory 禁用或当前资产 recall 禁用时不判断、不暴露 Lens；已有配置可以移除。
401 和不合法响应要求重新配置；临时错误保留可见引用。Memory health 展示稳定错误码，不记录上游错误正文。Attention 配置或状态损坏仅使该可选视图不可用，普通 Memory 和 Execution 继续工作；未来版本仍保持拒绝读取、不改写原数据。

## 验证

控制器测试覆盖 Lens、一次性提示、持久去重、scope 隔离、忘记、衰减、故障、取消、generation 和未来版本拒绝。
Provider 测试检查官方请求体及认证失败；SecretStore 集成测试覆盖加密、CAS、轮换 journal 恢复。
CLI → Desktop 测试通过真实 Canonical Feed 和 Memory job 完成后续提炼；Core 测试确认提示保留原工具结果且观察失败不影响执行。
设置页使用生产组件和隔离 IPC fixture 检查错误、保存、密码清空、移除及正常/焦点状态。
真实 Jev 与真实 Runtime 联调需要用户配置有效 Key；fixture 测试不等同于该联调。
