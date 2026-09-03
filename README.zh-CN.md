<p align="center">
  <img src="docs/images/pragma_launcher.jpg" width="88" alt="launcher">
</p>

<h1 align="center">Pragma</h1>

<p align="center">
  <a href="./README.md">English</a> | 简体中文
</p>

<p align="center"><strong>一次构建你的 Agent Team，到处使用。</strong></p>

<p align="center">构建跨模型与 Agent Harness 的可移植 AI Agent Team——为每项任务组合合适的模型、工具、Context 与工作流。你可以通过 Pragma 提供的 Desktop 或 CLI 直接运行；也可以不改变现有工作方式，将它接入 Codex、Claude Code 等常用 AI 工具；还可以使用 SDK 直接集成到自己的 AI 系统中。</p>

<p align="center">
  <a href="https://github.com/pqpo/pragma/releases"><img alt="最新预览版本" src="https://img.shields.io/github/v/release/pqpo/pragma?include_prereleases&label=preview" /></a>
  <img alt="项目状态：预览版" src="https://img.shields.io/badge/status-preview-F59E0B" />
  <img alt="桌面平台：macOS" src="https://img.shields.io/badge/desktop-macOS-111827?logo=apple" />
  <a href="./LICENSE"><img alt="许可证：源码可用" src="https://img.shields.io/badge/license-source--available-2563EB" /></a>
</p>

Pragma 是一个跨模型、跨 Agent Harness 的 AI-native 工作方式平台，用来把一套工作方式构建成可运行、可复用的 Agent Team。一个团队不只是 Prompt，还可以组合 Expert、ExpertTeam、Flow、工具、Skill、共享 Context、Memory、权限和人工确认。

与单一聊天工具或 Coding Agent 不同，Pragma 把 Agent Team 及其工作方式作为可移植单元。你可以用 YAML DSL 定义它，在 Desktop 中构建，通过 CLI 从终端运行，也可以使用 SDK 将同一团队嵌入自己的应用。

在一次 Mission 中，工作可以在不同专家之间持续推进，同时保留决策、产物和积累的经验。同一套团队可以为不同步骤协调不同模型与 Harness，并在统一的治理模型下管理 Context、权限、交接和执行。

<p align="center">
  <a href="https://github.com/pqpo/pragma/releases"><strong>下载</strong></a>
  · <a href="#快速开始"><strong>快速开始</strong></a>
  · <a href="./docs/usage/README.md"><strong>文档</strong></a>
  · <a href="./examples/README.md"><strong>示例</strong></a>
</p>

<p align="center">
  <img src="./docs/images/pragma_desktop_cn.png" alt="Pragma Desktop 正在运行一项多专家 Mission" width="800" />
</p>
<p align="center">
  <img src="./docs/images/pragma_expert.png" alt="Pragma Desktop running a multi-expert mission" width="800" />
</p>
<p align="center">
  <img src="./docs/images/pragma_team.png" alt="Pragma Desktop running a multi-expert mission" width="800" />
</p>


> [!IMPORTANT]
> Pragma 当前处于预览阶段。最新 Desktop Release 提供 macOS Apple Silicon 与 Intel 安装包；安装前请确认安装包来自官方 Release。

## 快速开始

### 运行 Pragma Desktop

