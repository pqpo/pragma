# Flow 范式

当前 Flow 是持久化、可恢复的顺序控制流。范式使用现有 step、route、repeat 和 HumanTask
组合，不新增另一套运行时快捷 API。

## Prompt Chain

用普通 transition 串联步骤，输出通过 `save: state.*` 保存，后续步骤通过 `$state.*` 显式读取。
所有节点都必须从 start 可达，最后一条边明确 end 或 fail。

## Routing

分类节点输出稳定字段，route transition 按值选择分支。必须提供 fallback，避免未知分类在运行期
才暴露。各分支最终独立 end 或 fail。

## Evaluator Optimizer

optimizer 生成候选，evaluator 输出 accepted/revise。accepted 结束；revise 使用具名 repeat 回到
optimizer。Loop 必须声明正整数 maxIterations，onLimit 必须离开循环区域。

## 暂不支持的范式

Parallel 和 Orchestrator Workers 需要 fork/join、并发 Invocation、合并、取消与恢复协议。当前
调度器逐节点推进，不能把普通分支描述为并行执行；在相应 ADR 和运行时能力完成前不提供这两类模板。
