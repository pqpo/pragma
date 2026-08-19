# Pragma 当前架构概览与演进判断

> 基线：2026-08-07 当前仓库实现。本文面向架构评审，描述已经
> 存在的系统，而不是早期愿景；不展开类和函数级细节。

## 结论先行

Pragma 已经形成一个质量较好的**本地 Agent 执行内核**：Expert、ExpertTeam、Flow、Execution、Runtime Session、插件、上下文、MCP 和本地 Runtime Adapter 都有实际实现，Runtime 与 Core 的依赖方向也基本合理。

但它还不是完整的“云端多专家编排平台”。当前最主要的问题不是缺少更多 Agent 能力，而是三个关键边界尚未闭合：

1. **安全边界未闭合**：Desktop 被定义为本地权限闸门，但尚无真正的 Local Permission Guard，Claude Code Runtime 默认还是 `bypassPermissions`。
2. **控制面未落地**：Server、Worker、Runtime Gateway、持久化调度和多租户治理仍是骨架，当前能力主要在单机文件系统内运行。
3. **协议所有权分散**：Core、Shared、Desktop 各自持有一部分 Expert、Execution、Capability 和 Bridge 数据模型，云端与 Desktop 还没有一套统一、版本化、可重放的协议。

因此，下一阶段不宜继续横向增加更多 Runtime、插件或 UI 功能，应优先把“本地执行安全边界 + 云端控制面协议 + 生产级执行事件模型”做完整。

## 已接受的 CLI 本机应用层边界

`@pragma/local-host` 是 Desktop Main 与公共 npm CLI 共同使用的 Node-only application layer；它不
依赖 Electron 或具体 Runtime。`apps/cli`（`@pragma/cli`，binary `pragma`）只负责 argv、TTY、
text/json/jsonl 输出、信号和 composition，用户手动通过 npm 在 macOS 或 Windows 上安装，并使用现有
Node.js >=22。Runtime factories 仅由 Desktop Main 或 CLI composition root 注入。

```text
apps/desktop Main ─┐
                   ├─> @pragma/local-host ─> domain packages / Host ports
apps/cli ──────────┘                              ▲
                                                   └─ Runtime factories injected by each app
```

同一 Mission 的执行控制由持久 `MissionControllerLease` 和单调 fencing token 管理；非 owner 的
`send`、`steer`、`respond`、`interrupt` 与 queue mutation 通过持久 `MissionCommandInbox` 投递。
`steer` 保持严格 same-turn 语义，绝不降级为 queue/send。Shared integration wire schema 置于
`@pragma/shared/integration`，保持浏览器安全，不能暴露 Electron 状态、Node 对象或 secret。

## 当前真实架构

```text
                                  ┌───────────────────────┐
                                  │      apps/web         │
                                  │  Health 展示与 Client │
                                  └───────────┬───────────┘
                                              │
                                      @pragma/client
                                              │
                                              ▼
                                      @pragma/shared

┌───────────────────────┐           ┌───────────────────────┐
│     apps/desktop      │           │  apps/server / worker │
│ Studio / Mission / IPC│           │  目前仍是最小入口     │
│ Capability / Secret   │           └───────────┬───────────┘
└───────────┬───────────┘                       │
            │                                   │ 未来控制面、调度
            │ compose                           │
            ▼                                   ▼
┌────────────────────────────────────────────────────────────┐
│                       @pragma/core                         │
│ Expert / Team / Flow / Execution / Context / Plugin / MCP │
│ Runtime contracts / Runtime session ownership / File store│
└───────────┬───────────────────────────┬────────────────────┘
            │                           │
            ▼                           ▼
┌─────────────────────────┐   ┌─────────────────────────────┐
│ @pragma/runtime-*       │   │ user plugins                │
│ PI / Codex / Claude Code│   │ trusted Expert extensions  │
│ Qoder / Antigravity     │   │                             │
└───────────┬─────────────┘   └─────────────────────────────┘
            │
            ▼
  本机 Runtime 进程与本地文件系统
```

