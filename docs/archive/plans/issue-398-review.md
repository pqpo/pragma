# Issue #398：CR 复核与修复

> 历史记录：保留当时的实施、验收及未完成项，不代表当前状态或开发规范。当前入口见[文档索引](../../README.md)。

范围：本次 CLI、Shared DTO、Local Host 查询/展示/owner 改动，以及文档和包审计。逐条检查候选问题，确认业务影响后修复；不把待执行的平台 smoke 视作已完成。

## 已确认并修复

- [x] R1 — owner 请求与失败边界：原先先 fork 再验证请求，错误输入可能留下等消息的子进程；receipt presenter 抛错也不能正常结束等待。改为先验证，并通过统一结束路径断开 IPC。Worker 请求解析和 Host 创建纳入失败 frame 边界；默认文本 mutation 在副作用前输出 request ID。
- [x] R2 — watch 的 scalar 指纹：持久化包装对象参与指纹，内容读取却解包，导致正常续读报 CURSOR_EXPIRED。watch 现在对实际原值编码、生成指纹，中文与 emoji 可完整恢复。
- [x] R3 — 普通事件误用最终结果引用：任意带 result/executionId 的事件曾被映射到最终结果，导致工具/进度正文读错或不存在。仅最终结果和明确 command.result 使用结果引用；普通持久事件绑定自己的事件身份。
- [x] R4 — scalar 预算按错误编码计算：非 well-formed 字符串按原始 UTF-8 估算，实际无损 JSON 编码超限时没有持久化。预算判定复用真正的内容编码，引用能够恢复原始字符串。
- [x] R5 — 实时事件时间不是真正持久时间：实时展示可能合成 occurredAt。append 回执现在返回实际 occurredAt，与 event ID 一起用于实时输出，和 watch 续读一致。
- [x] R6 — 有限等待仍读取 TTY：嵌入式 mutation 的 auto/text/TTY 分支仍采集终端回答。有限等待现在直接返回完整 input_required envelope，不后台读取 TTY。
- [x] R7 — 超时后观测无限等待：可选 summary 查询没有时限，可能让 wait-timeout 永不返回。观测最多等待 250ms；不可用时保留持久 receipt 和 unknown 状态。
- [x] R8 — 续页丢失协议选项：显式 query-version 1 在下一页变回默认有界输出。续页保留 query-version、recent-input、output-view 和输出格式，以及原有筛选参数。
- [x] R9 — owner mutation 完成投影差异：完成/待回答 frame 丢失 execution ID，文本绕过原 mutation presenter，可能输出整份大 JSON。完成 frame 保留 execution ID；文本统一使用原 receipt presenter，并保留 request ID 与操作状态。
- [x] R10 — 内容 selector 默认值与来源：Schema 接受的默认 start/maxBytes 未实际使用；无队列端口的直接查询也可能把 queue selector 当作事件。读取使用验证后的默认值；queue 必须经过真正的 Host queue 端口。
- [x] R11 — 并发写入使回执 cursor 指向后续事件：append 后读取最新 snapshot，在另一条事件先落盘时会跳过当前事件，并使当前正文引用误读后续事件。已用实际持久控制器复现 sequence 1 的回执错误指向 sequence 2；回执现在直接绑定 committed.sequence，回归验证精确 cursor 和正文恢复。
- [x] R12 — owner 输入错误变成内部错误：非法 Flow JSON、非法 UTF-8 输入和非法 answers JSON，在普通调用返回 INPUT_SCHEMA_INVALID/INVALID_ARGUMENT，在 owner 中却返回 INTERNAL_ERROR。统一命令错误转换，三个回归同时比较普通调用和 owner frame，保持公开错误码和退出语义。
- [x] R13 — receipt 释放 lease 与新命令存在竞态：完整内核门禁和独立冷 Flow 场景复现，新 send 在 applying 时失去 lease，编译拒绝后无法写入 command.rejected。原有“读取 pending 后再释放”不是原子操作。增加持久锁内的 releaseIfIdle，queued/applying 期间保留 guard 和 poller；空闲时才释放，并恢复释放期间到达的新命令。已有冷停止断言与超时未修改；owner/controller 专项 64 项和完整 Node 编译执行 27 项通过。

## 复核后未判为缺陷

- Mutation owner 的 failed 执行会被 executeMutationCommand 拒绝并发送失败 frame，不会因 succeeded 分支误报成功。
- 输入模板明确要求替换占位符并按完整 Schema 验证，不承诺复杂约束下直接可执行。
- 列表 cursor 的过期规则与事件 replay cursor 分开，未削弱完整 256-bit 指纹，也不依赖进程内映射。
- watch 等待消费者 flush 后再推进 cursor 是已有的背压与恢复保证；不能为了超时在消费者尚未确认时提前推进 cursor。

## 验证

首批新增回归在修复前复现 10 个失败场景；后续补充真实控制器的并发 cursor 复现、三个 owner 输入错误契约对比，以及 queued/applying 期间 lease 保留的回归。13 组确认问题已修复并逐项勾选。

基于 main `e70173b1` 的最终代码，门禁全部通过：

- `pnpm check`：lint、typecheck 和核心测试通过。
- `pnpm build`：19 个任务通过，Desktop 打包 Host 存储 worker 启动检查通过。
- `pnpm test:local-host-kernel`：106 个文件、985 项通过、1 项跳过；文件锁另有 22 项通过，最终进程退出码为 0。
- 完整 CLI adapter：21 个文件、158 项通过，包括真实 owner 进程在调用方退出后完成和幂等重试。
- npm 包构建和审计通过；包内 owner 的真实 IPC 启动检查通过。
- 最终 Token 基准与保存的 JSON 完全一致；格式及 `git diff --check` 通过。

