# Issue #368 第三阶段实施与三阶段验收汇总

日期：2026-10-09。基线：远程 main `ecd5989c1b5328811283e15f80295a8ab867aeff`（PR #374）。
准备阶段执行 `git fetch origin main`，从 `origin/main` 创建 managed worktree
`issue-368-phase-three/expert-mesh` 与分支 `codex/issue-368-phase-three`；原 checkout 未修改。
Node 23.11.0、pnpm 10.12.1，`pnpm install --frozen-lockfile` 完成。

**实现状态：第三阶段 15 条命令、三个 Skill 及默认目录切换已实现。默认 management 选择
15 → 0，managed tools 17 → 2，Pi 默认口径 28 → 13。Issue #368 仍有 Runtime、平台、
真实人工交互与性能门禁，不能按工具数量结项。**

## 统一命令与复用边界

用户在实施期间明确选择全部管理命令放入 `pragma manage`。前两阶段 DSL、Flow、Evaluation
也更新为此入口；其 Skill、references、帮助、子进程测试和 Runtime probe 同步更新。
原用户 `pragma mission …`、executor run 等入口保留，不根据 Execution 环境抢占同名命令。
管理命令使用同一 parser 和输入/结果协议；用户明确将独立管理 Host composition 延后。
本阶段缺少 Execution endpoint 时仍拒绝，不能退回广泛用户权限。Desktop 自带 client 与
公共 CLI 共用代码；内部 command wire 的 operation 名和 v1 协议不变。

| 分组       | 当前命令                                           |                   新迁移工具 |
| ---------- | -------------------------------------------------- | ---------------------------: |
| Mission    | `pragma manage mission list                        |                          get | create | send           | interrupt`、`work list | get` | 7   |
| Host 发现  | `pragma manage workspace list`、`home-project list | get`、`knowledge-store list` | 4      |
| Automation | `pragma manage automation list                     |                         save | delete | reset-session` | 4                      |

加上前两阶段及四个恢复命令，当前静态 command 共 46 项。CLI 支持两层和三层 operation
路径，使用 `--input FILE|-`、按命令 help、结构化结果、稳定错误码与原退出码。
业务输入由原 handler/Schema 校验，可信 operation identity 不在模型输入中。

Mission 查询、work 投影、创建/发送/中断适配与 Automation 管理端口移入 Local Host，
删除原 Desktop adapter 文件；Node workspace 校验也共享。Desktop 保留具体资源、
executor/知识就绪校验、Project 与 scheduler 接线。CLI 不复制业务实现。
Mission 使用同一 application factory、command consumer 与 owner；没有新增 daemon、
owner 或执行服务替换。创建保留准确 executor ref、绝对 workspace、知识绑定及 required 审批。

默认 Pragma 保留 management binding 并使用 `tools: []`；Interpreter 原有 contribution hooks
仍能装配通道。生产 Host 编译回归验证两个 Revision 调用、六个 Skill、真实 Session 中
command endpoint 和成功 origin，以及关闭后的撤销。普通 Expert 不因 Skill 获得 grants，
allow/deny、当前 submission 审批、hooks、approved-input 与 receipt 沿用前两阶段。
原 handler/Capability 定义、显式 binding、Revision Agent 的工具及历史配置语义保留。

## 持久化与 Skill

- Mission 从可信 operation identity 派生稳定 ID；创建后 operation result 未落盘时查回原 Mission。
  真实 CLI 回归移除该 result 并将外层 receipt 置为 pending，重放仍只有一个 Mission。
- 中断新增独立 `pragma.mission-command-interrupt/v1` journal，冻结原 Execution target；恢复不
  中断后来启动的 Execution。既有 Mission/operation 文件未改变。
- Automation 使用 Local Host 的 `pragma.management-mutation/v1` journal，持有 operation 和
  target 锁，冻结 binding/generation、publication identity 及清理进度。Project 已发布时先查询
  原 publication，再补 binding；reset 的 binding 已写入时复用原 generation。
