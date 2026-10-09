# Issue #368 第一阶段实施与验收记录

日期：2026-10-08 至 2026-10-09。起点：main `a32bdedb`。
Worktree：`issue-368-phase-one/expert-mesh`，由 main 创建。

**状态：公共基础、Flow CLI 闭环与内置 Skill 投影已实现。2026-10-09 用户明确授权先移除
六个默认 Flow 工具，由用户继续手动测试；已执行默认 Schema 切换（Pi 默认口径 55 → 49）。
尚未完成的 Runtime、性能与发行验收继续记录，不表示这些验收已通过。**

## 已实现

- CLI 提供 `flow draft create|get|update|validate|prepare|discard`，以及 Flow 需要的
  `dsl resources list|read`、`dsl options list`、`dsl ids allocate`、`dsl changes read|commit`。
  参数对象继续由原 handler/Schema 校验，大输入使用原有有界文件/stdin reader。
- Local Host 复用管理工具 factory 和 Core 审批管道；共享草稿、prepare/commit、分页、锁和
  journal 业务已从 Desktop adapter 提取。Desktop 保留目录、系统资源及 binding 策略的窄适配。
  因公共 prepare/commit 与草稿逻辑相互依赖，提取保留同一实现内的现有 DSL/Evaluation 行为，
  没有提前迁移第二阶段 CLI 或默认工具。
- Core 提供不进入模型 MCP config/catalog 的私有 command registration。Interpreter 传递 Host
  lifecycle hooks；六种 Runtime 共用该生命周期，不新增 daemon 或 Runtime 私有管理服务。
- Host 绑定真实 Execution/Invocation/Context，保留 ownership、denied policy 与提交审批。
  Desktop 为默认 Pragma 显式配置本阶段 command grants；原 allow/deny policy 继续限制它们，
  不会因拥有 Skill 而扩大普通 Expert 权限。Core 保留独立 executionToolApprovals 元数据，
  CLI 合并原 handler、Expert 声明和插件审批，隐藏模型 Schema 不会丢失更严格的审批。
- requestId 与短命 MCP 请求序号分离；Context 内相同请求复用 receipt，冲突 payload 拒绝，
  响应保留原操作 origin。私有 Session 根保存 request/owner/update journal，跟随 owner 图删除。
  create/update/prepare 与事务提交具备针对新命令的恢复路径；中断不撤销已发布 revision。
- `input_required` 是 Human checkpoint 控制状态，不归类为业务 internal_error。结构化错误
  保留 management code、retryability、details/recovery；既有 Runtime MCP 编码保持原样。
- Desktop 自包含 client 随构建产出，ASAR 解包，用 Electron 自带 Node 启动。launcher 只进入
  Runtime 的进程 PATH。缺少/撤销 endpoint 不回退到更广泛的用户 Host 权限。
- 新增 `author-pragma-flow`，迁走 Flow references，原 DSL Skill 指向新 Skill。静态注册表为
  Runtime、依赖闭包、fingerprint 与工作台提供同源内容。工作台复用既有页面和 DTO，显示内置
  标记、版本、正文与 references；store、IPC、Revision service 同样拒绝系统 Skill mutation。

架构决策见 [ADR 067](../adr/067-execution-management-cli-and-built-in-skills.md)。公共 CLI 在没有
当前授权 endpoint 时拒绝 Flow mutation；Desktop 关闭时的独立人工 Flow 编辑 composition 未交付。

## 回归与实际执行证据

逐工具静态数据见[基线 JSON](management-tools-cli-skills-phase-one-baseline.json)。42 个管理工具
采用 Core token counter、o200k_base 和格式化 JSON 同一口径。六个 Flow 定义合计 27,035 bytes /
13,065 tokenizer tokens；这是拟移除定义量，不是实际供应商输入节省。

