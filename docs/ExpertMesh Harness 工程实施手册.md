# ExpertMesh Harness 工程实施手册

## 1. 实施范围

本阶段只搭建工程底座，不实现业务功能。

本阶段完成后，工程必须具备：

1. pnpm Monorepo；
2. Web、Server、Worker 三个独立应用；
3. Shared、Client、Server、Agent 四类 Package 边界；
4. TypeScript 严格模式；
5. ESLint 依赖限制；
6. Turborepo 统一执行 lint、typecheck、test、build；
7. 基础 CI 校验；
8. 可作为后续专家 Agent、Playbook、Runtime、Context Store 的长期 Harness。

本阶段明确不做：

- 专家 Agent 实现；
- Playbook 编排器；
- Runtime Adapter；
- 数据库模型；
- 用户认证；
- 队列；
- MCP、Skill、Hook、Plugin；
- Git Context Store；
- 真实业务 API。

---

# 2. 技术基线

```text
Node.js: >= 22
Package Manager: pnpm
Monorepo: pnpm workspace + Turborepo
Language: TypeScript
Module System: ESM
Lint: ESLint Flat Config
Formatting: Prettier
Unit Test: Vitest
Web: Next.js
Server: Fastify
Worker: Node.js + TypeScript
```

原则：

```text
先搭边界，再填能力。
先定义依赖方向，再创建业务模块。
先保证可验证，再开始扩展。
```

---

# 3. 最终目录结构

第一阶段只创建真实需要的目录，不提前创建大量空包。

```text
expertmesh/
├── apps/
│   ├── web/
│   ├── server/
│   └── worker/
│
├── packages/
│   ├── shared/
│   │   ├── contracts/
│   │   ├── domain/
│   │   └── utils/
│   │
│   ├── client/
│   │   └── sdk/
│   │
│   ├── server/
│   │   └── database/
│   │
│   ├── agent/
│   │   └── agent-core/
│   │
│   └── tooling/
│       ├── eslint-config/
│       └── tsconfig/
│
├── docs/
│   ├── architecture/
│   │   └── module-boundaries.md
│   ├── adr/
│   │   └── 001-monorepo-and-dependency-rules.md
│   └── conventions/
│       └── coding-conventions.md
│
├── infra/
│   └── compose/
│
├── .github/
│   └── workflows/
│       └── ci.yml
│
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── eslint.config.mjs
├── prettier.config.mjs
├── tsconfig.base.json
├── .gitignore
├── .npmrc
└── README.md
```

---

# 4. Package 命名规范

统一 scope：

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

禁止使用模糊 package 名：

```text
common
core
base
shared-lib
helpers
platform
lib
```

原因：这些名称会逐渐变成无边界的代码垃圾桶。

---

# 5. 模块边界设计

## 5.1 逻辑分层

```text
shared
  ↑
client / server
  ↑
agent
  ↑
apps
```

说明：

| 层级   | 定位                         |
| ------ | ---------------------------- |
| shared | 跨端、纯逻辑、无运行环境依赖 |
| client | 浏览器或客户端能力           |
| server | Node 服务端基础设施能力      |
| agent  | Agent 执行能力，仅 Node 环境 |
| apps   | 应用组合层与启动入口         |

---

## 5.2 依赖矩阵

| 来源模块      | 允许依赖                          |
| ------------- | --------------------------------- |
| `apps/web`    | `shared/*`、`client/*`            |
| `apps/server` | `shared/*`、`server/*`            |
| `apps/worker` | `shared/*`、`server/*`、`agent/*` |
| `shared/*`    | 仅 `shared/*`                     |
| `client/*`    | `shared/*`、`client/*`            |
| `server/*`    | `shared/*`、`server/*`            |
| `agent/*`     | `shared/*`、`server/*`、`agent/*` |

明确禁止：

```text
web → server
web → agent
client → server
client → agent

shared → client
shared → server
shared → agent

agent → client
agent → ui-web
server → ui-web
```

---

# 6. 各目录职责

## 6.1 `apps/web`

职责：

```text
页面
路由
浏览器状态
调用 SDK
展示 API 数据
```

允许依赖：

```text
@expertmesh/contracts
@expertmesh/domain
@expertmesh/utils
@expertmesh/sdk
```

禁止：

```text
@expertmesh/database
@expertmesh/agent-core
Node.js 内置模块
Prisma
服务端 Repository
```

初始功能：

```text
GET / 页面
显示 “ExpertMesh Web Ready”
调用 Server health API
```

---

## 6.2 `apps/server`

职责：

```text
HTTP API
基础健康检查
输入校验
后续承载鉴权、元数据、任务创建
```