- 故障回归发现初版会在 publication 成功后重放出第二个 revision；已修复。最终回归覆盖
  publication 后故障、binding 后故障、pending 重放、payload 冲突、未来 journal 拒绝，以及
  历史 Mission 在 reset/delete 后仍可读取。未修改已有 Project、binding、receipt、DSL 或
  compiler Schema；两个 journal 是首次引入的独立 family，没有使用迁移豁免。

新增三个 canonical Skill ref 在静态声明处由权威 Schema 校验，进入 Bundle、生成文件、
fingerprint 与 Runtime 物化。工作台使用相同 registry。Host store 回归对全部六个 Skill
验证正文、文件投影及拒绝修改，不生成用户可编辑副本。三个新 Skill 的 skill-creator
validator 通过。Automation reference 从 `author-pragma-dsl` 移至独立 Skill；DSL 保留短交接。

最终对应关系：Flow → author-pragma-flow；DSL → author-pragma-dsl；Evaluation →
author-pragma-evaluation；Mission → manage-pragma-missions；Host 发现 →
discover-pragma-resources；Automation → manage-pragma-automations。默认只注入精简索引。

## 真实 Runtime 与三阶段成本

[Runtime 证据 JSON](management-tools-cli-skills-phase-three-runtime-evidence.json)保存 reported Usage、
原生调用、审批、实际 Project 结果和 Host command receipts；不保存 endpoint/凭据或模型自由输出。
前两阶段证据不改写。当前 Runtime probes 的入口与 assertions 继续保存在原验证脚本中。

| Runtime             | 本轮实际结果                                                                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex 0.159.0       | 最终两个 managed tools 下发现资源、创建带知识 Mission、work 查询、后续消息和中断；Automation 保存/修改/禁用/reset/delete；独立补充 mission.list receipt。Flow、DSL、Evaluation 经新命名空间重新完成真实流程，分别发布 revision 2/2/3，含原有失败修复、冲突或拒绝流程 |
| Claude Code 2.1.195 | 原生 shell 通过最终私有通道获得成功 resource-list receipt；不等同于完整三阶段任务                                                                                                                                                                                    |
| OpenCode            | 首轮 `opencode --version` 超时；后续真实 smoke 成功，保留失败记录                                                                                                                                                                                                    |
| Antigravity         | host-keyring 原生命令成功 receipt；关闭仍出现 SIGTERM 超时后的 Runtime 强制终止诊断                                                                                                                                                                                  |
| Qoder CLI           | 额度耗尽，没有成功 receipt，未购买额度或改订阅                                                                                                                                                                                                                       |
| Pi                  | 本轮 setup 45 秒无成功证据，终止本轮进程组；没有供应商请求/Usage 证据。前两阶段已确认的 Keychain 门禁仍未解除，不把此次超时重新当作栈诊断                                                                                                                            |

以下静态数据均为 Core RuntimeTokenCounter/o200k_base、格式化 JSON 的逐工具参考计数，
不是实际请求节省。第三阶段详细数据见[静态估算 JSON](management-tools-cli-skills-phase-three-token-estimate.json)。

| 阶段 | 移除默认工具 | Pi 数量 | 参考定义 tokens | Skill 数 |
| ---- | -----------: | ------- | --------------: | -------: |
| 一   |            6 | 55 → 49 |          13,065 |        2 |
| 二   |           21 | 49 → 28 |           7,083 |        3 |
| 三   |           15 | 28 → 13 |           3,972 |        6 |
| 累计 |           42 | 55 → 13 |          24,120 |        6 |

Native reported input 统一取 input + cacheRead；表中 before/after 均为 CLI 工作流中保留/隐藏
该阶段工具，不是旧 native managed-tool 工作流对比。缓存、模型行动与并行验证负载未控制，
不能跨阶段直接比较绝对输入或合并为收益百分比。

