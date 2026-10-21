# 各模块实现约束

修改对应模块前阅读相应小节；允许依赖以[模块边界](../architecture/module-boundaries.md)为准。

### `apps/desktop`

职责：

- Electron 主进程、本地存储和 Runtime 装配。
- preload IPC Bridge。
- renderer 页面与本地权限确认 UI。

边界要求：

- main 可以依赖 Desktop 允许的 Core、Interpreter、Built-in Agents 和具体 Runtime。
- preload、renderer 和跨层 shared 代码只允许依赖 `@pragma/shared` 与浏览器安全的
  `@pragma/interpreter/ast`、`@pragma/evaluation/ast`、`@pragma/built-in-agents/contracts`、`@pragma/local-host/deployment-contracts`，不得导入
  Interpreter 或 Built-in Agents 主入口及其他 Node-only `@pragma/*` package。
- preload 使用的 workspace TypeScript 必须在构建阶段完成转换；生产产物必须自包含，运行时只允许外部加载
  Electron 和 Node 内置模块，不得直接加载仓库 `.ts` 文件。
- Electron main 必须在构建阶段编译所有直接依赖的 workspace package。`electron.vite.config.ts` 的
  `externalizeDeps.exclude` 必须从 `apps/desktop/package.json` 的 `workspace:` 依赖自动派生，不得维护手工
  package 名单；新增内部依赖后，构建产物中不得残留任何外部 `@pragma/*` import，避免 Electron 在运行时
  直接解析 workspace package 导出的 TypeScript 源码。
- Desktop 完整 CLI 与 npm CLI 共用 `apps/cli/scripts/build-bundles.mjs` 的入口和 Worker 清单，随包 CLI
  位于 `resources/app.asar.unpacked/out/main/desktop-cli/`，通过应用内 Electron Node 模式运行。
  用户终端默认优先使用 Desktop 版 `pragma`，`pragma-desktop` 显式指向内置版；不得覆盖其他包管理器的入口。
  Agent 的管理客户端继续使用 Execution 私有 PATH 和授权通道，不依赖公共终端注册。
  CLI 注册在首个窗口创建后执行；macOS 移除状态不在应用重启时自动恢复，Windows 整机注册由提权安装器负责。
- Desktop build 必须验证 preload 产物和 `pragmaDesktop` Bridge 注入；Bridge 或 renderer 启动失败时必须记录
  主进程日志并显示可操作的错误页，不得静默白屏。
- Desktop 本地 Capability、ContextStore 与 RuntimeProfile 的 Host 绑定资源统一通过
  `apps/desktop/src/main/platform/bindings/desktop-bound-resource-policy.ts` 分类、创建和重绑定；Feature
  模块不得各自派生 ID、重建 metadata 或按资源数组顺序选择身份。编辑器、默认资源与系统专家身份策略属于 Desktop Host；通用安装与重绑定使用 Local Host。不得将产品身份策略下沉到
  Core、Shared 或 Interpreter。
- Local Host 在显式保存和 Bundle 导出派生图中统一 Host 资源引用：等价 Capability 绑定复用目录身份并合并历史别名，RuntimeProfile 根据完整专家引用图命名。Desktop 继续拥有 ID 分配与目录创建策略；归一化不得改写不可变 Revision、拆分共享 Runtime 或覆盖不等价的资源配置。目录身份优先级由 Host 注入；环境重绑定不能因此重分配已有资源 ID，兼容扩展字段以存储中的定义为准。
- ready Capability 新修订必须通过 Local Host Capability mutation coordinator 激活：先验证当前 Expert 的
  工具白名单，再以稳定 journal 提交 Capability 与凭据状态。Project、System Expert 与普通 Expert 只保存
  Capability ID，不传播修订号；运行时解析 active revision，并在 Execution 中记录实际修订与 fingerprint。
  历史 Project Revision 与 Mission 中的旧 binding 只保留 Capability identity，不继续 pin revision；恢复或继续
  执行时同样解析当前 active revision。已经落盘的 Execution 与旧 Capability revision 保持固定，
  `needs_attention` 修订不得自动激活。

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

