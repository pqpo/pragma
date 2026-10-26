# 文档入口

开发前先读根目录 [AGENTS.md](../AGENTS.md)，再按本次改动阅读专题规范。

## 当前规范与架构

| 主题                    | 入口                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 系统定位与分层          | [当前架构概览](architecture/current-architecture-overview.md)、[模块边界](architecture/module-boundaries.md)                                                                |
| 模块实现约束            | [Package contracts](conventions/package-contracts.md)                                                                                                                       |
| 协议、存储、升级、删除  | [持久化与升级治理](conventions/persistence-and-upgrades.md)                                                                                                                 |
| 编码、语义 ID、后台诊断 | [编码规范](conventions/coding-conventions.md)                                                                                                                               |
| 测试与发行              | [测试与发布](conventions/testing-and-release-performance.md)                                                                                                                |
| Desktop UI              | [UI 规范](conventions/desktop-ui.md)                                                                                                                                        |
| Runtime 接入            | [Host/Runtime 规范](conventions/runtime-integration.md)、[接入清单](conventions/runtime-adapter-integration-checklist.md)、[Usage](conventions/runtime-usage-accounting.md) |
| DSL、编译、Bundle       | [DSL](architecture/pragma-yaml-dsl.md)、[Bundle](architecture/pragma-bundle.md)、[部署与环境服务](adr/075-shared-deployment-and-environments.md)                            |
| Mission 读取与输出      | [Conversation read model](architecture/mission-conversation-read-model.md)、[附件与多模态输入](architecture/mission-attachments-and-multimodal-input.md)                    |
| Memory                  | [提炼与恢复](architecture/memory-extraction-execution.md)、[Attention](architecture/memory-attention.md)                                                                    |
| 设计决策                | [ADR 索引及适用范围](adr/README.md)                                                                                                                                         |

版本号与能力范围以权威 Schema、能力常量和可执行测试为准。修改文档中的可运行示例时同步核对源码，历史版本说明不能当作当前写入协议。

## 使用与运维

- [使用指南](usage/README.md)：Desktop、CLI、Expert、Flow、Context、Memory、插件和发行。
- [Execution SDK](Execution-SDK-Design.md)、[Agent Core](architecture/agent-core-architecture.md)。
- [技术文章](articles/README.md)、[产品策略](strategy/README.md)。
- [本地存储离线迁移手册](migrations/local-storage-v3-ai-migration.md)：按其适用版本操作，不代替应用内支持窗口升级。

## 交付范围与历史边界

- [Issue 399 交付与暂缓范围](plans/issue-399.md)：共享配置已交付，独立部署、Linux 与 Memory Headless 仍暂缓。
- [验证记录](validation/README.md)：范围、环境与限制随记录保留。
- [性能测量入口](performance/README.md)：可复用基准、复测口径与历史验收缺口。
- [历史验收摘要](archive/README.md)：必要验收边界和旧 ADR，阶段明细从 Git 历史追溯。

## 维护规则

- 稳定规则放 conventions，系统行为放 architecture，取舍及兼容性授权放 ADR；不要在根 AGENTS 累加具体 bug 的实施记录。
- 新 ADR 使用未占用编号；早期重号以完整文件名和主题区分，不重编号破坏引用。
- 完全重复且无独立历史约束的 ADR 合并到权威后继；仍有有效部分的 ADR 明确范围；已取代但保有 cutover/验收依据的记录进入 archive。
- 归档不代表验收通过，也不删除支持中的迁移、历史 Schema 或 fixture。删除历史记录前保留有效约束及验收缺口，同步维护链接。

- 一次性截图、探针、源码快照、采样 JSON 和逐轮 CR 留在仓库外或 CI artifact；文档只保留可复用方法、必要结论和限制。
- 文件密集目录与超长文档优先检查重复、过时和生成内容；接口与 Schema 链接权威源码，避免抄写。源码、迁移链和有效回归不能仅因数量或行数删除。
