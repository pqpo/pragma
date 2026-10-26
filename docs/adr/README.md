# 架构决策索引

本目录保留仍有有效范围的决策。先读[当前架构](../architecture/current-architecture-overview.md)和[模块边界](../architecture/module-boundaries.md)，再读主题 ADR。
ADR 是有时间和范围的决策记录；版本、路径和支持范围以权威源码及当前专题规范为准。部分取代的记录在文件头声明后继，不把历史实现当作新功能要求。

## 基础执行与 Host

- [ADR 001: Monorepo and Dependency Rules](001-monorepo-and-dependency-rules.md)
- [ADR 006: Runtime Session ownership and leases](006-runtime-session-ownership-and-leases.md)
- [ADR 007: Execution Canonical Event Log](007-execution-canonical-event-log.md)
- [ADR 008: Process-shared Execution MCP Gateway](008-process-shared-execution-mcp-gateway.md)
- [ADR 014: Desktop Home Mission Entry and System Experts](014-desktop-home-mission-entry-and-system-experts.md)
- [ADR 015: Pragma as the Default General-Purpose Agent](015-pragma-default-general-purpose-agent.md)
- [ADR 017: Flow 并行范式必须建立在持久化 Fork/Join 协议上](017-flow-parallelism-requires-fork-join.md)
- [ADR 021: Unified Diagnostic Logging](021-unified-diagnostic-logging.md)
- [ADR 025: Host-owned token usage accounting](025-host-owned-token-usage-accounting.md)
- [ADR 041: Runtime Feature Framework and Conformance Evidence](041-runtime-feature-framework.md)
- [ADR 042: Local Host application layer and CLI boundary](042-local-host-and-cli-boundary.md)
- [ADR 043: Context-addressed Expert collaboration](043-context-addressed-expert-collaboration.md)
- [ADR 043: Mission controller lease, fencing, and durable command inbox](043-mission-controller-lease-and-command-inbox.md)
- [ADR 047: Durable Mission command receipts and owner lifecycle](047-durable-mission-command-receipts.md)
- [ADR 062: Long-running Mission heartbeats and ownership fencing](062-long-running-mission-heartbeats.md)
- [ADR 063: Idle Mission resource release](063-idle-mission-resource-release.md)
- [ADR 077: Mission execution dependency snapshots](077-mission-execution-dependency-snapshots.md)
- [ADR 078: Expert-owned native Harness permission modes](078-expert-native-harness-permissions.md)
- [ADR 079: Full-access MCP approval defaults](079-full-access-mcp-approval-defaults.md)
- [ADR 080: Expert lifecycle actions without approval](080-expert-lifecycle-without-approval.md)
- [ADR 064: Mission durable delivery](064-mission-durable-delivery-and-capacity-accounting.md)
- [ADR 065: Incremental Host-owned Execution storage](065-incremental-execution-storage.md)
- [ADR 065: Mission 删除的停止确认与持久后处理](065-mission-deletion-stop-and-post-processing.md)
- [ADR 066: Unified Local Host Mission application](066-unified-local-host-mission-application.md)
- [ADR 067：Execution 管理 CLI 与内置 Skill](067-execution-management-cli-and-built-in-skills.md)
- [ADR 076：正式技能与知识库的 Agent 查询入口](076-managed-resource-cli-queries.md)
- [ADR 068: Desktop bundled CLI and terminal registration](068-desktop-bundled-cli-and-terminal-registration.md)
- [ADR 069: Built-in Revision Agent Context Continuation](069-built-in-revision-agent-context-continuation.md)
- [ADR 071：CLI 查询语义、精简视图与有限等待](071-agent-friendly-cli-queries-and-owner-waiting.md)

## 资源、DSL、部署与分发

- [ADR 004: Desktop Capability Library](004-desktop-capability-library.md)
- [ADR 011: Mission Manifest and Durable Timeline](011-mission-manifest-and-file-timeline.md)
- [ADR 012: Desktop Plugin Catalog and DSL Resolution](012-desktop-plugin-catalog-and-dsl-resolution.md)
- [ADR 020: Automation Integrations and Trigger Adapters](020-automation-integrations-and-trigger-adapters.md)
- [ADR 022: Resource-Scoped Project Change Sets](022-resource-scoped-project-change-sets.md)
- [ADR 023: Semantic Resource Identity and Project Revisions](023-semantic-resource-identity-and-project-revisions.md)
- [ADR 024: Interpreter-Owned DSL Migrations](024-interpreter-owned-dsl-migrations.md)
- [ADR 028: Independent Evaluation resources](028-independent-evaluation-resources.md)
- [ADR 029: Interpreter compiler compatibility and scoped execution validation](029-interpreter-compiler-compatibility-and-scoped-validation.md)
- [ADR 030: Desktop-bound resource identity and Capability activation](030-desktop-bound-resource-identity-and-capability-revision-propagation.md)
- [ADR 031: Interpreter-owned `.pragma` bundle protocol](031-interpreter-owned-pragma-bundle-protocol.md)
- [ADR 040: DSL-defined Built-in Agents package](040-dsl-defined-built-in-agents-package.md)
- [ADR 044: Sparse Context Store Revision Drafts](044-sparse-context-store-revision-drafts.md)
- [ADR 046: 轻量 Git Bundle Source 与工作室广场](046-lightweight-git-bundle-source.md)
- [ADR 048: 知识库成为一级 Bundle 资产](048-first-class-knowledge-base-bundles.md)
- [ADR 050: Desktop 直接发布 Bundle Source](050-desktop-bundle-source-publication.md)
- [ADR 051: Raw Skill revision drafts](051-raw-skill-revision-drafts.md)
- [ADR 052: Synchronous Skill validation and manual review](052-synchronous-skill-validation.md)
- [ADR 054: Localized Bundle asset identity](054-localized-bundle-asset-identity.md)
- [ADR 055: Mission-owned DSL file drafts](055-mission-owned-dsl-file-drafts.md)
- [ADR 056: First-class Skill Bundles](056-first-class-skill-bundles.md)
- [ADR 075: Shared deployment and environment services](075-shared-deployment-and-environments.md)