| 阶段/场景                     | before 输入 | after 输入 | 原生调用 before → after | 耗时 before → after |
| ----------------------------- | ----------: | ---------: | ----------------------- | ------------------- |
| 一：聊天                      |      17,939 |     17,937 | 0 → 0                   | 见阶段一原证据      |
| 一：Flow                      |     110,348 |    117,731 | 37 → 41                 | 197.099 → 213.990 s |
| 二：聊天                      |      15,529 |     15,533 | 0 → 0                   | 16.463 → 10.498 s   |
| 二：Expert/Team               |     110,962 |    115,162 | 34 → 38                 | 144.021 → 152.380 s |
| 二：Flow                      |     120,018 |    129,300 | 41 → 41                 | 233.881 → 253.558 s |
| 二：Evaluation                |     111,844 |     92,454 | 40 → 43                 | 212.623 → 191.470 s |
| 三：聊天                      |      15,658 |     15,668 | 0 → 0                   | 12.565 → 14.666 s   |
| 三：Mission/Automation 父任务 |      70,187 |     72,213 | 31 → 46                 | 207.227 → 235.419 s |

第三阶段两轮分别为 17/2 managed tools、相同六个 Skill 索引。首轮探索性 before 错误恢复了
六个 Flow 工具（23），已排除，不覆盖为合格成本样本。before/after 的模型行动和缓存不同；
本轮切换期间默认指令也更新，因此这只是探索性输入对照。

Mission 与 Automation 分两段执行；父任务 Usage 不包含其创建 Mission 的子 Runtime 用量，
不是完整父子任务成本。专业任务的 provider 首次请求、Skill/help 独立计费输入及重复样本
仍缺失。无工具聊天的一条 reported observation 保留未缓存/缓存拆分，不能推断专业场景的
首次 provider 请求。receipt 结果字节为 16,533 → 16,905，只计独立 receipt，排除重试交付、
help/Skill 和 shell 包装。没有普通聊天下降证据，第三阶段父任务代价上升，未接受性能 cutover。

## 工程与发行检查

- 默认 Built-in DSL/MCP catalog 与原 Host handler：35 项通过；被迁移工具没有另一默认名称注入。
- CLI adapter：7 项通过；mutation journal 专项：1 项通过。
- 四文件 command/Mission creator/Automation/resource adapter：39 项通过。
- 六个 Skill 的 Capability store/catalog：40 项通过；生产空白名单 hooks 专项通过。
- 初轮 Node 测试并行下载 Electron 发生安装竞争；安装完成后顺序重跑，失败不作为业务通过。
- 完整 `pnpm check` 已通过；新增 operation 锁后的 mutation 专项继续通过。
- Desktop adapter 全套：111 passed、2 skipped、3 个五秒超时；原超时和断言不变，两相关文件
  单独复跑 8 passed、2 skipped。这不是一次完整 Desktop gate 成功。
- 最终 command/Project adapter 首轮 55 passed、1 个目录数量断言失败；新增三项 Skill 后同步
  为静态 registry 数量，定向复跑通过。最终组合回归及发行结果在下方补记。

## 遗留门禁与结论

1. Pi 完整真实任务及 provider 输入对照；Qoder 可用额度下的专业任务；各其他 Runtime 的
   smoke 不替代完整 authoring/Mission/Automation 验收。
2. 真实模型的非自动批准 Human checkpoint、取消、历史接管及崩溃恢复；故障注入和已有
   warm Session 回归不替代真实人工流程。
3. Windows launcher/实际发行与历史定制配置/whitelist 的完整验收，继续保留前两阶段缺口。
4. 同模型、规则、权限、可比较缓存条件下的重复成本样本，以及首次 provider 请求、父子
   总成本和 Skill/help 归因；目前不能宣称启动或整体任务成本下降。
5. 新命名空间已交付，公共 CLI 的独立管理 backend 按用户要求延后；外部 Codex 仅加载 Skill
   尚不能在没有 Execution endpoint 时获得这些管理能力。

本轮不关闭 Issue、不发布发行包或修改用户 PATH。工程迁移与默认目录切换完成，不等于
三阶段所有产品门禁完成。最终构建、发行和组合检查结果必须以以下补记为准。

## 最终补记

- 最终 command/Project adapter 两文件 **56 项通过**；最终 Built-in DSL/原 handler 三文件
  **49 项通过**，包含六组迁移工具的显式 binding 编译回归。
