# OpenCode 实现 CR 与复核

日期：2026-09-29。范围：当前 worktree 的 OpenCode SDK 接入、steer 队列与恢复、流式输出及 Desktop 投影变更。

## 确认的问题

| 优先级 | 触发条件与影响                                                                                                           | 修复与复核                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2     | 1.x pending 工具快照和 2.x input-start 事件尚无完整参数；提前发出 tool-start 后，真实参数被忽略，持久历史记录为空对象。  | 等待 running / called 事件再发出工具开始，保留此前文本的排序依赖；终止事件提前到达也只结算一次。真实 1.x / 2.x CLI 的非空参数回归在修复前失败，修复后通过。           |
| P2     | 1.x 一轮包含工具调用和后续回答时，只使用最后一条 assistant 的用量，遗漏中间步骤；fallback 同样遗漏中间正文和 reasoning。 | 按本轮开始前的消息 ID 排除旧历史，再汇总本轮全部 assistant 用量；缺少原生上报时将本轮正文与 reasoning 交给 Core 计数器。两个版本均验证 reported 优先及估算 fallback。 |
| P2     | 2.x MCP connect 返回时仍可能处于 failed，原实现将其当成注册成功，第一轮随后遇到工具不可用。                              | 握手后查询服务器状态，仅 connected 允许完成注册；真实 CLI 对不可达 MCP 的注册明确失败，真实 MCP 正常调用回归通过。                                                    |
| P1     | 底层已确认 steer 接收，但写入 confirmed 记录失败，队列停留在 dispatching，调度被挡住而缺少可核对的暂停状态。             | 转为持久 uncertain，暂停队列并允许核对。注入确认记录写入失败的回归在修复前失败；修复后核对 delivered，不产生第二次 admission 或队列重放。                             |

上述问题均已修复。复查确认：明确未投递继续保留原队列项；不确定投递不得自动降级为下一轮；原生步骤结束与 Pragma Execution 结束保持独立边界；snapshot 与增量共用内容游标，最终答案只提交一次。

## 验证边界

- Core：7 个 steer 定向回归及队列崩溃恢复测试通过；Host 队列测试 2 个通过；Desktop 聊天投影测试 14 个通过。
- OpenCode：流式单元回归 8 个通过；真实 1.18.33 / 2.0.16 CLI 的流式、非空工具参数及 reported / estimated 用量组合 4 个通过；真实 2.x MCP 连接失败回归通过。
- OpenCode 全套 45 个测试已在全套与定向复跑中逐项通过。首次全套运行出现 catalog 等待与 1.x CLI 探测／冒烟超时；定向复跑均通过，未修改产品超时阈值。1.x 启动／恢复冒烟最终在 7.61 秒完成。
- Core / OpenCode 类型检查、lint 和构建通过；Desktop Node 类型检查、主进程生产构建及无外部 `@pragma/*` import 校验通过。格式检查和 `git diff --check` 通过。检查日志保存在本机 `/tmp/pragma-opencode-acp-research/cr-*.log`。
- 测试使用本地模拟模型，不代表使用真实认证供应商的验收。保留 SDK 接入与 ACP 暂缓的既有结论。

## PR #329 评论复核

已读取普通评论、完整 review body 与行内评论。Bot 的行内 P1 与维护者的 P1 review 指向同一问题：Codex、Pi、Qoder CLI、Claude Code 没有 receipt reconciliation 时，不确定 steer 会永久挡住队列。该问题成立并已修复。

- Driver 按实际 receipt 方法生成 `steeringRecovery: receipt | terminal` 能力，conformance 检查声明；四个 Runtime 的契约测试覆盖 terminal，OpenCode 保留 receipt。
- 普通恢复继续核对投递。只有显式 `recovery: abandon` 才会取消不确定消息、停止 live native Session，并在同一持久事务中解除旧 native snapshot 绑定；不自动重放不确定消息。
- Desktop 提供“跳过不确定消息，重新开始”；CLI 提供 `queue resume --abandon-uncertain`。保留原队列恢复入口，提示先前操作可能已经发生，其他排队消息会在新对话中继续。
- 覆盖四种 Runtime 契约的 Core 恢复、丢弃后的重启、真实 SIGKILL 的 dispatching 崩溃窗口、关闭失败、持久写入失败与并发恢复。不存在因修复而绕过不确定投递 fence 的隐式 fallback。

