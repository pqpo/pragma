# 排队轮已执行但页面未更新

截图反馈的缺口在 Steer 修复后仍存在。它位于 Desktop 的执行投影承接，与 Codex 是否支持 ACP 无关。

Codex、Claude Code（ACP）、PI、OpenCode、QoderCLI 和 Antigravity 共用 Core ExpertSession
排队调度与这条 Desktop 观察链路，因此同类缺口可能影响所有这些 Runtime，公共修复也覆盖它们。
Codex 原生 `turn/steer` 的 NotSubmitted 错误分类属于另一项供应商专用修复；公共投影回归与 Codex
受控 Adapter 集成不能代替各 Runtime 的真实模型验收。

Core 的 Session 队列在上一轮结束后自动运行后续 prompt。旧 Desktop 实现只有上一轮 Mission observer
完成 terminal event、聊天投影、归档和订阅清理后，才调用 `attachNextSessionTurn()` 订阅下一轮。
这些副作用延迟时，Core 已在执行后续轮，页面仍使用旧 Execution，缺少新轮的流式输出和 running 状态。
再次发送消息触发 invalidate 后，历史输出才被读出。

本次在排队消息被接受后订阅其 `execution.started`，并在订阅建立后读取状态，以覆盖已经启动或快速
完成的轮。新轮由现有 admission gate 串行安装 Mission / chat observer，并主动发送 running 通知；
恢复 Session 时也为尚未开始的后续消息注册订阅，并按 Session 实例替换、关闭旧订阅，防止旧实例
占用同一 Execution 的观察资格。没有轮询刷新页面，也没有重新提交任务。

旧轮仍完成自己的 terminal event 和输出持久化，但晚到的状态通知、清理和聊天 close 不得覆盖
新轮的 execution、实时订阅、human interaction、work 或 context window。执行投影更新使用已有
executionId 闸门；取消、已转为 Steer 的队列项和被替换 Session 的回调不会再安装活动投影。
订阅错误报告 `MISSION_QUEUED_TURN_OBSERVER_FAILED`，标记聊天同步 degraded。

回归覆盖：

- 修复前分别阻塞上一轮 terminal event 与聊天投影，两项均复现“后台第二轮已开始，Mission 仍指向
  第一轮 / 已完成”的错误。
- 修复后，在上述投影仍被阻塞时，连续第二、第三轮都会推送 running 和流式输出，无需额外发送消息。
- 第三轮运行中放行第一轮的投影和归档，第三轮仍继续流式输出，旧 terminal 通知不会回退当前状态。
- 相同场景经过真实 Codex Adapter、RPC Client、Core 文件 Store 和 Desktop observer；原生 stdio peer
  可控，没有调用真实模型或加载宿主 Codex 认证。
- 另验迟到的 chat close、快速完成、Steer 承接、不确定投递、取消及 human checkpoint / 恢复入口。

验证结果：20 项 Host / observer 相关回归通过；补齐 Session 订阅替换后，9 项针对性回归通过，
覆盖三个投影阻塞场景、快速完成、Steer 两种结果和三个订阅边界。Desktop 类型检查、构建、
ESLint、主进程与 preload 产物检查、样式及格式校验通过。

没有修改 Runtime 执行协议或持久状态 Schema，没有切换到 ACP。

## 2026-09-30：刷新请求跨越排队轮切换

后续回归发现 `#330` 仍遗漏了聊天页读取的竞态。`getChatPage()` 在异步读取历史前捕获
上一轮的 live projection，却在读取完成后返回当前最新 revision。排队轮在读取期间启动时，
新轮的 `message.delta` 只存在于新的 live projection，旧投影和持久事件都无法补齐这些文本。
返回的快照因此可能遗漏新轮输出，却宣称已经包含它的消息版本。

聊天页现在在返回前检查 live projection 与最近一次 invalidate revision；任一变化时重新读取，使返回的
实时内容与 revision 一致。发送或操作队列后的主动刷新也复用订阅刷新使用的
`reconcileMissionChatRefresh()`，避免相同版本的迟到页面覆盖已经应用的流式文本。

只比较 live projection 对象仍有遗漏：读取开始时没有活动投影，两轮在读取期间完成后，
活动投影又恢复为空。单调递增的 invalidate revision 能识别这个窗口，也覆盖队列记录变化；
普通文本 patch 不触发重读，由同一同步时段捕获的 live entries 和 revision 覆盖。

原有三个排队流式回归现在同时覆盖“刷新开始于第一轮、返回于第二轮”的窗口。修复前，
真实 Codex Adapter 配合受控 stdio peer 的用例稳定缺少第二轮答案；修复后，三个用例
均包含第二轮输出，并继续验证第三轮的流式更新。页面合并回归还验证同版本主动刷新后
能继续追加文本。

补充回归使用真实 Codex / Qoder Runtime Adapter 与 Core 文件存储，仅控制 Codex stdio peer
和 Qoder SDK 消息源。两套 Runtime 均覆盖“读取期间两轮全部结束”以及“跨轮刷新后继续流式追加”，
经过 Desktop 消息转发、协议解析、renderer 合并，再断言实际聊天条目的静态渲染内容。
这些用例不等于启动 Electron 窗口或真实 Codex / Qoder 模型验收。
