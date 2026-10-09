# Issue #368 第二阶段实施与验收记录

日期：2026-10-09。基线：远程 main `a69bd99d0591aef773cd126332ae3eecaa37e41a`。
准备阶段执行 `git fetch origin main`，通过 Codex managed worktree 从 `origin/main` 创建
`issue-368-phase-two/expert-mesh`，分支 `codex/issue-368-phase-two`；原 checkout 未修改。

**状态：DSL/Evaluation CLI 与 Skill 已实现。2026-10-09 用户明确要求“移除已经迁移到cli的工具”，
据此移除第二阶段 21 个默认工具：managed tools 38 → 17，Pi 默认口径 49 → 28。
下文保留切换前 prospective probe、成本与未完成验收记录；授权切换不等于这些门禁已通过。**

## 实现与复用

- 补齐 `dsl draft start|list|inspect|review|prepare|restart|discard`、`dsl changes prepare`，
  复用第一阶段 resources/options/ids/change read/commit。新增
  `evaluation draft create|get|cases|update|run|prepare|discard`。所有输入继续使用原 handler、
  Schema 和 Local Host Project port；CLI 只承担路由、文件/stdin、帮助与 presenter。
- Desktop 与公共 CLI 使用第一阶段 Execution 私有 command channel、grants、allow/deny、
  当前 submission 审批、ownership 和 request receipt。未新增 daemon 或第二套事务实现。
  Evaluation `suite.passed: false` 保留原完整结果并返回 invalid/退出码 10。
- 新命令向原端口注入可信 operationId；创建/prepare/restart 在目标产生前预留 owner，
  create/start 重放复用原目标，Evaluation update 先在原锁内写独立 mutation journal 再替换草稿。
  DSL prepare 恢复 candidate 与不可变 submission 后再完成 draft 状态；restart 复用原 journal。
- 审批修改输入后重新校验真实目标；新增私有 approved-input hash 防止 pending 请求用不同的
  审批修改结果重放已产生的 candidate。相同 requestId 不同原 payload 仍由原 receipt 拒绝。
- CLI-only `dsl draft recover` 和 `evaluation draft recover` 复用 required 审批与可信 owner lookup。
  DSL 文件草稿还校验既有 Mission/workspace；不推断缺失 Context，不接管已知 foreign owner。
  恢复不发布，公共 prepared change recovery 与 commit 仍独立审批。
- DSL 文件草稿、未知字段合并、review 分页、冻结、资源身份、冲突/restart、清理和发布算法保持原位。
  泛化 prepare 继续拒绝绕过 Expert/Team 文件草稿及 Evaluation 工作流。
  Flow 先提交，Evaluation 绑定已提交 Flow，prepare 复验整套案例，只独立提交 Evaluation。

新增 operationId/commandResultsRoot 只属于可信 Host TypeScript 端口，不加入模型输入。
command enum 是兼容增加；旧请求/结果、owner、Project、draft、DSL、compiler 和已有 journal
格式未改变。`pragma.evaluation-command-mutation/v1` 与 `pragma.management-approved-input/v1`
是首次写入的独立私有 family，跟随原 Runtime owner 删除；未知版本通过权威读取边界拒绝。
没有用“实验协议”例外跳过既有迁移。

## Skill 与实际 Electron 验收

保留 `author-pragma-dsl` identity，替换 DSL 指令为 CLI 并收窄为 Expert/Team 文件草稿。
Run Dry reference 移入 `author-pragma-evaluation`；Flow 继续由 `author-pragma-flow` 承接。
Automation 的未迁移说明仍保留，不实施第三阶段。新增 Capability ref 在声明处通过权威
Schema 校验，进入 Bundle import、静态 registry、生成文件、依赖闭包及 Runtime 物化。
默认只注入三项精简索引，正文/reference 按需读取。

使用本 worktree 生产构建和隔离 PRAGMA_HOME 启动真实 Electron，未使用测试 Bridge：

- 工作室技能目录实际列出 DSL、Flow、Evaluation，均标记内置/就绪；三个正文和文件树均经
  preload/main IPC 可读，Evaluation reference 可读取。
- 实际详情页只有正文/文件/源码查看，无编辑、删除或修订按钮；视觉检查确认布局正常。
- 通过真实 IPC 尝试删除 Evaluation Skill 和提交修订，Host 均返回
  `Built-in capabilities are read-only.`。用户 Skill 行为保留在既有 store/Revision suite。