### 已经落地的能力

| 区域               | 当前状态                                                                             | 架构判断                                           |
| ------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Expert 声明        | `defineExpert()` 是异步创建入口，负责插件、Context、Tool 和模型配置归一化            | 方向正确，但公共定义仍以 TypeScript interface 为主 |
| 多专家协作         | 普通 Expert launcher 与 `defineExpertTeam()` 共用子 Invocation 委派机制              | 局部 subagent 与团队治理边界清晰                   |
| Flow               | Task、HumanTask、Expert、Team、子 Flow 共用 Invocation Tree                          | 顶层对象收敛合理，恢复语义已有测试                 |
| Execution          | Execution、Invocation、Canonical Event、Output 投影、ExpertSession 均有持久化 schema | 领域骨架完整；文件存储仍不适合直接上云             |
| Runtime            | PI、Codex、Claude Code、Qoder CLI、Antigravity CLI 分包实现统一 Runtime Driver       | 是目前最成熟、最值得保留的扩展边界                 |
| Session 所有权     | ExpertSession / FlowExecution 显式拥有 Runtime Session，并有 claim、lease 和恢复校验 | 对避免 Session 串用和 TOCTOU 很重要，设计合理      |
| Plugin             | 插件可贡献 MCP、Skill、Model、Tool、Approval 和生命周期 Hook                         | 扩展面丰富，但 SPI 与具体能力边界还可收敛          |
| Context            | ContextSystem 支持多 Store、元数据、检索、写入与装配                                 | 能力完整，但实现体量已经过大                       |
| Desktop            | 已实现 Expert、Capability、Context Store、Model Provider、Mission 的本地管理         | 已是本地控制台，不再只是占位壳                     |
| Capability Library | 本地能力不可变 revision、凭据独立加密、工具快照和显式 allowlist                      | 是良好的供应链和变更治理基础                       |
| Memory             | Host 内置 Plane、Episodic/Semantic、Knowledge/Skill promotion 已落地                 | 必做重构完成；CodeGraph 是可选扩展                 |

### 尚未落地或仅为骨架

- `apps/server` 只有 `/health`，`@pragma/server` 的 `DatabaseClient` 仍是无行为占位对象。
- `apps/worker` 只注册 Runtime、创建一个 Expert 并输出 Ready，没有任务获取、调度、重试或治理循环。
- `packages/server/src/runtime-gateway` 和 `packages/core/src/local-agent-bridge` 尚不存在。
- Desktop 的 Gateway 和 Device 状态是离线快照，没有设备绑定、心跳、任务下发、事件回传或断线恢复。
- Mission 已连接 ExpertSession / Flow Execution；v3 manifest 只保存有界元数据，跨轮用户消息和
  Execution 引用追加到 `messages.jsonl`，生成内容仍由 Execution Canonical Event Log 投影。
- Desktop Home 是 Mission 新建入口，默认使用只读通用系统 Agent `expert:0000000000pragma`；即使没有
  创建任何项目 Expert，用户也可以直接让 Pragma 在授权工作区中完成任务。Studio 与任务执行器
  目录通过同一个 System Expert Registry 展示和解析 Pragma，不再维护独立 Home Chat。
- Web 和 Client 仍只有健康检查路径，不代表控制面产品能力。

## 合理、应继续保持的设计

### 1. Core 不依赖具体 Runtime

`@pragma/runtime-pi`、`@pragma/runtime-codex`、`@pragma/runtime-claude-code`、`@pragma/runtime-qodercli`、`@pragma/runtime-antigravity` 独立依赖 `@pragma/core`，Core 不反向依赖具体 Runtime。这使 Worker、Desktop 或未来云端执行器可以按部署环境装配 Runtime。

建议继续保持 Runtime 包彼此隔离，不引入跨 Runtime 的共享实现包；真正通用的契约或纯逻辑应回到 Core 或 Shared。

