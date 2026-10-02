# Issue #348 R1：第二轮 PR 评论核验

本报告对应[新增评论](https://github.com/pqpo/pragma/pull/353#issuecomment-5951540710)，审查基点 `6da4af3d8e59c0b3197a89b2d728976192e60c9c`。这是第二轮评论核验，架构 R2/R3/R4 未开始。R1 验收仍未通过，PR 保持 Draft。

## 核验结论与修复

评论未提出新的代码缺陷，上轮终态错误透传和自动门禁两项已被独立验证，113 项控制测试通过；审查基点的 GitHub CI/CLI package verification 与跨平台 smoke 均成功。成功的 CI 不覆盖全部产品验收。

完整 Runner 的大输出失败、真实模型样本为零以及 Native resume 未正常退出等缺口属实。本次真实 Native 诊断进一步确认了普通关闭路径的资源泄漏，并修复：

- 原 `ExpertSession.closeInternal()` 调用 `stopForDeletion()` 后跳过 Runtime pool 的完整 cleanup。Native 进程停止，但 MCP registration、HTTP listener 与销毁 hook 未释放。该遗漏在 main 也存在，不声称由本次 R1 新增。
- 普通关闭在 Native stop 已确认后调用 `runtimeSessions.finishDeletion()`。即使后续取消投影失败，也完成已安全停止的资源清理。未确认 stop 时保留资源；cleanup 错误继续传播。持久 Execution/Session Context 只在 cleanup 成功后关闭。
- 实际 owner 删除的 stop/finish 两阶段边界、Journal 和持久协议版本不变。未更改 Runtime adapter 必填接口。
- 新增真实 HTTP MCP 边界回归，覆盖 prompt→refresh→prompt→close、正常关闭幂等、cleanup failure 传播且 Context 不误报关闭、Native stop failure 保留注册。加入 Core `test:core`，经根 check/CI/Release 执行。

新增回归在旧生产实现上为 2 失败、1 通过；修复后 3 通过。最初 fixture 误以为 refresh 后旧 endpoint 必须返回 404，实际最后一个旧 registration 会关闭 listener，正确断言是连接拒绝；finally 先关闭 Session 再删除临时目录，避免清理错误覆盖原失败。保留这些失败日志摘要，不将 fixture 错误当生产复现。独立只读 CR 未发现新增确认问题。

## 大输出诊断

串行运行未减小输出、未增加 deadline 的完整 `mission-runner.test.ts`，只加入临时计时观察；所有观察改动（Core src/dist 与测试）均字节级恢复。原始阶段 trace 见[诊断数据](../performance/local-host-kernel-r1-pr-review-r2-oversized-trace.jsonl)。这是诊断运行，不能作为无观察器性能验收样本。

只有一次 `RuntimeTokenCounter.countText()` 对 200001 字符正文计数，调用栈为 Runtime attempt 的 Usage fallback，耗时 **55250.63 ms**；计数后约 127 ms 返回 send，再约 65 ms 观察到第二轮 settled。此前 128000 字符普通文本计数只需 10.41 ms。没有重复计数、重复 Runtime dispatch 或 terminal join 的额外长等待。

候选 `runner.sendMessage()` 经耐久 Controller 的 `waitForTerminal()`，main 的旧入口直接走消息 admission。同步 tokenizer 阻塞可以侵占这两个位置的不同 deadline；但本轮没有对 main 完整套件做相同动态 trace，历史 main running/succeeded 断言与候选 timeout 的差异仍不宣称已完全排除。相关 tokenizer、stream controller、driver 与 overflow 代码在两侧没有改变。

技术方案要求 R1 等价迁移，并把新性能算法与重构分开。对超长连续文本切换既有 heuristic 的保护可避免该输入阻塞，但会改变计数：本样本 tokenizer 25001，heuristic 50001；还影响 Usage、Context budget 和 Memory 分段。该策略尚未实施，范围选择已请求维护者确认。没有删除失败场景、伪造 reported Usage 或放宽 timeout。

## 真实 Runtime 与性能证据

真实模型 warm pilot 串行重试，继续在 120 秒原上限超时。新增只含阶段名称的 IPC 标记将阻塞定位为 `credentials-read`，尚未完成原 Keychain 读取，未进入临时 Keychain 写入或模型请求。未输出凭据，不更换凭据存储、不绕过授权；有效样本仍为 0，见[失败状态](../performance/local-host-kernel-r1-pr-review-r2-model-pilot-status.json)。

修复前 Native Codex resume 两个真实断言通过，summary 已输出，session/store close 也已返回；240 秒后仍不退出，诊断显示残留 `TCPServerWrap`。静态所有权检查和真实 MCP 回归共同定位普通 close 漏 cleanup。临时 async_hooks 观察只记录资源类型与代码栈，已恢复原 probe。修复后未加观察器的 Codex 0.159.0 resume：两个断言通过，29.47 秒正常 exit 0。

未经改动的 steering probe 随后 19.68 秒 exit 1，最终只有 cleanup quiescence 错误，原始失败被 finally 覆盖，不能根据耗时推断最初失败。静态核验发现活跃检测遗漏了 Codex 原生 `progress(turn/started)` 和 `thought.delta`。probe 补入这两种真实事件，保留原 10 秒上限、严格 `mode: steer` 和原始 turn 输出中的 marker 断言；Session 已创建后的执行失败与两个 cleanup 失败分别保存到 evidence，并保留全部 Error/cause。第一次 lint 拒绝 finally 中的 throw，已改为顺序清理后统一抛错，最终 lint/typecheck 通过。初始化前边界不属于本次错误收集改动。

纠正活跃检测后真实 steering 31.22 秒正常 exit 0，原 turn 输出为 `STEERING_PROBE_OK_8172`，有实际消费证据，不将 Native ACK 作为成功。官方证据的 events observation 因有界归档被截断；开头的完整原 turn 输出与通过断言仍可读取，见[Native 记录](../performance/local-host-kernel-r1-pr-review-r2-native.json)。最终错误收集形式定稿后再次串行复测：resume 29.62 秒 exit 0、两个断言通过；steering 25.07 秒 exit 0、原 turn marker 实际消费，均绑定最终 probe 源码 SHA。这是 Core/Native 单 Session smoke；不代表实际 Mission queue、Host 接管/崩溃恢复或全部产品场景均已验收。

原 12 次局部 storage/preparation/renderer 对照绑定旧 digest `228f00277f24f0588abad69e374e713afd3790f3c42973f5b3f11c5a3563b430`，其结果保留为历史局部证据，不能重标为本次源码的性能通过。正常后台负载、规定完整场景、逐请求 I/O 与实际 Mission/Studio 首屏等缺口继续保留。

## 验证与源码身份

已完成 `pnpm check`（459 项基础测试）、全仓 build（19 tasks，Desktop 四项产物验证）、控制专项 113 项、Core Session/pool 18 项、Local Host 完整 execution-system 120 项、benchmark helpers 20 项，均通过。新回归最终 fixture ID 使用 16 位 Crockford Base32，三项再验证通过。最终未改 fixture/deadline 的完整 Desktop Runner 为 **84 通过、1 失败，0 unhandled**，原 30000 ms timeout；oversized 场景 55630 ms，总计 185.69 秒。另有 Flow recovery claim renewal 的 Execution not found 日志，保留为诊断信号，不将该日志本身计作 unhandled。详情见[最终验证记录](../performance/local-host-kernel-r1-pr-review-r2-validation.json)。测试组可能重叠，不相加为唯一测试数。各顶层验证命令与 Runtime 测量按序执行；测量期间无并发构建/测试。源码清单见[本轮身份](../performance/local-host-kernel-r1-pr-review-r2-source.json)，保留原 1164 文件范围，额外校验新增测试与 Core 门禁 package 文件；文档不计入生产源码 digest。本次未修改原工作区，最终检查仍为 clean。

`performanceAcceptancePassed = false`，第一阶段未标记完成。
