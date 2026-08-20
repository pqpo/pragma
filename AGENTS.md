# AGENTS.md

本文件是给后续 Codex、Agent、自动化脚本和人类协作者看的工程说明。进入本仓库后，先读本文件，再动代码。

## 项目定位

Pragma 是一个多专家 Agent 编排系统的长期工程底座，目标是沉淀可扩展、边界清晰、协议可治理、运行时可替换的 Agent 编排平台。

项目演进优先级是：架构合理性、功能完整性、实现清晰度、可验证质量。允许为了合理架构引入 breaking change；不要为了兼容旧代码保留无用适配层、废弃字段、空实现或迁移期分支。发现已经弃用且没有长期价值的代码，应直接删除并同步更新调用方、类型和文档。

## 技术基线

```text
Node.js: >= 22
Package Manager: pnpm
Monorepo: pnpm workspace + Turborepo
Language: TypeScript
Module System: ESM
Lint: ESLint Flat Config
Formatting: Prettier
Test: Vitest
Web: Next.js
Server: Fastify
Worker: Node.js + TypeScript
```

所有新增 TypeScript 代码必须满足严格模式。所有 package 必须是 ESM。

## 目录结构

```text
apps/
  web/       Next.js Web 应用，页面与浏览器交互入口
  server/    Fastify HTTP API 应用
  worker/    Node Worker 应用
  desktop/   未来 Desktop App，本地 Agent 桥接入口

packages/
  shared/         跨进程、跨端协议、领域模型和值对象、跨端纯函数工具
  client/         浏览器或客户端使用的 HTTP SDK
  server/         Node 服务端基础设施边界，例如数据库边界
  core/           ExpertAgent、Context、工具、插件、Runtime Adapter 与默认 Runtime
  memory/         Host 内置 Memory Plane、Evidence adapter、Module registry 与联邦 Context
  mission-board/  Host 可复用的 Mission 白板 Context bindings 与使用 Guide
  context-filesystem/ Host 侧文件系统 Context adapter 出口
  interpreter/    Pragma YAML DSL 的 AST、解析、校验、编译、扩展 registry 与 dump
  eslint-config/ 共享 ESLint 配置出口
  tsconfig/      共享 TypeScript 配置

docs/
  architecture/ 架构说明
  adr/          架构决策记录
  conventions/ 编码约定

infra/
  compose/      基础设施编排目录
```

未来 Desktop 本地 Agent 桥接目录规划：

```text
apps/
  desktop/             Desktop App，负责本地登录、设备绑定、权限确认、连接云端、本地 Agent 调用

packages/
  core/src/local-agent-bridge/     云端与 Desktop App 的桥接协议、消息类型、能力注册模型
  server/src/runtime-gateway/      云端 Runner/Device 注册、会话管理、Run 下发、事件接收
```

不要新增 `apps/local-runner`。本地 Agent 的产品入口是 Desktop App，而不是独立 CLI runner。

关键根文件：

```text
package.json
pnpm-workspace.yaml
turbo.json
eslint.config.mjs
prettier.config.mjs
tsconfig.base.json
```

## Package 命名

统一使用 `@pragma/*` scope。

当前 package：

```text
@pragma/shared
@pragma/client
@pragma/server
@pragma/core
@pragma/memory
@pragma/interpreter
@pragma/evaluation
@pragma/built-in-agents
@pragma/runtime-pi
@pragma/runtime-codex
@pragma/runtime-claude-code
@pragma/runtime-qodercli
@pragma/runtime-antigravity
@pragma/desktop
@pragma/examples
@pragma/eslint-config
@pragma/tsconfig
```

不要新增模糊名称，例如：

```text
common
base
shared-lib
helpers
lib
```

新增 package 前，必须先明确它属于 `shared`、`client`、`server`、`core`、`interpreter`、`built-in-agents`、`runtime-*`、`plugins/*`、`examples`、`apps/*` 还是配置工具。

## 模块依赖规范

下面的箭头统一表示“左侧可以依赖右侧”。

核心原则：

- `shared` 是最底层协议、领域模型和纯工具，不依赖任何运行环境层。
- `client` 是浏览器/客户端 SDK，只依赖 `shared`，不直接碰 Server 内部实现或 Agent。
- `core` 是专家 Agent 的执行抽象和 Runtime Adapter 边界，只依赖 `shared` 和 core 内部模块，不依赖具体 runtime、`client` 或 `server`。
- `evaluation` 是独立测评领域包，拥有 Evaluation 协议、Run Dry 执行器与结果模型；只依赖 `core`，不依赖 `interpreter` 或应用层。
- `interpreter` 是 Pragma DSL 的语言实现，拥有 AST、解析、链接、校验、编译、扩展 registry 和 dump；可以依赖 `evaluation` 和 `core`，但 `core` 与 `evaluation` 不得反向依赖 `interpreter`。
- `built-in-agents` 是六个内置 Agent（Pragma、Memory Curator、Store Revision、Skill Revision、Skill Evaluation、Evaluation Judge）的跨 Host 产品能力包。所有 Agent 均由静态 DSL 定义；包内拥有 descriptor/compiler、独立宿主端口、提示词、结构化输出解析、修订规则与纯状态机。Host 负责 Runtime 执行、权限、持久化、Mission 和 UI 适配，不要求六个 Agent 使用统一调用接口。
- `memory` 是 Host 内置 Memory Plane，拥有 Evidence adapter、Module SPI、独立消费状态和联邦只读 Context；只依赖 `core` 与 `shared`，不得反向进入 Core。
- `mission-board` 是 Host 可复用的 Mission-scoped 通用白板，只依赖 `core` Context 合约，不依赖文件系统、Memory 或应用。
- `context-filesystem` 是显式 Node/Host 文件系统 adapter 出口；Mission Board 与 Memory 不得依赖它。
- `runtime-*` 是具体 Runtime Adapter 实现，依赖 `core`、`shared` 和该 runtime 自己的 SDK；不同 runtime 包相互独立。
- `server` 是服务端控制面与基础设施层，可以依赖 `shared` 和 `core` 抽象。
- `apps/server` 和 `apps/worker` 是云端运行入口，未来由它们调度专家 Agent；不是 Agent 反过来依赖 Server。
- `apps/desktop` 是未来本地 Agent 桥接入口，主动连接云端，承载本地权限闸门和本机 Agent 调用。

