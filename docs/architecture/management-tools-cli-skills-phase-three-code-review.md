# Issue #368 第三阶段 Code Review 与修复复核

2026-10-09。审查基线 `ecd5989c`（本次工作开始时的远程 main），被审查提交截至
`f70b816b`，包含第三阶段迁移、统一 manage 命名空间、Skill 合并及删除未发布兼容。
审查对象是运行代码、接线、Skill/DSL、回归和当前架构说明；历史 Runtime 证据用于核对
已记录事实，不作为本次修复的新执行证据。

## 已确认并修复的问题

### P1：Automation 重放可能删除新 generation 已接受的状态

原位置：`automation-service.ts` 的 save/reset apply 清理块。计划先保存新 binding，
然后整目录移走 `automationStateRoot(ref)`，最后记录 `cleaned`。如果在文件移动之后、
进度落盘之前中断，新 generation 可以在原路径接受队列；恢复再次移动整个目录，会
删除新队列。该目录也包含 Automation aggregate lock，整目录移动不适合与状态写入并发。

复现：真实 CLI/Host/Project/AutomationStore 集成，在 reset 绑定落盘和清理后分别注入
中断，模拟外层 pending receipt；在重试间向新 generation 接受一条队列事件，再用同一
requestId 恢复。修复前成功返回，但 queue 从一条变成空数组，断言失败。

修复：AutomationStore 的 `retireGeneration(ref, generation)` 在现有 aggregate lock 内
读取权威状态，只有文件仍属于计划中的旧 generation 时才移走 `state.json`；保留锁文件
及其目录。若旧文件已移走或新 generation 已写入，则跳过清理。save/reset 共用该存储
操作，继续使用原 trash transaction 与 mutation progress，不增加 owner/consumer、状态
版本或第二份调度实现。复核：旧状态清理、绑定恢复、相同 requestId 重放、新队列保留及
历史 Mission 保留均通过集成测试。

### P2：命令端口包装丢失原型方法

原位置：`management-commands.ts` 的 Mission/Automation commandPorts。用对象展开
包装端口只保留 enumerable own properties；接口允许类实例或其他原型方法实现，这些
端口的 list/get 等方法会丢失。方法内部使用 this 时，也必须保留原 receiver。

复现：将真实 Mission 与 Automation port 的方法放到原型，并让 list 验证 receiver，
通过真实 CLI 分别调用 mission.list/automation.list。修复前第一条返回 failed。

修复：按端口接口显式转发全部方法，调用原端口的方法以保留 receiver；修改类命令仍保留
原 IntegrationError 捕获，不改变授权/审批。新增集成回归通过。

## 复核结论与验证

本轮两项发现均先复现失败，再修复并复核，没有因修复降低成功断言或改成容许失败。

- Desktop：4 文件、73 项通过，覆盖命令通道、15 条第三阶段操作、只读 Skill 目录、
  原型方法、Automation 调度、发布/绑定/清理恢复和 Mission 历史保护。
- 最终原型端口与清理后恢复的两条定向回归分别再次通过。
- Local Host mutation runner：1 项通过；Local Host lint/typecheck/build 通过。
- Desktop Node typecheck 与修改文件 ESLint 通过。
- 根级 `pnpm check` 通过：19 lint、19 typecheck、11 test:core tasks；不把 fast tests
  当作此前完整共享 Host 门禁的替代。
- 更新后的 Desktop production build 通过；main/preload/storage-worker/样式验证通过。

另核对：管理命令只在 `pragma manage` 下路由；用户 Mission/Flow 入口保留；默认管理
binding 的 `tools: []` 仍保留 hooks/grants；六组详细指引只来自一个只读 manage-pragma
Skill；旧五个 Skill ID/定义和多绑定兼容已删除；Mission/Automation 仍调用共享用例，
没有新 owner/consumer；本轮未修改持久化 Schema。

此次 CR 未发现其他有足够证据确认的新增问题，不等于证明不存在未知缺陷。前次报告的
共享 Host 完整门禁 baseline 失败、Runtime/额度、签名发行、Windows 和真实模型审批/
恢复等未完成项继续保留。本轮没有重跑所有真实 Runtime 或发行矩阵，不以此关闭 Issue。

## PR #375 评论复核与修复

读取 PR 的全部会话评论、review 和行内线程：两条会话评论、一份 review、一个行内线程，
分页均已结束。自动审查行内意见与人工复核第一项为同一问题；去重后两项实质意见均已
通过真实 Project/AutomationStore/Local Host port 复现，采纳修复。

1. [保存恢复缺少当前资源校验](https://github.com/pqpo/pragma/pull/375#discussion_r4231333125)：
   首次创建已经发布但未写 binding，后续删除，再重放旧 save，会恢复孤立 binding。
   现在读取历史 publication 内该 Automation 的实际内容，并与当前权威目标比较；已删除
   或修改时返回 `COMMAND_REJECTED`，先于 binding/清理/调度副作用。按资源内容比较，
   不要求整个 Project head 等于原 publication；无关 Expert 更新仍可正常恢复。
2. [reset 使用旧资源调度与返回结果](https://github.com/pqpo/pragma/pull/375#issuecomment-6083335444)：
   pending reset 写入新 binding 后，Project 将资源禁用并重新 reconcile；旧实现重放旧
   enabled 快照，恢复了 nextRunAt，并返回过时 summary。现在保留 journal 中的稳定
   binding/generation，但调度和 summary 读取当前权威资源；目标已删除则在写入 binding
   前拒绝，不再执行清理和调度。

新故障回归五场景：save 后删除、修改目标、修改无关资源；pending reset 后禁用、删除。
修复前四项因错误行为失败，无关更新恢复原本通过；修复后五项全通过。reset 已删除
分支验证 binding 写入次数为零，权威 state 文件字节不变。没有修改持久化 Schema、
放宽授权或恢复旧 Skill 兼容。原未完成门禁继续保留。

本轮最终验证：Desktop 相关四文件 78 项通过，根级 `pnpm check` 通过；更新后的 Desktop
production build 及 main/preload/storage-worker/样式验证通过。未重跑真实 Runtime/发行
矩阵；它们的既有验收缺口没有变化。