截图和隔离 Home 在仓库外，不提交。此证据补齐本轮 macOS Skill 浏览链路，不把第一阶段
Windows/发行/历史用户配置门禁整体标为完成。

## 回归与真实 Runtime 证据

新增真实 CLI 子进程覆盖关联 Expert/Team 文件草稿、无效 prepare 后修复、原子提交、拒绝零发布、
Context fencing、丢弃、稳定 requestId、Evaluation 失败修复/coverage/独立提交，以及 pending
update 和 candidate/submission 恢复。审批后的 payload 变化在 pending 重放时拒绝。
历史 DSL/Evaluation fixture 由未修改的 main writer 实际写出，来源与 SHA 记录在
`legacy-authoring-a69bd99d/provenance.json`；仅将工作区根作可移植替换，不伪造版本号。
恢复回归验证未接管拒绝、批准交接后字节保留及 foreign owner 拒绝。

[Runtime 证据 JSON](management-tools-cli-skills-phase-two-runtime-evidence.json)保存真实 reported Usage、
原生工具调用数、审批、Project revision、command receipt origin/hash 与结果大小。
模型文字成功不作为通过依据。调用入口继续复用：

```sh
pnpm exec tsx apps/desktop/scripts/verify-flow-command-runtime.ts codex dsl after
pnpm exec tsx apps/desktop/scripts/verify-flow-command-runtime.ts codex evaluation after
pnpm exec tsx apps/desktop/scripts/verify-flow-command-runtime.ts codex dsl-conflict after
pnpm exec tsx apps/desktop/scripts/verify-flow-command-runtime.ts <runtime> phase-two-smoke after
```

| Runtime     | 本轮实际结果                                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | DSL 关联资源原子创建、局部修改、prepare/commit、拒绝与丢弃实际 revision 2；Evaluation 先提交 Flow、错误 mock 修复、案例读取、coverage、草稿 revision 冲突及明确请求的两案例批次，独立提交至 revision 3；Flow 回归实际两次发布及提交拒绝 |
| Claude Code | 隐藏本阶段工具的原生 Bash 调用，成功 Host resource-list receipt                                                                                                                                                                         |
| OpenCode    | 隐藏本阶段工具的原生 bash 调用，成功 Host resource-list receipt                                                                                                                                                                         |
| Antigravity | host-keyring 模式，原生 run_command，成功 Host resource-list receipt                                                                                                                                                                    |
| Qoder CLI   | 额度耗尽，无成功 receipt，不通过；未购买额度或修改订阅                                                                                                                                                                                  |
| Pi          | 再次卡在 macOS Keychain `SecKeychainFindGenericPassword`；采样后终止，无供应商请求/Usage，不通过                                                                                                                                        |

最终 Codex 冲突 probe 在 17 managed tools 配置下实际遇到 prepared commit 冲突，restart 后
比较只读 reference、显式重放局部修改、review/prepare/commit，Project 实际 revision 3。
最终 command channel smoke 同样使用新增 approved-input 绑定并产生成功 receipt。

DSL probe 使用临时可移植 authoring catalog，不执行新建 Expert/Team。它证明真实模型经真实
命令通道完成 authoring，不替代完整 Desktop 模型目录、binding 和历史用户配置的发行验收。

## 成本与性能

[静态估算 JSON](management-tools-cli-skills-phase-two-token-estimate.json)使用 Core 统一 counter、
o200k_base、格式化 JSON：21 个定义为 **7,083 tokens**。索引、正文、reference 与按命令加载的
help Schema 开销分别记录；这些静态量不等于供应商实际节省。

Codex 使用相同 CLI 场景和三个 Skill 索引，仅保留/隐藏本阶段 21 个工具。before/after 不是
旧 managed-tool 工作流对比。Native 缓存条件与模型行动没有严格受控；以下为一组探索性样本。
input 为现有 Core UsageSink 的 reported `input + cacheRead` 求和，非供应商逐 wire 请求归因。
专业场景的首次 provider 请求、Skill/help 的独立计费输入尚未捕获，不能用这些数据冒充该门禁。

| 场景                 | before reported input | after reported input | 原生调用 before → after |   耗时 before → after |
| -------------------- | --------------------: | -------------------: | ----------------------: | --------------------: |
| 普通聊天（无工具）   |                15,529 |               15,533 |                   0 → 0 |   16.463 s → 10.498 s |
| Expert/Team 三段任务 |               110,962 |              115,162 |                 34 → 38 | 144.021 s → 152.380 s |
| Flow 三段任务        |               120,018 |              129,300 |                 41 → 41 | 233.881 s → 253.558 s |
| Evaluation 两段任务  |               111,844 |               92,454 |                 40 → 43 | 212.623 s → 191.470 s |