```text
apps/web    -> client -> shared
apps/server -> server -> core -> shared
apps/worker -> server -> runtime-* -> core -> shared
apps/desktop    -> built-in-agents -> interpreter -> core -> shared
apps/desktop    -> interpreter -> evaluation -> core -> shared
apps/desktop    -> runtime-* -> core -> shared
apps/desktop    -> memory -> core -> shared
plugins/*   -> core -> shared
examples    -> runtime-* / plugin-* / core -> shared
```

更具体地说：

| 来源                       | 允许依赖                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                 | `@pragma/shared`、`@pragma/client`                                                                                                                   |
| `apps/server`              | `@pragma/shared`、`@pragma/server`、`@pragma/core`                                                                                                   |
| `apps/worker`              | `@pragma/shared`、`@pragma/server`、`@pragma/core`、具体 `@pragma/runtime-*`                                                                         |
| `apps/desktop`             | `@pragma/shared`、`@pragma/core`、`@pragma/memory`、`@pragma/evaluation`、`@pragma/interpreter`、`@pragma/built-in-agents`、具体 `@pragma/runtime-*` |
| `plugins/*`                | `@pragma/shared`、`@pragma/core`；不依赖 app、server、client 或具体 runtime                                                                          |
| `examples`                 | `@pragma/core`、具体 `@pragma/runtime-*`、具体 `@pragma/plugin-*`                                                                                    |
| `packages/shared`          | 无内部 package 依赖；只允许运行时中立依赖                                                                                                            |
| `packages/client`          | `@pragma/shared`                                                                                                                                     |
| `packages/server`          | `@pragma/shared`；需要编排时可依赖 `@pragma/core`                                                                                                    |
| `packages/core`            | `@pragma/shared`                                                                                                                                     |
| `packages/memory`          | `@pragma/shared`、`@pragma/core`；不得依赖 app、server、client、interpreter 或具体 runtime                                                           |
| `packages/interpreter`     | `@pragma/shared`、`@pragma/core`；AST 子入口只使用运行时中立依赖                                                                                     |
| `packages/evaluation`      | `@pragma/core`；`/ast` 保持浏览器安全且不依赖 Interpreter                                                                                            |
| `packages/built-in-agents` | `@pragma/shared`、`@pragma/core`、`@pragma/interpreter`、`@pragma/evaluation`、`@pragma/memory`；`/contracts` 保持浏览器安全                         |
| `packages/runtime/*`       | `@pragma/shared`、`@pragma/core`、该 runtime 自己的 SDK                                                                                              |

明确禁止：

```text
web -> server
web -> core
client -> server
client -> core
shared -> client
shared -> server
shared -> core
shared -> interpreter
core -> client
core -> server
core -> interpreter
evaluation -> interpreter
core -> runtime-*
core -> memory
runtime-pi -> runtime-codex
runtime-pi -> runtime-claude-code
runtime-codex -> runtime-pi
runtime-codex -> runtime-claude-code
runtime-claude-code -> runtime-pi
runtime-claude-code -> runtime-codex
runtime-qodercli -> runtime-pi
runtime-qodercli -> runtime-codex
runtime-qodercli -> runtime-claude-code
runtime-pi -> runtime-qodercli
runtime-codex -> runtime-qodercli
runtime-claude-code -> runtime-qodercli
runtime-antigravity -> runtime-pi
runtime-antigravity -> runtime-codex
runtime-antigravity -> runtime-claude-code
runtime-antigravity -> runtime-qodercli
runtime-pi -> runtime-antigravity
runtime-codex -> runtime-antigravity
runtime-claude-code -> runtime-antigravity
runtime-qodercli -> runtime-antigravity
server -> client
server -> web
core -> web
plugin-* -> server
plugin-* -> client
plugin-* -> runtime-*
memory -> plugin-*
built-in-agents -> app
built-in-agents -> server
built-in-agents -> client
built-in-agents -> runtime-*
```

这里的 `core` 指专家 Agent 的执行抽象、Invocation、Runtime Adapter 合约和公共运行协议。DSL AST、Manifest 解析和对象编译属于 `@pragma/interpreter`。具体 runtime 实现放在独立 `@pragma/runtime-*` 包，由 Server/Worker/Desktop 等应用入口按需装配；不要让 `core` 依赖 `interpreter`、具体 runtime、`client`、Web 或 Server 应用层。

所有跨 package 依赖必须使用 package import：

```ts
import { HealthResponseSchema } from "@pragma/shared";
```

禁止跨 package 使用相对路径：

```ts
import { HealthResponseSchema } from "../../../shared/contracts/src/index.ts";
```

内部依赖版本必须使用：

```json
{
  "@pragma/shared": "workspace:*"
}
```

禁止对内部依赖使用 `"*"`、固定 semver 或 npm registry 版本。

## 语义资源 ID 与后台任务可观测性

- Expert、ExpertTeam、Flow、Automation、Capability、ContextStore、RuntimeProfile 和 Evaluation
  的 ID 必须是 16 位小写 Crockford Base32；允许 `0-9`、`a-h`、`j-k`、`m-n`、`p-t`、`v-z`，
  禁止易混淆字符 `i`、`l`、`o`、`u`。
- 内置或系统资源 ID 不得只靠人工检查字符串。必须在常量声明处通过权威运行时 Schema 构造 canonical ref，
  并在第一个持久化或跨进程消费边界补集成测试；只 mock 掉边界的单元测试不算覆盖。
- Evidence 捕获/发布不等于成功生成 Memory。计数器、日志和 UI 必须使用准确阶段名称，禁止把 Evidence
  数量展示为记忆生成成功数量。
- 后台任务进入 `needs_attention`、Module unavailable 或投递隔离时，所属子系统必须报告 degraded，日志和
  用户界面必须展示 Module 与稳定错误码。可重试 Evidence 必须保留，修复配置或升级应用后可直接唤醒，
  不要求用户重跑原任务。

## 协议与版本升级治理

以下规则适用于所有持久化和跨进程协议，包括 DSL `apiVersion`、状态 `schemaVersion`、
Interpreter `compilerVersion`、manifest、lock、IPC、Bridge 和 Runtime capability：

- 任何会让新代码拒绝或改变既有合法数据语义的改动，必须在同一个 Pull Request 中提交明确的版本升级、
  可执行升级机制和完整测试；禁止先升级 Schema 或版本号、再留待后续补迁移。缺少升级机制时不得合入。
- Capability 必须区分“当前代码可直接读取的版本”和“可通过迁移升级的来源版本”。只有当前 parser
  能完整接受真实历史 fixture 时才能声明直接可读；禁止只放行旧版本号后把旧数据交给当前严格 Schema。
