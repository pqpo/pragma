# Pragma 当前架构概览

> 本文描述当前仓库的稳定架构边界。实现细节以代码、运行时 Schema 和已接受 ADR 为准。

## 系统定位

Pragma 是一个跨模型、跨 Agent Harness 的多专家编排平台。系统将 Expert、ExpertTeam、Flow、
Capability、Context、Memory、Evaluation 和 Runtime binding 组合成可执行、可版本化、可迁移的
AI-native 工作方式，并由 Desktop、CLI 或嵌入式 SDK Host 运行。

核心设计围绕四个长期资产展开：

- 可移植的工作方式：使用 Pragma YAML DSL 描述并通过 Interpreter 编译；
- 可替换的执行环境：PI、Codex、Claude Code、Qoder CLI 与 Antigravity 以独立 Runtime Adapter 接入；
- 可治理的任务状态：Mission、Execution、Invocation、Session 与事件具有稳定身份和持久化语义；
- 可积累的知识：Evidence、Episodic、Semantic、Knowledge 与 Skill revision 形成独立 Memory Plane。

## 分层结构

```text
apps/web ───────────────────────────────────────────────> @pragma/shared

apps/server / apps/worker ──────────────────────────────> @pragma/core

apps/desktop ─┬─> @pragma/local-host ─┬─> @pragma/core
              │                       ├─> @pragma/interpreter
              │                       ├─> @pragma/evaluation
              │                       ├─> @pragma/built-in-agents
              │                       ├─> @pragma/memory
              │                       └─> @pragma/context-filesystem
              └─> @pragma/runtime-* ─────> @pragma/core ─────> @pragma/shared

apps/cli ─────┬─> @pragma/local-host
              └─> @pragma/runtime-*
```

这组依赖方向由 ESLint、TypeScript、workspace package exports 与测试共同约束：

- `@pragma/shared` 保存跨进程 Schema、领域值对象和浏览器安全的纯逻辑；
- `@pragma/core` 保存执行抽象、Invocation、Context、插件与 Runtime Adapter 合约；
- `@pragma/interpreter` 拥有 DSL AST、解析、链接、校验、迁移、编译与 bundle 协议；
- `@pragma/evaluation` 拥有独立 Evaluation 资源与 Run Dry；
- `@pragma/built-in-agents` 以静态 DSL 定义系统 Agent，并通过 Host ports 接入产品能力；
- `@pragma/memory` 是 Host 内置的 Memory Plane，不反向进入 Core；
- `@pragma/local-host` 是 Desktop Main 与公共 CLI 共享的 Node application layer；
- `@pragma/runtime-*` 分别适配具体 Harness，不互相依赖。

完整依赖矩阵见仓库根目录的 `AGENTS.md`。

## 执行模型

Expert、ExpertTeam 与 Flow 使用同一个 Execution / Invocation 模型：

```text
Mission
└── Execution
    ├── root Invocation
    ├── Expert / Team member Invocation
    ├── Flow step / SubFlow Invocation
    └── HumanTask interaction
```

`defineExpert()` 是普通 Expert 的统一创建入口。`createAgentLauncher()` 与 `defineExpertTeam()` 共用
子 Invocation 的执行、Context、并发、事件和 Usage 机制。Flow 的 Expert、ExpertTeam、SubFlow、
Task 与 HumanTask 也进入同一棵 Invocation Tree，因此恢复、取消、消息、输出和审计使用统一语义。

Execution 的持久状态、Invocation patch 与 Canonical Event 通过幂等提交边界更新。完整消息和生命周期
事件进入持久事件流；token、thinking 与 tool delta 通过活动执行的实时 Output 通道投影。历史读取使用
事件 cursor，活动订阅可获得当前执行的内存回放和后续增量。

## Mission 与本机 Host

`@pragma/local-host/node-application` 组合 Mission controller、owner lease、command inbox、query/watch、
Project catalog、Mission Board、Core store 与 Usage sink。Desktop 和 CLI 在相同应用协议上注入各自的
Runtime factory、文件系统、SecretStore、交互界面与 Host policy。

同一 Mission 的 mutation 由持久 `MissionControllerLease` 和单调 fencing token 协调。非 owner 的
`send`、`steer`、`respond`、`interrupt` 与 queue mutation 写入持久 `MissionCommandInbox`；提交使用
request ID 保证幂等，接受回执、应用结果与最终执行结果分别观察。`queue.try-steer` 在 same-turn 边界
不可用时保留 FIFO 队列项，HumanTask 回答按 `interactionId` 寻址。

`@pragma/shared/integration` 是 Desktop 与 CLI 共用的跨进程 wire 出口。它保持浏览器安全，不包含
Electron 对象、Node 实例或 secret。

## Runtime 与 Session

每个 Runtime Adapter 实现统一的 `RuntimeAdapter` / `RuntimeAgentSession` 合约，并通过 Runtime Feature
Framework 声明能力状态和一致性证据。Host 在创建 Runtime Context 时确定 `runtimeId`、revision 与
environment fingerprint；恢复时按持久绑定解析同一环境。