### 2. Execution 统一 Expert 与 Flow 的运行视图

ExpertTurn 和 FlowExecution 都落到 Execution / Invocation Tree，而不是维护两套观测、恢复和输出模型。普通 Expert subagent 与团队委派都直接产生子 Invocation，没有伪装成单节点 Flow。这是正确的领域收敛。

### 3. Runtime Session 有明确 owner

Runtime Session 由 ExpertSession context 或 FlowExecution Invocation 明确拥有，并通过原子 claim、lease、完整身份校验和恢复引用防止误复用。这一约束应视为运行时不变量，不要为简化调用方而弱化。

### 4. Capability 使用不可变 revision

Expert 固定引用 Capability revision 和 tool allowlist，健康状态与凭据独立管理。MCP 参数 schema
由服务端动态提供；运行前只要求 allowlist 中的工具仍然存在，工具删除时引导用户修改 Expert。这比把
Skill、MCP 和 Secret 直接嵌入 Expert 配置更可治理，同时避免非破坏性的参数变化阻塞已有 Expert。

### 5. 依赖边界有自动化守卫

ESLint 已约束 Web、Desktop Renderer、Shared、Core、Runtime 和 Plugin 的非法依赖方向，当前 `pnpm check` 也能通过。边界规则已经成为可执行约束，而不只是架构文档。

## 不合理设计与风险

### P0：本地权限闸门名义存在，实际未闭合

**状态：已确认。**

架构文档把 Desktop 定义为文件、Shell、Git、网络和 Secret 的本地权限边界，但当前没有统一的 `LocalPermissionGuard`。更危险的是：

- Claude Code Runtime 默认 `permissionMode = "bypassPermissions"`。
- Antigravity Runtime 默认使用 `request-review`、终端 sandbox 和 fail-closed `PreToolUse` relay；这只闭合
  该 Adapter 的 native tool 路径，不等价于跨 Runtime 的统一 Local Permission Guard。
- Electron `BrowserWindow` 设置了 `sandbox: false`。
- Desktop 还没有把 workspace scope、runtime native tool 和用户确认串成一个强制执行链。

Core 的 Managed Tool approval 只能约束进入 Pragma Tool/MCP 层的调用，不能自动证明 Runtime 自带文件、Shell 或网络工具都被拦截。

**建议：** 在接入 Runtime Gateway 或允许 Mission 真正执行之前，先定义独立、fail-closed 的权限决策协议。所有 Runtime Adapter 必须声明其 native capability 如何映射到统一权限模型；无法拦截的能力不能以“本地受控 Runtime”对外宣称。生产默认值不得是 bypass。

### P1：Cloud Control Plane 与执行内核之间存在巨大空层

**状态：已确认。**

目前 Core 已有较复杂的 durable execution，而 Server/Worker 仍是启动骨架。这会诱导后续代码把租户、鉴权、配额、调度、重试和审计继续塞进 Core，或者直接塞进入口应用。

**建议：** 下一阶段优先在 `@pragma/server` 建立控制面应用服务和基础设施端口，至少明确：

- Run / Session / Device / Lease Repository；
- 调度队列、重试和 dead-letter 语义；
- Runtime placement 与 capability matching；
- tenant、actor、policy、budget、audit 上下文；
- 事务提交和事件发布的 outbox 边界。

`apps/server` 和 `apps/worker` 只负责传输、进程生命周期和装配，不承载可复用业务规则。

### P1：跨进程协议没有唯一所有者

**状态：已确认。**

Execution 的部分协议在 `@pragma/shared`，Runtime/Expert 契约在 Core，而 Desktop 又定义了自己的 `pragma.expert/v2`、Mission、Capability、Gateway Snapshot 和 IPC schema。Core 的 Expert 仍标记为 `pragma.expert/v1`，Desktop 在实例化时需要把 v2 定义降成 Core v1 对象。