中途完整门禁曾出现恢复场景失败，单文件独立复核 27 项通过；随后冷 Flow 的 lease 竞态在完整门禁和独立用例中复现，已按 R13 修复。控制器/owner 专项 64 项和完整 Node 编译执行 27 项通过，最终再独立运行整个共享门禁并通过。没有修改既有断言或放宽超时。一次执行会话中断且没有完整汇总，不计为通过；最终独立日志记录了完整汇总和退出码。

真实子进程回归使用确定性 executor 和生产 Local Host 存储。真实模型 Runtime、macOS/Windows smoke 尚未执行；发布前仍需验证。

## 同步 main #401 后的最终结果

PR 创建后 main 合入 #401（`3d89ff0c`），已解决全部合并冲突并保留 Mission 删除屏障、SQLite 锁重试和不可读 owner 诊断。诊断和分页来自同一次 Host 读取；无可读 owner 时保持 fail closed。含诊断的页使用独立 `pragma.mission-list-page/v2`，严格通用 v1 DTO 不改。

合并后的 check/build、Host 专项 24 项、CLI 专项 38 项通过；再独立完成整个共享门禁：107 个文件、1005 项通过、1 项跳过，文件锁 22 项通过，退出码 0。最终完整 CLI adapter 21 个文件、160 项通过；npm 包构建与包内 owner IPC 启动审计通过；Token 基准与保存的 JSON 精确一致。PR 无冲突并处于可审核状态。

## PR #402 评论复核（2026-10-15）

已读取全部 2 条讨论评论、3 条行内评论和 1 次审核（基于 `af03fab`）。自动评审汇总与审核说明没有额外独立问题；维护者评论补充了补全和 SIGINT 回归要求。

- [x] [Cursor 投影绑定](https://github.com/pqpo/pragma/pull/402#discussion_r4273586701)：确认需要修复。Executor 和 Queue 原先按原始列表与筛选生成 cursor，未绑定 `maxContentBytes`。现在把该值纳入 scope；省略表示 full，数值表示有界投影。回归分别覆盖 full→有界、有界→full、预算变化和相同预算跨 Host 实例正常续页，变化均返回 `CURSOR_INVALID`。CLI 嵌入式完整 Queue fallback 也绑定同一预算，并覆盖 compact→full 拒绝和 compact→compact 正常续页。两项新增测试先复现失败，修复后 Host 专项 18 项通过。
- [x] [watch 超时文本](https://github.com/pqpo/pragma/pull/402#discussion_r4273586706)：确认需要修复。文本优先展示 `lastObservedStatus`，并独立展示 `stopReason=timed_out`；没有观测值时保留 `unknown`。`running` / `input_required` 两个回归先复现失败，修复后通过；JSON/JSONL 原始状态契约不变。
- [x] [有限 mutation 的 SIGINT](https://github.com/pqpo/pragma/pull/402#discussion_r4273586697)：自动评论描述的 cancel frame 被吞路径在当前 mutation 调用中不成立，因为该分支未安装 `onInterrupt`。新增 runCli 接线断言和真实 Linux Node 调用方/owner 子进程回归：持久 receipt 后发送 SIGINT，调用方在 1.5 秒内退出，owner 完成真实 Host Inbox 命令并落盘、释放 lease；同时验证 executor run 的显式 cancel frame 仍产生持久 interrupted 结果。Windows 不用 Node POSIX 信号模拟，两个信号专项明确跳过；其余 owner 回归照常运行。owner/transport 专项 12 项通过。
- [x] [Shell Completion](https://github.com/pqpo/pragma/pull/402#issuecomment-6181604866)：确认遗漏并修复 bash/zsh/fish/PowerShell 的 Mission query/workspace、内容 selector、query-version/recent-input、wait-timeout 和全局 output-view 参数。四种 Shell 的命令上下文回归通过，仍限制 watch 不提供不支持的 JSON 输出。
- [x] 默认 Host 双重初始化：维护者明确本 PR 不要求重构。此次不修改 owner/调用方的 Host 生命周期，作为后续优化保留。
- [x] 最新 CI：`af03fab` 的 source 质量/业务、CLI 包构建及 macOS/Windows/Linux 包 smoke 全部成功（条件入口一项跳过）。本次修复推送后会重新触发 CI。真实模型 Runtime smoke 仍未执行，平台包 smoke 不替代真实 Runtime 验证。

完整共享门禁首次执行出现一个既有测试的同步竞态：`canonical-event-feed` 删除屏障用例在调用异步批量删除后立即释放 feed，没有等待全局文件锁内的 `deleting` 屏障生效，因此下一批事件可能先投递。独立原文件 15 项通过；已将测试改为观测 `store.get()` 的删除屏障拒绝后再释放 feed，保留原来 append 一次、一个 handoff 的全部断言和测试超时。生产删除实现不改，修复后的专项及完整门禁重新验证。

本轮最终验证：`pnpm check` 通过；最终 `pnpm build` 19 个任务通过（含 Desktop 打包 Host worker 启动），CLI 最后补全修改的 lint/typecheck 通过。修正同步后的完整共享门禁 107 个文件、1007 项通过、1 项跳过，文件锁另有 22 项通过，退出码 0；最终完整 CLI adapter 21 个文件、165 项通过，包含四种 Shell 补全、embedded Queue 模式绑定和真实 SIGINT 进程回归。npm 包审计及包内 owner IPC 检查通过，提交后重新绑定产物的提交身份并审计。
