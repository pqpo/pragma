# ADR 034: Conservative Semantic Memory

- Status: Accepted
- Date: 2026-08-03
- Extends: [ADR 031](./031-extensible-memory-plane.md)

## Context

Episodic Memory 回答“过去发生过什么”，不能作为当前真值。Semantic Memory 需要从同一安全 Evidence
独立提炼当前事实，同时处理 subject 身份、重复观察、矛盾、时效、权限和人工更正。模型不能从正文杜撰
User、Project 或 Repository 的稳定 ID，新证据也不能只因置信度较高就静默覆盖冲突事实。

Desktop 当前没有 Repository registry，也没有跨设备账户身份。为 Repository 路径构造临时身份会把代码
仓库错误地变成所有 Agent 任务的前置条件，因此不属于本阶段。

## Decision

`pragma.memory.semantic` 是独立的 dynamic-projection Module，直接消费安全 execution Evidence，不依赖
Episodic Memory 或 Mission Board。每个事实记录 statement、subjectRefs、predicate、normalizedValue、
confidence、时效、Evidence、visibility、binding、冲突和 provenance。

Subject 使用 allowlist：Desktop 为每个普通 Mission Execution 幂等登记安装级 local User 和 Pragma
Project；根 Expert/ExpertTeam/Flow 与 producer Expert 来自 Evidence attribution。Curator 只能选择这组
引用。Repository subject 暂不发现或登记。

同 subject、predicate、normalizedValue 的观察合并 Evidence。对同 subject/predicate 的 exclusive
事实，Curator 可以引用当前 Fact id/revision 声明 replacement；Host 只有在新 Evidence 包含直接 user
消息、subject/predicate 完全一致、值确实变化且 revision CAS 成功时，才使用原 Fact id 创建下一
revision。替换后的当前 revision 只引用新值 Evidence，并清除旧验证状态；旧值保留在历史 revision。
不满足权威条件的不同值仍双向标记 `conflictsWith`，不能只凭更高置信度覆盖。失效、过期和 superseded
投影不进入默认 recall，冲突事实全部暴露并要求核验 Evidence。

Semantic Context 的热点 INDEX 与深度召回分离。`summary.md`、`index.md` 和 federated overview 只使用
当前 binding 的 hot Fact；literal Search 和精确 item Read 仍可访问 archived Fact，并在成功命中后更新
该 binding 的召回时间。List 只枚举分层入口，不枚举 Fact 详情。

治理 mutation 使用 revision CAS。同一 fact id 的更正、验证和失效都生成新的不可变 revision、保留旧
快照并写原子审计；更正不会改写 subject、visibility、sensitivity 或 binding。新事实默认只允许根资产
recall，export 为 deny。

Semantic job 在权威事实事务中写 applied-job 标记。若事实已提交但 job 状态尚未完成，恢复只补齐 job，
不再次调用 Curator。MissionRunner 在 execution 创建或恢复后登记 subject context，不反查或扫描全部
Mission，也不升级 Core Execution 协议。

## Consequences

- Semantic 与 Episodic 可独立失败、重试、诊断和演进；
- 用户直接表达的独占事实变化可以收敛为一个稳定 identity，同时保留完整可审计历史；
- 当前事实具有可解释冲突和完整 revision history，不以自动覆盖换取表面简洁；
- local User 是安装级身份，跨设备账户合并必须由后续显式迁移解决；
- Repository subject、主动排序和管理中心 UI 继续属于后续阶段；
- Renderer 通过类型化 IPC 查询和治理事实。
