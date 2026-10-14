# Issue #398：CR 复核与修复

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
