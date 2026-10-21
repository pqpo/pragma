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

## 计划与历史证据

- [Issue 399 当前收尾计划](plans/issue-399.md)：保留明确未完成项，不将计划视为已实现能力。
- [验证记录](validation/README.md)：范围、环境与限制随记录保留。
- [性能历史](performance/README.md)：只证明对应提交和环境，不能据此认定当前性能。
- [历史归档](archive/README.md)：阶段方案、CR、旧 ADR 与实施证据，不参与当前规范优先级。

## 维护规则

- 稳定规则放 conventions，系统行为放 architecture，取舍及兼容性授权放 ADR；不要在根 AGENTS 累加具体 bug 的实施记录。
- 新 ADR 使用未占用编号；早期重号以完整文件名和主题区分，不重编号破坏引用。
- 完全重复且无独立历史约束的 ADR 合并到权威后继；仍有有效部分的 ADR 明确范围；已取代但保有 cutover/验收依据的记录进入 archive。
- 归档不代表验收通过，也不删除支持中的迁移、历史 Schema 或 fixture。链接、脚本路径和历史证据一起维护。
