# ADR 071：CLI 查询语义、精简视图与有限等待

Status: Accepted

Issue: #398。基线：`1cec48eba13590094c6ac0ddcd61dad3d01598ba`。

## 决策

Shared 定义查询、分页、正文引用与 owner IPC 的版本化 DTO；Local Host 拥有事实读取、筛选、排序、分页、内容指纹及运行生命周期。CLI 只组织参数、进程、信号和展示。Desktop 的相同 Host composition 注入同一 timeline 读取端口。保留原有完整列表端口，显式分页使用 queryMissions/queryExecutors/querySharedBoard/queryMissionQueue；旧嵌入式完整列表由 Local Host 导出的纯查询函数适配，不在 CLI 建立业务内核。

列表页显式标记 `pragma.list-page/v1`，不能按 `items` 猜测分页。Mission 按 updatedAt 降序、ID 升序排列；Executor 按 ref 排列。筛选和排序后的完整结果参与指纹。每次续页重新读取实时列表：匹配结果改变时返回 `CURSOR_EXPIRED`，调用方重新查询。这不是持久快照，也不提供文件系统查询索引。

分页 cursor `p2.` 使用 32 字节范围 SHA-256、32 字节结果 SHA-256、6 字节 offset，Base64URL 后共 97 字符。保留完整校验，不复用 Core 的 96-bit 摘要来降低既有校验强度，不引入短 ID 服务或进程内映射。旧 `pragma.cli.cursor.v2.` 没有结果指纹，无法证明稳定性，明确过期并要求重启查询；其他未知格式无效。cursor 是可重建查询状态，不是持久用户数据。事件 watch/replay cursor 及其迁移链保持不变。

CLI 默认请求 Mission summary/result v2（含 nullable title）；`--query-version 1` 协商原严格 v1。旧 v1 DTO 保持不变，严格消费者可以继续请求 v1，或根据 schemaVersion 更新 parser。`--recent-input` 从 timeline 尾部读取最近的持久输入，按 Unicode code point 限长并报告截断，不调用模型。该输入可能仍在队列中，当前执行仍由 execution/queue 字段说明。历史缺少标题返回 null，不使用 ID 假装标题。

`--output-view full` 保留 CLI result/event v2 的 envelope、状态校验及 stream.end.result；`--output-view compact` 显式选择 v3，完整结果仅出现一次，结束记录只保留状态、退出码、诊断与恢复字段。查询成功与任务执行成功是不同事实。持久事件保留真实 replay 元数据。问题、选项、答复值、错误和恢复 ID 不按普通正文预算裁切；现有 question contract 使用问题文本作为 answers key，不制造不存在的 question ID。

text/compact 的大结果、事件和队列正文使用 `pragma.mission-content-reference/v1`。结果投影升级为 v3、事件投影升级为 v2；原始最终结果继续是权威事实，没有自动摘要或历史拼接。`mission get --view content` 读取绑定完整内容指纹的 UTF-8 字节范围 `[start,end)`；结构化值及非 well-formed 字符串使用 utf8-json 编码，全部分段合并后再 JSON.parse。变化返回 CURSOR_EXPIRED，删除/消费/保留窗口清理导致引用不可用时返回 NOT_FOUND。引用不授予额外权限。正文预算是每页/每结果的预算，不包括必须完整的协议字段与交互/错误。

原来不持久化的大 scalar/array Runtime 事件，在选择有界展示时先记录为 `pragma.mission-event-scalar/v1` 数据，再发布恢复引用。已有事件记录不改写，旧完整展示的行为不变；通用事件 data 是开放的 JSON 对象，新增数据族不改变 aggregate/events 的存储版本。标题、正文和分页改造不触碰 #396/#397 的存储修复。

## 有限等待与进程归属

`run --wait-timeout`、`run --detach` 及支持等待/分离的 send、steer、respond、interrupt、queue steer，在默认 CLI composition 中由一次调用专属的 owner 子进程执行。子进程复用已有 Local Host，先返回持久 receipt，再等待执行结束，最后通过已有 dispose 路径关闭资源。它不是常驻 daemon，不引入第二套任务控制器；Kernel 继续负责租约、fencing、权限和幂等。Worker bootstrap 复用同目录 cli.js，避免复制整份 Runtime bundle。

超时后调用方断开 IPC 并退出，owner 保持独立进程生命周期。返回 accepted/exit 0、waitExpired、Mission ID、可得的 Execution/operation 标识与状态、当前观测及查询/等待入口。accepted 不表示执行成功。--ack-timeout 仍表示命令确认时限；wait-timeout 从持久 receipt 后限制执行观察。相同 request ID 与语义 payload 重试复用已有执行，改变 payload 仍冲突。启动确认不确定时报告原 request ID，不能另建 UUID 盲目重试。

有限等待默认把问题返回给调用方，不等待 TTY；与 --interactive always、--detach 的组合明确拒绝。现有非有限等待的 TTY 行为保留。Worker 不自动批准动作。run 的显式 Ctrl-C 仍取消；watch 超时或 Ctrl-C 只停止观察，保留 cursor，不 claim 或取消任务。注入的嵌入式 Host 或显式 onBeforeExit 生命周期钩子继续由调用者拥有；停止等待不会 dispose 它。mission resume 的既有独立恢复语义不在本次进程改造中替换。

## 兼容、迁移与回滚

- 无 Mission、aggregate、journal 或 DSL 版本升级；不扫描或改写历史数据。
- v1 查询和 v2 完整输出保持可协商；新的视图使用独立版本标签。旧严格 GET 消费者需加 --query-version 1，或升级到语义 v2 parser。
- 回滚 CLI 后可以重新获取列表 cursor；已有事件回放 cursor 保留原规则。回滚前先结束或显式中断活跃的 owner，避免不同应用版本交替拥有同一任务。
- 新增 scalar 数据族只使用现有开放事件 data，并保留原始 value；旧读取器仍可作为普通事件对象读取。没有删除或降级历史事实。
- 必须保留问题/错误完整性；无法绑定内容的读取必须明确诊断，不伪造结果。

## 验证

计划及逐项证据见 [实施清单](../plans/issue-398.md)。真实子进程回归验证调用方自然退出、Host 后续持久化结果和幂等重试一次 start；执行器端口为确定性 fixture，不冒充真实模型 Runtime smoke。正式平台发布前仍执行 macOS/Windows 与实际 Runtime 的业务 smoke。

固定数据的输出基准见 [JSON 证据](../plans/issue-398-output-evidence.json)，由旧/新 presenter 和统一 o200k_base tokenizer 产生；它衡量获取相同事实的输出与调用数，不是生产模型成本预测。