复核结果：Core 恢复定向测试 10 项通过，Session pool / conformance / 崩溃测试 21 项逐项通过；四个 Runtime 契约测试共 13 项通过。Shared 协议 21 项、Host 队列及转发 3 项、CLI mutation 14 项及补全 2 项、Desktop 队列 UI 2 项通过。相关类型检查、lint、格式检查、Core / Shared / Host / CLI 构建与 Desktop 全量生产构建通过，main / preload / styles 校验通过。这些恢复回归使用受控 Runtime fixture；未新增四种 Runtime 的真实供应商验收声明。

## PR #329 新增评论复核（review 5351912497）

已读取新增 review、普通评论及行内评论。维护者新增的 P1 与 P2 均成立。

- P1：原实现先取消源 Execution 再写入放弃决定，写入失败后会留下仍排队的 Prompt 和已经 cancelled 的源 Execution；后续 `not_dispatched` 核对无法执行原消息。现先以原有 aggregate journal 持久化 Prompt 取消与 native snapshot 解绑，再清理源 Execution。失败写入回归在修复前复现 `cancelled`，修复后保留 `queued`，改走 receipt 核对后原消息成功执行。
- 已持久化的 cancelled uncertain Attempt 作为可重放清理意图，显式重试与 owner 恢复补齐源 Execution 取消。补测发现旧暂停事件还会阻挡下一条新消息，现同时清理与已放弃请求关联的投递暂停，保留其他原因的暂停。
- P2：Host 和 Desktop 快照投影 `steeringRecovery`，receipt 显示核对及放弃，terminal 仅显示放弃；缺失能力信息时同样隐藏核对。Host/UI 测试覆盖三种投影。

本轮验证：Core 恢复定向回归 12 项、真实 SIGKILL 崩溃恢复 1 项、Host 队列投影 4 项和 Desktop UI 4 项通过，共 21 项。Core / Host / Desktop Node 与 renderer 类型检查、相关 ESLint、Core / Host 构建、Desktop 生产构建及 main / preload / styles 校验通过。格式检查和 `git diff --check` 通过。日志保存在 `/tmp/pragma-opencode-acp-research/pr-new-review-*.log`；本轮未新增真实认证供应商验收。

## 合并最新 main 的冲突复核

合并 main `cbcd0bb9`（包含 #330 的队列实时投影与 Codex steer 修复），人工处理 Core、Local Host、Desktop composition 和 UI 共 5 个冲突文件，并检查自动合并结果。

- 保留 receipt / terminal recovery、持久放弃与源 Execution 清理顺序，以及不确定投递禁止自动重放的 fence；不采用 main 原有清除 uncertain 后重跑的恢复语义。
- 合入排队 Execution 观察器、旧轮 terminal 投影闸门、明确未投递的 strict fallback 崩溃重放、关闭状态与 attempt identity 校验。确认写入失败和 rollback 写入失败都显式传入当前 attemptId，避免新校验遗漏 uncertain 标记；两个注入写入失败的回归通过。
- 同时保留队列项自身的不确定状态和全队列暂停，三种语言保持 receipt 核对／显式放弃入口；移除自动合并造成的重复翻译键和已不用的 blind retry 文案。
- 共享崩溃 fixture 仅在 strict fallback 场景启用 steering，保持普通 dispatching 场景原有 Runtime binding。Codex 的迟到回复测试改用显式关闭 Session，并先断言投递未决时清空队列被拒绝，继续验证关闭与恢复不会复活消息。

合并验证：Core steer / recovery 原定向 27 项通过，确认与 rollback 写入失败 2 项通过（其中确认项为复跑）；两种真实子进程 SIGKILL 崩溃 2 项、Runtime conformance 17 项、Host 5 项、Desktop queued-turn 集成 7 项、observer / chat / delivery 14 项、三语言及恢复 UI 6 项通过。真实 OpenCode 2.0.16 的 steer 集成与流式共 12 项通过，使用本地模拟模型；Codex Adapter 受控 peer 的 12 项在全套与定向复跑中通过。相关类型检查、ESLint、冻结依赖安装、Desktop 依赖构建与生产构建、main / preload / styles 校验、格式及 diff 检查通过。日志见本机 `/tmp/pragma-opencode-acp-research/merge-*.log`。
