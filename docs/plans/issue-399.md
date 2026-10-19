# Issue 399 独立部署与 Memory Headless 重构执行计划

目标是让 Desktop 与 CLI 共用资源部署、环境管理和 Memory 后台业务，CLI 能在不启动 Desktop 的情况下完成配置、导入、运行与学习。先在现有支持的平台完成业务闭环，Linux 支持放到最后。

代码基线：2026-10-19 拉取的 `main`，`e1b6d427`。需求依据为 [Issue 399](https://github.com/pqpo/pragma/issues/399)、维护者的[阶段核对](https://github.com/pqpo/pragma/issues/399#issuecomment-6260731002)和 [Memory Headless 补充](https://github.com/pqpo/pragma/issues/399#issuecomment-6260968883)。

## 已完成的基础

以下能力已经存在，后续直接复用，不重新实现。

| 已完成内容                               | 当前边界                                                                                                     | 依据                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop 与 CLI 统一 Mission application  | 控制、编译、执行、owner 和恢复已共享                                                                         | [PR 356](https://github.com/pqpo/pragma/pull/356)、[ADR 066](../adr/066-unified-local-host-mission-application.md)                              |
| 管理 CLI 与 manage-pragma Skill 迁移     | 管理命令仍依赖 owning Execution endpoint                                                                     | [PR 375](https://github.com/pqpo/pragma/pull/375)                                                                                               |
| 凭据诊断修复                             | 已修复存储版本误报，尚不包含 Linux 无桌面凭据支持                                                            | [PR 400](https://github.com/pqpo/pragma/pull/400)                                                                                               |
| CLI 查询与运行能力完善                   | 已有分页、有限等待、owner 生命周期与机器输出                                                                 | [PR 402](https://github.com/pqpo/pragma/pull/402)、[实施记录](issue-398.md)                                                                     |
| Bundle 协议与 Desktop 导入能力           | Interpreter 拥有协议；阶段 1 已将安装、资源写入、配置和绑定收敛到 Local Host                                 | [Bundle 架构](../architecture/pragma-bundle.md)、[Desktop 导入说明](../architecture/desktop-bundle-transfer.md)                                 |
| Memory 数据面及提炼、检索、Learning 能力 | CLI 已能采集 Evidence、提交 Job 和读取已有记忆；提炼执行、索引写入和 Learning 编排尚未形成独立 Headless 闭环 | [Memory 说明](../usage/memory.md)、[ADR 057](../adr/057-unified-memory-revision-learning.md)、[PR 407](https://github.com/pqpo/pragma/pull/407) |

这些成果是本次重构的起点，不代表 Issue 399 的独立部署与后台业务闭环已经完成。

## 阶段顺序与状态

| 顺序 | 阶段                        | 当前进展                                    | 接下来交付                                      |
| ---- | --------------------------- | ------------------------------------------- | ----------------------------------------------- |
| 1    | 共享部署与环境服务          | 共享业务与工程门禁完成                      | CLI 入口留待阶段 2，真实闭环验收留待阶段 4      |
| 2    | CLI 独立部署入口            | 运行、查询、诊断和管理客户端已有基础        | 从空配置完成导入、环境准备、修复与运行          |
| 3    | Memory 与 Learning 独立运行 | 领域能力已存在，后台业务仍依赖 Desktop 装配 | 共享后台服务与 CLI 配置、处理、审核入口         |
| 4    | 现有平台闭环验收            | 已有分项测试与验证                          | 使用实际 CLI 包完成独立部署和 Memory 全链路     |
| 5    | Linux 支持                  | 当前包不支持 Linux，CI 仅验证拒绝安装       | 无桌面认证、平台适配、正向 CI 与完整 Linux 验收 |

按 1 → 2 → 3 → 4 → 5 推进。每阶段可以拆成多个 PR；前三阶段及现有平台验收不以 Linux 支持为前置条件。本次只交付阶段 1；CLI 独立部署、Memory Headless 和 Linux 仍按后续阶段推进。

## 阶段 1 共享部署与环境服务

**已完成：** 在 `e1b6d427` 的已有 Mission application、compile service、owner、恢复和 SecretStore 上继续收敛，没有新增执行内核。Project、Capability、ContextStore、Plugin 写入，Bundle 导入导出和安装，模型连接及 Runtime Environment 业务均已进入 `@pragma/local-host/deployment`；Desktop 生产入口直接接入，旧业务实现已删除。浏览器安全 DTO 使用独立的 `@pragma/local-host/deployment-contracts`。具体 Runtime 工厂、PI 模型目录/探针、Electron/凭据后端以及编辑器、默认资源和系统专家身份策略留在 Desktop。详见 [ADR 075：共享部署与环境服务](../adr/075-shared-deployment-and-environments.md)。

**主要目标：** 将资源部署所需的通用业务收敛到 Local Host，Desktop 同步改接，给 CLI 提供完整可复用的服务。

**实现思路：** 复用现有业务，按资源写入、Bundle 安装、环境配置、绑定修复逐块下沉。Interpreter 继续负责协议、依赖分析、引用重写和编译；平台凭据与具体 Runtime 工厂通过窄端口注入。

**执行计划：**

1. 明确共享业务、平台适配和持久协议的边界，补充必要 ADR 与契约。
2. 收敛 Project、Capability、ContextStore、Plugin 写入及 Bundle 安装业务，补齐统一的请求重试、中断恢复和冲突处理。
3. 收敛模型连接、Runtime Environment、确定性绑定、就绪检查与局部修复，明确共享配置的影响范围。
4. 每块业务迁移时同步改接 Desktop，删除重复实现，验证既有导入、导出、绑定和运行行为。

**完成标志：** 两端可调用同一套部署与环境服务；Local Host 不依赖 Desktop Store 或 Electron；安装重试、恢复、缺依赖和重新绑定通过验证。

**本次实现记录（2026-10-19）：**

- 安装请求 UUID 与内容身份分离；持久保存已验证的原始归档、资源映射、资产分配和 publication UUID。同请求重试复用结果，丢失写入回执和进程中断可重放，决策不一致或 Project 并发修改明确报冲突。
- 安装 catalog/record v8→v9 使用静态相邻迁移，保留既有升级链、备份和 journal。新增 fixture 来自基线真实 Desktop writer 的导出/导入结果，覆盖 v8 journal 恢复后继续升级，并恢复完整历史 owner 的 15 个真实文件验证升级后的 Project、知识快照和 ready 状态；没有通过改当前对象版本号伪造历史数据。Bundle/DSL 协议版本不变。
- 安装成功与 ready 分开；Runtime、模型目录、凭据、资产缺失和绑定歧义保留稳定诊断。自动选择要求唯一精确候选；显式选择优先，缺失的显式模型不会被默认模型替代。
- 修复只作用于选定安装，共享依赖及祖先按需复制，引用重写仍由 Interpreter 完成。修复 journal 支持丢失发布回执后恢复；保留未知字段、旧 Project Revision 和既有 Execution/Session Runtime 身份。
- 模型连接修改显式声明共享范围，返回受影响资源及 fingerprint；在持久锁内执行 revision CAS 后更新凭据并失效相关缓存。Desktop 编辑界面显示共享影响提示。
- 保持显式副本、资产身份和凭据隔离。按本次范围确认继续拒绝含 Plugin 依赖的 Bundle 导入/导出；独立 Plugin 写入服务已共享。

**阶段状态：共享业务及 Desktop 接线完成，工程门禁通过。** 本次没有实施后续阶段入口。

**工程验证（本机 macOS/x64，Node 23.11.0）：**

| 验证                                             | 结果与证据                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`、`pnpm typecheck`                    | 各 19 个任务通过；补充契约护栏/历史 owner 测试后，Local Host lint/typecheck 与根 ESLint 配置检查再次通过                                                                          |
| `pnpm build`                                     | 19 个任务通过；main 无外部 `@pragma/*` import，preload 自包含且注入 `pragmaDesktop`，随包 CLI 构建完成，打包 storage Worker 真实启动并持久写入 receipt DB                         |
| `node scripts/run-business-tests.mjs --prepared` | 15 个阶段全部通过；Host 1086 项通过、1 项跳过，CLI 165 项通过，Desktop 519 项通过、2 项跳过，Memory 142 项通过，另含 Core/Runtime/内置工具及源码 Worker 门禁                      |
| `pnpm test:core`                                 | 4 个任务通过，22.56 秒；包含快速领域契约与 Desktop 启动/打包检查                                                                                                                  |
| `pnpm test:revision` 同一清单                    | 32 + 212 + 15 项通过；仅为遵守资源预算，在 Turbo build 上增加 `--concurrency=2`，最后一次调用按原命令筛选 15 项，其余 69 项未选中                                                 |
| 迁移与新增边界补跑                               | Core Bundle 迁移 8 项通过；编译后 Host 的完整历史 owner 与全部 ESLint 护栏 7 项通过（其余 58 项仅未选中）。部署/环境专项合计覆盖 65 项，其中完整历史 owner 为门禁后新增的独立补跑 |

共享业务测试使用真实临时存储、Project/资产写入、跨进程锁和 SIGKILL；Desktop 使用生产 IPC/配置适配。历史 owner fixture 保存真实 writer 文件字节，迁移后重新读取 Project 和知识快照并检查 ready。浏览器契约护栏实际拒绝 Node API、Node application entry 和相对路径越界；合法 renderer 契约入口可用。

完整业务计时及每包结果保存在本次 worktree 的 `.test-results/business-timing.json` 和同目录 JSON（生成文件，不提交）。本地业务阶段共 1048.59 秒，Host 串行阶段 695.19 秒，**没有达到八分钟性能目标**；本次未运行 CI 冷/暖缓存测量，不能据此宣称性能验收完成。没有通过缩短生产租约或跳过必需文件来压缩时间。

环境门禁未启用 `PRAGMA_RUN_REAL_M7`、`PRAGMA_MISSION_DELETE_NATIVE`、`PRAGMA_MISSION_DELETE_BENCHMARK`，对应真实 Team/Flow、真实 Codex 删除和删除性能用例共 3 项跳过；系统钥匙串专项按既有业务清单排除。Runtime/凭据测试使用受控端口，不计作真实 Runtime 或 native keychain 验收。

**本阶段 CR 复核（2026-10-19）：** 对本分支全部改动进行代码核对，复现并修复以下六类问题，修复后的工程回归均已通过。

- 安装清理原先只检查 DSL 引用，可能删除其他资源仍绑定的同一底层 Capability/ContextStore。现在先检查保留资源的资产绑定，拒绝破坏共用资产的清理。
- 清理比较基准不可靠：丢失发布回执时会错误使用安装前 Revision，readiness recheck 又可能把后续用户编辑当作安装内容。现在通过稳定 publication receipt 恢复基准；带事务的 v9 安装在只读就绪复查中保留最后一次安装/修复发布 Revision，清理取锁后重新读取安装记录。
- 重新绑定遇到旧修复 journal 时原先直接返回恢复结果，吞掉本次新绑定。现在先恢复旧意图，再验证本次 baseRevision 和请求，过期请求明确报冲突。
- 绑定校验原先读取 latest Capability，可能误用未激活候选。共享绑定和 readiness 现在共用 active 优先的解析；没有 active 的未就绪资产仍允许保留待配置状态。
- 首次安装可能把缺少 Expert 声明工具的 ready Capability 当作可运行。现在检查声明的 Skill/工具兼容性，保留明确诊断，并验证无需重新导入即可局部修复。
- Desktop 模型编辑未传递表单加载时的配置修订，可能覆盖并发修改。现在由实际编辑入口保存并传递 expectedRevision；通过 UI 请求适配→生产 IPC→真实配置/加密凭据存储，验证旧表单被拒绝且凭据不被覆盖。

三个旧 Skill 测试夹具此前错误声明为 tools，已改为真实的 Skill 声明，保持原有 ready 成功断言。未更改持久协议版本或增加持久字段；继续使用本阶段 v9 安装协议及修复 journal。

本轮修复后重新执行根目录 lint、typecheck、build，均为 19/19 任务通过；编译产物上的共享部署及架构边界测试 75/75、真实历史安装迁移 8/8、CLI adapter 全部 165/165、Desktop 部署/环境/IPC/UI 相关 13 个文件 221/221，通过且没有跳过。本轮共 469 项回归，覆盖前述六类问题；不以此替代上文已经记录的完整业务门禁或真实 Runtime 验收。新增共享部署 ADR 原先误用已有编号，已改为未使用的 075 并补入索引，相关引用同步更新。

**剩余边界：** 本阶段无 CLI 新部署入口、Memory Headless 或 Linux 适配。真实模型/Harness 执行、系统钥匙串、交互式 Desktop 全流程和 macOS/Windows 发布包验收尚未执行，留待相应平台和阶段 4 验收；本次工程测试不能替代这些验收。CI 性能目标同样尚未验收；本次已记录本地超出目标的计时，未将其标作通过。

**PR #408 评论复核与修复（2026-10-19）：** 完整读取普通评论、审核正文及行内评论，确认三个 P1 均成立，已修复并独立验证。原提交 `0e6acee8` 的 GitHub CI 质量、业务与 CLI 包验证已通过；以下为修复后的本机证据。

- Desktop 将没有 transaction 的历史 installing/failed 记录也识别为中断安装，直接进入恢复结果页并调用共享 recheck。共享入口阻止新 UUID 绕过未完成历史记录；缺少可恢复 journal 时保留记录，明确报告安全清理或备份恢复路径。
- 失败安装结果页增加确认后的安全清理入口，成功后重新 inspection 并生成新 requestId；清理受阻时保留原记录、展示原因及人工处理提示。共享安装冲突使用明确错误类型，Desktop IPC 保留稳定冲突码。
- 清理前检查同 Project 中其他 Installation 的 resourceRefs；keep_local 复用根或依赖时拒绝删除创建者，保留共用资源及消费者的 readiness。
- 新增真实 v8 installing/failed owner fixture、历史恢复/损坏 journal/持久冲突的生产 IPC 回归，以及真实 Chromium 对话框测试入口 `pnpm --filter @pragma/desktop test:bundle-recovery-ui`。

验证：根目录 `pnpm lint`、`pnpm typecheck`、`pnpm build` 各 19/19 任务通过；编译后共享部署及边界 76/76、Core 历史迁移 8/8、CLI adapter 165/165、Desktop 相关 14 个文件 236/236，共 485 项通过且无跳过。Chromium 另有 3 组交互场景通过，覆盖无 transaction 的两类历史状态、确认/取消、拒绝清理时展示服务端原因、重新 inspection 和新 UUID。浏览器交互使用受控 Bridge，生产 IPC 测试另行验证真实 Project/ContextStore/归档和历史迁移边界，两者不冒充真实 Runtime 验收。已检查简中 1440×900/100%、英文 1080×700/125%、繁中 1080×700/150% 的正常与焦点态截图；Tab 验证真实焦点移动，隐藏 macOS 窗口的焦点态截图使用 DevTools 强制 focus-visible。临时截图保留在仓库外，未提交。

非阻断建议已核对：当前模型编辑已有 provider revision CAS，实际消费者影响预览及 expectedImpact 接线留待后续；Bundle application service 内部按规划/事务/恢复/绑定修复拆分属于后续维护，不在本次缺陷修复中扩大重构。阶段 2、3、5 和真实 Runtime/平台验收的未完成状态保持不变。

## 阶段 2 CLI 独立部署入口

**已完成：** CLI 已有 Runtime 装配、Mission 运行与恢复、查询、分页、诊断、有限等待和机器输出；Agent 管理 CLI 已完成迁移。

**主要目标：** 在现有支持的平台，仅通过 CLI 从空 `PRAGMA_HOME` 完成配置、导入 Bundle、修复依赖并运行任务。

**实现思路：** CLI 只补参数、交互、输出和进程适配，业务全部调用阶段 1 的共享服务。独立部署入口不要求先有 owning Execution endpoint。

**测试收敛目标：** 共享业务测试与 CLI 真实生产链路通过后，应能覆盖 Desktop 所复用的部署、环境和绑定业务的基本正确性；Desktop 通过必要的适配与界面测试验证平台差异。CLI 测试必须实际调用共享服务，不能以 mock 共享业务后的命令测试作为这一保证。

**执行计划：**

1. 接入初始化、Harness/模型发现、连接与凭据配置，支持从零创建运行环境。
2. 接入 Bundle 检查、安装、状态查询、诊断和局部重新绑定，沿用已有 Mission 运行与结果查询。
3. 补齐参数或配置文件驱动的非交互流程，以及可复用的无密钥绑定配置。
4. 验证无 TTY 时不挂起、依赖不足时准确报告、修复后无需重新导入，并保留原管理客户端的授权边界。
5. 将仍位于 Desktop 的通用部署业务测试迁移到 Local Host，包括 Project、Capability、ContextStore、Plugin、Bundle、模型连接和 Runtime Environment 的通用用例。保留真实持久化、迁移、重试、中断恢复、冲突、依赖缺失、绑定歧义和局部修复覆盖；Core、Interpreter 等领域包继续拥有自身测试。
6. 接通 CLI 生产入口对这些共享服务的端到端覆盖，同步清理 Desktop 中的重复通用业务用例，并更新分级业务门禁。不能通过删除恢复、迁移或真实持久边界用例来减少测试数量；同一共享业务选集在门禁中只执行一次。

**测试职责与验收：**

- Local Host 验证通用业务规则及真实存储边界，成为 Desktop 与 CLI 共用的业务回归依据。
- CLI 使用实际构建的入口和 Worker，从空配置验证部署、配置、绑定、运行、诊断及跨进程恢复；覆盖非交互与无 TTY 行为，不另建 CLI 专用业务实现。
- Desktop 保留 UI/IPC 参数与结果传递、凭据后端、具体 Runtime 装配、打包产物，以及编辑器、默认资源和系统专家特有身份策略的测试。只调用共享服务的通用业务用例迁出，不重复验证共享内核；Desktop 特有行为仍须验证。
- 提交迁移前后用例与门禁的对应记录，证明覆盖被转移而非丢失，并记录共享、CLI、Desktop 各选集耗时。遵循现有 worker 与测试分级预算；真实 Runtime、系统钥匙串及发布包验收与受控测试端口的工程验证分开记录。

**完成标志：** Desktop 关闭且没有历史 Pragma 配置时，CLI 可以完成一次真实部署与任务执行；相同安装请求安全重试，不影响其他资源或已有 Session。通用部署业务测试已集中到共享层，CLI 生产链路与 Desktop 必要接线测试共同通过，Desktop 不再重复维护这一范围的通用业务测试。

## 阶段 3 Memory 与 Learning 独立运行

**已完成：** Memory 已有共享数据面、提炼 Job/Session、Curator 工具契约、向量检索和 Learning 规则；Desktop 已能执行后台提炼及 Knowledge/Skill 草稿审核。最新 PR 407 已完善 Curator v2 与历史会话恢复。

**主要目标：** Desktop 关闭时，CLI 或显式托管的 Worker 仍能完成记忆提炼、索引维护和 Learning，并保留人工治理。

**实现思路：** 将 Desktop 独占的后台业务编排收敛到 Local Host，复用 Memory、Built-in Agents 和共享 Mission 用例。Desktop 与 CLI 仅管理各自生命周期和交互，不新增 CLI 专用提炼或索引实现。

**执行计划：**

1. 共享 Curator、提炼调度、诊断和恢复服务，提供显式、有界或持续处理的 Worker 生命周期。
2. 接通无 Desktop 的 Embedding 配置、全量回填、增量索引与失败恢复，保留关键词降级；Jev 继续可选。
3. 共享 Knowledge/Skill Learning 的规划、托管草稿和 Revision 编排，保持原触发门槛及人工批准规则。
4. 补齐 CLI 的 Memory 配置、处理、查询、重试和审核入口，Desktop 同步改接共享业务。

**完成标志：** 无 Desktop 时，新 Evidence 能生成 Episodic/Semantic Memory 并被下一次 Mission 召回；索引可更新，Learning 能生成草稿并在授权批准后生效；重启可恢复且不重复写入。

## 阶段 4 现有平台闭环验收

**已完成：** 各能力已有工程测试、使用文档和分项验证，但尚不足以证明独立部署及 Memory/Learning 的完整闭环。

**主要目标：** 先在当前支持的平台验证前三阶段，形成可复现的交付与回归证据。

**实现思路：** 使用实际候选 CLI 发布包、真实 Desktop 导出的 Bundle 和真实 Runtime/模型。独立环境从空配置开始，验收期间不启动 Desktop；另行回归 Desktop 原有体验。

**执行计划：**

1. 验证配置、Bundle 资产导入、自动绑定、真实任务、进度和结果查询，以及无密钥配置复用。
2. 验证依赖缺失、凭据错误、绑定歧义、局部修复、安装中断与跨进程恢复。
3. 验证记忆生成、下一任务召回、真实向量检索、Learning 草稿审核和发布。
4. 完成相关共享业务、CLI、Desktop 与打包回归，更新使用文档并保存验收记录。

**完成标志：** 现有平台独立运行闭环通过，工程测试与真实运行证据分别记录。Linux 验收继续保留在阶段 5，Issue 399 不提前视为全部完成。

## 阶段 5 Linux 支持

**已完成：** 已有 CLI 发布包、Worker 打包与审计基础；当前 npm 包仅支持 macOS/Windows，Linux CI 验证的是拒绝安装。

**主要目标：** 在无 Desktop、无图形登录和历史用户配置的 Linux 环境中，运行前四阶段的完整能力。

**实现思路：** 在已共享的业务之上补平台适配，优先支持明确的发行环境、架构与 Runtime 组合。此阶段确定可用的无桌面凭据方案，不提前绑定具体实现。

**执行计划：**

1. 明确首版支持矩阵及无桌面凭据后端，保持受控注入和 SecretStore 边界，不静默降级为明文持久化。
2. 适配原生依赖、权限与路径、Harness 发现、环境传递和包内 Worker。
3. 使用实际发布包增加 Linux 正向安装与运行 CI，保留 macOS/Windows 回归。
4. 在干净 Linux 环境重复部署、真实任务、Memory/Learning 和恢复验收，补充支持矩阵与部署文档。

**完成标志：** 实际 CLI 包在声明的 Linux 组合中通过完整闭环；平台声明、CI 和可复现文档一致，随后核对 Issue 399 全部验收项。

## 各阶段共同约束

- Desktop 与 CLI 使用同一共享业务；每次下沉同步改接，避免长期保留两套实现。Core、Interpreter、Memory 和 Built-in Agents 保持原有领域所有权。
- 保持资源身份、显式副本导入、确定性绑定和已有 Session 的持久 Runtime 身份；不按名称猜测或静默替换环境。
- 持久协议语义改变时，同步交付版本、相邻迁移、历史 fixture 和恢复测试；保留 Curator 历史工具契约的恢复能力。
- Memory 默认关闭并要求显式启用，Learning 不绕过人工批准；凭据不进入 Bundle、普通配置或日志。
- 每阶段验证相关业务和生产接线；“命令存在”“已入队”或 mock 成功不能代替真实任务、记忆生成和正式发布结果。

## 后续推进方式

每次选择一个阶段推进，先核对最新代码与 Issue 更新，只实施剩余部分。完成后在下表记录 PR、验证证据和剩余缺口，再进入下一阶段；具体文件、命令和测试拆分在该阶段实施时确定。

| 阶段                          | 本计划剩余工作状态           | 实施与验证记录                                                                              |
| ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| 1 共享部署与环境服务          | 共享业务完成，验收边界见记录 | [ADR 075：共享部署与环境服务](../adr/075-shared-deployment-and-environments.md)，见本节记录 |
| 2 CLI 独立部署入口            | 待推进                       | —                                                                                           |
| 3 Memory 与 Learning 独立运行 | 待推进                       | —                                                                                           |
| 4 现有平台闭环验收            | 待推进                       | —                                                                                           |
| 5 Linux 支持                  | 延后，最后推进               | —                                                                                           |
