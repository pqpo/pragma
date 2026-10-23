# Expert Protocol

ExpertSession 是单专家和专家团唯一的外部交互入口。`prompt()` 未传 requestId 时由 Core 生成，
最终 ID 通过 `ExpertTurn.requestId` 返回；调用方也可以显式传入持久化 requestId。相同 requestId
与相同载荷返回原 ExpertTurn，不同载荷返回冲突。

enqueue prompt 使用 FIFO 队列。steer 只面向当前运行中的根 Turn；Runtime 没有声明并实现安全
steer 时必须拒绝。`abort()` 取消当前 Turn，`close()` 取消整个 Session 及所有 Runtime context。

普通 Expert 可以显式注入 `createAgentLauncher().tools`，ExpertTeam 则按 coordinator、成员和
权限策略自动生成相同的六个 Expert 生命周期工具。spawn/followup 在当前 Execution 中创建子
Invocation；内部 Invocation 可观察但不可直接提交外部 prompt。Context ID 表示 Session 内可复用的
会话，AgentInstance 属于单次 Execution，Invocation ID 表示一次任务；wait 始终按 Invocation ID 工作。

coordinator 在当前 Team Execution 内拥有系统继承的管理权限：可以委派给全部 members，发现全部
AgentInstance 及其指派关系，并对其 follow-up、steer 或 interrupt；wait 仍只接受当前任务直接创建的
Invocation。管理权限不由 DSL 权限矩阵撤销。`delegation.permissions.spawn` 和 `permissions.interact`
只控制成员之间的创建与交互；默认不开放 peer interaction，也不会隐式授予成员 interrupt。

每个 agent 同时最多运行一个 Invocation，不同 agent 受树级 `maxConcurrency` 约束并行运行。
父 Invocation 只有在所有直属任务都被 join 后才能终态；遗漏显式 wait 时由 Core 自动等待并续跑综合。

工具内部统一使用 `{ content, isError?, details? }`，`content` 是带类型的内容块数组，包含模型需要的完整结果，`details`
保留给 Host、程序调用和观测。六个生命周期工具保留结构化 `details`，结果顶层 `message` 说明
本次操作的含义与后续动作。Pi 与面向模型的 MCP 网关使用 Core 的统一正文投影，不向模型发送
`details` 或额外的 `structuredContent`；Pi SDK 的 `details` 仍保留为 Host/UI 元数据。
Runtime 工具事件写入历史时，文本与图片保留为原生内容块，`details` 单独保存在消息元数据中，
不能将完整工具结果对象再次序列化进正文。Memory attention 和工具辅助 Evidence 也只提取正文；
attention 优先使用文本与资源文字，媒体仅保留类型或资源引用，避免编码字节消耗观察预算。

外部 MCP 的标准 `structuredContent` 进入 Core 时映射为 `details`。仅有结构化结果时将其作为正文；
结构化结果未出现在正文中时补充一个文本块，已有等价 JSON 时不重复。MCP 内容块在执行层保留
文本、图片、音频、资源与注解，禁止把完整 MCP 协议响应序列化为模型正文。Pi 原生传递文本与图片，
其他内容类型在 Pi 适配边界转为带类型说明的文本并记录 `runtime.tool_content_degraded`。日志等字符串
消费方显式提取文本，Host 提示追加为独立文本块；已有持久化消息 Schema 不随执行期工具合约改写。
面向模型的 MCP 网关不声明要求重复结构化输出的
`outputSchema`，但仍在 Host 内校验原工具的输出 Schema。程序专用 MCP 服务保留标准协议。

`spawn_expert` 与 `continue_expert` 的 `status: queued` 是受理回执，不是完成结果，也不是返回时
任务仍未开始的实时保证。保存 `contextId` 用于相关后续工作，用本次新建的 `invocationId` 调用
`wait_experts`。工具结果省略内部 `agentId` 和 `agentDisposition`；执行、审计和恢复记录仍保留它们。

`wait_experts` 仅接受当前任务直接创建的 Invocation。`completed` 包含所有终态，并不代表全部成功；
必须检查各任务的 status、output、error。返回保留等待条件和时长、任务时间、usage、等待原因、最近
活动、完整输出或输出引用与错误诊断。pending 可能排队、运行或等待人工输入；等待超时不取消任务，
也不证明任务失败。超时或活动过旧/缺失本身不足以中断任务；继续 wait 收集结果，需要纠正方向时
steer，有明确取消意图时 interrupt。引导受理不代表已应用或任务完成，`already_terminal` 也不代表成功。

目录保留专家身份、Context、任务摘要、权限和分页/截断标志。可见性不授予操作权限；多个 Context
即使 expertId 相同也不是同一段工作，必须按准确 contextId 继续。生命周期结果精简不改变持久化协议。

ExpertTeam 的根 Invocation 代表团队，由 coordinator 执行。团队运行时的权限策略必须覆盖
参与者自己的 standalone launcher，成员不能借独立 launcher 绕过团队边界。