允许依赖：

```text
@expertmesh/contracts
@expertmesh/domain
@expertmesh/utils
@expertmesh/database
```

禁止：

```text
@expertmesh/sdk
@expertmesh/agent-core
任何 Web UI 包
```

初始功能：

```text
GET /health
返回：
{
  "service": "server",
  "status": "ok"
}
```

---

## 6.3 `apps/worker`

职责：

```text
异步任务入口
后续承载 Agent、Playbook、Runtime、评测执行
```

允许依赖：

```text
@expertmesh/contracts
@expertmesh/domain
@expertmesh/utils
@expertmesh/database
@expertmesh/agent-core
```

初始功能：

```text
启动后输出：
ExpertMesh Worker Ready
```

暂不接入队列。

---

## 6.4 `packages/shared/contracts`

职责：

```text
Zod Schema
DTO
API Request / Response Schema
跨进程事件协议
未来的 Expert Manifest 协议
未来的 Playbook 定义协议
```

要求：

```text
必须使用 Zod 定义 Schema
必须从 Schema 推导 TypeScript Type
不得只写 interface 而没有运行时校验
```

禁止依赖：

```text
React
Next.js
Fastify
Prisma
Node.js fs/path/child_process
Agent Runtime SDK
```

初始文件：

```text
packages/shared/contracts/src/
├── health.schema.ts
└── index.ts
```

示例：

```ts
import { z } from "zod";

export const HealthResponseSchema = z.object({
  service: z.string(),
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
```

---

## 6.5 `packages/shared/domain`

职责：

```text
纯领域模型
纯状态机
枚举
值对象
业务规则
```

初始只创建最小示例：

```text
packages/shared/domain/src/
├── run-status.ts
└── index.ts
```

示例：

```ts
export const RunStatus = {
  Pending: "PENDING",
  Running: "RUNNING",
  Succeeded: "SUCCEEDED",
  Failed: "FAILED",
  Cancelled: "CANCELLED",
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];
```

禁止：

```text
数据库访问
HTTP
文件系统
Runtime SDK
React
```

---

## 6.6 `packages/shared/utils`

职责：

```text
纯函数
字符串处理
时间处理
Result / Error 工具
ID 工具
```

约束：

```text
不允许访问外部服务
不允许使用 Node 专属 API
不允许依赖 client/server/agent
```

---

## 6.7 `packages/client/sdk`

职责：

```text
HTTP Client
SSE Client
认证 Header 注入
API 错误转换
```

初始只实现：

```text
ServerClient
getHealth()
```

示例接口：

```ts
export interface ExpertMeshClient {
  getHealth(): Promise<HealthResponse>;
}
```

禁止：

```text
React Hook
页面逻辑
数据库逻辑
Agent 执行逻辑
```

---

## 6.8 `packages/server/database`

职责：

```text
数据库抽象入口
未来 Prisma Client
未来 Repository
未来 Migration
```

本阶段不接真实数据库。

初始仅提供占位接口：

```text
DatabaseClient
createDatabaseClient()
```

要求：

```text
不安装 Prisma
不创建 schema.prisma
不创建迁移
只保留 package 边界
```

---

## 6.9 `packages/agent/agent-core`

职责：

```text
未来 Expert Agent 执行抽象
未来 Agent Invocation
未来 Agent Result
未来 RuntimeAdapter Interface
```

本阶段不实现 Runtime。

初始文件：

```text
packages/agent/agent-core/src/
├── expert-agent.ts
├── runtime-adapter.ts
└── index.ts
```

示例接口：

```ts
export interface RuntimeAdapter {
  id: string;
}

export interface ExpertAgent {
  id: string;
  name: string;
}
```

禁止：

```text
Claude SDK
Codex SDK
MCP 实现
Playbook 实现
React
HTTP Controller
数据库实现
```

---

# 7. 运行环境限制

| Package    | Browser |   Node |
| ---------- | ------: | -----: |
| contracts  |    支持 |   支持 |
| domain     |    支持 |   支持 |
| utils      |    支持 |   支持 |
| sdk        |    支持 |   支持 |
| database   |  不支持 |   支持 |
| agent-core |  不支持 |   支持 |
| web        |    支持 | 不支持 |
| server     |  不支持 |   支持 |
| worker     |  不支持 |   支持 |

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

---

# 8. Workspace 配置

