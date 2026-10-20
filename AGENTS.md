# AGENTS.md

进入仓库后先读本文，再按改动范围阅读下表中的专题规范。

## 项目与工作原则

Pragma 是跨 Harness 的多专家 Agent 编排平台，当前入口为 Desktop 与 CLI。
优先级：架构合理性、功能完整性、实现清晰度、可验证质量。
删除无长期价值的废弃代码、空实现和重复路径；支持窗口内的数据迁移与用户入口必须保留。

技术栈：Node.js >= 22、pnpm workspace、Turborepo、严格 TypeScript、ESM、Zod、Vitest、ESLint、Prettier。

## 核心边界

- `shared`：浏览器/Node 共用协议与纯工具，不依赖内部 package 或环境专属 API；跨进程协议使用 Zod，类型从 Schema 推导。
- `core`：执行、Invocation、Context、Runtime Adapter 合约；只依赖 `shared`，不依赖 Interpreter、Memory、具体 Runtime 或应用层。
- `interpreter`：DSL AST、解析、校验、编译与迁移；`evaluation` 拥有独立测评领域，不能反向依赖 Interpreter。
- `memory`：Host Memory Plane；只依赖 Core/Shared。Evidence 捕获不等于生成 Memory，各 Module 保有独立 authority。
- `built-in-agents`：五个静态 DSL 内置 Agent、提示词、宿主端口及纯业务规则；不拥有另一套执行内核。
- `local-host`：Desktop/CLI 共用的 Mission application、控制、编译、执行、恢复和部署服务；不依赖 Electron、app 或具体 Runtime。
- `runtime-*`：各自独立的具体 Runtime Adapter；由 Host 装配，不互相依赖。
- Desktop main 与 CLI 复用同一 Local Host factory 和 `MissionExecutionOwner`；不得另建 consumer、Runner 或完整执行服务副本。
- Desktop preload/renderer/shared 只使用浏览器安全入口，允许列表见[模块边界](docs/architecture/module-boundaries.md)。
- 跨 package 使用 package import，内部版本使用 `workspace:*`；源码相对导入保留 `.ts`。内部包使用 `@pragma/*`，公开 CLI 为 `@pqpo/pragma`。
- 不为单一调用方或未来占位新建 package；不要新增 `apps/local-runner`。

## 数据与恢复底线

- 改变既有合法数据语义或拒绝范围时，同一改动必须交付版本、相邻迁移、历史 Schema/真实 writer fixture 和恢复测试；禁止只改 Schema 或放行旧版本号。
- 业务 parser 只读当前 Schema。旧数据通过静态迁移链升级；未来版本、损坏数据或缺少迁移链必须明确拒绝，保留原数据。
- 升级在首次访问最小 owner 时、业务读取前执行。使用锁、备份、稳定 journal、原子替换与重放恢复；不得启动扫描全部 owner。
- 实验协议无迁移 cutover 必须有维护者明确授权和 ADR，不能自行推断“没有用户”。删除支持中的升级链同样需要 ADR 和离线恢复方案。
- workspace 只放任务输入、仓库与产物。权威数据在 `data/`，恢复状态在 `state/`，可重建内容在 `cache/`；路径统一通过 `PragmaPaths`。
- Runtime Session 必须有唯一 owner；恢复验证原身份，删除走可重放 owner 图事务。停止进程不等于删除数据。
- Desktop 先装配 IPC 并创建窗口，再启动后台工作。容量超限提示手动清理，不设全局写入门禁。
- 后台任务需关注、Module 不可用或投递隔离时必须报告 degraded、Module 与稳定错误码，并保留可恢复 Evidence。

## 按改动范围必读

| 改动范围                    | 规范入口                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 分层、依赖、新增模块        | [模块边界](docs/architecture/module-boundaries.md)、[模块实现约束](docs/conventions/package-contracts.md)                      |
| Schema、升级、存储、删除    | [持久化与升级治理](docs/conventions/persistence-and-upgrades.md)                                                               |
| Runtime、Token、进程隔离    | [Runtime 接入](docs/conventions/runtime-integration.md)、[接入清单](docs/conventions/runtime-adapter-integration-checklist.md) |
| Desktop UI                  | [UI 规范](docs/conventions/desktop-ui.md)，含资源名称展示与普通/键盘焦点态验收                                                 |
| 测试、构建、发行            | [测试与发布](docs/conventions/testing-and-release-performance.md)                                                              |
| 编码、语义资源 ID、可观测性 | [编码规范](docs/conventions/coding-conventions.md)                                                                             |
| Memory 提炼与重试           | [提炼执行协议](docs/architecture/memory-extraction-execution.md)                                                               |
| 架构决策与更多主题          | [文档入口](docs/README.md)、[ADR 索引](docs/adr/README.md)                                                                     |

## 开发与验证

```sh
pnpm install
pnpm --filter @pragma/desktop dev
```

- 先确定所属层和依赖边界，再改类型、Schema、调用方与必要文档。
- 按影响范围运行 lint、typecheck 和测试；`pnpm test:core` 是快速门禁，不能替代业务回归。
- 共享 Mission 内核修改必须运行 `pnpm test:local-host-kernel`；知识库修订运行 `pnpm test:revision`。完整业务选集为 `pnpm test:business`。
- Host binding、工具协议或编译身份修改必须以真实 Host binding 经过 Interpreter 编译，并覆盖首次执行和失败后手动重试；禁止只绕过编译读取 `binding.value`。新增回归进入对应业务门禁。
- bugfix 不得隐式删除既有用户入口或把成功断言改成失败；claim、恢复、删除和迁移同时验证首次使用与异常恢复。
- 不提交构建产物、临时截图、凭据或私人运行数据；保留任务外未提交改动。

## 文档维护

稳定约束集中在专题规范；当前架构集中在 architecture；ADR 记录决策及其适用范围。
历史报告放入 archive，不能作为当前实现指令。删除或归档前核对后继决策、迁移依据和引用，并更新链接。
发现文档与权威 Schema/实现冲突时核对并同步修正文档，不凭旧版本示例修改当前协议。