各组均实际达成对应发布与审核断言，原生调用只有 shell 等价工具，没有依赖原 DSL/Evaluation
managed tools。普通聊天没有下降证据；DSL 与 Flow 的代价上升。未接受性能 cutover。
独立 command receipt 结果字节分别为 DSL 21,378 → 21,392、Flow 9,514 → 9,311、Evaluation
12,262 → 13,039；这是不同请求的有界结构化结果量，排除重试交付、shell 包装和 help/Skill 文本。
模型读取 Skill/help 的次数和供应商独立开销尚无可靠归因，不能与 Schema 静态量直接相减。

## 遗留门禁与默认切换

1. Pi 完整 authoring/Evaluation/Flow 与普通聊天真实验证及供应商输入对照；Keychain 阻塞仍在。
2. Qoder 可用额度下的真实 command probe 与相应专业流程。
3. 真实模型的历史 DSL/Evaluation 接管、非自动批准 Human checkpoint、取消及异常恢复；自动化
   边界回归与第一阶段 Codex Flow 历史恢复不替代这些第二阶段场景。
4. Windows launcher/发行产物、历史用户定制 whitelist/grants 与模型目录接线验收；保留第一阶段缺口。
5. 可比较缓存条件下的 provider 首次/全任务输入与 Skill/help 开销；成本上升需要明确的接受依据。
6. 第二阶段默认白名单现已根据本轮用户明确授权切换（49 → 28）；原 handler/Capability 定义
   保留供 CLI、显式 binding 和 Revision Agent 使用。上述未完成验收继续保留，不能记为已通过。

本次未实施第三阶段，未合并、发布或宣称 Issue #368 已完成。

## 工程检查记录

- 原 Project adapter 首轮 32 项业务断言通过；新增 Skill 后目录计数断言已同步。
- Built-in DSL/management handler：28 项通过；Skill validator 两个 Skill 均通过。
- Project adapter/command/Capability store/catalog：4 文件 89 项通过；增加历史/崩溃场景后 command
  suite 18 项通过；再增加 pending 审批输入绑定后，最终 command suite 19 项通过。
- 最终 Host catalog 测试 helper 通过 Desktop bound-resource policy 构造 RuntimeProfile，定向真实
  CLI 文件草稿回归通过。Skill renderer 与 Revision service 三文件 76 项通过。
- 首轮缓存构建未恢复独立 command client，子进程 suite 失败；强制构建补齐后顺序复跑通过。
  之后一次重建与子进程 suite 重叠导致空 stdout，废弃该轮并按顺序复跑，不记为业务成功。
- lint 曾拒绝测试 helper 绕过 Desktop binding policy，已修正；新增 approved-input writer 首轮误用
  receipt validator，回归发现后修复并完整复跑 19 项；历史 fixture Mission 类型已修正，Node typecheck 通过。
- `pnpm check` 最终全仓通过（Runtime/DSL 检查、19 package lint/typecheck、11 task test:core）。
- 共享 Host/CLI 全套、Desktop adapter 全套及最终生产构建结果在下方追加；不把进行中的门禁记为通过。

补充检查：CLI adapter 6 项通过；历史 fixture 搬到不被忽略的 `workspace-files/` 后定向恢复回归通过。
Desktop adapter 首轮 112 passed、2 skipped、2 个 Mission deletion 用例超时；未改超时或断言，
该文件单独复跑 4 passed、2 skipped。该结果不是另一次全套成功。

最终补充：共享 Host 全套为 926 passed、1 skipped，唯一失败是
`node-compilation-execution.test.ts` 的既有 cold Flow send 五秒等待超时；未改超时或断言，
该用例在原设置下单独复跑通过。`pnpm --filter @pqpo/pragma test` 因此没有进入 adapter 阶段；
随后单独运行完整 `test:adapters`，16 文件 120 项通过。不能把该组合写成一次完整 CLI gate 成功。

增加未来 DSL draft 和 Evaluation command journal 拒绝断言；后者发现 legacy model-tool
normalizer 会把私有 storage error 改写为 internal_error，已在 CLI 端口适配边界保留权威
IntegrationError，未改变 Runtime MCP 结果语义。修复后完整 command suite 19 项再次通过，
Local Host lint/typecheck 和 Desktop Node typecheck 再次通过。