- 支持窗口内的旧版本必须提供静态注册的相邻迁移、协议协商或等价升级链。`fail closed` 只是损坏数据、
  未来版本和缺失迁移的安全兜底，不是升级策略。
- 业务 parser 只处理当前 Schema；历史 Schema 和字段转换放在迁移模块。废弃或错误字段可以由迁移显式
  删除，但必须记录决策、保留升级前备份并验证结果，不得静默丢弃，也不得为此保留长期业务兼容分支。
- Host 必须在首次访问最小 owner 时、进入该 owner 的业务读取前执行必要升级；禁止为了发现潜在旧数据
  在应用启动阶段扫描或升级全部 owner、Project 或 Revision。持久化升级使用锁、稳定 journal、备份、
  原子替换和可重放恢复；失败时保留原数据并提供可操作诊断。除非共享全局状态无法安全初始化，单个
  owner 或 Revision 升级失败不得阻断无关项目、对象、能力或应用启动。
- Desktop 必须先完成必要存储根初始化和 IPC 装配并创建窗口，再启动 Automation、Usage reconciliation、
  Runtime/Bundle warm-up 等后台工作。启动路径不得执行全量 storage maintenance；容量检查在写入闸门
  中按需执行。不要为此引入通用 readiness registry 或全局升级 coordinator。
- 升级测试必须使用由真实历史代码写出的 fixture，不得用当前对象只改版本号伪造。Pull Request 至少
  覆盖历史 fixture、当前版本 no-op、相邻和链式升级、崩溃恢复、未来版本拒绝以及升级后的启动/执行；
  缺少任一适用场景时不得合入。
- 删除仍在支持窗口内的升级链属于兼容性 cutover，必须另写 ADR，并提供导出、备份或离线升级方案。

## 运行环境边界

`shared` package 必须同时支持浏览器和 Node，不允许引入运行环境专属依赖。

在 `packages/shared` 中禁止导入：

```text
node:fs
node:path
node:child_process
node:worker_threads
@prisma/client
react
next
fastify
```

`apps/web` 与 `packages/client` 必须保持浏览器安全，不允许访问数据库、Agent、Node 内置模块。

`packages/server` 和 `packages/core` 是 Node-only，不允许依赖 React、Next 页面或 UI 包。

Server 与 Agent 的关系：

- Server/Worker 负责接收请求、创建运行、权限校验、调度 Playbook、记录 Trace、管理成本和治理流程。
- Core 负责定义专家能力、输入输出协议、Invocation、Runtime Adapter 合约，以及默认云端沙箱执行抽象。
- Core 通过可选 `UsageSink` 发出逐 Runtime turn 的 token observation，但不持久化跨 Execution
  的统计账本；Desktop/Server 等 Host 负责统计持久化、保留和查询策略。
- 所有 Token 数量预估必须调用 `@pragma/core` 导出的统一 `RuntimeTokenCounter`。具体 Runtime、
  Desktop、Server、Worker 或插件不得自行实现 chars/token、bytes/token、CJK 修正或其他 Token
  估算算法。Runtime 提供精确上报时必须优先采用上报值；只有缺少上报时才能调用统一计数器。
- 结构化消息的供应商协议序列化留在具体 Runtime，序列化后的文本统一交给
  `RuntimeTokenCounter`。统一 fallback 在 Core 中懒加载应用内安装的 tokenizer；不得把词表复制到
  Runtime package，不得从 CDN 下载并执行远程代码，也不得要求终端用户配置 tokenizer 环境变量。
- 新 Runtime 必须测试 Runtime 上报优先级和统一 Token 估算 fallback。代码评审发现新的 Runtime
  本地 Token 估算器时，按架构边界违规处理。
- Server/Worker 可以调用 Core；Core 不应该反向调用 Server 应用层。
- 本地 Claude Code、Codex、Qoder CLI、Antigravity CLI、自研执行环境属于 Runtime Adapter 的实现目标，由 Desktop App 承载本地连接、授权和执行桥接，不改变 Server 调度 Agent 的依赖方向。

本地存储边界：

- Agent workspace 只保存任务明确需要的 repository、input、artifact 和 Agent 主动创建或修改的文件。
- Desktop 内置默认 workspace 固定为 `~/.pragma/workspace/`，位于 `.pragma` 根目录，不得放入 `data/`。
- Runtime Session、Runtime 配置和插件安装副本不得写入 workspace。
- 权威数据存放在 `~/.pragma/data/`，可恢复运行状态存放在 `state/`，有界诊断归档存放在
  `archives/`，可重建内容存放在 `cache/`；`tmp/` 与 `trash/` 使用短期保留策略。
- Trash 只清理已完成且 journal 合法的删除项，固定按七天、总计 300 MiB、最多十项三个上限中
  最先达到者淘汰；Desktop 在首个窗口创建后及成功删除 owner 后触发定向维护，不在启动时扫描全部 owner。
- ExpertSession、Execution 与 Runtime Session 分别存放在 `~/.pragma/state/expert-sessions/`、`~/.pragma/state/executions/` 和 `~/.pragma/state/runtime-sessions/`。
- Execution 大输出通过 Host 注入的 Context overflow target 持久化；Desktop 使用 Mission Board 的
  `system/outputs/`。workspace 文件交接只在白板保存受控相对路径引用，不复制文件。
- Project Revision 只保存不可变 manifest 和 Merkle `snapshotHash`；文件实体全局去重到
  `~/.pragma/data/objects/sha256/`，所有 Revision 在 Project 删除前都是强引用根。
- Project Revision 的 compiler 升级不得改写权威 Revision、重发全部历史或改变 revision number；
  Host 在目标 Revision 首次访问时调用 Interpreter 的纯迁移链，并将结果保存为按源快照、源/目标
  compiler version 和迁移链版本寻址的可重建缓存。单个 Revision 升级失败只使该 Revision 不可用。
- Agent 插件按 package fingerprint 全局缓存到 `~/.pragma/cache/plugins/sha256/`；
  `cache/agents/<agentId>/` 只保存绑定元数据，不复制插件包。
- Codex 使用最小化 Runtime Context 私有 Home：sessions、SQLite、日志、配置和 Agent Skills
  不得跨 Context 共享，`CODEX_SQLITE_HOME` 必须指向私有目录。宿主
  `~/.codex/plugins/cache` 作为可重建缓存可以直接链接共享；不得复制或扫描完整
  `plugins`、`packages`、通用 `cache` 或宿主 sessions 树。