这在单机内可用，但进入 Cloud ↔ Desktop 后会产生双重模型、映射漂移和版本协商问题。

**建议：** 按“谁跨进程，谁拥有运行时 schema”的原则收敛：

- 通用 Execution DTO 继续由 `@pragma/shared` 持有；Cloud 与 Desktop 的桥接协议按既定边界放入 `packages/core/src/local-agent-bridge`，该子模块只包含 Zod schema、类型和纯协议逻辑；
- Core 内部行为对象不需要等同于 wire DTO；通过显式 mapper 转换；
- Expert Definition、Capability Reference、Device Capability、Local Run Command/Event 必须各有唯一 schema owner；
- 协议必须携带 schema version、request/event id、causation/correlation id 和幂等语义。

### 已完成：Execution 语义事件与实时 Output 分层

**状态：已解决。**

Execution 已采用单一 Canonical Event Log，只持久化完整标准化消息、Invocation 生命周期、委派、人工交互等可恢复语义事件。Runtime 原生事件先归一化为 `ExpertAgentStreamEvent`，其中 token、thinking 和 tool delta 只通过 `subscribeOutput()` 实时发布，不进入事件日志。

实时 Output 使用 `ExecutionOutputItem`，保留来源 event id、run/session 父子关系和 Invocation/Executor/Context 信息，但不拥有持久化 cursor。活动 Execution 的进程内 Live Bus 会向晚订阅者补发本次执行已产生的 Output，执行结束后即释放；完整 `AgentMessage` 仍通过 `invocation.message.appended` 进入 Canonical Event Log。Execution 状态、Invocation patch 与语义事件可通过幂等 `commit()` 原子提交。

Runtime 原生子 Agent 使用 `sessionId` / `parentSessionId` 表达会话归属，同一会话的多轮任务拥有不同 `runId`；spawn、wait、list、send、resume、interrupt 统一归一化为 `agent.command`。工作投影按 session 聚合记录并按 run 展开任务，子 Agent 输出不会再混入父 Invocation 的 Chat。

该设计明确拆分“活动执行的非持久化实时输出”和“历史/审计”：`subscribeOutput()` 可读取当前活动执行的内存回放并继续跟随新事件，`getMessageHistory()` 读取完整消息，`listEvents()` 使用 Execution cursor 分页读取编排历史。详见 ADR 007。

### P1：文件存储是很好的本地参考实现，但不是云端后端

**状态：已确认。**

当前 Store interface 为替换后端留出了空间，这是优点；但具体实现会重写完整 Invocation 数组、反复读取 JSONL，并以 25ms 轮询实现 watch。它适合本机 SDK、测试和 Desktop，不适合多 Worker、高事件量或远程共享存储。

**建议：** 明确命名和文档定位为 Local/File Adapter。云端实现应提供数据库事务、append-only event table/log、索引、租约 fencing token 和真正的 pub/sub wake-up。不要让云端通过共享磁盘继续沿用 File Store。

### P2：Core 已经成为“大内核 + 大出口”

**状态：需要架构决策。**

`@pragma/core` 同时拥有声明 DSL、执行应用服务、Runtime Driver、文件持久化、插件加载、Context Store、MCP client/server、HTTP-to-MCP、日志和路径治理，并通过根 `index.ts` 大量 `export *` 暴露。

问题不在于单个 package 大，而在于公共 API 边界过宽：存储实现、内部并发原语和领域契约具有相同可见性，未来很难判断什么可以 breaking、什么必须稳定。

**建议：** 暂时不急于新增模糊 package，先在 `@pragma/core` 内形成三个清晰层次：

1. `domain`：Expert、Flow、Execution、Invocation、Session 不变量；
2. `application`：创建、提交、恢复、取消、委派用例；
3. `infrastructure`：File Store、MCP transport、process probe、path/lock。

公共根出口只保留稳定 facade，实验性和基础设施 API 使用明确 subpath export。等 Server、Desktop 出现独立复用需求后，再按部署边界拆包，而不是按文件数量拆包。

