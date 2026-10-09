# Issue #368 第三阶段实施与三阶段验收结论

2026-10-09，基于远程 main `ecd5989c` 的独立 worktree 实施。完成剩余 15 个默认管理工具
迁移，Pi 默认工具 28 → 13。后续将六个 Skill 合并为一个 `manage-pragma`。
Issue #368 尚有未完成门禁，不以工具数量下降或静态估算宣称全部完成。

## 实施结论

- 迁移 Mission 7 项、Host 资源发现 4 项、Automation 4 项。三阶段共 46 条 CLI 命令：
  42 个迁移操作及 4 个显式恢复操作，全部使用 `pragma manage …`。
- 普通终端原用户 Mission/Flow 入口保留；管理命令目前仍要求 owning Execution endpoint，
  独立终端管理由用户推迟到后续阶段。复用原 handler、共享 Host 用例、受控通道、
  授权、审批和幂等恢复，没有新增 Mission owner/consumer 或第二份执行内核。
- 默认 management binding 保留 `tools: []`，确保默认不选择管理工具时 grants/hooks 和
  私有通道仍正常装配。保留两个 Revision 调用、显式 binding 和前两阶段工作流。
- Mission 创建固定业务身份，中断固定原 execution target；Automation 使用稳定 mutation
  plan、publication identity、generation 与清理进度恢复。既有持久化格式不变。
- 工作台与 Runtime 共用一个只读内置 Skill，六组详细规则在 references 中按需读取。
  用户确认尚未发布，旧五个 Skill 定义与兼容逻辑已删除。
- CR 与 PR 评论确认的四项缺陷均已复现并修复：新 generation 队列被重放清理、原型端口
  方法丢失、旧 save 恢复孤立 binding、reset 重放旧资源调度。

## 三阶段成本结论

静态计数采用 Core RuntimeTokenCounter/o200k_base、格式化 JSON 的逐工具参考口径。
以下 Skill 数量为各阶段测试时配置；最终产品只有一个 Skill。

| 阶段 | 移除默认工具 | Pi 数量 | 参考定义 tokens | Skill 数 |
| ---- | -----------: | ------- | --------------: | -------: |
| 一   |            6 | 55 → 49 |          13,065 |        2 |
| 二   |           21 | 49 → 28 |           7,083 |        3 |
| 三   |           15 | 28 → 13 |           3,972 |        6 |
| 累计 |           42 | 55 → 13 |          24,120 |        6 |

真实 Runtime 输入采用 reported input + cacheRead。before/after 是同一 CLI 工作流保留/
隐藏该阶段工具的探索性对照；缓存、模型行动、指令和并行负载没有完全控制，不可跨阶段
合并成收益百分比。Mission/Automation 数值不含子 Mission 用量。

| 阶段/场景                     | before 输入 | after 输入 | 原生调用 before → after | 耗时 before → after |
| ----------------------------- | ----------: | ---------: | ----------------------- | ------------------- |
| 一：聊天                      |      17,939 |     17,937 | 0 → 0                   | 见阶段一原证据      |
| 一：Flow                      |     110,348 |    117,731 | 37 → 41                 | 197.099 → 213.990 s |
| 二：聊天                      |      15,529 |     15,533 | 0 → 0                   | 16.463 → 10.498 s   |
| 二：Expert/Team               |     110,962 |    115,162 | 34 → 38                 | 144.021 → 152.380 s |
| 二：Flow                      |     120,018 |    129,300 | 41 → 41                 | 233.881 → 253.558 s |
| 二：Evaluation                |     111,844 |     92,454 | 40 → 43                 | 212.623 → 191.470 s |
| 三：聊天                      |      15,658 |     15,668 | 0 → 0                   | 12.565 → 14.666 s   |
| 三：Mission/Automation 父任务 |      70,187 |     72,213 | 31 → 46                 | 207.227 → 235.419 s |

结论：没有证明聊天或专业任务整体成本下降，性能 cutover 尚未验收。统一 Skill 索引
参考量从 206 降到 34 tokens，主 SKILL.md 含 frontmatter 为 499 tokens；这些静态值
不等于真实任务输入节省。

## 验证结论

- 最终 PR 评论修复后，Desktop 相关四文件 78 项、新增五个恢复场景均通过。
  Built-in Agents 68 项、CLI adapter 121 项、Revision 独立业务回归曾通过。
- 最终 `pnpm check`、Desktop production build 及 main/preload/storage-worker/样式检查通过。
- Codex 完成第三阶段 Mission/Automation 实际业务，以及 Flow、DSL、Evaluation 回归；
  合并 Skill 后的 mission.list smoke 成功。Claude Code、Antigravity、OpenCode 有成功
  CLI 通道验证；不将这些 smoke 等同于所有场景完成。
- macOS x64 未签名目录打包、ASAR 审计、打包后 management launcher help，以及公共
  CLI pack/audit 通过。合并前六 Skill 的真实 Electron 只读展示已验证；最终一个 Skill
  的目录、文件读取和拒绝写入由 Host 集成回归覆盖，未重跑其完整 UI 视觉检查。

## 未完成门禁

- 完整 shared Host gate：926 passed、1 skipped、2 failed；其中 cold Flow
  COMMAND_RESULT_TIMEOUT 在未修改 main 上复现。Desktop 完整 adapter gate 有三个超时，
  相关文件独立复跑通过；独立通过与 baseline 复现都不代表完整门禁通过。
- Pi 没有成功 Runtime receipt；Keychain 门禁仍保留。Qoder 额度不足，未完成验证。
- 公共 CLI 正向安装 smoke 被 registry 证书校验阻断；Windows 实际 launcher/发行、
  签名/公证安装包及平台负向矩阵未验证。没有关闭 TLS 校验来绕过门禁。
- 真实模型审批、取消、历史交接、崩溃恢复和性能门禁仍未全部验收。

仓库只保存上述结论与关键指标，不提交本次完整 Runtime 证据、逐工具估算或原始 receipt。
前两阶段既有文档保持原有记录。复现入口仍在验证脚本和回归测试中。

相关记录：[统一 Skill 结论](management-tools-cli-skills-unified-skill-implementation.md)、
[CR 与评论修复结论](management-tools-cli-skills-phase-three-code-review.md)。