## 8.1 `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*/*"
```

## 8.2 根目录 `package.json`

```json
{
  "name": "expertmesh",
  "private": true,
  "packageManager": "pnpm@10",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "dev": "turbo run dev --parallel",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "check": "pnpm lint && pnpm typecheck && pnpm test",
    "clean": "turbo run clean && rm -rf node_modules"
  },
  "devDependencies": {
    "turbo": "latest",
    "typescript": "latest",
    "eslint": "latest",
    "prettier": "latest",
    "vitest": "latest"
  }
}
```

## 8.3 `.npmrc`

```text
shared-workspace-lockfile=true
strict-peer-dependencies=false
auto-install-peers=true
```

所有内部依赖必须使用：

```json
{
  "@expertmesh/contracts": "workspace:*"
}
```

禁止使用：

```json
{
  "@expertmesh/contracts": "*"
}
```

---

# 9. TypeScript 配置

## 9.1 根目录 `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

## 9.2 Package `tsconfig.json` 规范

每个 package 必须：

```json
{
  "extends": "@expertmesh/tsconfig/base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

Web 允许单独覆盖 DOM 相关配置。

Server、Worker、Agent 包使用 Node 配置。

---

# 10. Turborepo 配置

## 10.1 `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "dev": {
      "cache": false,
      "persistent": true
    },
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "lint": {
      "dependsOn": ["^lint"],
      "outputs": []
    },
    "typecheck": {
      "dependsOn": ["^typecheck"],
      "outputs": []
    },
    "test": {
      "dependsOn": ["^test"],
      "outputs": ["coverage/**"]
    },
    "clean": {
      "cache": false
    }
  }
}
```

---

# 11. ESLint 依赖边界配置

## 11.1 基础原则

依赖限制需要同时覆盖：

1. Package 跨层依赖；
2. 浏览器与 Node 环境混用；
3. Type-only import；
4. 相对路径绕过 package 边界。

## 11.2 根目录 `eslint.config.mjs`

需要按文件路径区分规则。

### Web 限制

`apps/web/**/*` 禁止：

```text
@expertmesh/database
@expertmesh/agent-core
@expertmesh/server-*
node:*
@prisma/client
```

### Shared 限制

`packages/shared/**/*` 禁止：

```text
@expertmesh/sdk
@expertmesh/database
@expertmesh/agent-*
react
next/*
fastify
@prisma/client
node:*
```

### Client 限制

`packages/client/**/*` 禁止：

```text
@expertmesh/database
@expertmesh/agent-*
@expertmesh/server-*
@prisma/client
node:*
```

### Server 限制

`packages/server/**/*` 禁止：

```text
@expertmesh/sdk
@expertmesh/ui-*
@expertmesh/playbook-canvas
react
next/*
```

### Agent 限制

`packages/agent/**/*` 禁止：

```text
@expertmesh/sdk
@expertmesh/ui-*
@expertmesh/playbook-canvas
react
next/*
```

## 11.3 相对路径绕过限制

禁止跨 package 使用相对路径：

```ts
// 禁止
import { HealthResponseSchema } from "../../../shared/contracts/src";

// 正确
import { HealthResponseSchema } from "@expertmesh/contracts";
```

所有跨 package 引用必须使用 package 名称。

---

# 12. 每个 Package 的标准 `package.json`

以 `@expertmesh/contracts` 为例：

```json
{
  "name": "@expertmesh/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "lint": "eslint src",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "zod": "latest"
  }
}
```

要求：

```text
所有 package 必须 private。
所有 package 必须 type=module。
所有 package 必须提供 lint、typecheck、test、build、clean。
所有跨 package 依赖必须使用 workspace:*。
```

---

# 13. 应用启动要求

## 13.1 Web

启动命令：

```bash
pnpm --filter @expertmesh/web dev
```

验收：

```text
访问首页可见：
ExpertMesh Web Ready

页面自动请求 Server /health。
页面展示 Server 返回的 status=ok。
```

## 13.2 Server

启动命令：

```bash
pnpm --filter @expertmesh/server dev
```

验收：

```bash
curl http://localhost:3001/health
```

预期：

```json
{
  "service": "server",
  "status": "ok"
}
```

## 13.3 Worker

启动命令：

```bash
pnpm --filter @expertmesh/worker dev
```

验收输出：

```text
ExpertMesh Worker Ready
```

---

# 14. README 必须包含的内容

根目录 README 至少包含：

```text
项目定位
目录说明
依赖边界
本地启动方式
常用命令
新增 package 规范
禁止事项
Phase 0 验收标准
```

必须写明：

```text
不要把共享代码直接放入 apps。
不要让 Web 直接访问数据库或 Agent 包。
不要让 shared 包依赖 Node、React、数据库或 Agent Runtime。
不要通过相对路径跨 package 导入。
新增 package 前必须先定义所属层级。
```

---

# 15. ADR 文档要求

创建：

```text
docs/adr/001-monorepo-and-dependency-rules.md
```

内容必须覆盖：

```text
决策：采用 pnpm workspace + Turborepo。
决策：按 shared/client/server/agent 分层。
决策：应用仅作为组合层。
决策：所有内部依赖使用 workspace:*。
决策：使用 ESLint 阻止非法依赖。
决策：暂不引入 Nx。
后续：项目变大后可引入 Nx 依赖图和 module boundary。
```

---

# 16. CI 配置

创建 `.github/workflows/ci.yml`。

Pull Request 与主分支 Push 时执行：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

CI 必须失败的场景：

```text
TypeScript 报错
ESLint 报错
测试失败
构建失败
非法跨层 import
```

---

# 17. 实施顺序

## Step 1：初始化根工程

创建：

```text
package.json
pnpm-workspace.yaml
turbo.json
tsconfig.base.json
eslint.config.mjs
prettier.config.mjs
.gitignore
.npmrc
README.md
```

验收：

```bash
pnpm install
pnpm -r list
```

成功识别 workspace。

---

## Step 2：创建三个 App

创建：

```text
apps/web
apps/server
apps/worker
```

验收：

```bash
pnpm --filter @expertmesh/web dev
pnpm --filter @expertmesh/server dev
pnpm --filter @expertmesh/worker dev
```

三个应用均可独立启动。

---

## Step 3：创建 Shared Packages

创建：

```text
@expertmesh/contracts
@expertmesh/domain
@expertmesh/utils
```

验收：

```text
Web、Server、Worker 都能 import contracts。
所有 package typecheck 通过。
```

---

## Step 4：创建运行环境 Package

创建：

```text
@expertmesh/sdk
@expertmesh/database
@expertmesh/agent-core
```

只保留最小接口与目录，不实现业务。

验收：

```text
Web 能依赖 sdk。
Server 能依赖 database。
Worker 能依赖 agent-core。
Web 无法依赖 database 或 agent-core。
```

---

## Step 5：实现 ESLint 边界

至少新增以下非法 import 测试文件或验证方式：

```text
apps/web import @expertmesh/database
packages/shared/contracts import node:fs
packages/agent/agent-core import @expertmesh/sdk
```

验收：

```text
上述三种 import 必须被 ESLint 拦截。
```

---

## Step 6：接入 CI

验收：

```text
本地 pnpm check 成功。
GitHub Actions 成功。
故意增加非法 import 后 CI 失败。
```

---

# 18. 最终验收清单

## 工程

- [ ] pnpm workspace 正常工作
- [ ] Turborepo 可执行 dev、build、lint、typecheck、test
- [ ] 根目录存在统一 TypeScript、ESLint、Prettier 配置
- [ ] 所有 package 使用 ESM
- [ ] 所有内部依赖使用 `workspace:*`

## 应用

- [ ] Web 可启动
- [ ] Server 可启动并提供 `/health`
- [ ] Worker 可启动
- [ ] Web 可调用 Server `/health`

## 包边界

- [ ] shared 仅依赖 shared
- [ ] client 不依赖 server / agent
- [ ] server 不依赖 client
- [ ] agent 不依赖 client
- [ ] web 不依赖 database / agent
- [ ] 跨 package 不使用相对路径
- [ ] shared 不导入 Node、React、Prisma、Fastify

## 质量

- [ ] `pnpm lint` 通过
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过
- [ ] `pnpm build` 通过
- [ ] CI 通过
- [ ] 非法 import 可被 ESLint 拦截

---

# 19. Codex 执行约束

实施时必须遵守：

1. 不新增任何业务模块；
2. 不实现 Expert、Playbook、Runtime 的具体逻辑；
3. 不引入数据库、Redis、消息队列、Prisma；
4. 不引入 Claude、Codex、MCP SDK；
5. 不创建空的大量未来 package；
6. 不破坏 package 边界；
7. 任何新增依赖必须说明其所属层级；
8. 所有 package 必须能独立 lint 和 typecheck；
9. 所有内部依赖必须使用 package import；
10. 完成后输出目录树、依赖图说明、启动命令和验收结果。

---

# 20. 下一阶段预告

Phase 0 完成后，下一阶段只做：

```text
Phase 1：Expert Manifest 与基础 Expert Agent 模型
```

预计新增：

```text
packages/agent/agent-context
packages/agent/agent-runtime
packages/server/queue
packages/server/git-service
```

但只有在 Phase 0 的依赖边界和 CI 校验稳定后，才进入下一阶段。