### P2：Runtime 默认注册依赖进程级可变全局状态

**状态：已修复。**

已删除 `setDefaultRuntimeRegistryFactory()`、默认 Registry 单例以及同步 `RuntimeRegistry`。
`createPragma()` 现在必须显式注入异步 `RuntimeResolver`。Resolver 在创建 Context 时绑定最新的
Runtime Environment revision，在恢复已有 Context 时按持久化的 `runtimeId + revision + fingerprint`
解析历史版本。

Desktop 的 `RuntimeEnvironmentService` 每次解析都读取版本化 Store，不要求重启 Desktop。更新只影响
之后创建的 Context；已有 Context 和 Runtime Session 保持原 binding。默认 Runtime 是安装级显式配置，
Expert 未指定 Runtime 时由 Resolver 读取，而不是在 Expert 或 DSL 中推断 Codex。

### Memory Plane 必做重构已完成

**状态：ADR 031–039 已接受；阶段 1–8 已完成，CodeGraph 保持可选。**

ADR 002/003 的 Agent plugin、direct-write Memory 和并行 Skill authority 已由 ADR 031 取代并删除。
历史 Task/Experience/Fact/Skill 文件数据不读取、不导入，也不由应用自动删除。

ADR 031 已替代 ADR 002/003，并由 `docs/architecture/memory-plane-implementation-plan.md` 固化分阶段
实施顺序。目标边界为：

- Core 只拥有 Memory-neutral Canonical Event Feed、durable canonical-event commit handoff 和
  canonical identity；Mission Board 由 Host 注入通用 Context binding；
- `@pragma/memory` 拥有 Evidence adapter、Memory Module SPI、策略、联邦 Context 和后续检索；
- Memory 是 Host 内置能力，不再由每个 Expert 选择安装；
- Experience 与 Fact 是默认动态投影；可选 CodeGraph 仍是独立 Memory type；
- Memory 只产生 Knowledge promotion/revision Candidate。用户批准后的 Knowledge 进入“工作室 → 知识库”
  托管 Context Store，并与 Memory/Evidence 解耦；
- 通用 Store Revision Agent 加载目标 Store 与 revision prompt，生成 change set，用户批准后才激活新
  Store revision；Skill Candidate 评测后升级为现有 Capability；
- 旧 Memory plugin 与 Repo Manager plugin 已 hard cut，仓库不再附带内置 Expert plugin。

当前已能形成按资产隔离的历史 Episode、带冲突/时效的 Semantic Fact，并将用户批准的结构化 Knowledge
初始化为每个 Expert 唯一的 Studio Context Store。后续 Memory 变化只提交 Store 修订任务，由独立 Agent
生成 change set，用户批准后以 CAS 原子激活。旧 Published Knowledge 与 Bundle extension 已 hard cut，旧
目录不迁移、不读取。Skill Candidate、Evaluation、Capability promotion/revision 和旧插件 hard cut 均已
完成。CodeGraph 是最后的可选扩展验收，不作为 Memory 重构完成的前置条件。

### P2：Desktop Main Process 正在变成第二个业务内核

**状态：趋势明确。**

Expert migration、Capability revision、Credential、Context Store、Mission 和 Runtime discovery 都直接实现在 `apps/desktop/src/main`。短期合理，但继续增长后，Electron 生命周期、IPC、文件存储和领域规则会绑死在一起。

**建议：** 保持 Renderer → typed preload → Main 的边界，同时把 Main 视为 composition root。可测试的 device-local application service 与 store port 不应依赖 Electron；只有窗口、对话框、safeStorage、系统托盘和 IPC adapter 留在 Electron 层。

### Runtime environment 与模型能力

Desktop 将 Runtime environment 保存为独立的 Adapter binding：`runtimeId` 是该 Runtime
实例的唯一标识，`adapter.id + adapter.version` 决定由哪个 Adapter factory 创建实例，配置只属于该
实例。`runtimeId` 不编码 PI、Codex、Claude Code 等类型，也不编码本机或云端 placement。