从 [GitHub Releases](https://github.com/pqpo/pragma/releases) 下载适合当前 Mac 的安装包，安装后：

1. 打开**设置**，连接模型提供商或本机已经安装的 Runtime。
2. 选择允许 Pragma 使用的 Workspace。
3. 与 Pragma 对话，创建属于自己的 Expert、ExpertTeam 或 Flow。
4. 使用刚刚创建的专家、专家团或 Flow 开始任务，然后尽情使用。随着 Mission 不断积累，跨 Harness 动态记忆会把反复出现的经验沉淀为稳定知识与可复用 Skill。

启动 Desktop Release 时，请按以下顺序操作：

1. 先正常打开 **Pragma**。
2. 如果 macOS 阻止打开，请进入**系统设置 → 隐私与安全性**并选择**仍要打开**。
3. 仅在仍无法启动，且已确认安装包来自官方 Release 时，才清除应用的隔离属性：

```bash
sudo xattr -r -d com.apple.quarantine /Applications/Pragma.app
```

无需修改系统全局的“允许从以下位置下载的 App”设置。

[桌面发行说明](./docs/usage/desktop-distribution.md)记录了发行产物、校验和与安装流程。

### 从源码运行 Desktop

环境要求：Node.js 22 或更高版本，pnpm 10.12.1。

```bash
git clone https://github.com/pqpo/pragma.git
cd pragma
pnpm install --frozen-lockfile
pnpm --filter @pragma/desktop dev
```

### 体验 SDK 与 Runtime Adapter

仓库提供的是可以直接运行的完整示例，而不是省略关键装配的 API 片段：

```bash
# ContextStore 操作，不需要模型凭证
pnpm --filter @pragma/examples example:context

# 使用本机已安装且已登录的 Agent CLI
pnpm --filter @pragma/examples example:runtime-codex
pnpm --filter @pragma/examples example:runtime-claude-code
```

[示例指南](./examples/README.md)还包括 Expert Session、委派、ExpertTeam、Flow、人工评审闸门、MCP、Skill、Plugin、Memory、恢复与可移植 Bundle。

## Pragma 沉淀的三类资产

<p align="center">
  <img src="./docs/images/pragma_agent_cn.png" alt="Pragma 相互增强的三类资产：工作流、私有知识与私有评估集" width="800" />
</p>

### AI 工作方式

自由组合 Expert、ExpertTeam、Flow、子 Flow、工具与人工确认。每个步骤都可以绑定适合当前任务的模型、Agent Harness、权限与上下文。最终形成的工作方式可以被版本化、评测、导出和分享。

### 私有知识

Pragma 将上下文抽象为 Host 管理的 `ContextStore`，避免知识被困在单个对话产品里。不同任务、Harness 与模型产生的事件会进入统一的 Memory Pipeline，形成有证据支持的 episodic 与 semantic memory。随着动态记忆持续积累，后台任务可以按策略自动发起升级流程，将其整理为稳定知识或可复用 Skill；涉及权威知识变更时，仍需经过必要审阅后才能激活。

ContextStore 合约可以扩展。当前仓库提供 In-memory、JSON、文件系统、Mission Board 和 Memory-backed 实现；其他数据库或检索系统可以由 Host Adapter 接入。

### 私有评估集

可复用的工作流需要回归信号。Evaluation 记录真正重要的任务和预期，使 Prompt、Flow、模型、Runtime 或上下文来源发生变化时，可以在系统层验证效果，而不是只判断一次演示是否成功。

三类资产会相互增强：工作流产生证据，Memory 把证据沉淀为知识，Evaluation 判断下一次修订是否真的更好。

## 为什么使用 Pragma

- **每一步选择最合适的模型 × Harness。** 同一个模型位于 Coding Agent、浏览器 Agent 或领域工具中时，是不同的执行能力。Pragma 可以路由任务，而不把整套工作流锁定到一个厂商。
- **上下文贯穿整项 Mission。** 需求、决策、产物、评审意见和任务状态通过值或受控引用向后传递。每个 Expert 获得真正需要的上下文，不必重放全部对话。
- **自由组合，同时保留治理。** Expert、ExpertTeam 与 Flow 都可以成为步骤或受治理的工具。嵌套任务仍处于同一 Execution 中，交接、输出、审批、用量、取消和恢复形成统一审计链。
- **由人保持控制。** Flow 可以暂停并等待澄清、审批或评审；Desktop 管理本地 Workspace 访问和权限决策。
- **让工作方式跨系统移动。** `.pragma` Bundle 可以携带可移植 DSL 与选定的项目资产。Desktop 可以直接导入；其他 Host 可以通过 `@pragma/interpreter` 加载，并使用 `@pragma/core` 运行编译后的对象。

```text
Flow        = Expert + ExpertTeam + 子 Flow + 人工确认
Expert Tool = Expert + ExpertTeam + Flow
```

## 示例：一项 AI-native 研发 Mission

<p align="center">
  <img src="./docs/images/pragma_flow_cn.png" alt="AI 协作研发工作流示例" width="800" />
</p>

在这套示例配置中，UI 设计、需求讨论、技术架构、实现与独立审查分别使用不同的专家。已经确认的决策和产物会在阶段之间持续传递，有价值的事实、经验与 Skill 则可以继续服务下一项 Mission。

图中的模型与 Runtime 名称只是示例。路由属于 Host Binding，可复用的工作方式并不会与这些特定提供商绑定。

## 选择如何构建和运行 Agent Team

Pragma 提供三种使用层次：功能完整的 Desktop、从终端直接调用的 CLI，以及集成到自有系统中的 SDK。

### Desktop：最直观、配置最完整的入口

使用 Pragma Desktop 以最直观、最完整的方式构建和运行团队。你可以配置模型提供商、本地 Runtime、权限、Context、Memory、工具与 Evaluation；在 Studio 中创建 Expert 和 Flow；运行 Mission、检查结果，以及导入或导出 `.pragma` Bundle。

### CLI：从终端直接调用 Agent Team

安装 `@pqpo/pragma` 后，可以从终端发现 Expert、运行或恢复 Mission、查看结果与事件、回答 HumanTask，以及管理 Mission 队列。JSON 与 JSONL 输出为脚本和其他 Agent 工具提供稳定协议，CLI 与 Desktop 共用同一套 Local Host 应用语义。

### SDK：集成到自己的系统

将 Agent Team 保存为版本化 YAML DSL，通过 `@pragma/interpreter` 加载和编译，再在自己的应用中使用 `@pragma/core` 直接调用编译后的团队。这样可以把 Agent Team 嵌入自己的产品或 AI 系统，同时保留定义的可移植性与可审阅性。可以从[可移植 Bundle 示例](./examples/projects/bundle-transfer/pragma.yaml)和 [DSL 架构说明](./docs/architecture/pragma-yaml-dsl.md)开始；可运行的集成示例位于 [`examples/src`](./examples/src/README.md)。

## 可用能力

| 领域            | 能力                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------- |
| Desktop         | macOS Apple Silicon 与 Intel 安装包                                                   |
| CLI             | macOS 与 Windows npm package，支持人类可读、JSON 与 JSONL 输出                        |
| Runtime Adapter | Claude Code、Codex、PI、Qoder CLI 与 Antigravity                                     |
| 组合能力        | Expert、ExpertTeam、Flow、子 Flow、HumanTask 与受治理委派                         |
| Context         | In-memory、JSON、文件系统、Mission Board 与 Memory-backed Store                          |
| Memory          | Evidence Pipeline、Episodic、Semantic、Knowledge 与 Skill refinement                     |
| Evaluation      | 版本化 Evaluation 资源与 Flow Run Dry                                                 |
| 可移植性        | `.pragma` Bundle 导入、导出、校验、Binding、编译与 Git bundle source                    |
| 可恢复性        | 持久 Mission command、Execution event、Runtime Session ownership 与 Schema migration |

实现边界详见[当前架构概览](./docs/architecture/current-architecture-overview.md)。

## 文档

- [使用指南](./docs/usage/README.md)
- [Expert 与 Session](./docs/usage/agents.md)
- [Flow 与常用范式](./docs/usage/flows.md)
- [Context](./docs/usage/context.md)
- [Memory](./docs/usage/memory.md)
- [Plugin](./docs/usage/plugins.md)
- [可移植 Desktop Bundle](./docs/architecture/desktop-bundle-transfer.md)
- [Agent 架构](./docs/architecture/agent-core-architecture.md)
- [产品定位与差异化](./docs/strategy/pragma-positioning-and-competitive-differentiation.md)

## 参与贡献与获得支持

提交 Pull Request 前请阅读[贡献指南](./CONTRIBUTING.md)。可复现 Bug 和功能提案请提交到 [GitHub Issues](https://github.com/pqpo/pragma/issues)；报告安全漏洞时请遵循[安全策略](./SECURITY.md)。

## 许可证

Pragma 使用 [Pragma Source Available License 1.0](./LICENSE)。这是自定义的源码可用许可证，不是 OSI 批准的开源许可证。完整条款以许可证正文为准；其中，面向第三方提供托管服务或进行商业嵌入需要事先取得书面授权。Pragma 名称、Logo 与官方视觉标识还受到[商标政策](./TRADEMARKS.md)约束。