Runtime Session 由 ExpertSession context 或 FlowExecution Invocation 明确拥有。Core 使用原子 ownership
claim、lease 和完整身份校验保护 `systemSessionId`，恢复还要求原 owner 与 `RuntimeSessionRef`。运行进程
的生命周期与持久 Session 数据生命周期彼此独立。

权限由两层明确分工：Pragma 管理的 Tool/MCP 调用使用 Host approval policy；Runtime 原生文件、Shell、
网络与 Git 能力使用对应 Adapter 的原生权限模式和 Host binding。Runtime Feature 诊断展示最终生效模式，
供 Host 在运行前选择符合任务信任边界的配置。

## Context、Mission Board 与 Memory

`ContextSystem` 统一装配 inline、filesystem、Host-managed ContextStore 与联邦 Context。每个 Context 通过
稳定 ID、可见性、优先级、预算和权限参与装配；大输出写入 Host 指定的 overflow target。

Mission Board 是 Mission-scoped 的持久协作白板。Agent 可按稳定路径维护计划、进度、决策、handoff 与
产物引用；并发修改通过 revision CAS 与显式冲突处理保护。它只保存受控相对路径引用，不复制 workspace
文件。

Memory Plane 消费持久 Canonical Event Feed，将跨 Runtime 事件转为 Evidence，再由独立 Module 生成和
治理 Episodic、Semantic、Knowledge 与 Skill 资产。Module 使用独立消费状态、稳定错误码和可恢复投递；
Knowledge 与 Skill 通过候选、审阅、不可变 revision 和显式激活进入权威资源。

## DSL、Project 与 Bundle

Pragma YAML DSL 的当前资源包括 Expert、ExpertTeam、Flow、Automation、Capability、ContextStore、
RuntimeProfile 与 Evaluation。Interpreter 是 AST、版本能力、迁移链、链接和编译的唯一所有者。

Project Revision 保存不可变 manifest 与 Merkle `snapshotHash`，文件对象按 SHA-256 全局去重。语义资源
使用稳定 16 位小写 Crockford Base32 ID；revision number 表示资源历史，而不是资源身份。Host 更新当前
资源时在统一持久化边界保留兼容窗口内的未知字段。

`.pragma` bundle 使用 Interpreter 拥有的 portable protocol。Desktop 负责导入、验证、binding、安装事务
和回滚；其他 Host 可以读取同一 bundle 并编译其中资源。

## Capability、Evaluation 与内置 Agent

Capability 使用不可变 revision、独立凭据和工具快照。Expert 固定引用 Capability revision 与 tool
allowlist；ready revision 的激活由 Desktop coordinator 原子更新当前 Project binding 和 System Expert
customization，历史 Project Revision、Mission 与 Execution 保持固定。

Evaluation 是独立、可版本化的资源。它可以针对真实任务定义输入与判定标准，通过 Run Dry 验证 Flow，
并为 Runtime、模型、Prompt、Context 或 Capability revision 的变更提供可重复比较的依据。

六个内置 Agent 均由 `@pragma/built-in-agents` 中的静态 DSL 定义。包内保存 descriptor、compiler、提示词、
结构化输出解析与纯状态机；Desktop 或 CLI Host 提供 Runtime、权限、持久化、Mission 和 UI 端口。

## 存储与可恢复性

本地数据按用途分区：

```text
~/.pragma/workspace/   # Agent 明确使用的工作文件
~/.pragma/data/        # 权威资源与内容寻址对象
~/.pragma/state/       # 可恢复运行状态
~/.pragma/archives/    # 有界诊断归档
~/.pragma/cache/       # 可重建内容
~/.pragma/tmp/         # 短期临时文件
~/.pragma/trash/       # 带 journal 的可恢复删除
```

持久 Schema 使用静态注册的相邻迁移链。Host 在首次访问最小 owner、进入业务读取前执行升级，并使用文件锁、
stable journal、备份与原子替换保证恢复。业务 parser 只接受当前 Schema；未来版本、损坏数据或缺失迁移链
使用稳定错误码拒绝，且不影响无关 owner。

## 主要入口

- Desktop：创建、管理和运行 Project、Expert、Team、Flow、Capability、Context、Memory 与 Evaluation；
- CLI：通过 `@pqpo/pragma` 发现资源、运行和恢复 Mission、查询事件、管理队列及输出机器可读协议；
- SDK：应用通过 `@pragma/interpreter` 加载 DSL，再通过 `@pragma/core` 运行编译结果；
- Server：提供 Fastify HTTP 应用与服务组合入口；
- Worker：提供异步进程与 Runtime composition 入口；
- Web：使用 `@pragma/shared` 的浏览器安全协议访问服务。

## 相关文档

- [ADR 索引](../adr/README.md)
- [Agent Core 架构](./agent-core-architecture.md)
- [Pragma YAML DSL](./pragma-yaml-dsl.md)
- [Pragma Bundle](./pragma-bundle.md)
- [Runtime Feature Framework](./runtime-feature-framework.md)
- [Mission Board](../articles/03-mission-board.md)
- [Memory](../usage/memory.md)
- [Execution SDK](../Execution-SDK-Design.md)