`RuntimeResolver` 是执行侧唯一的解析边界，Desktop 的实现由版本化 Store 与 Adapter Factory Registry
组成。Settings 和 Expert 编辑器通过 Resolver inspection 中的 Adapter descriptor 与 `listModels()`
获取显示名称、模型、Provider 和思考深度，不按已知 Runtime ID 分支。一个损坏或未知 Factory 的环境
只会报告自身不可用，不影响其他环境和 Desktop 启动。

PI Adapter 的模型目录来自 Desktop 注册的 Model Provider；Codex、Claude Code、Qoder CLI 和 Antigravity CLI Adapter 使用各自的
原生模型发现能力。模型身份统一为 `providerId + modelId`，思考深度必须属于所选模型声明的集合。PI
还会把声明集合与自身真实支持的思考深度取交集。RuntimeProfile 不再承载 Provider credential；凭据只
由具体 Runtime Factory/Adapter 在运行时解析。

模型能力协议只保存运行时中立的 `reasoning`、规范化思考档位与可选默认档位，不保存 PI 的
`thinkingLevelMap` 或 `compat`。PI 内置模型目录与版本化 Compatibility Profile 均由
`@pragma/runtime-pi` 持有：精确命中的内置模型优先，未知兼容服务使用保守 Profile，Desktop 的供应商
级和模型级高级设置可以显式覆盖。Desktop 的连接验证也通过 PI 发起最小真实请求，从而同时验证消息
角色、思考参数和 Token 字段转换；Codex 与 Claude Code 不经过这条 Profile 链路。详见 ADR 015。

接入一个直接可访问的云端 Agent Runtime 不需要先建设 Runtime Gateway：实现一个负责远程认证、
会话与事件流的 `RuntimeAdapter`，提供 factory，并把对应 environment 注册到版本化 Store 即可。
只有当需要由云端控制面向 Desktop 设备下发本地任务、维护设备在线状态和断线恢复时，
才引入 Local Agent Bridge 与 Runtime Gateway。

## 最需要预留的扩展点

| 扩展点             | 现在已有                                                       | 需要补齐                                                                           |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Runtime Adapter    | Driver、模型发现、Session create/restore、stream、cancel/close | native permission mapping、placement、capability negotiation、remote proxy runtime |
| Execution Store    | Store interface、统一 event log、幂等 commit、文件事务 journal | fencing token、数据库与消息总线实现                                                |
| Local Agent Bridge | Desktop 入口和 runtime availability                            | 版本化协议、设备身份、心跳、断线续传、幂等 command、backpressure                   |
| Policy             | Tool approval、HumanInteraction                                | tenant/device/workspace/runtime 四级策略、默认拒绝、可审计决策                     |
| Scheduler          | Execution 与恢复语义                                           | queue、lease、retry、timeout、dead-letter、placement、fairness                     |
| Capability         | revision、tool snapshot、credential separation                 | 签名与来源、发布/撤销、组织级目录、兼容性与供应链策略                              |
| Plugin             | contribution + hooks                                           | typed config schema、hook failure policy、隔离、版本兼容和权限声明                 |
| Memory             | 插件内四类记忆、evidence、distillation 原型                    | ADR 031 的持久 Feed、Module SPI、联邦 Context、资产治理和组织级隔离                |
| Observability      | 统一 Execution event envelope、Output 投影、logger、usage      | trace/span 关联、cost ledger、审计导出和 SLO                                       |

## 推荐演进顺序

### Phase 0：先封安全边界

- 取消本地 Runtime 的危险默认权限。
- 定义并实现 Local Permission Guard。
- 明确 Workspace Scope、Secret、Shell、File、Git、Network 的统一决策模型。
- 建立绕过测试：每个 Runtime 的 native tool 都必须证明无法越过 Guard。

### Phase 1：冻结对外协议

