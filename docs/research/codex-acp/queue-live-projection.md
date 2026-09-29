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
