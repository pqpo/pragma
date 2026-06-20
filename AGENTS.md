# AGENTS.md

本文件是给后续 Codex、Agent、自动化脚本和人类协作者看的工程说明。进入本仓库后，先读本文件，再动代码。

## 项目定位

ExpertMesh 是一个多专家 Agent 编排系统的长期工程底座。当前阶段是 Phase 0 Harness，只搭建工程结构、模块边界、质量检查和最小可启动入口。

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
  desktop/   未来 Desktop App，本地 Agent 桥接入口；当前 Phase 0 不创建

packages/
  shared/
    contracts/  跨进程、跨端协议；Zod schema 与由 schema 推导的类型
    domain/     纯领域模型、枚举、值对象、状态定义
    utils/      跨端纯函数工具
  client/
    sdk/        浏览器或客户端使用的 HTTP SDK
  server/
    database/   Node 服务端数据库边界；当前只有占位接口
  agent/
    agent-core/ Agent 抽象边界；当前只有接口
    agent-runtime/       未来 Runtime 选择、执行协议与云端运行抽象
    local-agent-bridge/  未来本地 Agent 桥接协议，不直接实现 Desktop UI
  tooling/
    eslint-config/ 共享 ESLint 配置出口
    tsconfig/      共享 TypeScript 配置

docs/
  architecture/ 架构说明
  adr/          架构决策记录
  conventions/ 编码约定

infra/
  compose/      后续基础设施编排目录，当前不接真实服务
```

未来 Desktop 本地 Agent 桥接目录规划：

```text
apps/
  desktop/             Desktop App，负责本地登录、设备绑定、权限确认、连接云端、本地 Agent 调用