新增真实 CLI 子进程 suite 使用实际 Project repository 和共享用例，覆盖：创建、Unicode
operations、无效校验、修复、revision 冲突、prepare、审批拒绝零发布、commit、重试、discard、
pending update journal 重放、发布后缺失 receipt 的恢复、Context 隔离、denied policy、取消、
凭据撤销以及同 Context 后续 Execution 查询原 receipt。Human checkpoint 单独返回等待状态。
另覆盖未来 command server 版本在调用前拒绝、隐藏工具后的更严格审批拒绝且不创建草稿。

已有 Project adapter、handler、Capability store 和 Gateway suite 继续运行。新增只读投影测试
验证正文/reference 读取与 mutation 拒绝，不生成用户可编辑的系统 Skill payload 副本。

本轮已确认：

| 检查                                                  | 结果                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| handler + built-in DSL suites                         | 已运行；补齐新增 Capability 计数、Flow 指引及 Bundle import 回归                                               |
| Project adapter + Flow CLI process + Capability store | 70 tests 通过；CLI process 最终复跑另列                                                                        |
| 系统 Skill store + renderer 只读断言                  | 44 tests 通过                                                                                                  |
| CLI stdin/help/退出码新增 adapter                     | 2 tests 通过；全部 CLI adapter 116 tests 通过                                                                  |
| Core Gateway                                          | 8 tests 通过                                                                                                   |
| Interpreter                                           | 117 tests 通过                                                                                                 |
| Desktop mission adapters                              | 113 passed、2 skipped                                                                                          |
| 共享 Host 完整门禁                                    | 925 passed、1 skipped；唯一失败为新增 Evaluation 依赖未同步测试白名单，已按 AGENTS.md 的允许边界修正并定向复跑 |
| lint                                                  | 19 packages 通过；最终修改后再次通过                                                                           |
| typecheck / build                                     | 全仓 typecheck 19 packages、Desktop 生产构建与四项产物检查通过                                                 |
| test:core                                             | 首轮 Memory tokenizer 用例超时；该 suite 独立复跑 12 tests 通过，全仓复跑通过（11 tasks）                      |
| Electron Node client                                  | 打包 client 的真实 Electron Node `flow draft get --help` 返回 0，包含 draftId，无 stderr                       |

完整门禁初次失败和修复均保留记录，不把定向补跑写成另一次全量成功。测试输出在本次会话
`/tmp/pragma-368-*.log`；最终结果在文末补充。截图/临时测试 Home 不提交。

真实 Runtime 执行入口：

```sh
pnpm exec tsx apps/desktop/scripts/verify-flow-command-runtime.ts codex flow after
pnpm exec tsx apps/desktop/scripts/verify-flow-command-runtime.ts <runtime> smoke after
```

脚本用临时 Project、实际 Core Execution、真实 Native Runtime、打包 CLI 子进程和 Host receipt
证明可用性。未使用 mock 模型；未修改用户的模型配置或正式 Project。Pi 配置在临时副本升级，
仅通过既有 secret store 读取凭据。未使用的资源/Mission/Automation 端口不在该 probe 中执行。

[Runtime 汇总 JSON](management-tools-cli-skills-phase-one-runtime-evidence.json)记录工具数、Usage、
command receipts、批准结果与实际 Project metadata，不包含凭据、bearer endpoint 或宿主 Session 树。

| Runtime                | 已验证结果                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Codex 0.159.0          | 完整创建、校验失败修复、已有 Flow 修改、冲突、prepare/commit、拒绝、discard；实际 revision 2                     |
| Claude Code 2.1.195    | 原生 shell 调用 CLI，Host resource-list receipt 成功                                                             |
| OpenCode 1.18.33       | 原生进程调用 CLI，Host resource-list receipt 成功                                                                |
| Antigravity 1.2.14     | host-keyring 模式原生调用 CLI，Host resource-list receipt 成功；关闭出现 SIGTERM 超时后强制终止的原 Runtime 诊断 |
| Qoder CLI 1.1.64       | 原生模型调用返回额度耗尽，没有成功 command receipt，不计为通过                                                   |
| Pi / DeepSeek v4 Flash | Node 阻塞在 macOS Security/keyring 凭据读取，尚无供应商请求/Usage，不计为通过                                    |

