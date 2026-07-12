# Expert Protocol

ExpertSession 是单专家和专家团唯一的外部交互入口。`prompt()` 必须携带持久化 requestId；
相同 requestId 与相同载荷返回原 ExpertTurn，不同载荷返回冲突。

enqueue prompt 使用 FIFO 队列。steer 只面向当前运行中的根 Turn；Runtime 没有声明并实现安全
steer 时必须拒绝。`abort()` 取消当前 Turn，`close()` 取消整个 Session 及所有 Runtime context。

ExpertTeam 的根 Invocation 代表团队，由 coordinator 执行。成员只能通过团队委派工具接收任务，
内部 Invocation 可观察但不可直接提交外部 prompt。