- Qoder CLI 新建 Runtime Session 将整个 `external-commands` 目录链接到
  `~/.pragma/cache/runtimes/qodercli/external-commands/`；认证、Project、日志和 Session 状态继续私有。
  已有 Session 的本地 `external-commands` 目录不得在启动时扫描、迁移或替换；Pragma 只清理共享缓存中
  已完成的 `download-*` 与无活动锁保护的过期 `.tmp-*`。
- Antigravity CLI 认证使用显式双模式：启用官方 `AGY_ADC_AUTH` 时使用完整私有 `HOME`；使用交互式
  OAuth 时允许 `host-keyring` 兼容模式保留宿主 `HOME`，因为 agy 1.1.11 在替换 `HOME` 后不会读取操作系统
  钥匙串。兼容模式不得由 Pragma 向宿主 `~/.gemini` 复制或物化配置；Pragma Agent、Hook、MCP 与 Skills 必须物化到
  Runtime Session 私有的额外 `.agents` workspace，并使用唯一 namespace。兼容模式会按 agy 原生语义共享
  宿主 settings、全局 customization 与 native Session 存储，必须在架构文档和诊断中明确披露；恢复只能按
  已拥有的 conversation ID 定向读取，不得扫描宿主 Session 树。PreToolUse relay 凭据只能写入 Session
  私有 hook 文件，不得暴露给 agy 进程环境及其子 shell。
- Runtime 进程停止不等于持久数据删除。Mission 删除必须按 owner 图级联移动 ExpertSession、
  Execution、Runtime Session 和 ownership claim 到带 journal 的回收站。
- 外部 ID 目录段统一通过 `@pragma/core` 的 `PragmaPaths` 编码和解析，具体 Runtime 或插件 loader 不自行拼接管理路径。
- 每个 Runtime Session 必须由 ExpertSession context 或 FlowExecution Invocation 明确拥有；恢复还必须提供原 `systemSessionId` 和 `RuntimeSessionRef`。
- Core 必须通过原子 ownership claim 保证 `systemSessionId` 只有一个 owner；不要用“先扫描再写入”的 TOCTOU 检查代替原子声明。
- Execution、ExpertSession、Runtime Session 等可恢复持久状态升级时，必须遵循 ADR 019：
  当前 storage major 内提供相邻版本的前向迁移，在 aggregate file lock 内首次读取时执行；
  多文件迁移先写稳定 journal，再原子替换目标文件，未完成 journal 必须可重放。业务代码只读取当前
  Schema，不保留历史字段分支。新版本数据和没有迁移链的旧版本必须 fail closed，不得猜测、静默删除
  或自动降级。
- 持久状态 Schema 升级必须同时提交旧版本 fixture、当前版本 no-op、崩溃恢复和未来版本拒绝测试；
  删除旧迁移链属于 storage-major cutover，必须另写 ADR 和导出/备份方案。DSL 版本兼容与本地运行状态
  兼容是两个独立边界，不得用同一个版本开关处理。
- Core 持久状态迁移统一放在 `packages/core/src/storage/migrations/<family>/`；历史 Schema 放入
  `schemas/vN.ts`，相邻迁移放入 `steps/vN-to-vN+1.ts`，`index.ts` 只做静态、有序注册。不得把多个
  版本继续堆在 Store 文件中，不得从最新 aggregate Schema 派生历史 Schema，也不得运行时动态扫描
  或执行迁移模块。
- 任何可恢复持久状态的 `schemaVersion` 升级，都必须在同一个改动中补齐对应的升级脚本；禁止只修改
  当前 Schema 或版本号。升级脚本必须是 `steps/vN-to-vN+1.ts` 相邻迁移，并在该 family 的
  `index.ts` 中静态注册；如果业务 transaction journal 内嵌了被升级对象，还必须同步升级 journal
  Schema 和迁移链。
- 持久状态 Schema 升级的 Pull Request 必须同时包含旧版本 Schema 快照、旧数据 fixture、升级后
  fixture、当前版本 no-op、跨版本链式升级、未完成 journal 重放和未来版本拒绝测试。缺少任一必要
  迁移脚本或测试时，不得合入。

## 本地 Agent 桥接规范

未来本地 Agent 通过 Desktop App 接入云端，不设计 `apps/local-runner`。

推荐链路：

```text
Cloud Server / Worker
→ Runtime Gateway
→ 双向安全连接
→ Desktop App
→ Local Permission Guard
→ Local Agent Adapter
→ Claude Code / Codex / Qoder CLI / Antigravity CLI / 自研本地 Agent
```

云端职责：

- 维护用户、租户、设备、会话和本地能力注册。
- 创建 ExpertRun / PlaybookRun。
- 校验权限、预算、输入输出 schema。
- 选择云端 Runtime 或本地 Runtime。
- 通过 Runtime Gateway 向在线 Desktop App 下发运行请求。
- 接收运行事件、日志、diff、artifact 和最终结构化结果。
- 记录 Trace、成本、审计、取消和超时状态。

Desktop App 职责：

- 负责用户登录、设备绑定、本地工作区选择。
- 主动连接云端，避免云端直接访问用户机器或要求本机暴露公网端口。
- 注册本机可用 Runtime 能力，例如 Claude Code、Codex、Qoder CLI、Antigravity CLI、自研本地 Agent。
- 承载本地权限闸门，包括文件读取、文件写入、shell、网络、secrets、git 操作。
- 调用本地 Agent，并把过程事件流式回传云端。
- 在需要时展示本地确认 UI，例如执行 shell、修改文件、读取敏感目录。

通信方式优先级：

1. Desktop App 主动建立 WebSocket 或等价双向安全通道。
2. 在企业网络限制下，可降级为 App 主动轮询云端任务。
3. 不要求云端直连本机端口。
4. 不把本地执行能力实现成 `apps/local-runner` CLI。

桥接协议应放在：

```text
packages/core/src/local-agent-bridge
```

云端会话和任务下发能力应放在：

```text
packages/server/src/runtime-gateway
```

Desktop App 自身未来放在：

```text
apps/desktop
```

新增这些目录前必须先补 ADR、边界规则和最小可验证实现方案。

## 各目录职责

### `apps/web`

职责：

- 页面与路由。
- 浏览器状态。
- 调用 `@pragma/client`。
- 展示 API 数据。
- 为每个页面提供完整的多语言支持，包括 Home 页面；禁止新增仅支持单一语言的页面。

允许依赖：

```text
@pragma/shared
@pragma/client
```

禁止依赖：

```text
@pragma/server
@pragma/core
node:*
@prisma/client
服务端 Repository
```

### `apps/server`

职责：

