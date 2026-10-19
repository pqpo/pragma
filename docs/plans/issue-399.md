# Issue 399 独立部署与 Memory Headless 重构执行计划

目标是让 Desktop 与 CLI 共用资源部署、环境管理和 Memory 后台业务，CLI 能在不启动 Desktop 的情况下完成配置、导入、运行与学习。先在现有支持的平台完成业务闭环，Linux 支持放到最后。

代码基线：2026-10-19 拉取的 `main`，`f7ebcc87`。需求依据为 [Issue 399](https://github.com/pqpo/pragma/issues/399)、维护者的[阶段核对](https://github.com/pqpo/pragma/issues/399#issuecomment-6260731002)和 [Memory Headless 补充](https://github.com/pqpo/pragma/issues/399#issuecomment-6260968883)。

## 已完成的基础

以下能力已经存在，后续直接复用，不重新实现。

| 已完成内容                               | 当前边界                                                                                                     | 依据                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop 与 CLI 统一 Mission application  | 控制、编译、执行、owner 和恢复已共享                                                                         | [PR 356](https://github.com/pqpo/pragma/pull/356)、[ADR 066](../adr/066-unified-local-host-mission-application.md)                              |
| 管理 CLI 与 manage-pragma Skill 迁移     | 管理命令仍依赖 owning Execution endpoint                                                                     | [PR 375](https://github.com/pqpo/pragma/pull/375)                                                                                               |
| 凭据诊断修复                             | 已修复存储版本误报，尚不包含 Linux 无桌面凭据支持                                                            | [PR 400](https://github.com/pqpo/pragma/pull/400)                                                                                               |
| CLI 查询与运行能力完善                   | 已有分页、有限等待、owner 生命周期与机器输出                                                                 | [PR 402](https://github.com/pqpo/pragma/pull/402)、[实施记录](issue-398.md)                                                                     |
| Bundle 协议与 Desktop 导入能力           | Interpreter 拥有协议；安装、资源写入、配置和绑定仍有 Desktop 独占业务                                        | [Bundle 架构](../architecture/pragma-bundle.md)、[Desktop 导入说明](../architecture/desktop-bundle-transfer.md)                                 |
| Memory 数据面及提炼、检索、Learning 能力 | CLI 已能采集 Evidence、提交 Job 和读取已有记忆；提炼执行、索引写入和 Learning 编排尚未形成独立 Headless 闭环 | [Memory 说明](../usage/memory.md)、[ADR 057](../adr/057-unified-memory-revision-learning.md)、[PR 407](https://github.com/pqpo/pragma/pull/407) |

这些成果是本次重构的起点，不代表 Issue 399 的独立部署与后台业务闭环已经完成。

## 阶段顺序与状态

| 顺序 | 阶段                        | 当前进展                                    | 接下来交付                                      |
| ---- | --------------------------- | ------------------------------------------- | ----------------------------------------------- |
| 1    | 共享部署与环境服务          | Mission 内核已共享，Desktop 已有部署业务    | 安装、配置、绑定与修复统一到 Local Host         |
| 2    | CLI 独立部署入口            | 运行、查询、诊断和管理客户端已有基础        | 从空配置完成导入、环境准备、修复与运行          |
| 3    | Memory 与 Learning 独立运行 | 领域能力已存在，后台业务仍依赖 Desktop 装配 | 共享后台服务与 CLI 配置、处理、审核入口         |
| 4    | 现有平台闭环验收            | 已有分项测试与验证                          | 使用实际 CLI 包完成独立部署和 Memory 全链路     |
| 5    | Linux 支持                  | 当前包不支持 Linux，CI 仅验证拒绝安装       | 无桌面认证、平台适配、正向 CI 与完整 Linux 验收 |

按 1 → 2 → 3 → 4 → 5 推进。每阶段可以拆成多个 PR；前三阶段及现有平台验收不以 Linux 支持为前置条件。当前下一步为阶段 1 的剩余共享业务收敛。

## 阶段 1 共享部署与环境服务

**已完成：** Mission 执行内核、资源读取、SecretStore 和部分 Memory 数据面已经进入 Local Host；Desktop 已有 Bundle 导入、资产安装、环境配置与绑定能力。

**主要目标：** 将资源部署所需的通用业务收敛到 Local Host，Desktop 同步改接，给 CLI 提供完整可复用的服务。

**实现思路：** 复用现有业务，按资源写入、Bundle 安装、环境配置、绑定修复逐块下沉。Interpreter 继续负责协议、依赖分析、引用重写和编译；平台凭据与具体 Runtime 工厂通过窄端口注入。

**执行计划：**

1. 明确共享业务、平台适配和持久协议的边界，补充必要 ADR 与契约。
2. 收敛 Project、Capability、ContextStore、Plugin 写入及 Bundle 安装业务，补齐统一的请求重试、中断恢复和冲突处理。
3. 收敛模型连接、Runtime Environment、确定性绑定、就绪检查与局部修复，明确共享配置的影响范围。
4. 每块业务迁移时同步改接 Desktop，删除重复实现，验证既有导入、导出、绑定和运行行为。

**完成标志：** 两端可调用同一套部署与环境服务；Local Host 不依赖 Desktop Store 或 Electron；安装重试、恢复、缺依赖和重新绑定通过验证。

## 阶段 2 CLI 独立部署入口

**已完成：** CLI 已有 Runtime 装配、Mission 运行与恢复、查询、分页、诊断、有限等待和机器输出；Agent 管理 CLI 已完成迁移。

**主要目标：** 在现有支持的平台，仅通过 CLI 从空 `PRAGMA_HOME` 完成配置、导入 Bundle、修复依赖并运行任务。

**实现思路：** CLI 只补参数、交互、输出和进程适配，业务全部调用阶段 1 的共享服务。独立部署入口不要求先有 owning Execution endpoint。

**执行计划：**

1. 接入初始化、Harness/模型发现、连接与凭据配置，支持从零创建运行环境。
2. 接入 Bundle 检查、安装、状态查询、诊断和局部重新绑定，沿用已有 Mission 运行与结果查询。
3. 补齐参数或配置文件驱动的非交互流程，以及可复用的无密钥绑定配置。
4. 验证无 TTY 时不挂起、依赖不足时准确报告、修复后无需重新导入，并保留原管理客户端的授权边界。

**完成标志：** Desktop 关闭且没有历史 Pragma 配置时，CLI 可以完成一次真实部署与任务执行；相同安装请求安全重试，不影响其他资源或已有 Session。

## 阶段 3 Memory 与 Learning 独立运行

**已完成：** Memory 已有共享数据面、提炼 Job/Session、Curator 工具契约、向量检索和 Learning 规则；Desktop 已能执行后台提炼及 Knowledge/Skill 草稿审核。最新 PR 407 已完善 Curator v2 与历史会话恢复。

**主要目标：** Desktop 关闭时，CLI 或显式托管的 Worker 仍能完成记忆提炼、索引维护和 Learning，并保留人工治理。

**实现思路：** 将 Desktop 独占的后台业务编排收敛到 Local Host，复用 Memory、Built-in Agents 和共享 Mission 用例。Desktop 与 CLI 仅管理各自生命周期和交互，不新增 CLI 专用提炼或索引实现。

**执行计划：**

1. 共享 Curator、提炼调度、诊断和恢复服务，提供显式、有界或持续处理的 Worker 生命周期。
2. 接通无 Desktop 的 Embedding 配置、全量回填、增量索引与失败恢复，保留关键词降级；Jev 继续可选。
3. 共享 Knowledge/Skill Learning 的规划、托管草稿和 Revision 编排，保持原触发门槛及人工批准规则。
4. 补齐 CLI 的 Memory 配置、处理、查询、重试和审核入口，Desktop 同步改接共享业务。

**完成标志：** 无 Desktop 时，新 Evidence 能生成 Episodic/Semantic Memory 并被下一次 Mission 召回；索引可更新，Learning 能生成草稿并在授权批准后生效；重启可恢复且不重复写入。

## 阶段 4 现有平台闭环验收

**已完成：** 各能力已有工程测试、使用文档和分项验证，但尚不足以证明独立部署及 Memory/Learning 的完整闭环。

**主要目标：** 先在当前支持的平台验证前三阶段，形成可复现的交付与回归证据。

**实现思路：** 使用实际候选 CLI 发布包、真实 Desktop 导出的 Bundle 和真实 Runtime/模型。独立环境从空配置开始，验收期间不启动 Desktop；另行回归 Desktop 原有体验。

**执行计划：**

1. 验证配置、Bundle 资产导入、自动绑定、真实任务、进度和结果查询，以及无密钥配置复用。
2. 验证依赖缺失、凭据错误、绑定歧义、局部修复、安装中断与跨进程恢复。
3. 验证记忆生成、下一任务召回、真实向量检索、Learning 草稿审核和发布。
4. 完成相关共享业务、CLI、Desktop 与打包回归，更新使用文档并保存验收记录。

**完成标志：** 现有平台独立运行闭环通过，工程测试与真实运行证据分别记录。Linux 验收继续保留在阶段 5，Issue 399 不提前视为全部完成。

## 阶段 5 Linux 支持

**已完成：** 已有 CLI 发布包、Worker 打包与审计基础；当前 npm 包仅支持 macOS/Windows，Linux CI 验证的是拒绝安装。

**主要目标：** 在无 Desktop、无图形登录和历史用户配置的 Linux 环境中，运行前四阶段的完整能力。

**实现思路：** 在已共享的业务之上补平台适配，优先支持明确的发行环境、架构与 Runtime 组合。此阶段确定可用的无桌面凭据方案，不提前绑定具体实现。

**执行计划：**

1. 明确首版支持矩阵及无桌面凭据后端，保持受控注入和 SecretStore 边界，不静默降级为明文持久化。
2. 适配原生依赖、权限与路径、Harness 发现、环境传递和包内 Worker。
3. 使用实际发布包增加 Linux 正向安装与运行 CI，保留 macOS/Windows 回归。
4. 在干净 Linux 环境重复部署、真实任务、Memory/Learning 和恢复验收，补充支持矩阵与部署文档。

**完成标志：** 实际 CLI 包在声明的 Linux 组合中通过完整闭环；平台声明、CI 和可复现文档一致，随后核对 Issue 399 全部验收项。

## 各阶段共同约束

- Desktop 与 CLI 使用同一共享业务；每次下沉同步改接，避免长期保留两套实现。Core、Interpreter、Memory 和 Built-in Agents 保持原有领域所有权。
- 保持资源身份、显式副本导入、确定性绑定和已有 Session 的持久 Runtime 身份；不按名称猜测或静默替换环境。
- 持久协议语义改变时，同步交付版本、相邻迁移、历史 fixture 和恢复测试；保留 Curator 历史工具契约的恢复能力。
- Memory 默认关闭并要求显式启用，Learning 不绕过人工批准；凭据不进入 Bundle、普通配置或日志。
- 每阶段验证相关业务和生产接线；“命令存在”“已入队”或 mock 成功不能代替真实任务、记忆生成和正式发布结果。

## 后续推进方式

每次选择一个阶段推进，先核对最新代码与 Issue 更新，只实施剩余部分。完成后在下表记录 PR、验证证据和剩余缺口，再进入下一阶段；具体文件、命令和测试拆分在该阶段实施时确定。

| 阶段                          | 本计划剩余工作状态 | 实施与验证记录 |
| ----------------------------- | ------------------ | -------------- |
| 1 共享部署与环境服务          | 待推进             | —              |
| 2 CLI 独立部署入口            | 待推进             | —              |
| 3 Memory 与 Learning 独立运行 | 待推进             | —              |
| 4 现有平台闭环验收            | 待推进             | —              |
| 5 Linux 支持                  | 延后，最后推进     | —              |