- 完成 Local Agent Bridge ADR 和最小 wire schema。
- 基于统一 Execution cursor 定义 Gateway ACK 和恢复协议。
- 收敛 Expert / Capability / Device / Run 的 schema owner。
- 在协议中加入幂等、关联、版本协商和错误分类。

### Phase 2：建立最小云端控制面

- Server 创建 Run，Worker 通过 lease 领取并执行。
- 引入生产级 Execution/Session Repository 和 event publisher。
- 实现 Device registration、heartbeat、capability matching 和本地任务下发。
- 先跑通单租户、单区域、至少一次投递，不急于复杂调度算法。

### Phase 3：收敛 Core 和 Desktop 内部边界

- 缩小 `@pragma/core` 根出口，分离 domain/application/infrastructure。
- 移除生产路径中的全局 Runtime Registry。
- 把 Desktop Main 中可复用的业务服务与 Electron adapter 分开。
- 最终确定 Memory SPI 与默认 Agent tool surface。

### Phase 4：再扩展平台能力

- 多租户策略、预算、成本和组织级审计。
- Capability registry、签名、撤销和组织分发。
- 多 Worker placement、限流、公平性和跨区域恢复。
- Web 控制台、评测、治理和运营视图。

## 不建议现在做的事

- 不新增 `apps/local-runner`；Desktop 仍应是本地 Agent 产品入口。
- 不因为 Core 文件变大就立即拆出一批 `common`、`base`、`runtime-utils` 包。
- 不在 Cloud Control Plane 未完成前继续堆更多 Runtime Adapter。
- 不把 Desktop IPC schema 直接当成 Cloud wire protocol。
- 不让 File Store 通过共享盘承担云端多 Worker 协调。
- 不在安全闸门落地前把 Mission 连接到默认 `bypassPermissions` 的本地执行。
- 不为旧 Expert 或旧状态格式长期保留兼容分支；继续采用显式 schema version 和可控迁移。

## 关键证据入口

- Core facade：`packages/core/src/index.ts`
- Pragma 执行入口：`packages/core/src/pragma-app.ts`
- Execution Store：`packages/core/src/execution/execution-store.ts`
- Expert Session：`packages/core/src/execution/expert-session.ts`
- Runtime Driver：`packages/core/src/runtime/driver.ts`
- Runtime Session ownership：`packages/core/src/runtime/session-record.ts`
- Shared Execution schema：`packages/shared/src/execution/execution.schema.ts`
- Claude Code 默认权限：`packages/runtime/claude-code/src/adapter.ts`
- Antigravity 私有 HOME、权限 Hook 与 stream-json：`packages/runtime/antigravity/src/`
- Desktop composition root：`apps/desktop/src/main/index.ts`
- Desktop Expert/Capability schema：`apps/desktop/src/shared/desktop-api.ts`
- Desktop Expert 映射：`apps/desktop/src/main/desktop-expert-factory.ts`
- Server 当前入口：`apps/server/src/app.ts`
- Worker 当前入口：`apps/worker/src/index.ts`
- Memory 实现：`packages/memory/src/`
- 相关决策：`docs/adr/031-extensible-memory-plane.md`、`docs/architecture/memory-plane-implementation-plan.md`、`004-desktop-capability-library.md`、`005-execution-owned-runtime-storage.md`、`006-runtime-session-ownership-and-leases.md`

## 总体评价

如果把 Pragma 看成“本地可持久化 Agent SDK”，当前架构已经有较扎实的骨架，尤其是 Runtime 隔离、Execution 统一模型、Session ownership 和 Capability revision。

如果把它看成“云端多专家编排平台”，当前仍处于**执行内核领先、控制面滞后、安全桥未闭合**的阶段。最有价值的下一步不是增加功能数量，而是把安全、协议、事件和控制面这四个平台级不变量做实。它们一旦稳定，Runtime、插件、Memory、Desktop 和 Web 才能在不持续重写核心的前提下扩展。
