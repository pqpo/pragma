# Issue #368 第一阶段 Code Review 与修复复核

日期：2026-10-09。范围：main `a32bdedb` 到当前 worktree 的全部 tracked/untracked 实施改动，
包括后续默认 Flow 工具切换。本记录在创建 PR 前完成本地 CR；没有向 GitHub 发布独立 review 评论。

## 已核实的发现

以下发现已逐项审查因果和适用范围，并修复；没有把未核实推测直接当作问题。

| 级别 | 问题与触发                                                                                                                                                     | 修复与复核依据                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1   | 两个 CLI 进程连接同一 Execution endpoint 时，MCP 数字 request ID 从头计数并相撞；共享 stateless transport 的 response map 将响应发给另一客户端，另一个调用挂起 | 两个真实 Client 使用 barrier 强制重叠，修复前出现 request mismatch 与超时；私有 command 注册现在按 HTTP 请求创建独立 Server/transport，复用原 Gateway listener 和 bearer lease；原 native Runtime 注册保持原路径                     |
| P2   | 撤销 lease 时客户端在 SSE 断流后继续重连，直到长请求超时才结束                                                                                                 | 每个请求显式 AbortController 随 HTTP/lease 关闭而取消；client 将连接错误/关闭并入调用 signal，及时返回 dependency 错误；实际 SDK close 本身会取消 handler，复核纠正了此前相反的判断；撤销中的请求回归验证 handler 被取消且客户端结束 |
| P2   | 用户主动中断 command 被 catch 误报为 channel dependency failure，初始化握手也未绑定调用 signal                                                                 | connect/callTool 使用相同取消 signal；用户中断明确映射 INTERRUPTED/130，连接故障仍是 dependency；预先中断的客户端回归覆盖                                                                                                            |
| P2   | 无效 stdin/输入读取失败丢失显式 requestId 和 command，Commander 参数错误也可能出现同样问题                                                                     | 解析 action/option 时保留合法请求 identity，失败 presenter 保留 command 和所选格式；无效 JSON 和未知参数回归先复现失败，再验证修复                                                                                                   |
| P2   | 公共 CLI 的前置 --format 等全局选项绕过 management 路由；根 help 缺少新入口                                                                                    | dispatcher 跳过明确的全局选项，management parser 接收并继承它们；根 help 显示 Flow/DSL 管理入口；前置 text 输出回归先复现失败，再验证修复                                                                                            |
| P2   | receipt 损坏 JSON、null/缺版本以及未来 owner 版本被误报为普通 COMMAND_REJECTED/INVALID_ARGUMENT                                                                | 请求 receipt 和 owner 使用统一严格版本读取边界，返回 STORAGE_CORRUPTED/STORAGE_VERSION_UNSUPPORTED，保留原文件且禁止 mutation；损坏/未来版本回归先复现失败，再验证零写入                                                             |
| P2   | 多会话同时准备同一 launcher 时直接 writeFile 会截断目标脚本，正在启动的 shell 可能读到半个文件                                                                 | 唯一临时文件、权限设置、rename 原子替换和 finally 清理；真实 launcher 并发准备/执行 20 次，验证参数、私有权限、完整执行与清理；Windows 真实平台验收仍另列                                                                            |
| P2   | afterPack 审计未检查新增 command client，错误的 ASAR 打包策略仍可通过审计                                                                                      | 审计要求 client 与原 ACP worker 均具有 unpacked 标记及实际文件；真实 ASAR fixture 中仅 client 未解包时，修复前审计成功、修复后拒绝                                                                                                   |

## 复查排除的疑点

- 默认工具移除是否扩大 CLI 权限：command grants、toolPolicy 与独立 executionToolApprovals
  都在可信 Host/Execution 边界执行；读取已有 receipt 之前同样先做 ownership/grant/policy 检查。
- 是否存在 Project Expert 同 ID 冒充系统 Expert：Mission compile service 的系统资源优先解析
  和 System Expert registry 的默认能力继承规则保留；没有在用户输入中接收 agent/Context identity。
- 默认工具移除是否删除显式 handler：只删除默认 Pragma binding 的六个名字；factory、Schema
  和 CLI handler 仍存在，真实编译与 MCP catalog 回归断言默认目录缺失这些工具。
- stop-only 定义是否强制准备 CLI：Desktop adapter Host 已有 purpose=stop 分支，在分发调用前
  返回停止用的空贡献；该分支保留。
- 缓存请求是否重复发布或更新覆盖新草稿：既有 payload hash、增量 journal、publication identity
  和相同 Context 的原 origin 保留，恢复回归继续覆盖；不为新命令改变旧持久 Schema。

## 最终验证

最终结果：

- 全仓 lint、typecheck 各 19 packages 通过；test:core 11 tasks 通过。
- Desktop command/launcher/adapter Host 14 tests、Built-in 编译与 MCP catalog 15 tests、
  Core 原 native Gateway 8 tests、ASAR packaging 3 tests 通过。
- CLI 全量首轮 110 tests 通过，doctor suite 的构建准备 hook 在与全仓构建并行时超时；
  构建完成后原 doctor suite 8 tests 定向复跑通过，未修改断言或放宽超时。最终 CLI identity
  suite 另行 5 tests 通过，包含后续新增的 Commander 失败关联断言；覆盖合计 119 个独立用例。
- Desktop 生产构建、main/preload/storage worker/renderer styles 产物检查通过。
- 修复后真实 Codex smoke 成功：生产默认 tools 为 38，实际 CLI child process 调用
  dsl.resources.list，Host receipt 为 succeeded/0。见[脱敏 Runtime 证据](management-tools-cli-skills-phase-one-cr-runtime-evidence.json)。
- git diff --check 通过。二次复查后，本轮 8 项确认问题均已修复；没有遗留本轮确认的代码问题。

失败复现和回归输出位于本次会话 `/tmp/pragma-368-cr-*.log`；
临时路径仅是诊断，不提交凭据、bearer endpoint、Runtime 私有 Home 或截图。

本轮修复不等于原计划所有发行/供应商验收已完成。Pi Keychain、Qoder 额度、真实 Windows、
完整 Electron IPC 浏览与可比较性能证据仍按实施报告保留；六个默认工具已按用户授权移除。
