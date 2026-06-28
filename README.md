# ExpertMesh

ExpertMesh 是一个面向企业复杂流程的多专家 Agent 编排与发布平台。

项目目标不是构建单个通用 Agent，而是把多个具备领域知识和专业能力的专家 Agent，通过 Playbook 剧本进行编排，形成可发布、可复用、可治理的统一服务。它面向需求分析、技术方案生成、代码编写、代码评审、测试分析、业务知识问答等企业协作场景。

当前仓库以长期可扩展的多专家 Agent 架构为核心：优先保证模块边界清晰、协议可治理、运行时可替换，并在每次演进中交付完整、可验证的功能闭环。

## 核心概念

### 专家 Agent

专家 Agent 是面向特定领域或能力的智能执行单元，可以是业务领域专家、前端专家、服务端专家、测试专家、代码评审专家、需求讨论调度官等。

一个专家 Agent 不是简单的模型调用，而是一组可治理的能力封装，包括专家配置、context、技能、工具、上下文加载策略、运行时适配、权限策略、评测集和发布版本。

### Playbook 剧本

Playbook 用来描述多个专家 Agent 如何协作完成一个业务流程，包括调用哪些专家、上下文如何传递、是否需要人工审核、失败后如何重试或降级，以及最终产物如何生成。

例如，一个需求分析 Playbook 可以由需求讨论调度官、订单业务专家、会员业务专家、营销业务专家、技术影响面专家和需求总结专家共同完成。

### 运行治理

ExpertMesh 后续会在统一服务层提供权限控制、运行调度、日志追踪、成本控制、灰度发布、回滚、租户隔离和审计等能力，让专家能力可以被稳定地发布和迭代。

## 目录结构

```text
apps/
  web/       Next.js Web 应用，页面与浏览器交互入口
  server/    Fastify HTTP API 应用
  worker/    Node Worker 应用

packages/
  shared/    跨运行时协议、领域模型和纯工具
  client/    浏览器或客户端使用的 SDK
  server/    Node 服务端基础设施边界
  core/      专家 Agent 抽象、协议与运行时边界
  eslint-config/ 共享 ESLint 配置
  tsconfig/      共享 TypeScript 配置

examples/    ExpertAgent 最小使用示例
docs/        架构说明、ADR、编码约定和设计文档
infra/       后续基础设施编排目录
```

更多背景可以查看：

```text
docs/多专家 Agent 编排系统设计文档 .md
docs/architecture/module-boundaries.md
docs/architecture/expert-agent-standard-protocol.md
```

## 技术栈

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

## 模块边界

ExpertMesh 按层组织代码，跨 package 调用必须使用 `@expertmesh/*` package import。

允许的依赖方向：

```text
apps/web    -> client -> shared
apps/server -> server -> core -> shared
apps/worker -> server -> core -> shared
```

基本规则：

- 不把共享逻辑直接放进 `apps`。
- Web 和 SDK 不直接访问数据库、Agent 或 Node 专属能力。
- `shared` 包必须保持浏览器和 Node 双端安全，不依赖 React、Fastify、数据库、Agent Runtime 或 Node 内置模块。
- 跨 package 不使用相对路径导入，使用 `@expertmesh/shared` 这类 package import。
- 新增 package 前先明确它属于 `shared`、`client`、`server`、`core` 还是配置工具。

## 本地安装

```bash
pnpm install
pnpm -r list
```

## 启动应用

启动 Server：

```bash
pnpm --filter @expertmesh/server-app dev
```

Server 当前提供 `GET /health`，默认端口为 `3001`：

```bash
curl http://localhost:3001/health
```

启动 Web：

```bash
pnpm --filter @expertmesh/web dev
```

默认访问地址：

```text
http://localhost:3000
```

Web 会展示当前服务状态，并通过 SDK 读取 Server 的健康检查结果。

启动 Worker：

```bash
pnpm --filter @expertmesh/worker dev
```

Worker 启动后会初始化基础 Agent 运行上下文并输出启动状态：

```text
ExpertMesh Worker Ready
```

也可以并行启动全部带 `dev` 脚本的 workspace：

```bash
pnpm dev
```

## 运行 ExpertAgent 示例

示例代码在 `examples/`，用于展示如何直接创建 `ExpertAgent`、注入模型配置、创建 runtime session、提交任务并处理流式输出。

```bash
cp examples/.env.example examples/.env
pnpm --filter @expertmesh/examples start:basic
pnpm --filter @expertmesh/examples start:workspace-context
```

示例默认使用仓库根目录下的 `workspace/` 作为 agent workspace。上下文示例支持通过 `--workspace` 指定外部 workspace，通过 `--context` 指定 markdown 上下文目录。

详细说明见 `examples/README.md`。

## 常用脚本

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
pnpm clean
```

说明：

- `pnpm lint`：运行 ESLint。
- `pnpm typecheck`：运行 TypeScript 类型检查。
- `pnpm test`：运行 Vitest。
- `pnpm build`：执行各 workspace 的构建任务。
- `pnpm check`：依次执行 lint、typecheck 和 test。
- `pnpm clean`：清理构建产物和根目录 `node_modules`。

## Package 规范

所有内部 package 使用 `@expertmesh/*` scope，并满足以下要求：

- `private: true`
- `type: "module"`
- 使用 `exports`
- 内部依赖使用 `workspace:*`
- 提供 `lint`、`typecheck`、`test`、`build`、`clean` 脚本
- 继承共享 TypeScript 配置

当前主要 package：

```text
@expertmesh/shared
@expertmesh/client
@expertmesh/server
@expertmesh/core
@expertmesh/eslint-config
@expertmesh/tsconfig
```
