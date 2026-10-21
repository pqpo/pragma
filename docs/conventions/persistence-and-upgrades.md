# 持久化、升级与存储治理

修改协议、状态 Schema、迁移、删除或存储布局前必读。领域 parser 的权威版本以源码为准。

## 协议升级

以下规则适用于所有持久化和跨进程协议，包括 DSL `apiVersion`、状态 `schemaVersion`、
Interpreter `compilerVersion`、manifest、lock、IPC、Bridge 和 Runtime capability：

- 任何会让新代码拒绝或改变既有合法数据语义的改动，必须在同一个 Pull Request 中提交明确的版本升级、
  可执行升级机制和完整测试；禁止先升级 Schema 或版本号、再留待后续补迁移。缺少升级机制时不得合入。
- 未发布或由项目维护者明确确认没有真实用户与需保留数据的实验协议，可以在维护者明确授权后直接
  切换协议，无需迁移。必须在同一 PR 的 ADR 中记录事实依据、授权、受影响协议、旧数据处理和新版本
  拒绝规则；使用独立命名空间，不自动删除旧数据，并验证新协议首次使用、异常恢复与未来版本拒绝。
  Agent 不得根据使用率低或自行猜测“没有用户”申请此例外；已发布且有用户、支持窗口内的协议及
  未经确认的数据继续遵守完整升级机制要求。
- DSL `apiVersion` 表示最低安全读取代际，不因普通可选字段增加而升级。当前版本的写入、直接读取和
  可迁移来源必须由 `@pragma/interpreter/ast` 的权威能力常量声明；Host、Evaluation 和测试不得复制当前
  版本字面量。只有旧客户端忽略改动会造成语义、安全、权限或数据错误时才升级 `apiVersion`。
- 当前 DSL 资源与 Bundle 的兼容读取边界必须递归保留所有对象和数组元素中的未知字段并报告 warning；
  已知字段仍按严格 Schema 校验，未知 discriminator、未来 `apiVersion`、Lock 和完整性协议继续 fail closed。
  Host 更新已有资源时必须在统一持久化边界合并未知字段，不得要求每个 UI 编辑器单独维护兼容白名单。
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
  Runtime/Bundle warm-up 等后台工作。启动路径不得执行全量 storage maintenance；容量统计仅在闲时低频
  后台执行，不得阻塞页面读取、Mission 创建/发送或其他正常写入。容量超限只提示用户手动清理，不设
  全局写入门禁。不要为此引入通用 readiness registry 或全局升级 coordinator。
- 升级测试必须使用由真实历史代码写出的 fixture，不得用当前对象只改版本号伪造。Pull Request 至少
  覆盖历史 fixture、当前版本 no-op、相邻和链式升级、崩溃恢复、未来版本拒绝以及升级后的启动/执行；
  缺少任一适用场景时不得合入。
- 删除仍在支持窗口内的升级链属于兼容性 cutover，必须另写 ADR，并提供导出、备份或离线升级方案。

## 存储与恢复

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
  Execution 与 Runtime Session 文件到带 journal 的回收站，并用同一删除事务的 catalog pending
  记录移除 SQLite ownership row；文件移动与 catalog 提交必须受跨进程锁保护且可在崩溃后重放。
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

## 决策依据

- [持久状态迁移](../adr/019-versioned-persistent-state-migrations.md)
- [Host 按需升级](../adr/020-host-coordinated-persistent-state-upgrades.md)
- [本地存储生命周期](../adr/016-local-storage-lifecycle-and-content-addressing.md)
- [不可变 Revision 的派生升级](../adr/029-interpreter-compiler-compatibility-and-scoped-validation.md)
