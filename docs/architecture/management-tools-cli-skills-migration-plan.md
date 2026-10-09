# Issue #368：管理工具迁移到 CLI + 内置 Skill 的三阶段计划

日期：2026-10-08。分析基线：`b35fa2ab` 的当前源码。

关联：[Issue #368](https://github.com/pqpo/pragma/issues/368)。

状态：第一阶段实现已进入独立 worktree；2026-10-09 用户授权先移除六个默认 Flow 工具并继续手动测试，默认 Schema 已切换，部分验收尚未完成。详见[实施报告](management-tools-cli-skills-phase-one-implementation.md)。本文件仍是分阶段计划，不表示阶段已完成。

## 1. 目标与范围

按预期上下文收益，分三个阶段将内置 Pragma 默认选择的 42 个管理工具迁移到 CLI，通过内置 Skill 按需发现和加载操作说明。每阶段提供完整可用工作流，再移除对应默认工具注入。

用户确认的产品要求：这些 Skill 必须出现在工作台的技能页面，标注为内置技能，可查看但不可编辑。默认 Mission 只注入精简 Skill 索引，用户在页面查看 Skill 不得导致其正文进入 Agent 初始上下文。

补充要求：最终一组管理工具对应一个内置 Skill，共六组；现有 `author-pragma-dsl` 一起迁移并收窄用途，不保留覆盖全部管理能力的旧版大 Skill。低回归成本的实现架构与测试复用结论见第 10 节。

最终保留 13 个基础操作与当前 Execution 工具。工具数量按内置 Pragma 默认配置 + Pi Runtime 计算，其他 Runtime、用户定制 Capability、插件和 delegation 配置另行计数。

本计划只处理工具定义与 Skill 分发。AGENTS.md 精简、通用动态 MCP 注册、Knowledge/Skill Revision Agent 内部工具迁移不在范围内。

## 2. 当前工具装配与收益基线

### 2.1 55 个默认工具的组成

| 来源                                      | 数量 | 内容                                                            |
| ----------------------------------------- | ---: | --------------------------------------------------------------- |
| Pragma management Capability 的显式白名单 |   42 | DSL、Flow、Evaluation、Automation、Host 资源发现与 Mission 管理 |
| Core 默认工具                             |    7 | 用户提问与 Context 读写                                         |
| Pragma 显式绑定的资源调用                 |    2 | Store Revision Agent、Skill Revision Agent                      |
| Pi 原生工具                               |    4 | read、write、edit、bash                                         |
| 合计                                      |   55 | 当前默认配置，非所有运行时的固定值                              |

主要证据：

- [Pragma 默认 DSL](../../packages/built-in-agents/dsl/experts/0000000000pragma.pragma.yaml)。
- [Host management tools](../../packages/built-in-agents/src/pragma-host-management-tools.ts)。
- [Core 默认工具](../../packages/core/src/context-system/context-tools.ts)。
- [Pi 工具装配](../../packages/runtime/pi/src/adapter.ts)及本地安装的 Pi SDK 默认 read/bash/edit/write 工具集；Pragma 的自定义 bash 覆盖同名工具，不重复计数。

管理 Capability 还定义 Knowledge Revision 的 9 个工具和 Skill Revision 的 6 个工具，但 Pragma 默认白名单不直接选择它们。这 15 个工具不属于上述 55 个，不计入本次迁移收益。

### 2.2 按收益排序

下表使用 Core `createRuntimeTokenCounter()`，等待 `load()` 成功后，逐工具计数：

```ts
counter.countText(
  JSON.stringify(
    {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
    null,
    2,
  ),
);
```

所有下表计数的 source 均为 `tokenizer`，使用应用内 o200k_base。Schema bytes 是 `Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8")` 的合计。Token 是逐工具求和，未计 outputSchema、Skill 索引、系统提示词中的工具摘要或供应商包装。

这是统一序列化口径下的静态排序依据，**不是实际请求输入，也不是供应商逐项上报**。Issue 中 21.985k 的估算采用另一序列化口径，不能与本表直接相减。实施时须保存真实 Runtime 请求与 Usage，供应商精确上报优先；紧凑 JSON 可能触发 Core 的超长无空白片段 fallback，必须记录 source，不能混用 heuristic 与 tokenizer 结果。

| 优先级 | 工具组           | 数量 | 输入 Schema bytes | 工具定义参考 tokens | 占 42 个管理工具定义 | 阶段     |
| ------ | ---------------- | ---: | ----------------: | ------------------: | -------------------: | -------- |
| P1     | Flow draft       |    6 |            27,035 |              13,065 |                54.2% | 第一阶段 |
| P2     | DSL 与公共提交   |   14 |             7,107 |               3,771 |                15.6% | 第二阶段 |
| P3     | Evaluation draft |    7 |             6,502 |               3,312 |                13.7% | 第二阶段 |
| P4     | Mission 管理     |    7 |             4,372 |               2,211 |                 9.2% | 第三阶段 |
| P5     | Host 资源发现    |    4 |             1,823 |                 920 |                 3.8% | 第三阶段 |
| P6     | Automation       |    4 |             1,703 |                 841 |                 3.5% | 第三阶段 |
| 合计   |                  |   42 |            48,542 |              24,120 |                 100% |          |

Flow 的主要收益来自 `update_flow_draft`（9,388 参考 tokens、19,453 Schema bytes）和 `create_flow_draft`（2,678 参考 tokens、5,763 Schema bytes）。DSL 与 Evaluation 的先后考虑公共提交依赖；Mission 和资源发现按完整任务组合迁移，不仅按单个工具大小切割。

## 3. 所有阶段共用的设计约束

### 3.1 包边界与业务复用

- `apps/cli` 只负责 argv、stdin/文件输入、进程交互、presenter、退出码和 Host composition。
- DSL AST、解析、校验和编译继续由 Interpreter 拥有；Evaluation、Revision 等领域逻辑留在所属包。
- Host 权限、草稿事务、持久化、operation receipt、审计与恢复由共享 Host 用例及其资源端口承担。现有 Desktop project/Automation adapter 中可复用的 Host 业务须提取到 `@pragma/local-host`，不得复制到 CLI。
- Skill 正文、references、静态 descriptor 与内置 DSL 归 `@pragma/built-in-agents`。Core、Built-in Agents、Runtime 不得反向依赖 Local Host 或 CLI。
- 当前持久化协议语义不因换入口自动改变。涉及协议不兼容变化时，同阶段提交版本、相邻迁移、真实历史 fixtures、备份/journal 恢复和未来版本拒绝测试。
- 默认 Pragma 白名单移除不等于直接删除整个 management Capability。实施前盘点已持久化的用户定制 Pragma/Expert、历史 Project Revision、Mission 和 Execution 对旧工具 binding 的引用；若删除定义会使既有合法配置失效，同阶段落实版本治理、升级或等价可执行路径，不能只改默认 DSL 后让已有配置失效。
- 不新增 daemon、local-runner、动态工具注册系统或完整 execution service override。

### 3.2 Agent 调用 CLI 的身份、权限与分发

第一阶段先提交 ADR，明确以下边界后再移除工具：

1. 开发版与发行版的可执行入口、定位方式、版本匹配和支持平台。Desktop 不能假设用户已安装兼容的 `pragma` 或 Node；方案必须明确随应用提供受控命令入口还是其他可验证分发机制。补充/修订 ADR 042 的相关决策，不擅自修改用户 PATH。
2. 区分用户主动调用 CLI 与 Agent 通过当前 Execution 调用 CLI。后者必须由 Host 验证调用来源，并继承 Mission、Execution、Invocation、Runtime Context、工作区、资源范围、取消与审计归属。
3. `PRAGMA_HOME` 和 Mission/Execution ID 是定位信息，不是授权凭证。授权必须由 Host 产生并校验；不得接受 Agent 自报身份后以宿主权限访问全部资源。
4. 保留既有业务审批。`commit_dsl_changes`、Automation mutation、Mission 创建/发送等审批不能因 shell 已获批准而自动通过，也不能只靠 Skill 文本要求模型自律。Agent 自动化模式必须能将所需交互交回原 Execution，不能卡在子进程 TTY。
5. 请求有稳定 operation/request identity，并验证幂等重试、payload 冲突和 owner fencing。CLI 退出或取消不等于撤销已提交事务；重试必须能查询原 receipt。
6. 缺少 CLI、版本不匹配、执行入口不可用时返回稳定错误码与可操作诊断。发布门禁要求已迁移能力可用；不静默丢失能力，也不长期保留工具回退双实现。

当前普通 CLI composition 建立 `surface: "cli"` 的独立 client，尚不能作为上述身份继承的实现证明。

### 3.3 命令输入输出与渐进加载

- 自动化调用使用结构化 JSON 输出、稳定错误码、明确退出码和有界结果；列表分页，正文按范围读取，诊断标明截断和 continuation。
- 大 YAML、Flow operations 与 Evaluation cases 使用文件或 stdin；避免 shell 参数中的长文和转义，不直接编辑正式 Project 存储。
- 子命令帮助按操作暴露参数、输入格式与简短例子；完整嵌套 Schema 不常驻注入，不把整个协议转写成默认 Skill 正文。
- CLI 仍调用权威 Schema 校验，不以任意 JSON 字符串替代业务类型和校验。
- Skill 只在相关任务触发时读取正文，按需要继续读取 references 或子命令 help。普通聊天不读专业 Skill 正文。
- 每次 prepare/commit、校验失败、版本冲突、取消和恢复保持现有语义；公共 CLI 命令可以先于默认工具移除交付，但业务实现始终只有一份。

### 3.4 内置 Skill 在工作台只读展示

第一阶段建立机制，后续阶段只增加静态 Skill 条目：

- 在现有工作台技能列表和搜索中展示内置 Skill，标记“内置”，详情展示名称、用途、版本信息、`SKILL.md` 和有界文件树/文本 references。
- 复用现有 Skill 目录、详情和浏览器安全 DTO；使用 `managedBy: "system"` 或现有等价系统所有权表达只读，不另建平行技能管理页面。
- 系统 Skill 的权威来源是 Built-in Agents 的静态包内容。Host 提供只读目录与文件读取投影，Runtime 使用同源物化内容；不在用户可编辑 Capability 目录维护另一份权威副本。
- 不提供编辑正文/元数据、生成修订、发布新修订、重命名、删除或 Git 同步覆盖入口。Host mutation/IPC 边界同样拒绝这些操作，不能仅隐藏 UI 按钮。
- 保持用户 Skill 的导入、修订和同步行为；内置 Skill 随应用版本更新，用户页面操作不改写其内容。
- UI 展示目录与 Agent Skill 索引来自同一静态注册来源。不得要求 renderer 读取包文件、扫描安装目录或导入 Node-only 包。
- 内置 Skill 可被配置为 Expert 能力；默认新增索引只绑定所需内置 Pragma，不全量注入所有 Expert。
- 新增语义资源 ID 必须通过权威 Schema 构造 canonical ref，并覆盖第一个持久化/跨进程消费边界。不要在计划中预造未经验证的 ID。
- 检查 `builtin.ts` 当前单一 `author-pragma-dsl` 路径前缀、DSL Capability 引用、文件生成/物化与 fingerprint；新增 Skill 必须进入依赖闭包和发行产物。

## 4. 第一阶段：Flow 完整工作流与共用基础

**收益最高；迁移 6 个默认工具，目标 55 → 49。参考移除定义量 13,065 tokens。**

### 实施清单

- [ ] 记录逐工具基线、真实“只回复 ok”新 Mission 基线，以及 Flow 新建/修改场景的任务累计输入与调用次数。
- [ ] 提交调用身份、授权/审批、CLI 分发和内置 Skill 只读投影 ADR，落实第 3 节公共基础。
- [ ] 优先复用现有管理工具 factory、handler 和 Host 端口；按第 10 节机械提取必要的 Host 实现，保留 draft revision、诊断、事务和恢复，不重写 Flow 业务。
- [ ] 提供 `pragma flow draft create|get|update|validate|prepare|discard`，大 operations 走文件/stdin。
- [ ] 同时提供 Flow 所需公共依赖：资源 list/read、options/ID 分配（按需要）、prepared change 读取、`pragma dsl changes commit`。这些是 CLI 能力依赖，第一阶段不移除仍被其他工具工作流使用的公共默认工具。
- [ ] 内置 `author-pragma-flow` Skill，说明草稿→增量修改→校验→prepare→审批/commit→冲突/取消恢复；references 按主题拆分。
- [ ] 将现有 `author-pragma-dsl` 的 Flow 指引改为发现新 Skill，消除旧 Flow 工具调用指令，保留尚未迁移的其他工作流。
- [ ] 在工作台展示新 Flow Skill 和现有 author-pragma-dsl Skill，并落实 UI 与 Host 双层只读验证。
- [ ] 真实 Runtime 验证完整流程后，从 Pragma 默认 Capability 白名单移除以下工具；检查生成内容、提示词和 Capability 元数据无残留引用。

| 移除工具            | 参考 tokens |
| ------------------- | ----------: |
| create_flow_draft   |       2,678 |
| get_flow_draft      |         258 |
| update_flow_draft   |       9,388 |
| validate_flow_draft |         211 |
| prepare_flow_draft  |         326 |
| discard_flow_draft  |         204 |

### 完成门禁

- 普通新 Mission 不携带这 6 个工具 Schema，仅有精简 Skill 索引。
- 真实 Runtime 完成 Flow 新建、已有 Flow 修改、无效输入修复、draft revision 冲突、prepare/commit、审批拒绝、discard/取消和异常恢复。
- 流程包含公共 commit 与资源依赖查询，不因缺少旧工具而停在半途；其他尚未迁移的 DSL 工作流继续可用。
- 验证 Agent 身份拒绝、资源/工作区越界、CLI 缺失与版本不匹配、幂等重试和取消归属。
- 工作台可以查看 Skill 正文和 references；UI 无编辑入口，直接 mutation/IPC 也无法改写内置 Skill。
- 使用真实 Pi 和至少一个通过 Execution MCP Gateway 暴露 managed tools 的本地 Runtime 验证；声明支持的 Runtime 补对应 conformance/probe，不能以 mock 代替可用性证据。
- 提交本阶段前后对照；不将静态定义量直接宣称为实际节省。
- 同模型、同权限、同规则文本和可比较缓存条件下，普通聊天首次实际输入应下降；专业任务累计输入、额外调用或耗时若上升，量化代价并在阶段验收中明确接受的权衡。

## 5. 第二阶段：DSL authoring 与 Evaluation

**第二批收益；迁移 21 个默认工具，目标 49 → 28。参考移除定义量 7,083 tokens。**

先完成 DSL 公共生命周期，再迁移 Evaluation。复用第一阶段身份、分发、Skill 投影与公共提交能力。

### DSL 工具范围（14 个）

| 移除工具                  | 参考 tokens |
| ------------------------- | ----------: |
| list_dsl_resources        |         304 |
| read_dsl_resource         |         252 |
| list_expert_options       |         305 |
| allocate_dsl_resource_ids |         250 |
| start_dsl_draft           |         502 |
| list_dsl_drafts           |         193 |
| inspect_dsl_draft         |         232 |
| read_dsl_draft_review     |         448 |
| prepare_dsl_draft         |         227 |
| restart_dsl_draft         |         223 |
| discard_dsl_draft         |         211 |
| prepare_dsl_changes       |         164 |
| read_prepared_dsl_change  |         367 |
| commit_dsl_changes        |          93 |

### Evaluation 工具范围（7 个）

| 移除工具                 | 参考 tokens |
| ------------------------ | ----------: |
| create_evaluation_draft  |         501 |
| get_evaluation_draft     |         348 |
| get_evaluation_cases     |         300 |
| update_evaluation_draft  |       1,374 |
| run_evaluation_draft     |         313 |
| prepare_evaluation_draft |         271 |
| discard_evaluation_draft |         205 |

### 实施清单

- [ ] 按第 10 节复用剩余 DSL file draft 与 Evaluation 工具 handler，必要 Host 实现连同原测试机械迁入 Local Host，Desktop 与 CLI 使用同一权威实现。
- [ ] 提供 `pragma dsl resources list|read`、`pragma dsl options list`、`pragma dsl ids allocate`、`pragma dsl draft start|list|inspect|review|prepare|restart|discard` 和 `pragma dsl changes prepare|read|commit`。
- [ ] 保持 Expert/Team 必须走 Mission-owned 文件草稿；泛化 prepare 不得绕过文件草稿要求。
- [ ] 复用 `author-pragma-dsl` 作为 Expert/ExpertTeam 与其依赖资源的 CLI 编写入口，保留现有 Skill identity 并更新用途；Flow 与 Evaluation 的详细工作流移至独立 Skill，避免重复和相互矛盾的正文。
- [ ] 提供 `pragma evaluation draft create|get|cases|update|run|prepare|discard`，cases 和 operations 走文件/stdin，正文和诊断有界。
- [ ] 新增内置 `author-pragma-evaluation` Skill，保持当前工具支持的 Flow Run Dry 范围，不顺带扩展测评领域。
- [ ] Flow 与 Evaluation 独立提交：先保存 Flow，Evaluation 绑定已提交 Flow；prepare Evaluation 仍执行必要复验，不用 Skill 约定代替 Host 检查。
- [ ] 将本阶段 Skill 接入工作台只读目录和 Pragma 精简索引，更新内置 DSL、生成文件、调用方、文档和 tests。
- [ ] 真实验证完成后移除 21 个默认工具；已迁移工具不在启动时继续通过另一 Capability 或 MCP 名称注入。

### 完成门禁

- 真实 Runtime 完成 Expert/Team 创建与修改、多资源原子提交、局部文件修改、review 截断分页、冲突 restart、prepare/commit 与失败恢复。
- 保留未知字段合并、不可变 submission、源文件/快照稳定性、目标身份约束及 Mission-owned change-set 访问边界。
- 真实 Runtime 完成 Evaluation 单案例、必要的批次、失败修复、coverage 查询、revision 冲突、prepare 复验、独立 commit 与取消。
- 第一阶段 Flow 流程继续可用；所有 DSL/Flow/Evaluation 操作可经 CLI 完成，无旧工具依赖。
- 工作台内置 Skill 可查看、不可编辑；用户 Skill 修订不受影响。
- 报告普通聊天、Expert/Team authoring、Flow 和 Evaluation 的阶段前后数据，单列 Skill/help/结果开销与额外调用。

## 6. 第三阶段：Mission、Host 资源发现与 Automation

**剩余管理工具收敛；迁移 15 个默认工具，目标 28 → 13。参考移除定义量 3,972 tokens。**

内部优先级为 Mission → 资源发现 → Automation；Mission 与资源发现按一条完整任务入口组合交付。

| 工具组           | 移除工具（参考 tokens）                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mission，7 个    | list_missions（483）、get_mission（208）、create_mission（397）、send_mission_message（242）、list_mission_work_items（436）、get_mission_work_item（241）、interrupt_mission（204） |
| 资源发现，4 个   | list_workspaces（238）、list_home_projects（231）、get_home_project（211）、list_knowledge_stores（240）                                                                             |
| Automation，4 个 | list_automations（322）、save_automation（242）、delete_automation（149）、reset_automation_session（128）                                                                           |

### 实施清单

- [ ] 复用现有 `pragma mission list|get|send|interrupt` 和 executor run 入口，补齐管理工具需要的语义，不另建 command consumer 或 active owner。
- [ ] 明确 executor run 创建 Mission 与当前 `create_mission` 的等价条件，补知识绑定、工作区、精确 executor ref、结构化创建 receipt 和原调用审批归属。
- [ ] 补充 `pragma mission work list|get`；当前 CLI 尚无对应 work 查询，不能用 event 原文假称等价替代。
- [ ] 提供 `pragma workspace list`、`pragma home-project list|get`、`pragma knowledge-store list`；保留 Home Project 与 DSL Project、知识库 UUID 与 DSL ref 的区别。
- [ ] 新增内置 `discover-pragma-resources` Skill，独立承接这四个 Host 资源发现工具；Mission Skill 通过简短链接按需发现它，不复制整个资源发现教程。
- [ ] 新增内置 `manage-pragma-missions` Skill，覆盖发现资源→创建 Mission→查询工作→发送后续消息→中断；说明持久 Mission 与当前 Execution 子 Agent 的区别。
- [ ] 提取 Automation 共享 Host 用例，提供 `pragma automation list|save|delete|reset-session`；save 使用文件/stdin 中的完整 DSL，同时提交 workspace 和 permission binding。
- [ ] 新增内置 `manage-pragma-automations` Skill，覆盖创建/修改、启停、删除和 continuity reset；不通过泛化 DSL commit 绕过 Host binding。
- [ ] 更新 Pragma 默认指令，不再要求直接调用已移除的 list/create/send 等工具；Host 资源发现说明归独立 Skill，默认索引保持简短。
- [ ] 接入新 Skill 的工作台只读展示，并移除剩余 15 个默认工具。
- [ ] 收敛迁移过程中不再使用的工具 adapter、描述和调用方；专门的 Revision Agent 仍使用的 management tools 及其协议保留。

### 完成门禁

- 真实 Runtime 经 CLI 找到工作区、Home preset、executor 和知识库，创建 Mission、查看 work item、发送后续消息并中断；覆盖权限拒绝、target 冲突和跨进程控制。
- 验证尚未结束的当前 Execution 不会因 CLI 管理命令产生第二个 owner/consumer，调用审计能关联原 Mission/Execution。
- 真实 Runtime 完成 Automation 保存/修改、启停、删除与 reset；审批、幂等、异常恢复和并发修改符合原语义。
- 删除 Automation 保留其既有 Mission；reset 只影响下一次 continuity binding，不删除历史或中断不相关运行。
- 缺少 CLI、发行版入口错误、版本不匹配等诊断仍可操作；已支持 Runtime 没有无提示功能缺失。
- 最终普通 Pi Mission 只有建议保留的 13 个工具及精简 Skill 索引；定制场景单列实际工具集合。
- 汇总三阶段普通聊天与专业任务的实际输入、成功率、调用次数、耗时和恢复结果，决定是否还需压缩剩余工具描述/Schema。

## 7. 最终保留工具与边界

| 工具                                                            | 保留理由                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| read、write、edit、bash                                         | 通用任务、Skill 按需读取、草稿文件操作和 CLI 进程入口；各 Runtime 使用原生等价能力 |
| askUserQuestion                                                 | 当前 Execution 的用户交互与回答协议                                                |
| list_expert_context、read_expert_context、search_expert_context | 当前 Agent 的 Context 可见性、namespace、知识/Memory/白板及有界输出读取            |
| add_expert_context、edit_expert_context、delete_expert_context  | Context mutation 权限、revision/etag、动态挂载和私有 Runtime Context 隔离          |
| call_store_revision_agent、call_skill_revision_agent            | 当前 Execution 的 invokeResource、取消与调用治理；输入仅 prompt，迁移收益低        |

两个 Revision Agent 调用暂时保留，不使用普通 CLI executor run 替换它们；以后如迁移，需独立验证当前 Invocation 语义。

`spawn_expert`、`continue_expert`、`list_agents`、`wait_experts`、`steer_expert`、`interrupt_expert` 当前不在上述默认 55 个工具中；配置 delegation 或 ExpertTeam 时按权限注入，仍保留为结构化生命周期工具。CLI Mission 管理不能替代当前 Execution 的 ownerContextId、并发和深度治理。

## 8. 分阶段交付与验收记录

| 阶段 | 新移除默认工具 | 累计移除 | Pi 默认工具目标 | 参考移除定义量 | 必须交付的内置 Skill                                                         |
| ---- | -------------: | -------: | --------------: | -------------: | ---------------------------------------------------------------------------- |
| 一   |              6 |        6 |              49 |         13,065 | author-pragma-flow；现有 author-pragma-dsl 的只读展示与指引调整              |
| 二   |             21 |       27 |              28 |          7,083 | 更新 author-pragma-dsl；新增 author-pragma-evaluation                        |
| 三   |             15 |       42 |              13 |          3,972 | manage-pragma-missions、discover-pragma-resources、manage-pragma-automations |

每阶段独立安排实现、提交 reviewable PR 与验收记录，通过后再进入下一阶段。第一阶段的公共 CLI 支持不要求提前移除后续阶段工具；同一共享用例的不同入口不等于允许复制业务实现。

验收记录至少包含：

1. Git revision、应用/CLI/Skill/Runtime 版本、模型、权限配置与 workspace 条件。
2. 逐工具 name、input Schema bytes、统一参考 token count/source、审批要求与阶段归属；真实请求计数优先。
3. 普通聊天首次输入及缓存拆分；各专业任务首次输入、完成任务累计输入、Skill/help/命令结果输入、额外调用数、耗时和成功/失败结果。统一对话轮次与统计口径，并记录冷热缓存条件和重复样本。
4. 流程、权限拒绝、跨 scope 访问、并发冲突、审批、CLI 缺失/版本不匹配、取消与异常恢复证据。
5. 工作台内置 Skill 列表、正文/references 查看和只读 UI/IPC 验证；发行产物的 Skill 与 CLI 可用性验证。
6. 受影响模块 lint/typecheck/test/build、共享 Host 边界检查与真实 Runtime smoke；未完成的产品门禁明确标记，不以 mock 成功结项。

本计划的静态计数不能给出真实输入节省百分比；新增 Skill 索引、命令帮助、进程结果与更多交互轮次都应计入实际成本。

## 9. 主要实现入口与参考

- [AGENTS.md](../../AGENTS.md)：依赖、协议、存储、身份与启动治理。
- [ADR 042：Local Host 与 CLI](../adr/042-local-host-and-cli-boundary.md)：现有 CLI 分发与边界，需要第一阶段澄清相关决策。
- [ADR 055：Mission-owned DSL file drafts](../adr/055-mission-owned-dsl-file-drafts.md)：文件草稿、冻结快照、冲突与恢复。
- [ADR 056：First-class Skill Bundles](../adr/056-first-class-skill-bundles.md)：用户 Skill 与系统 Skill 的既有区别。
- [Desktop UI 规范](../conventions/desktop-ui.md)：在现有技能目录/详情中接入，不扩张页面结构。
- [Pragma Host tools](../../packages/built-in-agents/src/pragma-host-management-tools.ts)、[management tools](../../packages/built-in-agents/src/pragma-management-tools.ts)：定义、Schema、审批与输出治理。
- [内置资源与文件闭包](../../packages/built-in-agents/src/builtin.ts)、[现有 author Skill](../../packages/built-in-agents/dsl/skills/author-pragma-dsl/SKILL.md)：新增 Skill 的注册、物化与原指令更新。
- [Desktop DSL project adapter](../../apps/desktop/src/main/features/built-in-agents/pragma-agent-project-adapter.ts)、[Automation adapter](../../apps/desktop/src/main/features/built-in-agents/pragma-agent-automation-adapter.ts)：共享 Host 用例提取入口。
- [CLI argv](../../apps/cli/src/parser/argv.ts)、[CLI composition](../../apps/cli/src/composition/default.ts)、[Local Host Node application](../../packages/local-host/src/node-application.ts)：现有命令与应用接线。
- [技能目录](../../apps/desktop/src/renderer/src/pages/studio/CapabilityDirectoryFragment.tsx)、[技能详情](../../apps/desktop/src/renderer/src/pages/studio/CapabilityDetailFragment.tsx)、[内置 Capability](../../apps/desktop/src/main/features/capabilities/built-in-capabilities.ts)：复用系统只读标记、补 Skill 读取投影。

## 10. 补充调研：最小回归成本的复用架构

日期：2026-10-08。调研方式：阅读工具、执行链、Host 实现、CLI adapter、现有 Skill 和相关测试。此次只更新文档，未重新执行业务测试；下文“已覆盖”指现有测试代码覆盖的行为，不表示本次重新跑出的结果。

### 10.1 结论：复用现有 handler，Local Host 管调度，CLI 做薄包装

推荐的最小改动路线是：**已有管理工具保持唯一 handler 和权威 Schema，Local Host 增加受授权约束的命令调用入口，CLI 将命令映射到这些 handler，现有 DSL Skill 分拆并改写为 CLI 工作流。**

不把 `pragma-management-tools.ts` 与 `pragma-host-management-tools.ts` 整份直接搬到 Local Host。两份文件不只是 Host 业务：它们包含 Built-in Agents 的产品描述、工具目录、跨 Host 端口调用、协议校验、结果摘要和 Revision Agent 工具。整文件搬家会同时改动依赖方向、内置 Capability 目录、系统 Agent 编译和大量测试，收益不是消除模型 Schema 所必需的。

当前允许 `local-host -> built-in-agents`。Local Host 可以通过已有公开 `createPragmaManagementTools(ports, scope)` 构造工具，选出对应分组，进入现有 Core 执行管道；CLI 只依赖 Local Host 和 Shared wire 契约。这不需要 Built-in Agents 反向依赖 Local Host，也不需要将 CLI 变成 MCP server。

“复用工具”是复用受测试的 TypeScript managed-tool handler。**不是让 CLI 连接内置 Capability 中的 `http://pragma.invalid/builtin`**：该地址是产品目录占位元数据，实际执行通过 Host binding 和 Execution Gateway 装配。

### 10.2 现有代码已经分成四层

| 层                 | 当前事实与证据                                                                                                                                                  | 迁移处理                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 工具协议与 handler | `pragma-host-management-tools.ts` 内 Schema.parse、分页/正文范围、Flow 字符串恢复、compact summary、output 校验和 management-error 都已实现；handler 调用 ports | 初期原样复用，保留测试，不为 CLI 复制转换和诊断逻辑                                   |
| 执行管道           | Core `executeExecutionTool()` 包含 ownership 检查、审批、before/after hooks、日志和 Host result observation                                                     | CLI 自动化调用同一管道，不直接裸调 tool.call                                          |
| Host 业务          | Desktop project adapter 持有草稿文件、冻结快照、Project 事务、锁、journal 和 receipts；Automation adapter 持有 Host binding 与幂等操作                          | 按需要机械提取到 Local Host，保留算法、存储格式和现有业务测试；Desktop 留资源 adapter |
| 产品说明与发现     | 现有 author-pragma-dsl 把 Expert/Team、Flow、Evaluation、Automation 混在一个 Skill 中，且正文调用旧工具名                                                       | 分拆为六组 Skill，按阶段替换操作入口，所有 Skill 继续由 Built-in Agents 静态打包      |

现有 [工具测试](../../packages/built-in-agents/test/pragma-host-management-tools.test.ts)覆盖 Mission scope 注入、operation ID、审批 metadata、文件草稿约束、compact review、Flow/Evaluation 独立准备、增量输入校验和分页。

[Desktop project adapter 测试](../../apps/desktop/src/main/features/built-in-agents/pragma-agent-project-adapter.test.ts)进一步覆盖真实临时目录/Project store、原子冻结、并发冲突、未知字段保留、幂等发布、commit/discard journal 恢复、路径安全、Flow 合约和 Evaluation。不能只保留前一层 mocked ports 测试后宣布业务回归完成。

### 10.3 建议的执行架构

```text
Built-in Agents：六组 Skill + 现有管理工具 definitions/handler/Schema/ports
                         ↑ 允许的 package 依赖
Local Host：静态命令映射、授权、scope、operation identity、Host composition
                         ↓ 通用执行能力
Core：executeExecutionTool + Execution Gateway 的隔离与生命周期
                         ↓
现有 Host ports / 逐步迁入 Local Host 的 Host 用例
                         ↓
Project / Draft / Mission / Automation 的原持久化实现

Agent → 按需读取 Skill → Runtime 进程工具 → CLI client
                                             ↓
                                  当前 Host 的受控调用通道
                                             ↓
                                   上述同一条执行链
```

建议 Local Host 增加一个窄的管理 command application，职责限于：静态 `group + action -> canonical tool name` 映射、查找授权后的 handler、绑定当前 scope、通过 Core 管道执行、转换 CLI wire 输出。以下接口名是设计示意，实施 ADR 再定稿：

```ts
management.describe({ group, action }); // 按子命令取得帮助，不把全目录给模型
management.execute({ group, action, input, requestId });
```

身份、批准状态、runContext、executionContext、scope 和 Host ports 由可信 Host composition 提供，不是上述业务 input 的自报字段。入口只支持本计划中的静态管理命令，不提供任意工具代理、任意 Host service 查找或新插件 registry。

CLI 输入适配优先保持现有参数对象结构：例如 `pragma flow draft update --input operations-request.json --format json` 的文件承载完整 `draftId + expectedDraftRevision + operations` 对象，由原 handler 校验；少量标量可提供 flags。不要为全部嵌套字段发明第二套命令语法。每个子命令展示自己的帮助与例子。

### 10.4 MCP 可以复用，但要拆开模型可见目录与 CLI 调用通道

现有 [Execution MCP Gateway](../../packages/core/src/expert-tools-mcp-server.ts)已提供本地 listener、不可猜测的 Session 路由、隔离、注销和 `executeExecutionTool()` 调用；[Core tests](../../packages/core/test/expert-tools-mcp-server.test.ts)验证隔离、撤销、名称限制和 Human checkpoint。适合复用这些机制及 MCP client/transport。

但当前 `createExecutionLocalTools()` 从 `resolveExecutionTools(agent)` 取得工具，注册的工具也全部进入 toolCatalog。因此存在两个问题：

- 从 agent.tools 移除某个工具，会同时让当前 Gateway 无法再调用它。
- 把全部工具留在同一个提供给 Runtime 的 MCP endpoint，原生 Runtime 仍可能通过 tools/list 加载全部 Schema，启动开销没有真正消失。

推荐复用 Gateway 的 listener/隔离/销毁机制，为 CLI 提供**静态、单独授权的调用通道**，该通道不加入原生 Runtime MCP 配置，也不进入 Pi customTools。Core 只接受通用的执行工具与生命周期端口，不认识 Pragma 命令分组；分组与授权归 Local Host。

这里要分别表达模型可见工具、Host 授权的 CLI 操作和明确拒绝的操作。移除 Schema 可见性不等于撤销该组 CLI 操作授权；反过来，既有 deniedTools、Capability/资源范围与 owner 约束也不能通过 CLI 绕过。授权集合来自 Host 的显式配置与原有效策略，不以“拥有一个 Skill”自动授予全部管理权限。

Pi 当前只有 MCP registry lease，没有本地 Runtime 那套 HTTP Gateway registration。受控 CLI 通道必须由共享 Host/Execution 生命周期装配，覆盖 Pi 和各本地 Runtime，不能只复用某个 Runtime 私有 MCP URL。沿用进程内 Host，不新增 daemon；恢复时重新注册、轮换并撤销凭据，Context/Invocation 切换后重新验证调用归属。

CLI 凭据只通过受控进程环境或私有启动配置交付；不写进 Skill、模型提示词、命令参数或诊断正文。其他 Context、过期 Execution 与无权限命令必须在 Host 入口拒绝。

### 10.5 包装 CLI 时必须补齐的五个差异

1. **审批在外层。**管理工具 `approval` 是 metadata；`tool.call()` 本身不会执行审批。CLI 必须经 `executeExecutionTool()`，并传入当前 Host humanInteractionHandler 与 ownership context。测试须证明拒绝后没有进入端口 mutation，不只断言 approval 字段存在。
2. **operation identity 不能直接用新 MCP 连接的请求序号。**当前 Gateway 以 `String(context.mcpReq.id)` 作为 toolCallId，管理写操作再用它作 operationId。多个短命 CLI client 可能重复同一个 MCP 请求序号；这不是全局唯一的业务操作 ID。CLI 使用稳定 requestId，Host 校验作用域与 payload，并绑定到原 receipt；同请求重试复用，不同操作不碰撞。传输 ID 与业务 ID 分开，不能只把 argv 中的 ID 当身份凭据。
3. **错误不是都在 structuredContent 中。**当前 Gateway 的 `toCallToolResult()` 在 `isError: true` 时不返回 structuredContent；management-error 位于 text JSON，而且外层 Host hint 可能追加展示文本。CLI 专用通道应在成功和错误时都保留 handler 的结构化 details，按权威 Schema 解码，保留 code、retryable、details、recovery；不靠截取展示文本恢复业务协议。这个变化限于新 CLI 通道，避免顺带改变已有 Runtime 的 MCP 结果语义。不能把 JSON.stringify 后的错误交给一般异常消息分类而丢失语义。
4. **调用成功不代表业务验证通过。**prepare 的 `status: "invalid"` 和 Evaluation 的 `suite.passed: false` 可以是正常结构化结果，不一定有 `isError: true`。CLI 在 presenter 层定义明确退出码，同时完整保留原 diagnostics/case results；不修改原 handler 的业务结果。
5. **Human checkpoint 与取消是控制信号。**Gateway 当前专门重抛 HumanInteractionCheckpointError，不能包装成普通 internal_error 后让 Agent继续提交。CLI/Host 需把等待、拒绝、取消和已提交结果回传原 Execution；中断 CLI 不回滚已持久事务，下一次通过 receipt 恢复。

现有 CLI 的 [错误转换](../../apps/cli/src/commands/errors.ts)未完整映射 management-error 的 revision_conflict、response_too_large 等分类。转换应放在共享 Host wire 边界，显式映射到 Shared integration error/现有退出码，并保留原管理诊断；新增或改变 wire 语义按版本规则治理。

### 10.6 哪些源码移入 Local Host，哪些保持原位

| 内容                                                                           | 最小回归做法                                                            | 最终归属                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------- |
| 现有工具名称、描述、输入输出 Schema、摘要与 ports 调用 handler                 | 保留已有 factory，不为 CLI 改名或重写；CLI 名称通过静态映射转译         | Built-in Agents，跨 Host 的产品工具定义与薄适配 |
| CLI command application、身份/资源授权、operation identity 与通道装配          | 小范围新增，进入原 Core 执行链                                          | Local Host                                      |
| argv、文件/stdin、JSON presenter、TTY、退出码                                  | 在现有 CLI adapter 上扩展，复用现有 Shared wire                         | apps/cli                                        |
| Desktop 中的文件草稿、prepare/commit、journal、幂等和 Automation Host 业务     | 保持原算法提取；只将 Desktop 具体依赖替换成窄资源端口，原测试随业务移动 | Local Host 与原领域包                           |
| Capability/Runtime 选项、系统 Expert 目录、平台 binding policy 与 Electron/IPC | 给共享用例提供具体资源端口，不把 Desktop policy 下沉                    | Desktop composition/平台 adapter                |
| 六组 Skill 正文、references、metadata 和静态注册                               | 拆分现有 Skill 内容，不重写领域操作规则                                 | Built-in Agents；Desktop 只读展示               |
| Knowledge/Skill Revision Agent 的现有工具                                      | 本次不动，保留 factory 的这部分和原测试                                 | Built-in Agents                                 |

尤其不能直接搬整个 `pragma-agent-project-adapter.ts`：它导入 Desktop 的 CapabilityStore、RuntimeEnvironmentService、系统 Expert registry、PragmaProjectStore、平台 bound-resource policy 和文件物化 helper。Local Host 必须通过窄端口接收这些资源；不允许搬家后从 Local Host 相对导入 apps/desktop。

Host 业务提取采取“原语义搬移”，不顺便调整 Schema、文件路径、状态机、锁粒度、journal 阶段、分页规则或错误码。先在受控 Agent CLI 通道复用当前端口，再在同阶段完成该组所需 Host 用例共享；用户直接运行 CLI 不得通过导入 Desktop 源码获得能力。通道复用是降低改动面的实施顺序，不是永久保留 Desktop 业务副本的理由。

### 10.7 最终一组工具一个 Skill：六组映射

| 工具组                   | 工具数 | 唯一内置 Skill                                | 实施阶段 |
| ------------------------ | -----: | --------------------------------------------- | -------- |
| Flow draft               |      6 | author-pragma-flow                            | 一       |
| DSL authoring 与公共提交 |     14 | author-pragma-dsl（迁移现有 Skill，收窄用途） | 二       |
| Evaluation draft         |      7 | author-pragma-evaluation                      | 二       |
| Mission 管理             |      7 | manage-pragma-missions                        | 三       |
| Host 资源发现            |      4 | discover-pragma-resources                     | 三       |
| Automation               |      4 | manage-pragma-automations                     | 三       |

共 42 个工具、6 个 Skill。共享 CLI 命令可以被多个工作流调用，但只有一个实现和一份权威帮助。例如 Flow Skill直接调用公共 `pragma dsl changes commit`，无需加载整个 DSL Skill；不复制另一个 Flow 专用 commit handler，也不重复默认注入公共命令 Schema。

一个 Skill 是一组能力的操作入口，不是一个工具一份 Skill。每个 Skill 的 SKILL.md 保留发现、最小完整流程和关键治理规则；具体参数/例子放在该组 references 和子命令 help。

现有 `author-pragma-dsl` 必须同时迁移这些内容：

| 现有内容                                                                      | 迁移处理                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| SKILL.md 的 Expert/ExpertTeam、资源 ID、options、文件草稿与公共提交           | 保留在 author-pragma-dsl，替换成 CLI 命令；第二阶段收窄 frontmatter 触发范围     |
| references/expert.md、expert-team.md、avatars.md、resources-and-references.md | 归 DSL Skill；其中资源引用是 DSL ref 规则，不与 Host 资源发现混淆                |
| Flow 步骤、references/flow.md、flow-patterns.md                               | 移到 author-pragma-flow，第一阶段完成；原 Skill 不保留第二份 Flow教程            |
| Run Dry 步骤、references/run-dry.md                                           | 移到 author-pragma-evaluation，第二阶段完成                                      |
| Automation 步骤、references/automation.md                                     | 移到 manage-pragma-automations，第三阶段完成                                     |
| agents/openai.yaml、Skill Capability DSL、Pragma Skill 引用                   | 随对应阶段更新 description/default_prompt、索引与编译闭包                        |
| builtin.ts 中单一 Skill 前缀及 builtin.generated.ts                           | 改为明确的静态 Skill 清单与依赖闭包，继续使用既有生成机制；新增目录必须打包/物化 |

保留现有 author-pragma-dsl identity，不同时留下旧大 Skill 与新 Skill 两套冲突指引。每阶段只改变已经迁移的分支：第一阶段迁走 Flow，第二阶段迁走 Evaluation 并更新 DSL，第三阶段迁走 Automation。保留 Expert/Team 文件草稿、未知字段治理、Flow/Evaluation 独立提交等操作规则，不借迁移降低验证要求。

六个 Skill 均遵守第 3.4 节的系统所有权与只读展示；新增 resource discovery Skill 是本次补充要求对原五 Skill 方案的修正，不影响三阶段工具数与收益排序。

### 10.8 最小新增回归面与测试复用

| 验证层          | 复用内容                                                               | 新增验证范围                                                                                                     |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| handler/协议    | 保留 Built-in Agents 工具测试与 fixtures                               | CLI 静态映射、参数对象/文件/stdin 转换；不为每条业务规则再写一套 CLI 测试                                        |
| Host 事务       | 原 project adapter、Automation、Mission、锁/journal/历史 fixtures 测试 | 必要业务搬移时原断言随代码迁移，新增端口接线与两端真实 composition 契约                                          |
| Core 执行与 MCP | 原 approval、Gateway 隔离/撤销/Human checkpoint 测试                   | CLI 专用通道不进入模型 tools/list/config；原 denied policy、ownership、scope、审批拒绝、凭据撤销和稳定 requestId |
| CLI adapter     | 现有 argv/input/presenter/error/exit-code 框架                         | 代表性复杂 operations、Unicode/大文件、stdin、error text decode、validation-failed 退出码与诊断保留              |
| Skill/产品      | 现有 builtin 编译/物化、技能目录/详情测试                              | 六组映射、reference 链接、产物完整性、旧工具指令消除、可查看与 UI/IPC 拒绝写入                                   |
| 真实系统        | 现有 Host 业务与 Runtime probes                                        | 每阶段真实 CLI 子进程 + 当前 Execution + 临时存储路径的代表性成功/拒绝/冲突/恢复流程，及真实模型任务验收         |

采用以下实施顺序降低定位成本：

1. **先冻结行为。**记录原 handler/Host 的输入、输出与状态变更，以及已有测试门禁；任何只搬代码的提交只改路径/端口接线，不改断言证明的业务语义。
2. **再接薄 CLI。**静态命令映射保留原 input 字段和结果 payload；代表性夹具对比工具入口与 CLI adapter 的请求、业务结果、diagnostics、receipt 和存储结果，仅归一化时间/随机 ID 等已明确非业务字段。不保留两套业务实现做长期对照。
3. **验证新边界。**用真实 CLI 子进程走授权通道，覆盖审批拒绝后零写入、两个独立 CLI 请求序号相同但 operation 不碰撞、原 requestId 重试、跨 Mission/Context 拒绝、撤销、取消与 Human checkpoint。
4. **迁移 Skill。**更新现有内容和静态索引，验证工作台只读及 references；模型真实完成整组任务后再删除该组默认 Schema 注入。
5. **最后清理。**删除已无调用方的旧默认入口和指令；专门 Revision Agent 与支持窗口内配置仍使用的定义不能按文件名一并删除。

建议每阶段按“接线/必要机械搬移 → CLI adapter → Skill 与默认注入切换”组织可审查提交，不要求拆成额外迁移阶段。业务搬移时运行原业务 suite；之后若没有新的业务变化，只补新边界和相应真实流程，避免每个 CLI 子命令重复构建一套全领域回归测试。仍须完成仓库已有强制共享 Host、Desktop adapter、lint/typecheck/build 与发行门禁。

### 10.9 本补充对原计划的具体收敛

- 三阶段范围和工具数量不变，最终 Skill 从五个明确为六个，Host 资源发现独立成组。
- 第一阶段以复用 `createPragmaManagementTools` 和 Core 执行管道为起点，不以整包源码搬家或重写领域服务为前置条件。
- Host 业务按依赖提取，测试随业务移动；通用工具 handler 和 Skill保留在 Built-in Agents，不造成反向依赖。
- 默认 Schema 移除前，必须证明 CLI 专用通道与模型可见目录分离，审批、operation identity、Human checkpoint 与诊断均保持完整。
- 实施 ADR 需定稿受控 CLI 分发和专用通道接线；原默认能力切换只在这些门禁通过后进行。
