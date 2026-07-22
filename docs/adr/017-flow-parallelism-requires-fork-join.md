# ADR 017: Flow 并行范式必须建立在持久化 Fork/Join 协议上

## 状态

Accepted

## 决策

当前 Flow 只承诺逐节点推进。Prompt Chain、Routing 和 Evaluator Optimizer 使用现有
transition、route 和 repeat 表达；不提供声称并行的 Parallel 或 Orchestrator Workers 模板。

实现并行范式前必须先定义并验证：

- fork 创建的子 Invocation 集合、稳定 branch ID 和并发上限；
- join 的 all/any/quorum 策略、结果顺序和 reducer 幂等性；
- 分支失败、取消、超时及剩余分支的处理；
- 进程重启后已完成和运行中分支的恢复规则；
- 动态 worker 输入的有界数量、预算和审计关系。

这些状态必须随 Execution 持久化，不能藏在进程内 Promise 或 Task handler 中。完成协议、存储
schema、恢复测试和治理规则后，再为 Parallel 与 Orchestrator Workers 增加 DSL 或公共 API。

## 后果

现阶段文档和 Default Agent 只能推荐三类顺序可表达范式。需要并发的调用方必须使用已有、明确
受治理的 Agent delegation，不能把它描述为 Flow 原生并行。