- HTTP API。
- 健康检查。
- 输入校验。
- 后续承载鉴权、元数据、任务创建、Playbook 运行创建、专家 Agent 调度入口。

允许依赖：

```text
@pragma/shared
@pragma/server
@pragma/core
```

禁止依赖：

```text
@pragma/client
React / Next / Web UI 包
```

当前 API：

```text
GET /health
```

返回：

```json
{
  "service": "server",
  "status": "ok"
}
```

### `apps/worker`

职责：

- 异步任务进程入口。
- 后续承载 Agent、Playbook、Runtime、评测执行。

启动后输出：

```text
Pragma Worker Ready
```

暂不接队列。

### `apps/desktop`

职责：

- Electron 主进程、本地存储和 Runtime 装配。
- preload IPC Bridge。
- renderer 页面与本地权限确认 UI。

边界要求：

- main 可以依赖 Desktop 允许的 Core、Interpreter、Built-in Agents 和具体 Runtime。
- preload、renderer 和跨层 shared 代码只允许依赖 `@pragma/shared` 与浏览器安全的
  `@pragma/interpreter/ast`、`@pragma/evaluation/ast`、`@pragma/built-in-agents/contracts`，不得导入
  Interpreter 或 Built-in Agents 主入口及其他 Node-only `@pragma/*` package。
- preload 使用的 workspace TypeScript 必须在构建阶段完成转换；生产产物必须自包含，运行时只允许外部加载
  Electron 和 Node 内置模块，不得直接加载仓库 `.ts` 文件。
- Electron main 必须在构建阶段编译所有直接依赖的 workspace package。`electron.vite.config.ts` 的
  `externalizeDeps.exclude` 必须从 `apps/desktop/package.json` 的 `workspace:` 依赖自动派生，不得维护手工
  package 名单；新增内部依赖后，构建产物中不得残留任何外部 `@pragma/*` import，避免 Electron 在运行时
  直接解析 workspace package 导出的 TypeScript 源码。
- Desktop build 必须验证 preload 产物和 `pragmaDesktop` Bridge 注入；Bridge 或 renderer 启动失败时必须记录
  主进程日志并显示可操作的错误页，不得静默白屏。
- Desktop 本地 Capability、ContextStore 与 RuntimeProfile 的 Host 绑定资源统一通过
  `apps/desktop/src/main/platform/bindings/desktop-bound-resource-policy.ts` 分类、创建和重绑定；Feature
  模块不得各自派生 ID、重建 metadata 或按资源数组顺序选择身份。该策略属于 Desktop Host，不下沉到
  Core、Shared 或 Interpreter。
- ready Capability 新修订必须通过 Desktop Capability revision coordinator 激活：先验证当前 Expert 的
  工具白名单，再以稳定 journal 更新当前 Project 的全部绑定和 System Expert customization。历史 Project
  Revision、Mission、Execution 与旧 Capability revision 保持固定；`needs_attention` 修订不得自动激活。

### `packages/shared`

职责：

- Zod Schema。
- DTO。
- API Request / Response Schema。
- 跨进程事件协议。
- 未来 Expert Manifest、Playbook 协议。
- 纯领域模型。
- 纯状态机。
- 枚举。
- 值对象。
- 业务规则。
- 跨端纯函数。
- 字符串、时间、Result/Error、ID 等工具。

要求：

- 协议必须使用 Zod 定义运行时 schema。
- TypeScript type 必须从 schema 推导。
- 不要只写 interface 而没有运行时校验。

禁止外部服务访问、Node 专属 API、client/server/core 反向依赖。

### `packages/client`

职责：

- HTTP Client。
- 后续 SSE Client。
- 后续认证 Header 注入。
- API 错误转换。

已公开接口包括：

```text
ServerClient.getHealth()
```

禁止 React Hook、页面逻辑、数据库逻辑、Agent 执行逻辑。

### `packages/server`

职责：

- 数据库抽象入口。
- 后续 Prisma Client、Repository、Migration 的边界。

已公开数据库边界包括：

```text
DatabaseClient
createDatabaseClient()
```

引入 Prisma、迁移或具体 Repository 前，必须先明确数据库职责边界、迁移策略和调用方验证路径。

### `packages/core`

职责：

- Expert Agent 声明、Run Request / Result 协议。
- ExpertAgent 公共实现，包括上下文系统、AGENTS.md 加载、subAgent 声明和系统提示词组装。
- RuntimeAdapter 与 RuntimeAgentSession 核心接口。
- RuntimeResolver、不可变 Runtime Environment binding、运行事件、会话、取消、错误等公共运行协议。
- 未来本地 Claude Code、Codex、Qoder CLI、Antigravity CLI、自研执行环境通过独立 Runtime Adapter 包对接。

当前保留：

```text
ExpertAgent
ContextSystem
ContextManager
RuntimeAdapter
```

Expert API 设计要求：

- `defineExpert()` 是单专家唯一创建入口，负责异步插件加载、inline plugin entry 合并、日志初始化和实例归一化。
- `createAgentLauncher()` 为普通 Expert 创建可显式注入的 `spawn_expert`、`wait_experts`、
  `list_agents`、`followup_expert`、`steer_expert`、`interrupt_expert` 工具集；子 Invocation 的执行、Context、
  并发、深度、事件和 Usage 机制必须与 ExpertTeam 共用，不另建隐藏 Session 路径。
- `defineExpertTeam()` 声明由 coordinator 统一接收外部 prompt 的特殊 Expert。
- ExpertTeam 运行时按成员权限策略生成相同的生命周期工具集；coordinator 在当前 Team Execution 内
  拥有系统继承的全量管理权限。团队工具覆盖参与者自己的 standalone launcher，
  防止成员绕过团队治理边界。
- `defineFlow()` 声明 Flow；Task 和 HumanTask 只能通过 FlowSpec 内联创建。
- Flow Expert step、普通 Expert launcher 与 ExpertTeam delegation 必须统一使用具名、带版本的
  `ContextIdResolver`；是否复用只由最终 `contextId` 决定，不引入 `fresh/reuse` policy。
- Runtime Context 的 identity、snapshot 和 lifecycle 只存放在 `RuntimeContextRecord`；Invocation 与
  AgentInstance 只引用 `contextId`，不得复制 Runtime snapshot。
- ExpertSession 创建时必须同时创建唯一根 Runtime Context；同一 Session 的所有根 prompt 始终复用该
  Context，需要 fresh root 时创建新的 ExpertSession。根 Context 是固定 Session binding，不属于 delegation，
  不调用 `ContextIdResolver`。