- `pnpm test:revision` 通过；Revision 原独立业务及目标调用回归保留。
- 完整共享 Host gate：**926 passed、1 skipped、2 failed**。changed-authority successor
  超时及 cold Flow send 未及时 settle，使完整 CLI test 没有进入 adapter 阶段。
  原超时下定向复跑：两项 successor 通过，cold Flow 仍失败。随后在未修改的 main
  `ecd5989c` 上用同一 cold Flow 测试复现相同 COMMAND_RESULT_TIMEOUT；此门禁继续保留，
  未改内核、超时或断言，也不把 baseline 复现当作门禁通过。
- 独立完整 CLI adapter：**16 文件、121 项通过**。这个组合不是一次完整 CLI gate 成功。
- 根 `pnpm build` **19 task 通过（16 cached）**；最终 Desktop styles/main/preload/storage-worker
  四项检查通过。main 无外部 workspace import，preload 自包含并注入 pragmaDesktop。
- 使用最终生产构建和隔离 Home 启动真实 Electron：六个 Skill 的正文与全部文件经实际
  preload/main IPC 可读；逐一删除与提交修订均返回 read-only。三个新详情页视觉检查正常，
  无编辑/删除/修订按钮。截图与临时 Home 留在仓库外。
- 默认 `electron-builder --dir` 下载因本机 issuer certificate 验证失败；改为复用已安装的
  同版本 Electron 43.7.6 dist，macOS x64 未签名目录打包和 ASAR audit 成功。未禁用 TLS
  验证、未发布。packaged command client 位于 ASAR 外，真实 packaged Electron Node 执行
  `pragma manage mission work get --help` 返回 0，含原权威输入 Schema。
- 公共 CLI pack 与 audit 已通过。canonical artifact smoke 与最终检查结果继续在后面补记；
  不将初次缺少 smoke 参数的 usage error 记为成功运行。

最终源码提交：`0e56ab7b4333458c76e99a5ca7126a74cb280ff5`。最终再次完整
`pnpm check` 通过（19 package lint/typecheck、11 task test:core）；格式与 diff whitespace
检查通过。此前独立的共享 Host/CLI 和 Desktop 全套失败继续保留，没有被 check 覆盖。

公共 CLI 在该提交上重新顺序 pack/audit、生成 canonical artifact/SBOM/license/checksum。
6,377,399 字节 tarball SHA-256 为
`9e50acfe016385b5d3b76add40270943f32e205f483b220c48eb14664a45af5a`。
正向安装 smoke 已实际执行，但隔离 npm install 在下载 `@napi-rs/keyring` 时返回
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`；系统 CA 选项重试仍失败，未关闭 TLS 校验或改变
用户 npm 配置。此门禁标记受阻，不能把 pack/audit 当作安装验证通过。Windows、签名/
公证/安装器与 Node 20/Linux 负向发行矩阵本轮未验证。

真实 Electron 的隔离窗口已关闭；未停止用户原有应用。原 main 工作区保持干净。
新默认工具目录使用新建会话验证，历史 Session 的编译快照和数据没有被批量改写。

## 后续合并 Skill（2026-10-09）

本报告的三阶段成本、Runtime 与 UI 数据对应当时六个 Skill。用户随后要求统一为
`manage-pragma`，现已将六组详细工作流移到一个 Skill 的 references；当前默认与工作台
索引为 1 个 Skill，46 条 CLI 命令和 Pi 默认 13 个工具不变。历史证据文件未改写。
合并的验证与兼容身份处理见[后续记录](management-tools-cli-skills-unified-skill-implementation.md)。

## Code Review 后续修复（2026-10-09）

对截至 `f70b816b` 的第三阶段与 Skill 合并实现进行 CR，复现并修复两项问题：
Automation 清理后的恢复重放误删新 generation 队列，以及命令端口包装丢失原型方法。
修复使用既有 Automation aggregate lock、generation 和存储事务，命令继续调用原端口；
未增加 owner/consumer、兼容分支或持久化 Schema。具体复现、修复与复核见
[第三阶段 CR 报告](management-tools-cli-skills-phase-three-code-review.md)。原 Runtime/发行
验收缺口继续保留。