早期模型回答“命令不存在”的运行被判失败；定位并补齐 Interpreter hook 传递后，以上四个本地
Runtime 的 smoke 均以真实 Host receipt 验证，不能只依据模型文字回答判成功。

## 输入成本与性能

Codex 使用相同请求、规则、权限与当前两个 Skill 索引，分别保留/隐藏六个 Flow 工具进行单组
对照；before/after 是同一 CLI 工作流的 Schema 对照，并非旧版原生 Flow 工具工作流的基准。
使用 Native Runtime 的 reported Usage，输入含 cacheRead；不能与静态 tokenizer 排序直接相减。

| 场景                                |    before |     after |               差异 |
| ----------------------------------- | --------: | --------: | -----------------: |
| 普通聊天 input + cacheRead          |    17,939 |    17,937 | -2；无显著节省证据 |
| Flow 三段任务累计 input + cacheRead |   110,348 |   117,731 |  +7,383（约 6.7%） |
| Native tool.started 次数            |        37 |        41 |                 +4 |
| 三段任务耗时                        | 197.099 s | 213.990 s |          +16.891 s |

两组 Flow 均实际完成两次发布和一次提交拒绝。初始索引/工具数、help/Skill/命令结果与原生
Runtime 包装均影响成本；单组结果含模型执行差异，不足以接受性能 cutover。Pi 供应商首次输入、
全任务累计输入及 cache 条件对照仍缺失；没有宣称已节省 13,065 个实际输入 tokens。

## 未完成项与下一步门禁

1. 完成 Pi 钥匙串授权后的真实聊天/Flow 验证及供应商输入对照；当前阻塞已通过进程栈确认。
2. 在 Qoder 有可用额度时完成真实 command probe；本次未购买额度或更改订阅。
3. 补齐真实 Runtime 的取消、异常恢复与非自动批准 Human checkpoint 全流程证据；现有对应
   自动化边界和原 Core HTTP checkpoint suite 不能代替这些模型场景。
4. 完成 Windows launcher/发行产物验证与实际 Electron 工作台的端到端浏览；独立用户 CLI
   composition 未交付。当前 renderer QA 已浏览正文、文件树和 Flow reference 并确认无修改入口，
   使用实际组件/样式与静态 projection 的测试 Bridge，不代替实际 IPC 端到端验收。
5. 用户授权默认切换后，仍需补齐持久化用户定制 Pragma/Expert 白名单的真实边界验收。CLI grants
   已与模型目录分离，System Expert 按既有规则继承默认能力，原 allow/deny policy 继续限制命令。
6. 六个默认工具已按用户授权移除；继续补齐可比较性能证据。公共 DSL 工具、历史 handler
   定义、Revision Agent 工具和其他阶段默认工具继续保留。

本次未实施第二、三阶段的工具迁移，没有以工具回退替代 CLI 双实现；同一业务实现被两个入口
复用。默认工具切换已完成；上述验收缺口仍待补齐。

## 最终补充检查

- 全仓 typecheck：19 packages 通过。
- test:core：失败用例处理后全仓复跑通过（11 tasks）；没有修改 Memory 断言或扩大超时。
- 共享 Host 唯一失败的 manifest 白名单已按 AGENTS.md 允许 `local-host -> evaluation` 修正，
  boundary-guard 5 tests 定向复跑通过；其余 925 个业务断言首轮通过。
- Skill Revision service 的 56 tests 通过；新增系统目标拒绝发生在创建修订草稿之前。
- 使用实际 renderer 组件、实际 CSS 和静态 Skill wire 内容的浏览器 QA 确认了正文、文件树、
  Flow reference 的布局和只读入口；没有提交截图。实际 Electron IPC 浏览仍保留为未完成门禁。

