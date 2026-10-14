# Issue #398：CLI Agent 工作流实施清单

基线：`1cec48eba13590094c6ac0ddcd61dad3d01598ba`。
每项必须先实现，再验证并记录证据，最后勾选；未通过的项目保持未勾选。

- [x] 1. 队列分页与显式列表契约：Host 接收分页参数；小 limit 可跨调用读完；错误范围明确拒绝。
- [x] 2. Mission 语义：标题、最近输入摘要、历史缺失、严格 v1 兼容。
- [x] 3. 续页文本：cursor 只出现一次；筛选和 shell 转义保持完整。
- [x] 4. 交互信息：完整问题、选项、提交值和回答格式；非交互无终端读取。
- [x] 5. Board：字节范围、截断与续读；描述；max-bytes 与 offset 兼容。
- [x] 6. Executor 输入说明与字符串原文：按需 Schema、最小示例、多行结果。
- [x] 7. Host 搜索与稳定分页：标题/workspace 筛选；变化使 cursor 明确过期。
- [x] 8. 紧凑 cursor：跨进程、范围与指纹校验、旧 cursor 策略、Token 对比。
- [x] 9. 精简输出协议：显式新视图；正文一次；保留 JSON/JSONL v2。
- [x] 10. 有界正文：明确截断、续读与完整结果语义。
- [x] 11. 有限等待：超时不取消、可靠 owner 生命周期、恢复与幂等。
- [x] 12. 文档/Skills/收益/门禁：完整工作流与共享内核、check、build。

## 验证记录

实施开始前已确认：两条队列项在 limit=1 时没有 nextCursor；JSONL command.result 与 stream.end 重复完整 result。

### 1. 队列分页（通过）

Local Host pagination/application：13 测试通过；CLI readonly：27 测试通过。相关 ESLint、CLI typecheck、依赖图 15 个 package build 通过。跨新 Host 实例续页、完整包装返回值、范围不匹配、列表变化均覆盖。

环境：锁文件安装的 Qoder Worker 下载超时；使用 frozen-lockfile --ignore-scripts 恢复依赖。未更改锁文件；真实 Qoder Runtime 未验证。

### 2. Mission 语义（通过）

Mission query：14 测试通过；CLI readonly：28 测试通过。相关 lint、CLI typecheck、Shared build 通过。保留 Host 默认 v1；CLI 默认请求 v2，--query-version 1 可显式使用旧契约。--recent-input 按需从 timeline 读取，历史标题 null，Unicode 摘要明确截断。Desktop 同样注入 timeline 读取端口。

### 3. 续页文本（通过）

CLI readonly：28 测试通过；相关 lint 通过。Continue 保留 status/limit 等参数，cursor 恰好出现一次。

### 4. 交互信息（通过）

CLI interaction/terminal/watch/mutations/run：41 测试通过，typecheck 与 lint 通过。run/get/watch 共用完整 envelope 展示，question 文本是现有 answers key（不伪造 question ID）；缺失时提供只读查询入口，审批不预填批准。

### 5. Board（通过）

CLI readonly/parser：31 测试通过；文件系统 UTF-8 range：13 测试通过。中文/emoji 分段重建完整正文；部分范围明确显示 [start,end)、总字节和续读命令。相关 typecheck、lint 通过。字节预算不足以读完一个字符时返回可操作错误，避免原地循环。

### 6. 输入说明与原文（通过）

CLI Schema/readonly/run：41 测试通过；typecheck、lint 通过。必填输入模板按深度与字段数有界，复杂引用提示完整 Schema；模板明确要求替换占位符并验证。多行最终结果按原文输出。

### 7. Host 搜索与稳定分页（通过）

Host list/application/pagination：15 测试通过；CLI readonly：30 测试通过，mutations 回归通过；CLI typecheck、相关 lint 通过。筛选/排序/分页位于 Local Host；生产 Host 提供 queryMissions/queryExecutors/querySharedBoard/queryMissionQueue。列表为实时重新读取、内容指纹绑定的分页：匹配结果变化明确过期，不宣称快照。

### 8. 紧凑 cursor（通过）

