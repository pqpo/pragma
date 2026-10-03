# Issue #348 R2：Mission 编译编排实施与验证

日期：2026-10-03。状态：R2 代码实施已交付，阶段验收保持未完成；实测证据与剩余缺口见下文。R3/R4 未实施。R1 已由 PR #353 合入 main，工程验证和真实 Native Mission smoke 已通过，真实模型性能与完整产品场景仍未完成验收。

## 基线与范围

先 `git fetch origin main`，以 `a2741325ab106b3cbc8f472d4feec98b1367ae55` 创建独立 worktree `issue-348-r2`，实施分支为 `codex/issue-348-r2`。实施前读取 AGENTS.md、[issue #348](https://github.com/pqpo/pragma/issues/348)、[技术方案](local-host-application-kernel-refactor.md)、[R1 报告](local-host-kernel-r1-implementation.md)及[Token counter 后续修复](local-host-kernel-r1-token-counter-followup.md)。本报告的前后对照基线包含 R1 及其修复。

本次仅处理 R2：Mission compile service、资源端口、readiness 与缓存。未迁移首轮运行、完整 Session/recovery、Mission 持久业务或内部 Runner 调用；它们继续按 R3/R4 处理。未修改 DSL/compiler、Mission、Execution、Session、SQLite 或 journal 版本，未增加 package 或 runtime 依赖。

## 实施与删除路径

| 职责           | 实施结果                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编译编排       | `packages/local-host/src/missions/compile-service.ts` 统一 request scope、executor resolve、目标依赖、Capability active revision/credential fingerprint、identity、稳定性检查与 owner 缓存；真正的 `project.compile`/Built-in DSL compiler 仍调用 Interpreter。     |
| Revision       | 请求局部 pinned Revision promise 被 readiness、identity 与 compile 复用。源 fingerprint、derived compiler view、snapshotHash 与 revision number 保持独立；编译结果核对 derived/source authority，不重写历史 Revision。                                              |
| 缓存           | owner identity 相等时复核可变 authority，DSL compile 为零；需要 successor 时懒编译。miss 最多三次前后完整 compilation identity 稳定检查（Capability 与系统定义 fingerprint）；失败不缓存成功对象。缓存不保存 secret 明文、批准决定或跨 owner private Context 句柄。 |
| readiness      | `missions/runtime-readiness.ts` 只接受目标 Runtime IDs，成功结果缓存 30 秒，相同 binding/environment 合并并发，失败立即失效，配置/执行失败/刷新清除。Desktop 原 picker 查询保留。                                                                                   |
| 系统与内置资源 | source 提供 descriptor、DSL resource、customization fingerprint 和 execution profile；Local Host 调用统一编译；root 模型覆盖保持显式 Runtime，外部依赖请求内合并并检测交叉循环。Runtime defaults 两个纯函数归 Local Host，Desktop 薄 re-export。                    |
| Node/CLI       | `node-mission-compiler.ts` 组合同一服务与资源；catalog 和 built-in resolver 委托它，默认 Node composition 共享实例。无需 Electron 读取已支持的本机资源。                                                                                                            |
| 资源与 Schema  | `@pragma/local-host/resources` 拥有 Capability/ContextStore/Plugin 的读取、历史升级、凭据恢复及贡献；Shared 提供浏览器安全的权威 Schema，Desktop/Interpreter re-export 相同 Schema。Desktop mutation、ID policy、activation coordinator 与审批不移动。              |
| 诊断           | 缺管理、artifact、Plugin/Secret 等能力显式失败；Node 准备边界映射既有集成错误，保留安全 resource ref 和稳定诊断，不生成缺工具的可执行对象继续运行。                                                                                                                 |

已删除 Desktop `compileMissionExecutor*`、`compilationIdentity`、Capability/系统依赖遍历与 `compileSystemExecutor` 回调；`mission-runner-composition.ts` 只提供资源和生命周期适配。CLI catalog 的直编译与 built-in resolver 永久定义 Map 已删除。最终又删除已无调用方的 Desktop `PragmaProjectStore.compile` 转发方法及类型声明；Interpreter API 保留。Desktop 原资源 reader、credential/migration kernel 由共同 Node 实现承接，保留的 re-export 是仍有调用方的 package 边界；CRUD/审批留在 Host。

## 性能保护与边界

保留 identity JSON 字段顺序和 SHA-256 算法；模型/thinking、权限、Context mount、系统依赖及 Capability definition/credential fingerprint 继续参与失效。系统 customization 的附加 Capability 现通过 registry descriptor 端口进入闭包；其 active authority 原先未被 R1 捕获，现会按相同 identity 格式正确失效。未新增耐久写、全量缓存/Revision 扫描、全局 readiness registry 或容量门禁。Plugin 定向定位只 fingerprint 目标包；历史安装布局 fallback 只读取 manifest，不 hash 无关包。

前台 await 与 owner：Desktop readiness 的 Project head 读取改为请求内 pinned Revision promise，identity 与稳定编译复用它；warm hit 不添加 DSL compile、Session open 或 Runtime acquire。默认 Node 暖命令新增 pinned Revision/可变 Capability authority 检查，防止复用过期绑定；目标 readiness 成功命中不调用 canUse。未新增 Mission/Execution 必要耐久写或锁；owner/lease/fencing 仍属 R1 控制服务，DSL compiler 与既有首次访问迁移锁不改变。

P01–P17 的执行、投递、worker、SQLite、删除与 Token counter 机制保留。直接受影响的 P01 暖 owner、P03 请求内 Revision 复用及可变 authority 检查，以及四轮目标依赖闭包与成功 readiness 缓存通过新测试及 Runner 接线回归核对；其余由 control/chat/revision、构建和既有局部基准保护。编号以技术方案表为准，不能将本报告局部测量代替所有产品验收。

默认 Core `staticRuntimeResolver.bind()` 可能按既有实现调用 adapter 的 model list；本次未改 Core Runtime 算法。Local Host readiness 自身不枚举 model 或全部 Runtime，Desktop 正常目标路径继续使用不可变环境 binding 与缓存。不能声称所有默认 Host 的整个 bind 调用链完全没有 model discovery。最终60样本暖复测跨越30秒TTL，实测目标availability刷新时Runtime health/model catalog API每请求计数集合为{0,1}；已记录此间接discovery边界，未修改原Runtime探测算法。

## 工程验证

已完成的验证：

- `pnpm check` 退出 0（Runtime feature/API-version gate、全仓 lint/typecheck、test:core；未执行 test:all）。
- `pnpm build` 退出 0：19 个任务完成，包含 Desktop main/preload/renderer、Host storage worker 与 CLI bundle 检查。
- 首次 `test:mission-compilation`：Local Host 32 项、Desktop 10 项通过；新增 Node error boundary 13 项另通过。
- Desktop Runner 84 项、adapter/profile 8 项、Runtime defaults 2 项通过。
- 资源新专项 4 项、既有资源/凭据迁移 110 项、contribution/权限 16 项通过；真实旧 Capability v2、ContextStore v3 来源见 `packages/local-host/test/fixtures/resources/README.md`。
- `test:revision`：Built-in management 13 项、ContextStore revision 69 项及 Runner 修订接线 6 项通过（最终计数以日志为准）。
- `test:mission-chat` 串行重跑通过：Core 2 项、Memory 3 项、Desktop chat/renderer 71 项及 Runner 6 项。
- CLI 确定性 100 项通过；native doctor 8 项串行重跑通过。

首次并行执行中，Memory warm counter、controller delayed heartbeat 与 CLI doctor hook 超时；未修改其业务或延长测试预算，改为串行核验。首次全仓 lint 与 native fixture 并行，读到尚未清理的 `.m10-e07-bundle-*` 产物；清理后全仓 lint 通过。这些失败保留在验证日志，不能作为成功样本。

性能 pilot 曾发现 Desktop openRevision 遗漏外部系统 refs，修复后新增 Desktop published caller → system compile/execute、registry 附加 Capability 失效，以及 Node 已知 refs 编译/未知 refs 拒绝四项回归通过；历史 reader 8 项、registry 10 项继续通过。Desktop Secret 端口使用现有 pluginCredentialStore，持久化 Secret 与 Node 等价、缺失诊断及 locked 原错误传播测试通过。

默认 Node 真实集成新增 4 项通过：Expert、Team、Flow 使用实际 Interpreter、CAS Revision、active Capability revision 3 与 SQLite Execution，环境 snapshot 等价；执行失败清除 readiness 后重新探测。测试 Runtime 保留 Core 注册的原 Session factory 对象，未用 spread 伪造 Runtime。

真实 Node composition 另发现既有 `run-memory.ts` 将带 loggerProvider/callback 的完整 options 传给 Core canonical worker，触发后台 DataCloneError；现仅传 worker 所需 `pragmaHome`，未改协议、投递或 lifecycle 规则。测试缺 revision 与 Runtime fixture 对象失配属于夹具问题，已纠正，不归因于生产 fresh pin guard。

Node cold consumer admission 新增两项通过：真实 Node catalog/compiler 读取 pinned Revision 1 次、DSL 编译 1 次、executor resolve 1 次、Session resume 1 次；下一暖请求只增加一次 Revision 读取。缺 Capability 在恢复/接受前拒绝。此计数不覆盖整个 `missionControl.submit`：其既有 acquisition preflight 与 startOwner 可能再次 resolve/compile，未改 R1 fencing/lease 裁决；不能声称 CLI 完整冷提交只编译一次。

Node warm authority 新专项 4 项通过，连同旧 adapter/retained 2 项、real-boundary 8 项共 14 项。实际 Node compiler + Interpreter 证明 warm 每轮 pinned Revision API 读 1、Capability authority 读 1，额外 DSL compile/readiness probe/Runtime acquire 为 0；变更 authority 额外 compile 1 后拒绝旧 Session，原 Session 可检查；失败 warm turn 清除 readiness 后探测 1 次。

新增真实 Memory canonical worker 回归及原套件4项通过。最终冻结后以Node24.18.0串行复核：check退出0（159.07s）、build退出0（90.65s）、compilation gate 57 Host+13 Desktop=70项、control gate 124 Host+6execution-system+4Desktop=134项、CLI108项，以及pack/release:reports/positive package smoke全部退出0。逐命令耗时、计数及日志摘要见[工程证据](../performance/local-host-kernel-r2/validation.json)。新 gate `pnpm test:mission-compilation` 已加入 CI 与 Desktop release；R1 control、chat、revision gate 保留。

## 同条件性能对照

性能在实现、测试与构建进程退出后串行执行。编译 probe 使用同一脚本、隔离真实 Project/Mission/SQLite/Capability/ContextStore、相同 fake Runtime、固定权限与模型选择；它不测模型、renderer 或正常后台负载。Capability verifier/credential fingerprint fixture 仅用于可重复的 authority 变化；未访问用户凭据。

读取计数是 instrumented Host API 调用，DSL 编译计数在真实 Interpreter prototype 上计数；不是磁盘读取次数或物理 I/O。warm、cold、权限、模型、Capability、credential、system、Context mount 分组报告。prepared phase 与完整 send 准备耗时分别记录。源码摘要在每次测量前后核对。

正式两组 main → R2 对照，每端每场景20样本：warm P95 为639.54/674.03 → 626.41/597.93 ms；每请求 head/pinned Revision API读为1/1 → 0/1，warm DSL compile=0、active Capability/credential fingerprint各1，miss DSL=2（root+system）。准备包括Inbox/control接入，不代替产品UI指标。

第2组Capability失效P95为657.62 → 823.34 ms，触发>10%且>20ms检查；追加两组每端60样本，main/R2为673.90/664.95及688.17/668.37 ms，均未复现触发。原始触发、Revision read 146.64ms与Session open outlier、所有cache/pin计数保存，未改生产性能算法或延长超时。存储/读取、准备期间前台读取与renderer局部P95未触发回退线；转换总耗时每轮单值只报告波动，不冒充P95。

最终移除Desktop无调用方compile转发后，typecheck/lint、build和70项compilation gate再次通过。重新冻结最终源码并重测两组各20样本，warm P95为main/R2 608.19/715.36与727.78/623.09 ms；第5组触发>10%且>20ms，Revision read慢样本150.14ms。追加两组各60暖样本，main/R2为605.28/623.10、624.35/621.74 ms，均未重复触发。全部缓存/pin计数保持；初轮、最后删残留及最终测量的源码摘要分别保存，Node/Core/存储/renderer代码没有改变。

方法、完整准备与compile phase表、raw样本、I/O、源码摘要、额外复测、Native及provider缺口见[性能与Native验证报告](../performance/local-host-kernel-r2-performance.md)。正式测量与复测期间生产源码保持冻结，普通用户应用未关闭；无模型/正常后台负载的局部结果不能宣称完整性能验收通过。

## 阶段退出与剩余缺口

真实 Electron safe-storage 跨进程专项在 fixture native write 阶段 120 秒超时，未取得成功结果。确定性资源迁移通过不能替代 OS 凭据验收。

默认 Node 暖 owner 的命令现每次通过共同 compiler 复核 authority；初次 resolve 的编译 metadata 随 owner 传递，hit 不重开 Session、不重新 DSL compile。绑定变化时 compile cache 失效，显式 `COMMAND_REJECTED` / `executor_environment_changed_requires_successor`，不继续用旧环境。Core 对同一持久 Session 的定义变更 fail closed；默认 Node 当前按 Mission ID 恢复 Session，没有 successor 的持久 Session pointer。跨 Session successor 关联与恢复属于 R3，本次未伪造定义 migration 或新增持久格式。Desktop 的既有 successor 适配保持；该 Node 场景不能标记两端产品等价通过。

Expert/Team/Flow 的 Node Execution 现在传递共同 `missionCompilationEnvironmentSnapshot`，记录实际 Capability revision/fingerprint，既有 Execution 不重写。初始 run/start 和后续控制失败会清除成功 readiness 缓存；Runtime binding key 仍决定配置变化失效。

本次真实Native Mission smoke 18/18通过，72.92秒，进程正常退出。它使用真实Codex、共用run/control及直接解析的executor，覆盖queue/steer、暖记忆与正常释放后重开；不能证明新默认Node compiler的Native资源接线、Team/Flow、崩溃接管或完整产品性能。真实provider相同参数pilot：main/R2均在credentials-read阶段120秒超时、退出1且进程退出已确认，各0个有效模型样本，不记为通过。

| 退出条件                                                     | 本次状态                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 普通/system/built-in共用compile、readiness与具体资源端口     | 已实施；实际Interpreter、Host/Node/Desktop接线及构建通过                              |
| identity/hash、pin、derived view、Capability等失效与缓存计数 | 确定性测试及真实存储/fake Runtime对照通过；正式触发与追加复测均保留                   |
| 无关坏资源/慢Runtime隔离、30秒成功探测缓存、权限             | 对应专项通过；Core默认Node bind已有model discovery未在本次修改                        |
| Desktop关闭时Node执行与资源读取                              | 确定性真实Node/CAS/SQLite集成通过；OS native凭据跨进程专项未通过                      |
| 不回退与完整性能退出                                         | 局部对照与复测完成；真实provider、正常Memory/Automation负载与完整产品报告缺失，未通过 |
| R1状态与R3/R4范围                                            | R1已合并且保留未验收项；Node successor/完整冷acquisition收敛仍未实施；未扩大阶段      |

R2保持“代码实施已交付，阶段验收未完成”。真实模型同条件性能、完整产品场景及四项UI/terminal指标缺口继续保留，不能因Native smoke或局部缓存结果关闭这些项。

## CR 后续修复

独立 CR、逐项裁决与修复验证另见 [R2 CR 报告](local-host-kernel-r2-code-review.md)。修复后的源码属于新的测量批次；此前性能证据保留其原源码摘要，不能作为修复后源码已测量的声明。阶段验收缺口保持，不因 CR 问题修复而标记 R2 完成。

CR 后暖缓存同时定向复核实际使用的 Secret 与 Plugin guard，含 Plugin 凭据配置位置映射。guard 仅含引用与 hash，普通无贡献路径保持原读取数和 identity；非空 guard 追加新 Execution environment hash，以准确记录实际环境，已有 Execution 不重写，空 guard hash 不变。具体结果见 CR 报告，R3 successor 边界继续保留。