禁止外部服务访问、Node 专属 API 或 core 反向依赖。

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
- `createAgentLauncher()` 为普通 Expert 创建可显式注入的 `spawn_expert`、`continue_expert`、
  `list_agents`、`wait_experts`、`steer_expert`、`interrupt_expert` 工具集；子 Invocation 的执行、Context、
  并发、深度、事件和 Usage 机制必须与 ExpertTeam 共用，不另建隐藏 Session 路径。
- `defineExpertTeam()` 声明由 coordinator 统一接收外部 prompt 的特殊 Expert。
- ExpertTeam 运行时按成员权限策略生成相同的生命周期工具集；coordinator 在当前 Team Execution 内
  拥有系统继承的全量管理权限。团队工具覆盖参与者自己的 standalone launcher，
  防止成员绕过团队治理边界。
- `defineFlow()` 声明 Flow；Task 和 HumanTask 只能通过 FlowSpec 内联创建。
- Flow Expert step 继续使用具名、带版本的 `ContextIdResolver`。Expert delegation 不接受 Context policy：
  `spawn_expert` 固定创建新 Context，`continue_expert` 固定复用调用方显式提交的 `contextId`。
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
- Memory 将符合策略的来源交给 Store/Skill Revision Agent 创建或修订托管草稿；用户批准后的 Knowledge authority 属于
  Desktop“工作室 → 知识库”的托管 Context Store，不属于 `@pragma/memory`，也不依赖 Memory Evidence。

边界要求：

- 主入口是 Node-only，可以依赖 `@pragma/shared` 和 `@pragma/core`。
- `@pragma/core` 不得反向依赖 `@pragma/memory`；Core 的 Canonical Event Bus 必须保持 Memory 无关。
- Module 静态注册，不扫描目录；Module id、版本和 Context prefix 必须唯一。
- Module 不直接写另一个 Module Store，只通过版本化 Evidence/derived event 协作。
- Memory Module 不直接改写 Studio Knowledge Store 或 Skill；Host 通过 Store/Skill Revision Agent 创建和修订草稿，
  用户批准后才激活正式 revision。Memory Curator 只提炼 Episodic 和 Semantic。
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
  当前 DSL 的 AST 与 Zod Schema。
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

- 保存五个内置 Agent 的当前 DSL，以及 Pragma 的 `author-pragma-dsl` Skill。
- 分别导出 Pragma、Memory Curator、Store Revision 和 Skill Revision 的宿主端口；调用方式允许彼此独立。
- 拥有跨 Host 可复用的提示词、结构化输出解析、Memory 提炼、Store/Skill 修订规则、Skill 验证和纯状态机。
- 导出供 Desktop 或未来 Host 适配的运行时中立契约。
- 不拥有独立 ExpertSession、聊天历史或审批投影；宿主统一复用 Mission/Execution 链路。

边界要求：

- 主入口 `@pragma/built-in-agents` 是 Node-only，可以依赖 `@pragma/core` 和 `@pragma/interpreter`。
- `@pragma/built-in-agents/contracts` 必须保持浏览器安全，只依赖运行时中立 schema。
- Pragma、Store Revision 和 Skill Revision 是可在 Studio 配置的系统 Agent；Memory Curator 和
  Evaluation Judge 是隐藏、不可定制的托管能力。Skill 测评 Agent 已删除。
- Pragma 修改 Expert、ExpertTeam 和 Flow 时只通过 DSL 能力；应用层实现持久化与任务端口。
- Desktop 将 Pragma 注册为只读系统专家；Home 只负责创建全新 Mission，不维护独立 Chat。
- Home 为 Expert/ExpertTeam Mission 提供可选的模型与思考深度覆盖，并随 Mission 持久化；Home
  不允许覆盖 Runtime，Flow 不接受模型或思考深度覆盖。
- 宿主端口使用直接 TypeScript 接口；具体 Runtime 可继续通过现有 Execution MCP Gateway 调用 managed tools。

禁止依赖 Desktop/Electron、React、Server 应用层、Client SDK、数据库实现或具体 Runtime Adapter。