packages/
  agent/
    agent-core/         ExpertAgent、RuntimeAdapter、RuntimeEvent 等核心协议
    agent-runtime/      Runtime 选择、云端沙箱 Runtime、本地 Runtime 抽象
    local-agent-bridge/ 云端与 Desktop App 的桥接协议、消息类型、能力注册模型
  server/
    runtime-gateway/    云端 Runner/Device 注册、会话管理、Run 下发、事件接收
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
.github/workflows/ci.yml
```

## Package 命名

统一使用 `@expertmesh/*` scope。

当前 package：

```text
@expertmesh/contracts
@expertmesh/domain
@expertmesh/utils
@expertmesh/sdk
@expertmesh/database
@expertmesh/agent-core
@expertmesh/eslint-config
@expertmesh/tsconfig
```

不要新增模糊名称，例如：

```text
common
core
base
shared-lib
helpers
platform
lib
```

新增 package 前，必须先明确它属于 `shared`、`client`、`server`、`agent` 还是 `tooling`。

## 模块依赖规范

下面的箭头统一表示“左侧可以依赖右侧”。

核心原则：

- `shared` 是最底层协议、领域模型和纯工具，不依赖任何运行环境层。
- `client` 是浏览器/客户端 SDK，只依赖 `shared`，不直接碰 Server 内部实现或 Agent。
- `agent` 是专家 Agent 的云端优先执行抽象和 Runtime Adapter 边界，只依赖 `shared` 和 agent 内部包，不依赖 `client`。
- `server` 是服务端控制面与基础设施层，可以依赖 `shared`、`server` 内部基础设施包，并在编排/调度场景依赖 `agent` 抽象。
- `apps/server` 和 `apps/worker` 是云端运行入口，未来由它们调度专家 Agent；不是 Agent 反过来依赖 Server。
- `apps/desktop` 是未来本地 Agent 桥接入口，主动连接云端，承载本地权限闸门和本机 Agent 调用。

```text
apps/web    -> client -> shared
apps/server -> server -> agent -> shared
apps/worker -> server -> agent -> shared
apps/desktop    -> agent -> shared
```

更具体地说：

| 来源 | 允许依赖 |
| --- | --- |
| `apps/web` | `shared/*`、`client/*` |
| `apps/server` | `shared/*`、`server/*`、`agent/*` |
| `apps/worker` | `shared/*`、`server/*`、`agent/*` |
| `apps/desktop` | `shared/*`、`agent/*`；未来可依赖 Desktop App 专属本地桥接包 |
| `packages/shared/*` | 仅 `shared/*` |
| `packages/client/*` | `shared/*`、`client/*` |
| `packages/server/*` | `shared/*`、`server/*`；编排/调度类 server package 可依赖 `agent/*` |
| `packages/agent/*` | `shared/*`、`agent/*` |

明确禁止：

```text
web -> server
web -> agent
client -> server
client -> agent
shared -> client
shared -> server
shared -> agent
agent -> client
agent -> server
server -> client
server -> web
agent -> web
```

这里的 `agent` 指专家 Agent 的执行抽象、Manifest、Invocation、Runtime Adapter 合约和云端沙箱运行边界。默认形态是云端 Agent，由 Server/Worker 调度执行。未来对接本地 Claude Code、Codex 或其他本地执行环境时，由 Desktop App 作为本地连接和权限入口，再通过 Runtime Adapter 接入 `agent` 层；不要让 `agent` 依赖 `client`、Web 或 Server 应用层。

所有跨 package 依赖必须使用 package import：

```ts
import { HealthResponseSchema } from "@expertmesh/contracts";
```

禁止跨 package 使用相对路径：

```ts
import { HealthResponseSchema } from "../../../shared/contracts/src/index.ts";
```

内部依赖版本必须使用：

```json
{
  "@expertmesh/contracts": "workspace:*"
}
```

禁止对内部依赖使用 `"*"`、固定 semver 或 npm registry 版本。

## 运行环境边界

`shared` package 必须同时支持浏览器和 Node，不允许引入运行环境专属依赖。

在 `packages/shared/*` 中禁止导入：

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

`apps/web` 与 `packages/client/*` 必须保持浏览器安全，不允许访问数据库、Agent、Node 内置模块。

`packages/server/*` 和 `packages/agent/*` 是 Node-only，不允许依赖 React、Next 页面或 UI 包。

Server 与 Agent 的关系：

- Server/Worker 负责接收请求、创建运行、权限校验、调度 Playbook、记录 Trace、管理成本和治理流程。
- Agent 负责定义专家能力、输入输出协议、Invocation、Runtime Adapter 合约，以及默认云端沙箱执行抽象。
- Server/Worker 可以调用 Agent；Agent 不应该反向调用 Server 应用层。
- 本地 Claude Code、Codex、自研执行环境属于 Runtime Adapter 的实现目标，由 Desktop App 承载本地连接、授权和执行桥接，不改变 Server 调度 Agent 的依赖方向。

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
→ Claude Code / Codex / 自研本地 Agent
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
- 注册本机可用 Runtime 能力，例如 Claude Code、Codex、自研本地 Agent。
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
packages/agent/local-agent-bridge
```

云端会话和任务下发能力应放在：

```text
packages/server/runtime-gateway
```

Desktop App 自身未来放在：

```text
apps/desktop
```

Phase 0 不创建这些目录；进入对应阶段前必须先补 ADR 和边界规则。

## 各目录职责

### `apps/web`

职责：

- 页面与路由。
- 浏览器状态。
- 调用 `@expertmesh/sdk`。
- 展示 API 数据。

允许依赖：

```text
@expertmesh/contracts
@expertmesh/domain
@expertmesh/utils
@expertmesh/sdk
```

禁止依赖：

```text
@expertmesh/database
@expertmesh/agent-core
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
@expertmesh/contracts
@expertmesh/domain
@expertmesh/utils
@expertmesh/database
@expertmesh/agent-core
```

禁止依赖：

```text
@expertmesh/sdk
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

当前只输出：

```text
ExpertMesh Worker Ready
```

暂不接队列。

### `packages/shared/contracts`

职责：

- Zod Schema。
- DTO。
- API Request / Response Schema。
- 跨进程事件协议。
- 未来 Expert Manifest、Playbook 协议。

要求：

- 必须使用 Zod 定义运行时 schema。
- TypeScript type 必须从 schema 推导。
- 不要只写 interface 而没有运行时校验。

### `packages/shared/domain`

职责：

- 纯领域模型。
- 纯状态机。
- 枚举。
- 值对象。
- 业务规则。

禁止数据库访问、HTTP、文件系统、Runtime SDK、React。

### `packages/shared/utils`

职责：

- 跨端纯函数。
- 字符串、时间、Result/Error、ID 等工具。

禁止外部服务访问、Node 专属 API、client/server/agent 反向依赖。

### `packages/client/sdk`

职责：

- HTTP Client。
- 后续 SSE Client。
- 后续认证 Header 注入。
- API 错误转换。

当前只实现：

```text
ServerClient.getHealth()
```

禁止 React Hook、页面逻辑、数据库逻辑、Agent 执行逻辑。

### `packages/server/database`

职责：

- 数据库抽象入口。
- 后续 Prisma Client、Repository、Migration 的边界。

当前不接真实数据库，只保留：

```text
DatabaseClient
createDatabaseClient()
```

不要安装 Prisma，不要创建 `schema.prisma`，不要创建迁移。

### `packages/agent/agent-core`

职责：

- 未来 Expert Agent 执行抽象。
- 未来 Expert Manifest、Agent Invocation、Agent Result、RuntimeAdapter Interface。
- 默认面向云端 Agent 和云端沙箱执行。
- 未来本地 Claude Code、Codex、自研执行环境通过 Runtime Adapter 对接。

当前只保留接口：

```text
ExpertAgent
RuntimeAdapter
```

不要引入具体 Claude SDK、Codex SDK、MCP、Playbook、HTTP Controller、数据库实现或 Server 应用层实现。

## TypeScript 与导入规范

根配置是 `tsconfig.base.json`，package 应继承 `@expertmesh/tsconfig/base.json`、`node.json` 或 `web.json`。

源码内部相对导入使用 `.ts` 扩展名，TypeScript 构建时会重写为 `.js`：

```ts
export * from "./health.schema.ts";
```

不要手写跨 package 相对路径。

类型导入优先使用 `import type`：

```ts
import type { ExpertAgent } from "@expertmesh/agent-core";
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
pnpm --filter @expertmesh/server dev
```

验证 Server：

```bash
curl http://localhost:3001/health
```

启动 Web：

```bash
pnpm --filter @expertmesh/web dev
```

访问：

```text
http://localhost:3000
```

页面应显示：

```text
ExpertMesh Web Ready
Server health: ok
```

启动 Worker：

```bash
pnpm --filter @expertmesh/worker dev
```

应输出：

```text
ExpertMesh Worker Ready
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

## CI 规范

GitHub Actions 配置在：

```text
.github/workflows/ci.yml
```

Pull Request 和主分支 push 时执行：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

CI 必须在以下情况失败：

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
import "@expertmesh/database";

// packages/shared/* 中禁止
import "node:fs";

// packages/agent/* 中禁止
import "@expertmesh/sdk";
```

可以用 stdin 临时验证，不要提交非法测试文件：

```bash
printf 'import "@expertmesh/database";\n' \
  | pnpm exec eslint --stdin --stdin-filename apps/web/src/illegal.ts
```

## 开发流程

1. 先判断改动属于哪一层。
2. 检查目标层是否允许依赖被引用的 package。
3. 优先复用已有 package 和现有导出。
4. 需要跨 package 调用时，先在被依赖 package 的 `src/index.ts` 中导出公共 API。
5. 使用 `@expertmesh/*` package import。
6. 补充或调整类型、schema、最小测试或文档。
7. 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`。
8. 如果改动影响构建或应用入口，运行 `pnpm build`。

## 修改代码时的注意事项

- 不要把共享逻辑放进 `apps`。
- 不要为了绕过 ESLint 使用相对路径跨 package 导入。
- 不要在 `shared` 中使用 Node API。
- 不要在 Web 或 SDK 中使用数据库、Agent 或 Node 内置模块。
- 不要在 Server 或 Agent 中引入 React、Next 页面或 UI 包。
- 不要把当前占位接口扩展成真实业务实现。
- 不要新增未来阶段 package，除非当前任务明确要求并更新边界文档。
- 不要提交 `node_modules`、`dist`、`.next`、`.turbo`、coverage 等构建产物。

## 文档位置

更多背景见：

```text
docs/ExpertMesh Harness 工程实施手册.md
docs/architecture/module-boundaries.md
docs/adr/001-monorepo-and-dependency-rules.md
docs/conventions/coding-conventions.md
```

如果本文件和实施手册冲突，以实施手册为准，并同步修正本文件。

## Phase 0 验收清单

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

- `shared` 仅依赖 `shared`。
- `client` 不依赖 `server` / `agent`。
- `server` 不依赖 `client`，但可在调度场景依赖 `agent` 抽象。
- `agent` 不依赖 `client` / `server` / Web。
- `web` 不依赖 `database` / `agent`。
- 跨 package 不使用相对路径。
- `shared` 不导入 Node、React、Prisma、Fastify。

质量：

- `pnpm lint` 通过。
- `pnpm typecheck` 通过。
- `pnpm test` 通过。
- `pnpm build` 通过。
- 非法 import 可被 ESLint 拦截。