- Runtime routing 必须先完成并写入新 Context 的必填 `runtimeId`；执行时只读取
  `RuntimeContextRecord.runtimeId`，Session、Invocation 和 snapshot 不复制 Runtime identity。
- `ownerContextId` 是子 Agent 生命周期工具的权限边界；`createdByInvocationId` 只用于审计和树关系。
- PragmaApp 只公开 `experts` 与 `flows` 两个执行 namespace。
- Flow 循环控制状态必须随 Execution 持久化，保证恢复幂等。

不要引入 `@pragma/interpreter`、具体 Claude SDK、Codex SDK、PI SDK、具体 runtime 包、Playbook、HTTP Controller、数据库实现或 Server 应用层实现。

禁止引入 Server 应用层、Client SDK、React / Next Web UI、数据库实现或 Desktop 本地权限 UI。

### `packages/memory`

职责：

- 将 Core 的持久 Canonical Event Feed 适配为版本化 Memory Evidence。
- 定义静态 Memory Module registry、独立 checkpoint/retry/dead-letter 调度和 Module 健康诊断。
- 提供只读的联邦 `memory` Context Store；Episodic、Semantic 和其他动态投影由独立 Module 拥有。
- Memory 可以产生 Knowledge promotion 或 Store revision 候选，但用户批准后的 Knowledge authority 属于
  Desktop“工作室 → 知识库”的托管 Context Store，不属于 `@pragma/memory`，也不依赖 Memory Evidence。

边界要求：

- 主入口是 Node-only，可以依赖 `@pragma/shared` 和 `@pragma/core`。
- `@pragma/core` 不得反向依赖 `@pragma/memory`；Core 的 Canonical Event Bus 必须保持 Memory 无关。
- Module 静态注册，不扫描目录；Module id、版本和 Context prefix 必须唯一。
- Module 不直接写另一个 Module Store，只通过版本化 Evidence/derived event 协作。
- Memory Module 不直接改写 Studio Knowledge Store；它只能向 Host 通用 Store Revision 能力提交修订提示词。
  内置 Store Revision Agent 加载目标 Store 与提示词产生 change set，用户批准后才激活新 Store revision。
- Memory 存储治理使用 `@pragma/memory` 的固定版本化 policy；Feed 只能在所有注册 consumer 的最小
  checkpoint 之前清理，落后 consumer 固定的数据必须报告 degraded/blocked，不能为满足容量目标越过
  checkpoint 删除。
- 每个 Module 的待提炼 Evidence、curator prompt、失败 payload、job diagnostic 与 dead letter 必须有
  硬上限或固定保留期；应用启动不得自动唤醒 `needs_attention`，只能由匹配的配置修复或用户显式 CAS
  retry 触发。
- Mission 删除只清理关联 Execution 的 Feed、job、Evidence、subject context 等 transient state，并使用
  稳定 journal 保证可重放；已经提炼的 Episode/Fact 是独立治理的长期 Memory，不随 Mission 自动删除。
- Mission Board、TODO 与专家团白板不是 Memory Plane 的必需输入，但它们仍是独立的 Host
  内置短期协作能力。共享条目按 Mission 授权，私有条目按稳定 Runtime Context
  隔离；已提交变化可以发布 Evidence，但不得让私有内容在提炼、handoff 或导出时自动扩大可见性。

禁止依赖 Interpreter、具体 Runtime、Expert plugin、Desktop UI、Server 应用层或 Client SDK。

### `packages/interpreter`

职责：

- 定义 `Expert`、`ExpertTeam`、`Flow`、`Capability`、`ContextStore`、`RuntimeProfile` 的
  `pragma/v3` YAML DSL AST 与 Zod Schema。
- 负责 YAML 解析、跨文件 import/include、引用链接、静态校验和 lock 校验。
- 负责纯内存、相邻版本、前向迁移的 DSL migration chain；Host 负责文件或数据库事务、备份和持久化，
  不重复实现 DSL 字段、身份或引用转换。
- 将 DSL 编译为 `@pragma/core` 的 Expert、ExpertTeam、Flow 对象实例。
- 提供 Tool Adapter、Flow Action、Context Policy、Serializer 等具名版本 registry。
- 保存编译 provenance，并将实例通过 `dump()` 恢复成规范化 DSL。

边界要求：

- 主入口 `@pragma/interpreter` 是 Node-only，可以依赖 `@pragma/shared` 和 `@pragma/core`。
- `@pragma/interpreter/ast` 必须保持浏览器安全，只导出 Schema 和从 Schema 推导的类型。
- `core`、`shared`、具体 runtime 和 plugin 不得反向依赖 `interpreter`。
- 不要新增 `defineExpertFromManifest`、`defineExpertTeamFromManifest` 或 `defineFlowFromManifest`。
- Expert 对 Expert、ExpertTeam、Flow 的引用必须声明具名、带版本的 Tool Adapter；内置
  `pragma.tool.call@v1` 与 `pragma.tool.delegate@v1`，新增语义通过 registry 扩展。
- Flow 普通边必须保持 DAG；回边只能使用具名 `repeat` transition，并声明正整数
  `maxIterations`。
- `apiVersion` 专指 DSL 语言版本；`schemaVersion` 专指 Host 或运行状态序列化格式；
  `revision` 专指不可变项目内容序号。三者不得共用迁移开关。
- Interpreter 普通 parser/compiler 只接受当前 DSL；旧版本必须先经过静态注册的相邻迁移链。
- 删除仍在支持窗口内的旧 DSL 迁移步骤属于兼容性 cutover，必须另写 ADR，并提供导出、备份或离线升级路径。
- Project Revision 的 Interpreter 兼容能力统一由 `@pragma/interpreter/ast` 导出的 compiler capability
  声明，并分别列出 write version、direct-read versions 和 upgrade-from versions；Lock、Blueprint
  cache、Desktop IPC 和 Mission 编译不得各自维护版本常量。
- 修改闭合资源联合、严格资源 Schema，或新增会拒绝既有 Revision 的 portable validator 时，必须
  升级 compiler write version，并在同一改动中提供历史 Schema、相邻升级步骤、Host 事务迁移和真实
  新旧版本 fixture；不得把“可迁移”版本声明成“可直接读取”。
- `PragmaProject.validate()` 是全项目健康检查；执行入口使用目标资源及其传递依赖闭包校验。无关资源
  诊断不得阻断独立执行器，compiler、lock、source topology 和资源身份歧义仍然全局 fail closed。

禁止引入具体 Runtime Adapter、Desktop UI、Server 应用层、数据库实现或 Client SDK。

