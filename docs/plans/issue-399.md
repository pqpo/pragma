# Issue 399 共享运行配置收尾计划

阶段一已完成；本次只剩一个收尾阶段，做三件事：补齐 CLI 配置接线、验证与 Desktop 的运行一致性、补对应测试与文档。CLI 已经能够提交和执行 Mission、查询结果，这些能力直接复用。

核对基线：2026-10-19 的最新 `origin/main`，`5b3891e7`（[PR 408](https://github.com/pqpo/pragma/pull/408) 已合并）。实施时重新拉取最新远程 main 并创建独立 worktree。

需求依据：[Issue 399](https://github.com/pqpo/pragma/issues/399) 及维护者确认的[范围调整评论](https://github.com/pqpo/pragma/issues/399#issuecomment-6269368075)。本计划替代原阶段 2—5 的后续排期；原始独立部署、Linux 和 Memory Headless 目标暂缓，不标记为完成。

## 已完成及其价值

- Mission application、编译、执行、owner、恢复与查询已由 Desktop / CLI 共享；CLI 已有机器输出、分页、有限等待和外部 Agent 调用基础。
- 阶段一将 Project、Capability、ContextStore、Plugin 写入，Bundle 安装/导出/恢复/绑定修复，以及模型连接和 Runtime Environment 服务收敛到 Local Host，Desktop 已改接。详见 [ADR 075](../adr/075-shared-deployment-and-environments.md)。
- 这些共享服务保留，供 Desktop、CLI 及未来 Web 服务端复用。未来 Web 仍需接口、页面、权限和 Host 生命周期；本次不建设这些入口。

## 唯一剩余阶段 CLI 运行配置接线与验收

**主要目标：** 在当前支持的平台、同一操作系统用户及同一 Pragma home 下，Desktop 完成模型、Runtime、凭据配置与 Bundle 导入，关闭 Desktop 后，CLI 能使用预期配置执行已有资源并获取最终结果。

**实现思路：** 复用已有 Mission 命令及阶段一共享服务，重点补 CLI production composition。当前 Desktop 使用持久化 Runtime Environment 和模型连接 Store 装配 Runtime；CLI 仍直接创建固定的一组 Runtime，例如 PI 未注入 Desktop 使用的模型连接 Store。核对最新代码，只补两端配置解析与装配的实际差异。

**执行计划：**

1. **补配置接线。** CLI 接入已有共享环境服务，正确读取保存的 Runtime Environment、模型连接、SecretRef 与凭据。共享解析和校验放在 Local Host，具体 Runtime 工厂留在应用入口；沿用现有 SecretStore 和 Harness 原生认证，保持已有 Environment revision、Session Runtime 身份及权限边界。
2. **验证运行一致性。** Desktop 配置并导入资源后关闭 Desktop，用实际构建的 CLI 验证预期 Runtime、模型、连接和认证，完成任务并查询最终结果。已有提交、查询、必要交互与恢复入口仅做相关回归，有缺口才修；缺失配置或凭据须准确诊断，不静默改用默认模型。
3. **补测试与文档。** 补共享配置解析、CLI 生产入口/Worker 和必要 Desktop 接线回归，按本次改动合并重复测试，保留持久化与恢复覆盖。更新 CLI 使用、Agent 指南和本计划的实施记录，区分工程测试与真实 Runtime/模型验收。

**完成标志：** 至少记录一条 Desktop 关闭后、实际 CLI 使用预期配置完成真实任务的证据；相关测试和构建通过，无 TTY、机器输出及 owner 语义无回退，凭据不进入日志。无法执行的真实环境或平台验证如实记录，不以 mock 或入队回执替代。`--detach` 继续只表示持久入队，不承诺进程退出后持续执行。

## 暂缓范围与现有行为

- 暂缓空 home 的 CLI 完整配置与独立部署、Bundle 管理/修复命令、可移植绑定配置、Linux、SecretStore 文件模式/helper、Web/云端沙箱及常驻后台进程。
- 暂缓 Memory、Embedding、Learning Headless。现有 Memory 保留：策略允许时 CLI 仍保存 Evidence、提交持久提炼任务并召回已有记忆；提炼、索引维护与 Learning 继续由同一 home 下的 Desktop 承载。证据或任务入队不等于生成记忆，Knowledge/Skill 发布仍需人工批准。
- 不新增 Mission 内核或完整 CLI 管理面，不做全仓测试搬迁、Bundle service 大规模重构及无关 Provider 管理扩展。Plugin 依赖 Bundle 继续遵循现有拒绝策略。

收尾完成后按范围调整后的交付核对 Issue，不宣称原始 Linux 独立部署或 Memory Headless 验收通过。

## 推进状态

| 阶段                                       | 状态                   | 记录                                                                                                           |
| ------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| 阶段一：共享部署与环境服务                 | 已合并，验收边界见下文 | [PR 408](https://github.com/pqpo/pragma/pull/408)、[ADR 075](../adr/075-shared-deployment-and-environments.md) |
| 最后收尾：配置接线、一致性验证、测试与文档 | 本轮范围已完成         | 见下方收尾实施记录                                                                                             |
| 原独立部署、Memory Headless、Linux 阶段    | 暂缓                   | 不计入本轮交付                                                                                                 |

## 阶段一实施与验证记录

以下保留已合并阶段的历史实施和验证证据，不作为新增工作清单。

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

**阶段一验收边界：** 本阶段未提供 CLI 新部署入口、Memory Headless 或 Linux 适配；按当前范围，这些能力暂缓。真实模型/Harness 执行、系统钥匙串、交互式 Desktop 全流程和 macOS/Windows 发布包验收当时尚未执行；收尾只验证本次配置接线涉及的链路，不将历史缺项标为通过。CI 性能目标同样尚未验收；本次已记录本地超出目标的计时，未将其标作通过。

**PR #408 评论复核与修复（2026-10-19）：** 完整读取普通评论、审核正文及行内评论，确认三个 P1 均成立，已修复并独立验证。原提交 `0e6acee8` 的 GitHub CI 质量、业务与 CLI 包验证已通过；以下为修复后的本机证据。

- Desktop 将没有 transaction 的历史 installing/failed 记录也识别为中断安装，直接进入恢复结果页并调用共享 recheck。共享入口阻止新 UUID 绕过未完成历史记录；缺少可恢复 journal 时保留记录，明确报告安全清理或备份恢复路径。
- 失败安装结果页增加确认后的安全清理入口，成功后重新 inspection 并生成新 requestId；清理受阻时保留原记录、展示原因及人工处理提示。共享安装冲突使用明确错误类型，Desktop IPC 保留稳定冲突码。
- 清理前检查同 Project 中其他 Installation 的 resourceRefs；keep_local 复用根或依赖时拒绝删除创建者，保留共用资源及消费者的 readiness。
- 新增真实 v8 installing/failed owner fixture、历史恢复/损坏 journal/持久冲突的生产 IPC 回归，以及真实 Chromium 对话框测试入口 `pnpm --filter @pragma/desktop test:bundle-recovery-ui`。

验证：根目录 `pnpm lint`、`pnpm typecheck`、`pnpm build` 各 19/19 任务通过；编译后共享部署及边界 76/76、Core 历史迁移 8/8、CLI adapter 165/165、Desktop 相关 14 个文件 236/236，共 485 项通过且无跳过。Chromium 另有 3 组交互场景通过，覆盖无 transaction 的两类历史状态、确认/取消、拒绝清理时展示服务端原因、重新 inspection 和新 UUID。浏览器交互使用受控 Bridge，生产 IPC 测试另行验证真实 Project/ContextStore/归档和历史迁移边界，两者不冒充真实 Runtime 验收。已检查简中 1440×900/100%、英文 1080×700/125%、繁中 1080×700/150% 的正常与焦点态截图；Tab 验证真实焦点移动，隐藏 macOS 窗口的焦点态截图使用 DevTools 强制 focus-visible。临时截图保留在仓库外，未提交。

非阻断建议已核对：当前模型编辑已有 provider revision CAS，实际消费者影响预览及 expectedImpact 接线留待后续；Bundle application service 内部按规划/事务/恢复/绑定修复拆分属于后续维护，不在本次缺陷修复中扩大重构。上述记录仅代表阶段一的交付状态；当前后续范围以本文收尾阶段及 Issue 最新范围调整评论为准。

## 收尾实施记录（2026-10-19）

基于重新 fetch 的 `origin/main` `eb458180`，独立 worktree `pragma-issue-399-final`、分支
`codex/issue-399-final` 实施。本轮未创建 PR，未修改持久协议版本。

- Desktop / CLI 共用 `createLocalHostRuntimeConfiguration`，读取相同 Environment Store、模型连接和
  SecretRef。CLI 的具体工厂使用保存的 Runtime identity、环境变量策略、模型目录缓存和统一 Token
  counter，PI 注入共享 provider registry；既有 Environment revision / fingerprint 按精确绑定恢复。
- 旧 CLI 静态绑定保留 resolve-only 精确读取：只在 Environment binding 不可用且旧静态 descriptor /
  模型目录 fingerprint 完全匹配时恢复；新建 Session 始终使用共享 Environment。真实历史 resolver
  fixture 验证 `codex` / `codex-local` 身份不被改写，当前配置错误与未来 revision 不走旧读取路径。
- Mission 执行资源按持久权限模式取得 Runtime resolver，权限变化不改变 Runtime identity。缺失连接、
  锁定钥匙串、迁移要求及 Runtime / 模型不可用保留机器错误和诊断，不改用其他模型。
- 修复生产任务中发现的新建 Mission 接线：无事件的新分配任务可使用已解析的精确项目 Revision；后续
  执行使用同一 Revision。旧 reservation、历史 Mission 和已有 Session 的证明 / pin 规则保持严格。
- 编译错误映射新增模型连接错误与 Runtime 诊断。错误类使用独立叶子模块，源码子进程不再因连接 Store
  与 Host barrel 的循环初始化而退出；真实 SIGKILL 恢复回归重新验证。
- 保留既有 Memory Evidence 采集、持久入队与已有记忆召回。未增加 CLI 配置管理、Bundle 命令、Linux、
  Memory Headless、凭据后端、Web 或 daemon。

### 真实 Runtime 验收

macOS Intel、Node 23.11.0、Electron 43.7.6；同一操作系统用户，隔离 home
`/tmp/pragma399-acceptance/home`。真实 Electron Host 使用 Desktop 生产 application container 与真实
IPC 导入 `real-task.pragma`，Installation `54c977ba-416e-4bd0-9fd7-2aff2fe9f83a` 为 `ready`，
Project `studio@1`，Expert `expert:0000000000000400`。这条链路使用自动化隐藏窗口，未冒充人工 UI 操作。

Electron PID 28215 已退出后，用实际构建的 npm CLI（`0.1.0-next.23`）执行：

```bash
PRAGMA_HOME=/tmp/pragma399-acceptance/home node apps/cli/dist/pragma.js \
  expert run expert:0000000000000400 --project studio --revision 1 \
  --workspace /tmp/pragma-399-real-workspace \
  --prompt 'Compute 137 times 29. Return the product and one sentence of explanation. Do not call tools or modify files. End with PRAGMA399-REAL-20261019.' \
  --interactive never --json

PRAGMA_HOME=/tmp/pragma399-acceptance/home node apps/cli/dist/pragma.js \
  mission get 63af2b67-de59-47f7-8900-accf2d853377 --view result --json
```

- Runtime `codex`、provider `openai`、模型 `gpt-5.6-sol`、Harness 原生认证；不是受控模型服务。
- Mission `63af2b67-de59-47f7-8900-accf2d853377`，Execution
  `e84567aa-3bc3-4383-9fac-6137f1b24320`；run 与独立结果查询均为 `succeeded`，返回 `3973` 和
  `PRAGMA399-REAL-20261019`，实际报告 15956 tokens。
- 持久 Session 根 Context 保存 `codex@1`，fingerprint
  `30e4a83b0810584ab267572e34d2766ff06db4f6624711dd8c3fb3e8a9e56955`，模型仍为
  `openai/gpt-5.6-sol`，未替换身份。原生 Codex rollout 的 `turn_context` 同时确认
  `model=gpt-5.6-sol`、`approval_policy=on-request`、`sandbox_policy.type=workspace-write`。
- 另以固定构建产物副本和 `--wait-timeout 120` 验证真实 owner Worker：Mission
  `f668b354-6f1d-489e-9614-7d03bc282a36`、Execution
  `74e0ab79-35c1-4362-8c92-636d629ce1f1` 返回 `PRAGMA399-WORKER-OK` / `succeeded`。
  该固定副本 `cli.js` SHA-256 为 `a4f87b57b37fc704189509d28d6c0fed5bf95eaf6a345ae91ff0abbf024fd0bb`。

**收尾提交 `8e775bef` 构建产物的追加验收：** `cli-closeout-artifact/cli.js` SHA-256
`cf2aea73df12c145a843116fc021bd892a76b6cbc61a0af10113d1aa6384eafe`，与该次构建的
`apps/cli/dist/cli.js` 一致。

- 不传 `--project` / `--revision`，使用 `--wait-timeout 120 --interactive never --json`，Mission
  `c8a95cfc-024e-4967-8a30-c8b8cf4f25df`、Execution `687db454-5f71-43ca-9dfd-59bfdf522bbe`
  返回 `3973` / `PRAGMA399-CLOSEOUT-OK`；独立 `mission get --view result` 查询同样成功。
- 继续早先的 `63af2b67-de59-47f7-8900-accf2d853377`，返回 `PRAGMA399-CONTINUED-OK`；根 Context
  `5bd0312b-aed7-4e52-b077-76b49ba9ac59`、Environment binding 与模型选择不变，Native 记录为
  `thread_resume` / `restored: true`。
- 用修改前的真实 CLI 产物（静态 Runtime composition，SHA-256
  `472b7f44677768cd1ec0cdd32b278df1e461cc3726a610cb43fa21c5813a54f9`）创建 Mission
  `f960f853-b47c-4b97-b09e-ade392c1fedd`，成功返回 `PRAGMA399-LEGACY-CREATED`。再由最终 CLI
  `mission send --wait` 继续，Execution `e92267b4-4dc5-4031-9b0e-fd2807e66dd8` 返回
  `PRAGMA399-LEGACY-RESTORED`，独立结果查询成功。根 Context
  `77b87d29-d7be-48a2-b590-9acf3ed0a5c3` 的原静态 fingerprint
  `fc5a9a7360fa40064b7db50bb33999ab44d7af37703bbbe515c0e60444f6bac6`、`codex` binding 和
  `openai/gpt-5.6-sol` 不变；Native adapter 仍为 `codex-local`，原 systemSessionId
  `dbcfbae3-b7a1-47f7-bead-8fcdc863a3be` 得到恢复，没有热迁移或重建身份。

原始验收记录、CLI 输出和临时 home 位于仓库外 `/tmp/pragma399-acceptance/`，不提交凭据或生成文件。
首次并行构建期间的产物读取失败不计为通过；后续使用固定副本完成 Worker 验收。

### 工程验证与限制

工程测试和真实 Runtime 验收分开记录。本轮最终结果：

| 验证                                                | 结果                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`、`pnpm typecheck`、`pnpm build`         | 最后一轮各 19/19 任务通过，包含静态旧绑定读取；main 无外部 workspace import、preload 自包含、随包 CLI 与 storage Worker 验证通过      |
| `pnpm test:local-host-kernel`                       | Core 文件锁 22/22；Host 111 个文件、1095 通过、1 项条件跳过，Host 阶段 709.48 秒                                                      |
| `pnpm --filter @pqpo/pragma test:adapters:prepared` | 最后一轮 22 个文件、167/167 通过，包含历史静态绑定、未来 revision / fingerprint 拒绝和当前模型错误不走旧读取路径                      |
| CLI 生产配置 / owner Worker / 原生 SecretStore      | 最后单独补跑 1/1 通过；真实临时持久存储、原生钥匙串、受控 HTTP 服务，覆盖成功、独立结果查询、删除 SecretRef、删除连接及凭据不进入输出 |
| Desktop 接线                                        | Runtime Environment service/store 与模型 IPC 26/26，进程环境 / login shell 9/9，通过                                                  |
| 新建 / 恢复相关补跑                                 | run / core-run / Node composition / shared configuration 33/33；真实 SIGKILL 安装恢复 2/2；执行内核 25/25                             |
| `pnpm test:core`                                    | 4/4 任务通过，27.20 秒                                                                                                                |

旧静态绑定的 resolve-only 读取另行通过 CLI 全量 adapter、生产入口 / Worker、历史 writer fixture
与真实旧版 Session 恢复验收；未改变 Mission 持久化、队列或恢复内核。早期构建与
产物测试并行造成的临时失败不计入上述通过结果；后续固定构建产物后完成验收。新增错误映射导致的
源码循环初始化也已修复，并通过真实 SIGKILL 子进程恢复回归。

全量共享门禁仍超过历史八分钟性能目标，本轮没有扩展为性能优化或 CI 冷 / 暖缓存验收。原生钥匙串
独立平台专项仍按既有门禁规则排除；本轮新增生产 CLI 用例实际使用了 macOS 原生钥匙串测试凭据。

受控 HTTP 模型服务 + 实际 CLI/owner Worker 验证 PI 使用保存的自定义 Environment、精确模型、原生
SecretStore 凭据和独立 Mission 查询；验证认证 canary 不进入 stdout/stderr，删除连接后不再发送请求，
准确返回依赖 / Runtime 诊断。这是工程集成测试，不是实际 PI 模型验收。

当前 Node CLI 的内置 Pragma 仍缺少管理资源端口，会报告依赖不可用；本轮真实任务使用 Desktop
导入的 Expert，没有扩展这些管理端口。

真实 PI / 模型连接验收未完成：本机历史模型连接存在待恢复的 Electron credential migration，历史
safeStorage 读取未能在无人值守下完成；没有绕过钥匙串、复制明文凭据或更换后端。Windows、Apple Silicon、
真实 Team/Flow、人工 Desktop UI、独立安装 tarball 及所有 Harness 组合未在本轮真实环境验收。
Linux 与 Memory Headless 仍为暂缓项，不能将此轮结果用于声称原始 Linux 独立部署目标完成。

### 收尾提交的追加 CR 与修复（2026-10-19）

人工逐项审查 `8e775bef` 的配置、Mission 提交、编译错误、Desktop 接线及历史 Session 恢复改动，
确认并修复两项问题：

- P2：旧 CLI Session 的恢复 resolver 固定采用 `request-approval`，且永久缓存初次读取的环境变量
  策略。现在按 Mission 权限模式分别缓存，并在策略版本改变后重建 adapter；恢复继续校验真实历史
  descriptor / catalog fingerprint，不改写 Runtime binding。回归覆盖 `full-access`、恢复默认权限、
  显式允许变量与后续 blocklist 收紧。
- P2：新 Runtime 的缓存键与 adapter 构造分别读取策略，跨进程更新可能使 adapter 缓存到错误策略
  版本下。现在通过 factory `prepare` 捕获同一策略快照，缓存键和构造闭包共同使用它。回归模拟
  连续读取间策略变化，验证首次过滤、下次允许及相同版本缓存复用。

新增回归在原提交上复现为 2 项失败，在修复后为 3/3 通过。未发现其他已确认而未修复的问题；
本次 CR 不改变上文的真实平台、模型和安装验收限制。

修复后重新运行全仓 `pnpm lint`、`pnpm typecheck`、`pnpm build`，均为 19/19 任务通过；
CLI 全量 adapter 为 22 文件、168/168 通过；生产 CLI / owner Worker / 原生 SecretStore 配置
集成为 1/1 通过。此次只改 CLI composition，未改共享 Mission 内核；上文完整内核门禁未重复运行。

CR 后固定 CLI 产物 `cli-cr-artifact/cli.js` SHA-256 为
`d8b93aa2db1e89e56e54786f1bbe9866e4e61192512dce1e6c416f4e75778de3`。
用它继续同一旧 Mission `f960f853-b47c-4b97-b09e-ade392c1fedd`，Execution
`6efba6c9-71c3-4e72-8bb3-d0e9fc76aa7f` 成功返回 `PRAGMA399-CR-RESTORED-OK`，独立
`mission get --view result` 同样成功。持久 Session、根 Context、原静态 fingerprint 及
`openai/gpt-5.6-sol` 均与上文旧版恢复验收一致。记录为仓库外 `cli-cr-legacy.json` 与
`cli-cr-legacy-result.json`。固定副本首次未链接原生依赖目录的启动失败未计入通过结果；
补齐与此前验收一致的 `node_modules` 链接后完成以上验收，未改变源码或凭据。
