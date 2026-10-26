# Issue #434 CR 与复审

日期：2026-10-26。范围：当前工作区的第一阶段直接 Revision 提炼重构，包括 Desktop 装配、Knowledge/Skill 调度与恢复、提交回执、历史任务观察和 Evidence 来源隔离。

## 已确认并修复

| 级别 | 问题与触发条件                                                                                                     | 修复与复审证据                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | 使用 `draftId` 续改已有资产时，原生结果没有 `creation`，记录目标会空引用。已有草稿的 job/source 元数据也没有更新。 | 从已验证归属的草稿恢复目标和 operation，更新草稿记录。经过真实 Interpreter 编译的 Knowledge 续改与 Skill 草稿恢复用例通过。                             |
| P1   | 续聊忽略返回的 execution ID，投影尚未更新时可能结算上一轮终态；并发观察也可能重复发出续聊命令。                    | 持久化并绑定预期 execution ID；续聊准备和投递使用 admission 锁；回执恢复与结算使用状态锁并检查退役及执行身份。延迟投影、重启观察和并发 claim 回归通过。 |
| P1   | 原生 Revision 的 list/get/inspect 读取失败没有进入失败记录，可能被结算为“无变更”。                                 | 将原生读取抛错及 `isError` 纳入持久失败记录，同一工具成功读取后解除。Knowledge/Skill 原生读取失败均不能产生成功的无变更回执。                           |
| P2   | 权威服务已提交草稿但响应丢失后，再次 submit 会重复调用提交服务。                                                   | 先检查权威提交状态，从草稿检查结果恢复标准回执并保存。Knowledge/Skill 丢失响应后的重试均只调用提交服务一次。                                            |

同时收紧了退役记录的观察资格、缺失 Mission 的观察隔离，以及工具 binding fingerprint 的描述、输出 Schema 和审批字段。没有修改既有权威 Schema、历史迁移链或人工发布入口。

## 验证

- `pnpm test:revision`：318 项通过；定向筛选另有 74 项未运行，不计为通过。
- 集中回归四个文件：56 项通过，覆盖 executor、历史 observer、learning revisions 和 Mission system resources。
- 对关键修复进行临时反向验证：7 个定向用例中 6 个按预期失败，覆盖上述四类问题；验证结束后恢复修复源码。
- 恢复修复源码后，executor 的 20 项回归再次全部通过；`pnpm test:core` 四个任务通过。
- Desktop main TypeScript 与变更文件 ESLint 通过，`git diff --check` 通过。
- 新增回归已处于 `scripts/run-business-tests.mjs` 的 Desktop 业务选集。

本次 CR 确认的上述问题已修复。这个结论限定于已审查代码和列明的回归范围。

## PR #437 评论复核

完整读取两条行内意见、一条 review 和两条普通评论。自动审查与人工复审确认了相同的两个恢复缺陷；两项均需要修改。executor 按职责拆分属于非阻塞建议，本次只将旧注册身份管理提取为独立内部模块。

- 一个 Expert 的 job 级观察状态会拒绝后续 Expert 首次执行：Knowledge/Skill 现按具体 Expert/来源的 admission 事实判断，并要求原任务执行索引完整。部分记录缺失时，不用其他 Expert 的已完成回执放行。新增多 Expert 重启恢复与未知 owner 保护回归。
- 一个缺失的旧 Planner owner 会阻断所有来源：可读取的 Mission 首次访问时原子保存来源身份；其后 owner 缺失仅影响对应来源。历史空标记不改写、不删除。已删除且无身份的标记无法恢复归属，调度器结合任务创建时间及执行历史放行可证明无关的新任务；可能受影响的旧尝试仍须关注，手动重试也不能自动替换未知 owner。

修复前，两个 Memory 多 Expert 用例和四个旧 owner 隔离用例均复现失败。修复后的验证覆盖重启、首次执行、手动重试、身份写入中断重建、未来版本拒绝及原空标记保留。

本次最终集中回归：Memory 两个文件 97 项、Desktop 两个文件 32 项通过，Memory/Desktop main/Local Host 类型检查及变更文件 lint 通过。新用例通过现有业务选集进入门禁。

`pnpm test:revision` 的依赖构建与 Built-in Agents 52 项通过，默认两个 worker 的 Desktop 阶段有五项 5 秒超时及超时后的临时目录清理错误。随后以单 worker、相同选集运行：Desktop 249 项和定向 Mission 17 项全部通过，74 项仍属筛选未执行。没有修改用例、成功断言或超时配置；默认命令的失败仍作为限制保留，不能把串行复跑称作该命令全绿。

另外复核了远端业务 CI 失败。完整本地 kernel 首轮运行 1307 项，1300 通过、2 跳过、5 失败：M10、Core acceptance recovery、terminal fencing 各一项超时；两个交互式 Revision 捕获用例没有提供来源判定所需的权威 job。为捕获用例补齐真实 Schema 校验的 owner 输入，保留原成功断言，并增加 owner 缺失时暂停、恢复后继续和旧自动来源排除场景。随后单 worker、文件串行重跑上述失败文件及来源判定文件，共 47 项全部通过。没有改变超时、删除用例或放宽断言。补齐夹具后没有再次运行整个 kernel，不能将此次串行复跑写成全量门禁通过。

## PR #437 新增自动重试意见

新增评论 `6417234895` 指出的自动重试分支遗漏属实：A 的可重试失败沿 job 传给 B，使 B 的首次执行触发 executor 的缺失 owner 检查。Knowledge/Skill 现仅在当前 key 明确无 admission、且完整任务执行索引可证时清除该 key 的重试标志；未知或不完整的 owner 仍保留原保护。没有删除或放宽 executor 的缺失 owner 检查。

修复前，使用真实 Memory module、实际 direct executor 和 Interpreter 编译工具 binding，Knowledge/Skill 两个成功恢复用例均复现失败，两个缺失 owner 用例仍正确拒绝重投。修复后扩展为六个组合用例：两个种类各覆盖 A 原上下文重试后 B 首次执行、A owner 丢失、A 已完成但 B owner 丢失。六项均通过；整个 executor 文件 27 项与 Memory 两文件 97 项通过。Memory 构建、Desktop main 类型检查、变更文件 lint 通过。此组合回归使用测试 Runtime/应用适配，不属于真实模型验收。

## 未解除的验收限制

真实 Codex Runtime 在此前尝试中因 HTTP 401 未完成验收；本次没有重做真实模型质量验收。共享 Local Host kernel 的完整运行与串行复跑结果见上；本次没有修改共享 Mission 内核，也没有将先前失败或未执行项目算作通过。因此不能据此宣称全量门禁或真实模型质量验收完成。具体环境证据见 [阶段验收记录](issue-434-memory-revision.md)。