### `packages/evaluation`

职责：

- 定义独立 `Evaluation` 资源、Run Dry case、mock、assertion 和结果协议。
- 执行 Flow Run Dry 测评，并输出用例断言与转换覆盖率。
- 为未来测评方式提供独立扩展边界，不把测评生命周期重新嵌入 Flow。

边界要求：

- 主入口 `@pragma/evaluation` 是 Node-only，可以依赖 `@pragma/core`。
- `@pragma/evaluation/ast` 必须保持浏览器安全，只导出 Schema 和推导类型。
- `Evaluation.spec.target.ref` 关联被测资源；Flow 不得包含 `spec.runDry`。
- `expectInput` 对所有节点统一表示 case 原始 Flow input；渲染后的 Expert、Team、Human prompt
  使用独立 `expectPrompt`。

禁止依赖 `@pragma/interpreter`、具体 Runtime Adapter、Desktop UI、Server 应用层、数据库实现或 Client SDK。

### `packages/built-in-agents`

职责：

- 保存六个内置 Agent 的 `pragma/v5` DSL，以及 Pragma 的 `author-pragma-dsl` Skill。
- 分别导出 Pragma、Memory Curator、Store Revision、Skill Revision 和 Skill Evaluation 的宿主端口；调用方式允许彼此独立。
- 拥有跨 Host 可复用的提示词、结构化输出解析、Memory 提炼、Store/Skill 修订规则、Skill 验证和纯状态机。
- 导出供 Desktop 或未来 Host 适配的运行时中立契约。
- 不拥有独立 ExpertSession、聊天历史或审批投影；宿主统一复用 Mission/Execution 链路。

边界要求：

- 主入口 `@pragma/built-in-agents` 是 Node-only，可以依赖 `@pragma/core` 和 `@pragma/interpreter`。
- `@pragma/built-in-agents/contracts` 必须保持浏览器安全，只依赖运行时中立 schema。
- Pragma 是默认存在且可交互的通用 Agent；另外四个系统 Agent 为隐藏、不可定制的托管能力。
- Pragma 修改 Expert、ExpertTeam 和 Flow 时只通过 DSL 能力；应用层实现持久化与任务端口。
- Desktop 将 Pragma 注册为只读系统专家；Home 只负责创建全新 Mission，不维护独立 Chat。
- Home 为 Expert/ExpertTeam Mission 提供可选的模型与思考深度覆盖，并随 Mission 持久化；Home
  不允许覆盖 Runtime，Flow 不接受模型或思考深度覆盖。
- 宿主端口使用直接 TypeScript 接口；具体 Runtime 可继续通过现有 Execution MCP Gateway 调用 managed tools。

禁止依赖 Desktop/Electron、React、Server 应用层、Client SDK、数据库实现或具体 Runtime Adapter。

## TypeScript 与导入规范

根配置是 `tsconfig.base.json`，package 应继承 `@pragma/tsconfig/base.json`、`node.json` 或 `web.json`。

源码内部相对导入使用 `.ts` 扩展名，TypeScript 构建时会重写为 `.js`：

```ts
export * from "./health.schema.ts";
```

不要手写跨 package 相对路径。

类型导入优先使用 `import type`：

```ts
import type { ExpertAgent } from "@pragma/core";
```

## Package 标准

每个 package 必须：

- `private: true`
- `type: "module"`
- 使用 `exports`
- 提供 `lint`、`typecheck`、`test`、`build`、`clean`
- 内部依赖使用 `workspace:*`
- 能独立 lint 和 typecheck

标准命令：

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "lint": "eslint src",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "clean": "rm -rf dist"
  }
}
```

Web、tooling 等特殊 package 可以按实际工具调整，但必须保留同名脚本。

## 本地运行手册

首次安装：

```bash
pnpm install
```

查看 workspace：

```bash
pnpm -r list
```

启动 Server：

```bash
pnpm --filter @pragma/server-app dev
```

验证 Server：

```bash
curl http://localhost:3001/health
```

启动 Web：

```bash
pnpm --filter @pragma/web dev
```

访问：

```text
http://localhost:3000
```

页面应显示：

```text
Pragma Web Ready
Server health: ok
```

启动 Desktop：

```bash
pnpm --filter @pragma/desktop dev
```

使用内置 Qoder CLI Runtime 前，主机必须已安装可直接执行的 `qodercli`。可先运行
`qodercli --version` 验证；认证可复用本机已完成的 Qoder CLI 登录状态，或通过
`QODER_PERSONAL_ACCESS_TOKEN` 提供 PAT。非标准安装路径使用 `QODERCLI_PATH` 指向原生可执行文件。

使用内置 Antigravity CLI Runtime 前，主机必须安装可直接执行的 `agy` 1.1.11 或更高版本；可先运行
`agy --version` 验证。认证复用操作系统安全钥匙串中的 Antigravity CLI 登录状态，首次登录应在 Pragma
外部交互执行 `agy`；非标准安装路径使用 `AGY_PATH` 指向原生 `agy`/`agy.exe`，不要指向 Windows
`.cmd` shim。Runtime 不读取或复制宿主 `~/.gemini` 配置。

新增 Runtime 或提升既有 Runtime capability 前，必须逐项完成
[`docs/conventions/runtime-adapter-integration-checklist.md`](docs/conventions/runtime-adapter-integration-checklist.md)，
并为每项保留代码、自动测试和真实 Runtime smoke 证据；配置落盘或 mock 成功不能单独证明 capability 可用。

> **Electron 42 注意事项：** 从 Electron 42 开始，`postinstall` 不再自动下载 Electron 二进制文件，改为首次运行 Electron CLI 时才下载。Desktop 的 `predev` 会通过 `prepare:electron` 调用 `install-electron`，避免新成员首次 `dev` 时遇到缺失二进制的错误。

启动 Worker：

```bash
pnpm --filter @pragma/worker dev
```

应输出：

```text
Pragma Worker Ready
```

常用质量命令：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

`pnpm check` 只包含 lint、typecheck、test；CI 还会额外执行 build。

## 质量检查与桌面发行

当前仓库默认使用 GitHub Actions workflow 完成桌面发行。Pull Request、合并和桌面发行前由协作者在本地执行：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

桌面版本默认通过 `.github/workflows/desktop-release.yml` 在推送符合版本格式的 Tag 后完成原生打包、Tag、GitHub
Release 和产物上传。仅在离线网络限制、特殊调试或明确指定本地打包时，才使用 `apps/desktop` 的
`release:desktop` 脚本。详细流程见 `docs/usage/desktop-distribution.md`。

质量检查必须在以下情况失败：

- TypeScript 报错。
- ESLint 报错。
- Vitest 失败。
- build 失败。
- 非法跨层 import。

## ESLint 边界验证

ESLint 规则在根目录：

```text
eslint.config.mjs
```

以下非法 import 必须被拦截：

```ts
// apps/web 中禁止
import "@pragma/server";