Host cursor/list：4 测试通过；完整 256-bit 范围与结果指纹校验，97 字符，无进程内映射。旧 CLI v2 cursor 明确 CURSOR_EXPIRED 并要求重新查询；事件 replay cursor 未改。统一 o200k_base tokenizer 最终固定场景实测：cursor 176→97 字符、107→65 Token；续页入口 416→147 字节、230→77 Token。复现脚本 apps/cli/scripts/issue-398-output-evidence.mjs。

### 9. 精简输出协议（通过）

CLI compact/readonly/run/watch：51 测试通过；typecheck、lint 通过。--output-view compact 显式选择 v3；full 保持 v2，包括历史 stream.end.result。compact 正文按 execution/result 去重，结束保留状态、退出码、恢复 cursor；持久事件保留 eventId/时间/replayable；解析错误使用所选视图。

### 10. 有界正文（通过）

Host query/watch/run/catchup/content：52 测试通过；CLI compact/readonly/watch/run：52 测试通过；typecheck、lint 通过。结果 v3 和事件 v2 使用明确的 content reference；mission get --view content 读取原始字符串或 JSON 字节范围。引用由完整内容指纹绑定，无落盘迁移；队列消费/删除后明确 NOT_FOUND。问题、选项及错误不按正文预算裁切。full JSON/JSONL 保留完整协议；text/compact 按需读取正文/Schema。

### 11. 有限等待与 owner（通过）

CLI owner process/readonly/watch/mutations/run：65 测试通过；Host watch：15 测试通过；typecheck、lint 通过。真实客户端子进程超时后自然退出，独立 owner 子进程通过共享 Local Host 完成并持久化结果；相同 request ID 重试仅一次 executor start。执行器在该回归中是确定性端口，并非真实模型 Runtime。watch 超时不改变租约或事件；wait-timeout 与 ack-timeout 分开，超时 receipt 为 accepted/exit 0，明确 waitExpired 与恢复入口。

### 12. 文档、收益与最终门禁（通过）

更新 CLI 使用文档、Agent 工作流、manage-pragma 的外部 CLI 参考和 ADR 071。固定场景使用 Core RuntimeTokenCounter 的 o200k_base tokenizer；找任务/回答/Board 工作流输出 Token 分别减少 67.7%、43.7%、39.2%，JSONL 查询由 347 降至 175 Token。最终代码再次运行基准，与保存的 JSON 证据完全一致；不把固定路径的输出收益视为真实模型成本预测。详细数据见 [输出基准](issue-398-output-evidence.md)。

最终门禁全部通过：

- `pnpm check`：lint、typecheck 和核心测试通过。
- `pnpm build`：19 个任务通过；Desktop 打包 Host 存储 worker 能启动并持久打开 receipt 数据库。
- `pnpm test:local-host-kernel`：106 个 Host 测试文件，970 项通过、1 项跳过；文件锁另有 22 项通过。
- 完整 CLI 适配器：20 个文件、139 项通过，包括真实客户端退出和 owner 持续执行的回归。
- npm 包构建与审计通过，包含包内 owner 的真实 IPC 启动检查；worker bootstrap 复用 cli.js。
- Built-in Skill 校验 6 项、UTF-8 文件读取 13 项、精简契约负例及有界内容回归通过；格式与 `git diff --check` 通过。

最后复核修正了未提供 event ID 的 Runtime 事件：实时输出现在使用真正持久化的 event ID，避免 replayable 事件引用合成 ID；相关回归 15 项通过，并重新完成上述检查、构建、内核及 CLI 门禁。

验证范围：真实子进程回归使用确定性 executor 和生产 Local Host 存储；真实模型 Runtime 以及 macOS/Windows smoke 尚未执行，正式平台发布前仍需验证。Qoder Worker 下载超时，使用 frozen-lockfile --ignore-scripts 恢复依赖，锁文件未变；没有执行发布。

## CR 后最终验证

13 组复核确认的问题已全部修复，见 [CR 记录](issue-398-review.md)。在包含 main #400 修复的新基线上，最终 check/build、共享内核（985 通过、1 跳过，文件锁 22 通过）、CLI adapter（158 通过）、npm 包 owner 启动审计均通过；输出基准精确复现。补充覆盖并发事件的精确 cursor、owner 输入错误契约，以及 receipt 清理期间 queued/applying 命令的原子 lease 保留。