- 最后增加审批元数据保留和协议版本握手；Interpreter 117 tests 再次通过。
- Pi probe 在确认系统 Keychain 阻塞后终止本次测试进程，保留诊断；没有绕过授权或改动凭据。

- 全仓最终 lint/typecheck 再次通过（各 19 packages）；Desktop 生产构建与 main、preload、
  storage worker、样式四项检查通过，Core 相关 13 tests 再次通过。
- CLI 子进程 suite 曾与构建清空输出目录并发导致空 stdout，另一次审批断言遇到依赖 dist
  尚未重建；完成依赖构建后四项完整复跑通过。后续此 suite 必须在依赖和 client 构建结束后执行。

- CLI 子进程边界 suite 最终 5 tests 全部通过，包含声明式与插件两种更严格审批来源；
  最后测试变更的 Desktop Node typecheck 和 ESLint 定向复核通过。

## 2026-10-09 默认工具切换与 Token 估算

用户明确要求“可以直接移除，我再手动测试”。据此移除默认 Pragma management binding 的
create/get/update/validate/prepare/discard 六个 Flow 工具。编译后 managed tools 从 44 降为 38；
按计划 Pi 包含基础工具的默认总量由 55 降为 49。原 Capability 定义和 handler 继续用于 CLI
及显式配置；CLI command grants、toolPolicy 与 executionToolApprovals 不依赖默认工具目录。

Core 统一计数器、o200k_base、格式化 JSON 的静态估算仍为 **13,065 tokens**，约为原 42 个
管理定义 24,120 tokens 的 **54.2%**。其中 create 为 2,678，update 为 9,388，其余四个合计 999。
新增 Flow Skill 仅默认加载 name/description/path 索引，正文和 references 按需读取；预计启动
上下文净减少量接近 13k tokens（该参考序列化口径）。实际供应商序列化、Tokenizer、缓存和
原生 MCP 按需发现会改变 Usage，不能把该估算视为保证的实际输入/计费节省。

[估算 JSON](management-tools-cli-skills-phase-one-token-estimate.json)保留逐工具数据。
compact JSON 的大 Schema 触发 Core 长无空白串保护、回落 heuristic；其合计 7,167 仅为另一
序列化下的粗估，不与 13,065 的 tokenizer 口径混称实测。历史真实 Runtime 样本保留原日期
和测试变体；probe 的 before 显式恢复旧目录，after 现在直接使用生产默认目录。

切换后的定向验证：Built-in DSL/编译/MCP catalog suite 15 tests 通过，真实 CLI 子进程
边界 suite 5 tests 通过；Built-in Agents build/lint、Desktop Node typecheck、probe ESLint
及 Desktop 生产构建通过，main/preload 产物检查通过。未重新运行供应商模型 probe，用户继续
手动测试。手动测试须从本 worktree 启动更新后的 Desktop，并新建默认 Pragma 会话。

## Code Review 复核

2026-10-09 完整审查与确认的问题修复见[CR 记录](management-tools-cli-skills-phase-one-code-review.md)。
私有 command 通道按请求隔离 MCP transport，并随 HTTP/Execution lease 撤销取消；客户端连接
故障及时结束等待。补齐 CLI identity/global flags、存储诊断、原子 launcher 和发行 ASAR 审计。

发布准备检查：`pnpm check` 全部通过，`pnpm build` 19 packages 全部通过；工作改动保存在
`codex/issue-368-flow-cli-skills` 分支。未将 Runtime/平台验收缺口改写为已完成。

PR 评论处理与历史受控恢复见[后续复核记录](management-tools-cli-skills-phase-one-pr-review-follow-up.md)。
新增两个 CLI-only recovery 命令保留原文件、强制审批并拒绝已知 foreign owner；默认工具数不增加。