## 存储、升级与 Runtime

- [ADR 015: PI Model Provider Compatibility Profiles](015-pi-model-provider-compatibility-profiles.md)
- [ADR 016: Local Storage Lifecycle and Content Addressing](016-local-storage-lifecycle-and-content-addressing.md)
- [ADR 019: Versioned Persistent State Migrations](019-versioned-persistent-state-migrations.md)
- [ADR 020: Host-Coordinated Persistent State Upgrades](020-host-coordinated-persistent-state-upgrades.md)
- [ADR 026: Codex minimal Home projection](026-codex-minimal-home-projection.md)
- [ADR 027: Mission latency cache and Runtime warmup boundaries](027-mission-latency-cache-and-runtime-warmup.md)
- [ADR 028: Host-scoped MCP connections and Runtime tool projections](028-host-scoped-mcp-connections-and-tool-projections.md)
- [ADR 044: Cross-Host SecretStore](044-cross-host-secret-store.md)
- [ADR 049: Runtime Session SQLite catalog and Host storage binding](049-runtime-session-sqlite-catalog-and-host-storage-binding.md)
- [ADR 059: ACP Runtime Driver and Claude Code transport](059-acp-runtime-driver.md)
- [ADR 061: OpenCode steering and ACP decision](061-opencode-steering-and-acp.md)

## Memory 与资产同步

- [ADR 031: Extensible Memory Plane](031-extensible-memory-plane.md)
- [ADR 032: Durable Canonical Event Feed and Execution Handoff](032-durable-canonical-event-feed.md)
- [ADR 033: Layered Episodic Memory and Memory Curator](033-layered-episodic-memory.md)
- [ADR 034: Conservative Semantic Memory](034-conservative-semantic-memory.md)
- [ADR 035: Agent-driven Memory Recall and Host Governance](035-agent-driven-memory-recall-and-governance.md)
- [ADR 036: Memory Storage Retention and Recovery](036-memory-storage-retention-and-recovery.md)
- [ADR 037: Mission Board as a Host-bound Context Store](037-mission-board-context-store.md)
- [ADR 039: Promoted Knowledge Stores](039-promoted-knowledge-stores-and-agent-revision.md)
- [ADR 057: Unified Memory revision learning](057-unified-memory-revision-learning.md)
- [ADR 058: Mission Memory Attention](058-mission-memory-attention.md)
- [ADR 060: Structured core asset synchronization](060-structured-core-asset-sync.md)
- [ADR 061: Memory 向量检索与任务 Attention](061-memory-vector-retrieval-and-task-attention.md)
- [ADR 070: Automatic core asset reconciliation](070-automatic-core-asset-reconciliation.md)
- [ADR 072: Tool-driven Memory extraction](072-tool-driven-memory-extraction.md)
- [ADR 073: Shared conversation Memory extraction and continuation](073-shared-conversation-memory-extraction.md)
- [ADR 075: Incremental Memory learning](075-incremental-memory-learning.md)
- [ADR 080: Revision Agent 直接提炼 Memory 草稿](080-direct-memory-revision-extraction.md)
- [ADR 074: Explicit Memory Curator tool contract and resumable feedback](074-memory-curator-tool-contract-v2.md)

## 已合并或归档

- 原 ADR 005 的 owner/恢复约束已并入 [Runtime Session catalog 决策](049-runtime-session-sqlite-catalog-and-host-storage-binding.md)；生命周期仍见 [ownership 与 leases](006-runtime-session-ownership-and-leases.md)，删除重复记录。
- 原 Skill-only Git 同步 ADR 053 已由 [结构化资产同步](060-structured-core-asset-sync.md)、[自动 reconciliation](070-automatic-core-asset-reconciliation.md)及本地身份规则取代；[旧记录](../archive/adr/053-trusted-git-skill-synchronization.md)保留历史依据。
- 阶段实施、性能和 CR 不属于当前架构决策，见[历史归档](../archive/README.md)。

## 维护

新决策使用下一个未占用编号，不复用既有编号；早期同号 ADR 以完整文件名和主题引用。
状态声明为 Accepted、Superseded in part 或 Superseded，并给出有效范围/后继。
协议变化同次交付版本、迁移、真实历史 fixture 和恢复测试；归档文档不能作为删除支持中升级链的授权。