// packages/shared 中禁止
import "node:fs";

// packages/core 中禁止
import "@pragma/client";

// packages/core 中禁止
import "@pragma/runtime-pi";

// packages/core 中禁止
import "@pragma/interpreter";
```

可以用 stdin 临时验证，不要提交非法测试文件：

```bash
printf 'import "@pragma/server";\n' \
  | pnpm exec eslint --stdin --stdin-filename apps/web/src/illegal.ts
```

## 开发流程

1. 先判断改动属于哪一层。
2. 检查目标层是否允许依赖被引用的 package。
3. 优先复用已有 package 和现有导出。
4. 需要跨 package 调用时，先在被依赖 package 的 `src/index.ts` 中导出公共 API。
5. 使用 `@pragma/*` package import。
6. 补充或调整类型、schema、最小测试或文档。
7. 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test:core`（或单模块测试）。
8. 如果改动影响构建或应用入口，运行 `pnpm build`。

## 自动化测试与单测治理规范

- **分级测试机制**：CI、Release 及默认构建流程统一使用 `pnpm test:core`（核心快速测试），全量验证耗时必须控制在几十秒以内。
- **`test:core` 边界**：仅允许包含核心协议/契约（`@pragma/shared`）、核心架构与领域模型（`@pragma/core`）、DSL 编译解析（`@pragma/interpreter`）及最小 Bootstrapping 断言。严禁将大文件 I/O 模拟、带长时间 setTimeout/sleep 的异步流程或全量状态机集成测试放入 `test:core`。
- **谨慎运行全量测试**：日常开发与常规 CI 禁止无脑运行全量测试（`pnpm test:all`）。开发者在本地开发或调试时，原则上只跑自己改动到的模块单测（例如 `pnpm --filter @pragma/core test` 或直接执行具体 `*.test.ts` 文件）。
- **单测只加不删的治理原则**：禁止“单测只加不删”。当重构、废弃旧功能或发现冗余、重叠的断言时，必须同步清理或合并对应单测。发现已经弃用且没有长期价值的测试代码，应直接删除，避免测试代码无限膨胀与耗时堆积。

## 修改代码时的注意事项

- 不要把共享逻辑放进 `apps`。
- 不要为了绕过 ESLint 使用相对路径跨 package 导入。
- 不要在 `shared` 中使用 Node API。
- 不要在 Web 或 SDK 中使用数据库、Core 或 Node 内置模块。
- 不要在 Server 或 Core 中引入 React、Next 页面或 UI 包。
- 不要保留没有长期价值的空实现、废弃字段或迁移期分支。
- 不要新增未来能力 package，除非当前任务明确要求并同步更新 ADR、边界文档和验证路径。
- 不要提交 `node_modules`、`dist`、`.next`、`.turbo`、coverage 等构建产物。
- 开发、调试、设计审查和 UI 验收过程中产生的截图属于临时产物，未经任务明确要求不得擅自提交；完成后应从工作区移除或存放到仓库外。

### UI 输入控件约束

Desktop renderer 的新增与修改必须遵循
[Desktop UI 开发规范](./docs/conventions/desktop-ui.md)。该规范定义了颜色、字体、字号、字重、间距、
圆角、边框、阴影、页面骨架和视觉验收要求；不得用页面局部样式重新发明这些值。

- 组合输入框只能有一层可见边界。外层容器已经提供 `border`、`box-shadow` 或
  `:focus-within` 焦点环时，内部的 `input`、`textarea`、`select` 必须去掉自身的
  `border`、`outline` 和焦点阴影，禁止出现“外部容器边框套内部输入框边框”的双框效果。
- 新增或修改全局 `:focus` / `:focus-visible` 规则后，必须检查组合输入框是否被级联样式重新加上
  内框；必要时为内部控件添加更具体的 `:focus-visible` 重置，并保留外层清晰可见的键盘焦点态。
- 修改 Desktop UI 输入控件后，除代码检查外还必须在普通态和键盘焦点态下做视觉检查。

### UI 资源身份展示约束

- 面向用户的目录、列表、卡片、选择器、摘要和状态文案必须优先展示资源实际名称，禁止直接把语义资源
  ID 或 ref（例如 `expert:*`、`team:*`、`flow:*`、`automation:*`、`capability:*`、
  `context-store:*`、`runtime-profile:*`、`evaluation:*`）作为名称或默认次级文案。
- ID 或 ref 只允许出现在详情页的明确技术信息区、诊断、日志、复制 ID 操作或用户明确要求的开发者
  界面中，并且不能替代资源名称。
- 展示关联资源时必须先按 ref 解析实际名称；解析失败时展示本地化的“已删除”“不可用”或“未找到”
  文案，禁止回退显示原始 ID。需要消歧时使用资源类型、来源或状态等可读元数据，不得直接暴露 ID。

## 文档位置

更多背景见：

```text
docs/architecture/module-boundaries.md
docs/adr/001-monorepo-and-dependency-rules.md
docs/conventions/coding-conventions.md
```

如果本文件和架构文档冲突，以更具体、更接近当前实现的文档为准，并同步修正另一处。

## 质量验收清单

工程：

- pnpm workspace 正常识别全部 app/package。
- Turborepo 可执行 `lint`、`typecheck`、`test`、`build`。
- 根目录存在统一 TypeScript、ESLint、Prettier 配置。
- 所有 package 使用 ESM。
- 所有内部依赖使用 `workspace:*`。

应用：

- Web 可启动。
- Server 可启动并提供 `/health`。
- Worker 可启动。
- Web 可调用 Server `/health` 并展示 `status=ok`。

边界：

- `shared` 不依赖内部运行环境包。
- `client` 不依赖 `server` / `core`。
- `server` 不依赖 `client`，但可在调度场景依赖 `core` 抽象。
- `core` 不依赖 `client` / `server` / Web。
- `web` 不依赖 `server` / `core`。
- 跨 package 不使用相对路径。
- `shared` 不导入 Node、React、Prisma、Fastify。

质量：

- `pnpm lint` 通过。
- `pnpm typecheck` 通过。
- `pnpm test` 通过。
- `pnpm build` 通过。
- 非法 import 可被 ESLint 拦截。
