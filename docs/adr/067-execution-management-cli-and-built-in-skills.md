# ADR 067：Execution 管理 CLI 与内置 Skill

日期：2026-10-08。关联：Issue #368。状态：默认 Flow Schema 已按 2026-10-09 用户授权切换，部分验收待手动测试。

## 决策

管理命令复用 Built-in Agents 的工具 factory、权威 Schema 与 handler。Local Host 拥有静态
command→tool 映射、授权、request identity、receipt 和共享草稿/提交用例；CLI 只适配 argv、
文件/stdin、JSON/text 与退出码。Desktop 资源目录、系统 Expert 和 binding identity 策略继续留在
Desktop，通过窄端口接入。原 Project adapter 集成 suite 保留，用真实 repository 验证机械提取。

Core 的 Execution Gateway 增加通用私有 command registration；复用原 listener、不可猜测的
Session 路由和销毁机制。私有 command 注册按 HTTP 请求隔离 stateless Server/transport，
防止不同 CLI 进程的 JSON-RPC request ID 冲突；HTTP/lease 关闭会取消对应调用。此注册不加入
Runtime MCP 配置或模型目录，Core 不知道管理命令分组。
Interpreter 允许 Host Capability contribution 提供生命周期 hooks；这些 hooks 不序列化进 DSL。

命令进入原 `executeExecutionTool()`，继承 ownership、审批、hooks、日志及结果 observation。
Core 保留独立的 executionToolApprovals，合并 Expert 声明、插件及原 handler 审批要求；
工具从模型目录隐藏不丢失这些要求。Shell 批准不能代替提交批准。新通道始终保留结构化结果和 management-error；原 Runtime MCP
错误编码不变。Human checkpoint 返回独立 `input_required` 控制状态，原 Execution controller
继续负责等待和停止 Runtime。CLI 不等待子进程 TTY，也不能自行批准提交。

Desktop 为内置 Pragma 显式配置本阶段十二个 CLI command grants，与模型可见目录分离；
Core 的 allow/deny policy 继续约束这些 grants。System Expert customization 按既有规则继承
默认产品能力；普通 Expert 不因绑定 Skill 或声明同名工具获得 grant。默认 Schema 切换后
仍须补齐历史配置及显式 allow/deny policy 的验收，不删除它们引用的旧 handler 定义。

凭据只交付到当前 Runtime 的受控进程环境；Mission ID、PRAGMA_HOME、工作区或 requestId 均不是
凭据。当前调用者的 Context/Execution/Invocation 来自可信 Host，不能通过 input 自报。
通道只在当前 turn 活跃时接受请求；恢复注册新路由，Session 关闭撤销原路由。

requestId 与 transport ID 分离；operation identity 按 Mission、Runtime Context 和 requestId
寻址，payload 冲突拒绝。receipt 保存原 Execution/Invocation，支持同 Context 后续 Execution
查询同一请求的结果。receipt、owner sidecar 和增量更新恢复 journal 放在 Core 提供的私有
system Session 根下，随既有 owner 图删除；不扫描宿主 Session 树。

Flow create/prepare 使用可信 operation identity 定位可恢复结果；update 在原 aggregate lock
中先写结果 journal 再替换 draft。提交复用 Project transactional publication identity，恢复
“发布成功但 receipt 未写入”的窗口。旧 handler 参数对象、草稿 Schema、revision、锁、Project
manifest 和已有 receipt 格式不变。

## 分发与 Skill

补充 ADR 042：公共 CLI 仍独立发布，Desktop 不安装它、不改用户 PATH。Desktop 另随应用构建
同源的轻量 command client，用 Electron 自带 Node 运行；开发版与发行版都使用这一构建入口。
client 自包含并从 ASAR 解包，launcher 仅加入当前 Runtime 的进程 PATH。新通道匹配独立
`pragma.management-command/v1` 协议；缺少入口、撤销或协议不兼容必须返回可操作诊断。

公共 `pragma flow draft …` / `pragma dsl …` 同样可进入受控通道。没有当前 Execution endpoint
时拒绝执行，不回退到独立用户 Host 的广泛权限。本次未交付 Desktop 关闭时的独立 Flow 编辑
composition；需要这一入口时继续复用共享用例，不从 CLI 导入 Desktop 源码。

Built-in Agents 的静态 Skill 注册表拥有 source、canonical ref、version、content hash 与文件
投影。Runtime 物化和工作台读取使用同一来源；用户 Capability 目录不是系统 Skill 的权威副本。
工作台复用原列表/详情/文件 DTO，系统 Skill 可查看但不可修改。Host store、IPC 和 Revision
service 同样拒绝系统 Skill mutation；Git 继续只接收用户 Skill。

第一阶段迁移 Flow 文档到 `author-pragma-flow`；保留 `author-pragma-dsl` identity 和其他阶段
尚未迁移的说明。新增索引只绑定默认 Pragma，不向所有 Expert 全量注入正文。

## 版本与 cutover 门禁

上述 command wire、request receipt、owner sidecar、Flow command mutation journal 是本改动
首次引入的独立 v1 family；没有替换既有生产协议或旧 owner 数据。未知版本 fail closed；未修改
DSL apiVersion、compilerVersion、Core storage major 或已有持久 Schema，因此没有跳过旧协议
迁移链。以后改变这些 family 的合法数据语义仍必须按仓库升级治理提供完整相邻迁移。

管理 Capability 定义和显式工具 binding 能力保留。原计划在真实 Runtime、分发和性能门禁
通过后再移除默认工具；2026-10-09 用户明确授权“可以直接移除，我再手动测试”，因此已移除
默认 Pragma 的六个 Flow 工具。Pi Keychain、Qoder 额度和性能证据等缺口保留在验收记录中，
不将用户授权切换等同于所有验收已通过。

验收与未完成项见[第一阶段实施报告](../architecture/management-tools-cli-skills-phase-one-implementation.md)。
