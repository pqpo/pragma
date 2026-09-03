# Architecture Decision Records

本目录只保留当前架构仍在使用，或仍有明确适用范围的决策。已被后继方案完整取代的记录会从主文档集
删除；部分修订的记录会在文件开头说明仍然有效的范围。查找当前系统边界时，先阅读本索引与
[当前架构概览](../architecture/current-architecture-overview.md)，再进入专题 ADR。

ADR 的数字来自项目演进历史，早期曾出现同号记录。链接文件名是稳定标识，引用时应同时写明主题，
不要只写数字。

## 基础架构与执行

- [Monorepo 与依赖规则](./001-monorepo-and-dependency-rules.md)
- [Execution-owned Runtime storage](./005-execution-owned-runtime-storage.md)
- [Runtime Session ownership 与 leases](./006-runtime-session-ownership-and-leases.md)
- [Execution Canonical Event Log](./007-execution-canonical-event-log.md)
- [Process-shared Execution MCP Gateway](./008-process-shared-execution-mcp-gateway.md)
- [Unified Diagnostic Logging](./021-unified-diagnostic-logging.md)
- [Runtime Feature Framework](./041-runtime-feature-framework.md)
- [Context-addressed Expert collaboration](./043-context-addressed-expert-collaboration.md)

## Expert、Flow 与 Host

- [Desktop Capability Library](./004-desktop-capability-library.md)
- [Desktop Home、Mission 与 System Experts](./014-desktop-home-mission-entry-and-system-experts.md)
- [Pragma 默认通用 Agent](./015-pragma-default-general-purpose-agent.md)
- [Flow parallelism 与持久 Fork/Join](./017-flow-parallelism-requires-fork-join.md)
- [Automation 与 Trigger Adapter](./020-automation-integrations-and-trigger-adapters.md)
- [DSL-defined Built-in Agents](./040-dsl-defined-built-in-agents-package.md)
- [Local Host 与 CLI 边界](./042-local-host-and-cli-boundary.md)
- [Mission controller lease 与 command inbox](./043-mission-controller-lease-and-command-inbox.md)
- [Durable Mission command receipts](./047-durable-mission-command-receipts.md)

## DSL、Project 与 Bundle

- [Mission Manifest 与文件时间线](./011-mission-manifest-and-file-timeline.md)
- [Desktop Plugin Catalog 与 DSL resolution](./012-desktop-plugin-catalog-and-dsl-resolution.md)
- [Resource-scoped Project change sets](./022-resource-scoped-project-change-sets.md) — 保留 change-set concurrency
- [Semantic resource identity 与 Project revisions](./023-semantic-resource-identity-and-project-revisions.md)
- [Interpreter-owned DSL migrations](./024-interpreter-owned-dsl-migrations.md)
- [Interpreter compiler compatibility](./029-interpreter-compiler-compatibility-and-scoped-validation.md)
- [Desktop-bound resource identity](./030-desktop-bound-resource-identity-and-capability-revision-propagation.md)
- [Interpreter-owned `.pragma` bundle protocol](./031-interpreter-owned-pragma-bundle-protocol.md)
- [Lightweight Git bundle source](./046-lightweight-git-bundle-source.md)

## 持久状态与本机运行

- [Local storage lifecycle 与 content addressing](./016-local-storage-lifecycle-and-content-addressing.md)
- [Versioned persistent-state migrations](./019-versioned-persistent-state-migrations.md)
- [Host-coordinated persistent-state upgrades](./020-host-coordinated-persistent-state-upgrades.md)
- [Host-owned token usage accounting](./025-host-owned-token-usage-accounting.md)
- [Codex minimal Home projection](./026-codex-minimal-home-projection.md)
- [Mission latency cache 与 Runtime warmup](./027-mission-latency-cache-and-runtime-warmup.md)
- [Host-scoped MCP connections](./028-host-scoped-mcp-connections-and-tool-projections.md)
- [Cross-Host SecretStore](./044-cross-host-secret-store.md)

## Evaluation 与 Memory

- [Independent Evaluation resources](./028-independent-evaluation-resources.md)
- [Extensible Memory Plane](./031-extensible-memory-plane.md)
- [Durable Canonical Event Feed](./032-durable-canonical-event-feed.md)
- [Layered Episodic Memory](./033-layered-episodic-memory.md)
- [Conservative Semantic Memory](./034-conservative-semantic-memory.md)
- [Agent-driven Memory Recall 与 Host Governance](./035-agent-driven-memory-recall-and-governance.md)
- [Memory storage retention 与 recovery](./036-memory-storage-retention-and-recovery.md)
- [Mission Board Context Store](./037-mission-board-context-store.md)
- [Promoted Knowledge Stores 与 Agent revision](./039-promoted-knowledge-stores-and-agent-revision.md) — published authority 仍适用
- [Sparse Context Store revision drafts](./044-sparse-context-store-revision-drafts.md)

## 维护规则

- 新决策使用下一个未使用编号，不复用既有编号；
- 文件开头必须声明 `Accepted`、`Superseded in part` 或 `Superseded`；
- 完全被替代的 ADR 在后继决策吸收必要约束并更新引用后，从主文档集删除；
- 部分被替代的 ADR 必须写明保留范围和后继链接；
- 持久协议、DSL 和 storage schema 的版本升级必须与迁移、fixture 和恢复测试在同一变更中提交。