尝试 Desktop 自带 Electron Node 引擎执行 Pi 同一 probe，仍卡在同一 Keychain API，采样并
终止，仍无供应商请求/Usage。该尝试没有绕过钥匙串或更改凭据，Pi 门禁继续待验收。

最终构建：`pnpm build` 19 package 全部通过，Desktop main/preload/styles/storage worker 四项
产物检查通过；生产 main 产物包含最终 command-state error 透传边界。
未来版本拒绝与私有 journal 诊断补齐后，完整 command suite 19 项通过；Local Host
lint/typecheck 与 Desktop Node typecheck 通过。最后的脚本/CLI 变更另行 ESLint 定向通过。
全仓 `pnpm check` 成功记录保留原时间；其后的私有 journal 诊断改动使用上述定向检查，未虚称
再次运行了完整 check 或共享 Host 全套。

Pi 两种引擎的阻塞进程不响应 SIGTERM，最终使用针对本轮确切 PID 的 SIGKILL，并核实退出；
未扫描或终止用户原有 Runtime/桌面进程。实际 Electron UI 验证的隔离窗口也已关闭。

切换前产物实测：Electron 自带 Node 执行打包 client 的 `evaluation draft update --help` 返回 0，
包含权威 operations 输入协议。生产静态装配再次核对为 36 个 management 选择、38 个 managed
工具、Pi 口径 49、31 个 CLI command 和 3 个内置 Skill；第二阶段默认切换确实未发生。

## 2026-10-09 用户授权默认工具切换

用户在阅读第二阶段结果后明确要求“移除已经迁移到cli的工具”。据此从默认 Pragma management
白名单移除 DSL 14 个与 Evaluation 7 个工具，并同步更新生成产物与编译/MCP catalog 回归。
第一阶段已移除的六个 Flow 工具继续保持隐藏；第三阶段十五个工具与两个 Revision Agent 调用保留。

切换后的默认 management 选择为 15，managed tools 为 17，Pi 默认总量为 28。CLI 31 个 command、
三个内置 Skill、执行授权、审批及显式 binding 的权威定义/handler 不删除。
MCP 回归还检查移除工具没有以另一名字前缀重新注入默认目录。

前面的 49 工具核对与 prospective probe 是切换前事实；历史 Runtime 证据不改日期或数值。
Pi Keychain、Qoder 额度、真实 checkpoint/取消、Windows、历史定制白名单及性能门禁仍待验收。
本轮切换未新增供应商模型执行，不将用户授权或工具计数视为这些验收通过。

本轮切换验证：Built-in DSL/编译/MCP catalog 与 management handler 两文件 28 项通过；
真实 CLI 子进程/Host 边界 suite 19 项通过，含更严格审批、历史恢复、future version 拒绝和
pending 重放。Built-in Agents build/lint/typecheck、Local Host build、Desktop 生产构建与
main/preload/styles/storage worker 四项检查通过；`git diff --check` 通过。
静态装配再次确认 15 management 选择、17 managed tools、Pi 总量 28、31 CLI command、3 Skill。
使用本 worktree 的更新构建并新建默认 Pragma 会话进行手动测试；已有会话可能仍持有旧编译快照。

## 第二阶段 CR 跟进

[CR 与修复记录](management-tools-cli-skills-phase-two-code-review.md)记录本次逐项核实结果。
修复了 DSL CLI prepare 的 candidate 已落盘而草稿写入未完成时，普通读取/失败回滚删除
恢复快照的问题；新增独立 `pragma.dsl-command-prepare/v1` journal，在原草稿锁内绑定
候选与 submissionHash，读取及重试优先恢复 prepared 状态。既有协议未升级或改写。
新增当前 DSL 回归 helper 改用 Interpreter 权威写入版本常量。

修复后 command/Project adapter 共 52 项通过，Built-in 默认目录/management handler 共 48 项通过；
再次完整 `pnpm check` 和 Desktop 生产构建及四项产物检查通过。真实 Codex DSL after probe
在最终 17 managed tools 下再次成功发布 revision 2，并验证提交拒绝与丢弃；新 receipt 与
prepare journal 见 Runtime evidence 的 `crFollowUp`，不覆盖原成本对照。CR 没有已确认而未修复
的代码问题；上面的遗留 Runtime/发行/成本门禁仍未完成。
