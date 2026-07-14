# Expert Protocol

ExpertSession 是单专家和专家团唯一的外部交互入口。`prompt()` 未传 requestId 时由 Core 生成，
最终 ID 通过 `ExpertTurn.requestId` 返回；调用方也可以显式传入持久化 requestId。相同 requestId
与相同载荷返回原 ExpertTurn，不同载荷返回冲突。

enqueue prompt 使用 FIFO 队列。steer 只面向当前运行中的根 Turn；Runtime 没有声明并实现安全
steer 时必须拒绝。`abort()` 取消当前 Turn，`close()` 取消整个 Session 及所有 Runtime context。

普通 Expert 可以显式注入 `createAgentLauncher().tools`，ExpertTeam 则按 coordinator、成员和
allowlist 自动生成相同的五个 Expert 生命周期工具。spawn/followup 在当前 Execution 中创建子
Invocation；内部 Invocation 可观察但不可直接提交外部 prompt。Agent ID 表示可复用的执行线程，
Invocation ID 表示该线程上的一次任务，wait 始终按 Invocation ID 工作。

每个 agent 同时最多运行一个 Invocation，不同 agent 受树级 `maxConcurrency` 约束并行运行。
父 Invocation 只有在所有直属任务都被 join 后才能终态；遗漏显式 wait 时由 Core 自动等待并续跑综合。

ExpertTeam 的根 Invocation 代表团队，由 coordinator 执行。团队运行时的 allowlist 必须覆盖
参与者自己的 standalone launcher，成员不能借独立 launcher 绕过团队边界。
