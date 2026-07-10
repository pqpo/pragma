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
.github/workflows/ci.yml
```

## Package 命名

统一使用 `@pragma/*` scope。

当前 package：

```text
@pragma/shared
@pragma/client
@pragma/server
@pragma/core
@pragma/runtime-pi
@pragma/runtime-codex
@pragma/runtime-claude-code
@pragma/desktop
@pragma/examples
@pragma/plugin-memory
@pragma/plugin-repo-manager
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

新增 package 前，必须先明确它属于 `shared`、`client`、`server`、`core`、`runtime-*`、`plugins/*`、`examples`、`apps/*` 还是配置工具。

## 模块依赖规范

下面的箭头统一表示“左侧可以依赖右侧”。

核心原则：

- `shared` 是最底层协议、领域模型和纯工具，不依赖任何运行环境层。
- `client` 是浏览器/客户端 SDK，只依赖 `shared`，不直接碰 Server 内部实现或 Agent。
- `core` 是专家 Agent 的执行抽象和 Runtime Adapter 边界，只依赖 `shared` 和 core 内部模块，不依赖具体 runtime、`client` 或 `server`。
- `runtime-*` 是具体 Runtime Adapter 实现，依赖 `core`、`shared` 和该 runtime 自己的 SDK；不同 runtime 包相互独立。
- `server` 是服务端控制面与基础设施层，可以依赖 `shared` 和 `core` 抽象。
- `apps/server` 和 `apps/worker` 是云端运行入口，未来由它们调度专家 Agent；不是 Agent 反过来依赖 Server。
- `apps/desktop` 是未来本地 Agent 桥接入口，主动连接云端，承载本地权限闸门和本机 Agent 调用。

```text
apps/web    -> client -> shared
apps/server -> server -> core -> shared
apps/worker -> server -> runtime-* -> core -> shared
apps/desktop    -> runtime-* -> core -> shared
plugins/*   -> core -> shared
examples    -> runtime-* / plugin-* / core -> shared
```

更具体地说：

| 来源                 | 允许依赖                                                                     |
| -------------------- | ---------------------------------------------------------------------------- |
| `apps/web`           | `@pragma/shared`、`@pragma/client`                                           |
| `apps/server`        | `@pragma/shared`、`@pragma/server`、`@pragma/core`                           |
| `apps/worker`        | `@pragma/shared`、`@pragma/server`、`@pragma/core`、具体 `@pragma/runtime-*` |
| `apps/desktop`       | `@pragma/shared`、`@pragma/core`、具体 `@pragma/runtime-*`                   |
| `plugins/*`          | `@pragma/shared`、`@pragma/core`；不依赖 app、server、client 或具体 runtime  |
| `examples`           | `@pragma/core`、具体 `@pragma/runtime-*`、具体 `@pragma/plugin-*`            |
| `packages/shared`    | 无内部 package 依赖；只允许运行时中立依赖                                    |
| `packages/client`    | `@pragma/shared`                                                             |
| `packages/server`    | `@pragma/shared`；需要编排时可依赖 `@pragma/core`                            |
| `packages/core`      | `@pragma/shared`                                                             |
| `packages/runtime/*` | `@pragma/shared`、`@pragma/core`、该 runtime 自己的 SDK                      |

明确禁止：

```text
web -> server
web -> core
client -> server
client -> core
shared -> client
shared -> server
shared -> core
core -> client
core -> server
core -> runtime-*
runtime-pi -> runtime-codex
runtime-pi -> runtime-claude-code
runtime-codex -> runtime-pi
runtime-codex -> runtime-claude-code
runtime-claude-code -> runtime-pi
runtime-claude-code -> runtime-codex
server -> client
server -> web
core -> web
plugin-* -> server
plugin-* -> client
plugin-* -> runtime-*
```

这里的 `core` 指专家 Agent 的执行抽象、Manifest、Invocation、Runtime Adapter 合约和公共运行协议。具体 runtime 实现放在独立 `@pragma/runtime-*` 包，由 Server/Worker/Desktop 等应用入口按需装配；不要让 `core` 依赖具体 runtime、`client`、Web 或 Server 应用层。

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
- Server/Worker 可以调用 Core；Core 不应该反向调用 Server 应用层。
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
- RuntimeRegistry、运行事件、会话、取消、错误等公共运行协议。
- 未来本地 Claude Code、Codex、自研执行环境通过独立 Runtime Adapter 包对接。

当前保留：

```text
ExpertAgent
ContextSystem
ContextManager
RuntimeAdapter
```

ExpertAgent API 设计要求：

- 保留 `ExpertAgent.create()` 作为标准创建入口，负责异步插件加载、inline plugin entry 合并、日志初始化和实例归一化。
- `defineAgent()` 只是 `ExpertAgent.create()` 的声明语法糖；不要在 `defineAgent()` 下再实现独立 Agent 包装层。
- Agent 运行能力优先加到 `ExpertAgent`，不要只放在 Directive SDK 包装层中。

不要引入具体 Claude SDK、Codex SDK、PI SDK、具体 runtime 包、Playbook、HTTP Controller、数据库实现或 Server 应用层实现。

禁止引入 Server 应用层、Client SDK、React / Next Web UI、数据库实现或 Desktop 本地权限 UI。

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
pnpm --filter @pragma/desktop run prepare:electron
pnpm --filter @pragma/desktop dev
```

> **Electron 42 注意事项：** 从 Electron 42 开始，`postinstall` 不再自动下载 Electron 二进制文件，改为首次运行 Electron CLI 时才下载。`prepare:electron` 脚本调用 `install-electron` 手动触发下载，避免新成员或 CI 首次 `dev` 时遇到缺失二进制的错误。

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
import "@pragma/server";

// packages/shared 中禁止
import "node:fs";

// packages/core 中禁止
import "@pragma/client";

// packages/core 中禁止
import "@pragma/runtime-pi";
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
7. 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`。
8. 如果改动影响构建或应用入口，运行 `pnpm build`。

## 修改代码时的注意事项

- 不要把共享逻辑放进 `apps`。
- 不要为了绕过 ESLint 使用相对路径跨 package 导入。
- 不要在 `shared` 中使用 Node API。
- 不要在 Web 或 SDK 中使用数据库、Core 或 Node 内置模块。
- 不要在 Server 或 Core 中引入 React、Next 页面或 UI 包。
- 不要保留没有长期价值的空实现、废弃字段或迁移期分支。
- 不要新增未来能力 package，除非当前任务明确要求并同步更新 ADR、边界文档和验证路径。
- 不要提交 `node_modules`、`dist`、`.next`、`.turbo`、coverage 等构建产物。

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
