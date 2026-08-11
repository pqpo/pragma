# Runtime Adapter 接入清单

本文是新增 Runtime 或提升既有 Runtime capability 时必须逐项完成的接入闸门。它补充 Core 的
`RuntimeAdapter` 类型约束：类型能保证接口形状，但不能证明供应商事件、配置发现、权限和资源释放在真实
Runtime 中工作。

## 状态与证据规则

每一项必须标记以下一种状态，不允许留空或仅写“待验证”：

- **Supported**：已接通，具有代码位置、自动测试和真实 Runtime 验证证据。
- **Degraded**：有明确降级行为，用户可观察，能力声明不夸大；同样需要自动测试和真实验证。
- **Unsupported**：供应商公开接口不支持或本 Adapter 尚未实现；必须 fail closed 或给出可操作诊断。
- **N/A**：该 Runtime 的产品形态不适用，并说明原因。

每项证据至少包含：实现文件、自动测试、已验证 Runtime 版本/平台/日期、脱敏后的真实 wire fixture 或 smoke
记录。配置文件存在、mock 进程成功和 capability 布尔值都不能单独作为 Supported 证据。MCP 必须完成一次
真实工具发现与调用；streaming 必须在 terminal result 前观察到增量事件；Skill 必须实际影响一次模型行为或
出现明确的发现日志。

## 证据优先的 Harness 适配方法

Runtime Adapter 对接的主要风险不是接口形状，而是供应商 CLI 的实际加载时序、静默降级和版本漂移。新增
Runtime 时先建立证据，再实现能力：

1. 固定 Runtime 版本、平台、认证模式和隔离模式，脱敏保存 `--help`、`--version`、模型发现输出、实际
   argv、stdout/stderr、供应商日志及可恢复会话标识；不得只依据官网示例或另一个版本推断。
2. 将 availability/auth、stream、native tool、MCP、Skill、attachment、fresh/resume、compaction、cancel
   拆成独立小探针。每个探针只证明一个能力，失败时能直接定位到发现、权限、协议或生命周期层。
3. 对所有注入能力分别验证三个层次：**Materialized**（文件或参数已生成）、**Discovered**（Runtime 日志或
   初始化事件确认已加载）、**Executed**（真实行为成功）。只有 Executed 可以标记 Supported。
4. 不把退出码 `0` 当作语义成功。还必须验证 terminal event、非空或合法输出、实际选择的 Agent/模型、工具
   完整生命周期，以及日志中不存在 silent fallback、provider error、内部 timeout 或权限 soft-deny。
5. 公开 stdout/event stream 是主协议；受管日志是独立诊断证据。只有主协议缺失终态且日志能够确定当前轮
   边界时，才允许从日志或 transcript 做可观测的 Degraded 恢复，不能用轮询 transcript 伪造 streaming。
6. 先保存真实 wire fixture，再写归一化代码。未知事件必须经过脱敏后可观察；不能因为 parser 忽略未知
   payload 而让协议漂移表现为“成功但没有正文/工具卡片”。

### Antigravity 1.1.11 复盘

本次修复最初表现为“长时间 loading 后一次性出现正文”，但真实根因横跨多个独立契约：

| 现象                                    | 真实原因                                                                                               | 后续 Runtime 必查项                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 正文只在最后出现                        | `agent_response` 的 `ACTIVE`/`DONE` `text_delta` 未归一化                                              | 用真实长回答证明首个 delta 早于 terminal result，并测试最终 snapshot 去重     |
| custom Agent 已物化却使用 default Agent | print mode 在附加 workspace plugin 发现前解析 `--agent`，未知名称静默回退                              | 同时验证配置、发现日志和最终选中身份；silent fallback 必须失败                |
| MCP 配置存在但调用为 `unknown tool`     | workspace 顶层配置不是 1.1.11 的有效发现路径                                                           | 必须让 Runtime 真实发现 server 并完成一次无副作用调用                         |
| Skill 文件存在但不可用                  | agent-relative 路径缺少 `AgentBasePath`；Skill 是 slash expansion；禁用 slash command 会连带禁用 Skill | 验证真实调用入口、展开日志、支持文件读取和最终行为，不能只检查 `SKILL.md`     |
| Skill 展开后仍被拒绝                    | 展开过程用原生只读工具访问 Session plugin，权限 containment 只允许 Expert workspace                    | 分离 Expert workspace、受管 customization 根和只读 Skill 根的权限语义         |
| Hook 已返回 allow 但工具仍 soft-deny    | Runtime 还执行第二层 non-interactive confirmation                                                      | 分别探测 Hook 决策、Runtime 原生确认和 sandbox，不假设一个 allow 已完成授权   |
| 合法 workspace 被 Hook 拒绝             | Runtime 实际上报绝对路径、`file://` URI和附加 workspace                                                | 用真实 payload 验证 workspace identity，不从单一 mock 形状推断                |
| 私有 HOME 与登录态冲突                  | 交互 OAuth 依赖 host keyring，替换 HOME 后无法读取认证                                                 | 认证探针必须与最终进程环境一致，并明确隔离模式与兼容模式的继承边界            |
| Usage 恰好变成两倍                      | 同一个 terminal snapshot 同时走 native usage event 和 turn result，Core 合并时求和                     | 为每类 observation 指定唯一所有者，并用完整 Driver 集成测试核对最终 Usage     |
| 带附件时显式 Skill 失效                 | Core 在原请求前加入路径上下文，Adapter 仍只匹配整个 query 的首字符                                     | 针对 image/file/directory 验证受控 request 区段和 slash rewrite 的组合        |
| 用户批准后仍可写出 workspace            | 只在审批前或只对只读工具做 containment，修改后的最终参数未重新校验                                     | 文件工具按真实参数 schema 在审批前后验证；缺字段、URI、symlink 均 fail closed |
| 工具卡片一直 running 或错报成功         | 拒绝状态和 `tool_info.error` 没有进入 terminal/failure 判定                                            | fixture 必须覆盖 completed、failed、rejected/denied 和 DONE-with-error        |
| close 时 Hook/MCP 先消失                | native process 与 control-plane disposer 并行执行                                                      | 两阶段关闭：先有界停止 native，再在 finally 中聚合释放 registration/relay     |
| 缺 terminal 时返回半截正文              | 任意 ACTIVE delta 被当成完整 fallback，覆盖了 transcript 中已 settled 的答案                           | fallback 优先当前轮 settled transcript；纯 stream 只有明确 DONE 才能完成      |

这次经验说明 system prompt、startup message 和 compaction 也必须按生命周期验证：system prompt 的发现机制
必须在每次 native turn 有效；startup message 要分别证明 fresh 首轮注入、resume 不重复以及 compaction 后按
Core 预算重注入，不能用“首轮回答符合预期”替代这三个场景。

## 当前 Runtime 实现导航

下表只比较代码中已有的实现路径，不是 capability 验收记录，也不能据此声明 Supported。`I` 表示代码中有
实现，`G` 表示代码中有明确降级，`U` 表示未实现，`N/A` 表示不适用。每个 Runtime 仍必须把后面的清单复制
到自己的设计或验收记录中，按本文开头的 Supported / Degraded / Unsupported / N/A 规则逐项附证据；没有
版本、平台、日期和真实 smoke 的 `I` 只能视为待验收实现。

| 能力面                        | PI                | Codex             | Claude Code       | Qoder CLI         | Antigravity CLI 1.1.11                       |
| ----------------------------- | ----------------- | ----------------- | ----------------- | ----------------- | -------------------------------------------- |
| availability / auth           | I                 | I                 | I                 | I                 | I，ADC 私有 HOME；OAuth host-keyring         |
| 模型发现、选择、thinking      | I                 | I                 | I                 | I                 | I，来自 `agy models`                         |
| system / startup prompt       | I                 | I                 | I                 | I                 | I，plugin always-on rule + 首轮边界帧        |
| fresh / resume / Session 隔离 | I                 | I                 | I                 | I                 | I；host-keyring 原生 conversation 为兼容边界 |
| 真实增量 streaming            | I                 | I                 | I                 | I                 | I，`agent_response.text_delta`               |
| thought / reasoning           | I                 | I                 | I                 | I                 | I，按公开 step event                         |
| native tool lifecycle         | I                 | I                 | I                 | I                 | I，`tool_info` ACTIVE/DONE/失败/拒绝         |
| Pragma MCP tools              | I                 | I                 | I                 | I                 | I，Session 私有 plugin MCP                   |
| 权限 / 用户审批 / 问答        | I                 | I                 | I                 | I                 | I，PreToolUse relay；三种权限模式            |
| Skills                        | I                 | I                 | I                 | I                 | I，Session plugin + 显式 slash invocation    |
| 图片原生输入                  | 按模型            | 按模型目录        | 按模型目录        | G，本地路径上下文 | G，本地路径上下文                            |
| 文件、目录引用                | I                 | I                 | I                 | I                 | I，文本路径上下文                            |
| structured output             | I，Core 校验/重试 | I，Core 校验/重试 | I，Core 校验/重试 | I，Core 校验/重试 | I，Core 校验/重试                            |
| usage                         | I                 | I                 | I                 | I                 | I，CLI reported 单通道、Core fallback        |
| context window / compaction   | I                 | I                 | I                 | I                 | G，无可靠 denominator；支持 compaction event |
| cancel / close / error        | I                 | I                 | I                 | I                 | I，TERM/KILL、严格 NDJSON、退化恢复          |

代码导航：`packages/runtime/<name>/src/adapter.ts`、`models.ts`、`session.ts` 及对应 `test/`；Antigravity 的
特殊认证和 customization 边界见
[`docs/architecture/antigravity-cli-runtime.md`](../architecture/antigravity-cli-runtime.md)。模型目录中的
每模型 `thinkingLevels` 与 `inputModalities` 是模型能力的唯一事实来源；不要在 descriptor 上新增未进入
Core 正式类型、没有消费者的旁路字段。

本次 Antigravity CR 的自动证据包括脱敏的 1.1.11 NDJSON fixture、权限/物化/生命周期单测和默认跳过的
`real-smoke.test.ts`。仅看到本矩阵中的 `I` 或默认测试通过，不能推断真实 smoke 或 Desktop 验收已经执行。

本次真实 CLI 验收记录：2026-08-11，Darwin 25.5.0 x86_64，`agy 1.1.11`，`host-keyring` 认证模式；运行：

```bash
PRAGMA_ANTIGRAVITY_REAL_SMOKE=1 \
  PRAGMA_ANTIGRAVITY_SMOKE_AUTH_MODE=host-keyring \
  pnpm --filter @pragma/runtime-antigravity exec vitest run test/real-smoke.test.ts --reporter=verbose
```

结果 1/1 通过（57.38 s）。该记录实际证明首个 delta 早于 result settle、`list_dir` lifecycle、managed
`list_expert_context` MCP、always-on system marker、带图片附件的 namespaced Skill、路径降级和 conversation
resume。Desktop 正文/thought/工具卡片/审批/取消/错误提示的人工验收本次未执行，不能据此声明 Desktop
end-to-end 已验收；compaction 后 startup reinjection 当前由 Core 自动测试证明，不冒充真实 CLI compaction
smoke。

## 逐项接入检查

复制下面清单到 Runtime 的设计文档或 PR 描述，逐项填写 `状态 / 代码 / 自动测试 / 真实验证`。

### 1. 可用性、版本与认证

- [ ] 可执行文件或 SDK 的解析顺序明确，Windows launcher/shim 行为经过验证。
- [ ] 最低/最高兼容版本、版本 parser、超时和缓存边界明确；不支持版本给出可操作错误。
- [ ] 未安装、未登录、凭据过期、网络不可用和 provider 拒绝均有稳定错误分类。
- [ ] 认证材料不复制到 workspace、不进入日志、不通过 Agent 子进程环境泄漏。
- [ ] 真实 smoke 记录 Runtime 版本、OS/架构与认证模式，不记录 token、cookie、用户名或主目录细节。

### 2. 模型目录与选择

- [ ] 模型来自真实 discovery API/CLI；若静态维护，声明更新与过期策略。
- [ ] provider/model id 作为不透明值往返，不从 display name 猜 selector。
- [ ] 默认模型、显式模型、未知模型和 catalog 不可用行为经过测试。
- [ ] 每模型 thinking level 与 input modalities 准确，选择在启动前校验。
- [ ] descriptor 只声明 Core 已定义且有消费者的 Runtime 级 capability。

### 3. Prompt 与 Session

- [ ] Core 组装后的 system prompt 字符不丢失、不重复、不混入用户消息。
- [ ] startup messages 在 fresh Session、resume 和 compaction 后的注入次数明确且有测试。
- [ ] 当前请求、历史消息和结构化输出修复 prompt 的边界不会产生角色混淆。
- [ ] Session id 从真实协议捕获，fresh/resume 一致；未知、非法或串号 id fail closed。
- [ ] Runtime HOME/config/state/tmp/log 与 Expert workspace 的职责、权限和持久化 owner 明确。

### 4. Streaming 与事件归一化

- [ ] 使用公开协议的真实增量事件，不用延迟切片、打字机动画或重复最终文本伪造 streaming。
- [ ] 脱敏 fixture 覆盖 UTF-8 分块、增量、snapshot、terminal result、空输出和 malformed frame。
- [ ] `message.delta` 在 terminal result 前到达；最终 snapshot 与已流增量去重。
- [ ] thought、progress、session、usage、compaction 与未知事件均映射且未知 payload 经脱敏。
- [ ] event schema/行大小/缓冲区有界，供应商协议变化不会静默吞掉正文。

### 5. 工具、MCP、权限与用户交互

- [ ] tool started/delta/completed/failed 使用真实事件 fixture，id 与 name 在完整 lifecycle 中稳定。
- [ ] 拒绝、供应商错误、参数修改和用户问答不会被误报为成功工具调用。
- [ ] MCP 仅暴露当前 Expert allowlist，server/工具 namespace 按 Session 隔离。
- [ ] MCP smoke 必须发现并完成一个无副作用工具；只验证配置落盘不算通过。
- [ ] request-approval、auto-approve、full-access 三种模式分别覆盖 native tool、shell、网络和 MCP。
- [ ] workspace identity 支持供应商真实上报形态；路径 containment 处理 URI、相对路径、大小写和 symlink。
- [ ] Hook/relay secret 仅保存在 Session 私有文件，异常和 relay 关闭一律 fail closed。

### 6. Skills 与 customization

- [ ] Skill 使用供应商公开支持的发现布局，复制完整目录并排除依赖缓存/敏感文件。
- [ ] 名称冲突、frontmatter、可执行权限、重复 prepare、解绑和 stale 文件清理有测试。
- [ ] 真实 smoke 证明 Skill 被发现且执行；日志不得有路径解析或 base path 错误。
- [ ] 不扫描、不复制宿主全局 customization；兼容模式下 unavoidable 的继承行为明确披露。
- [ ] workspace 自带 Hook/MCP/plugin 的信任边界明确；无法安全治理时在 spawn 前 fail closed。

### 7. Attachments 与多模态

- [ ] image/audio/video/file/directory 分别标记 Supported、Degraded、Unsupported 或 N/A。
- [ ] 原生媒体必须使用供应商公开参数/SDK，且真实 smoke 验证二进制确实进入模型请求。
- [ ] 文本模型通过 Core 的路径上下文降级并记录 `runtime.image_input_degraded`，不得静默丢弃附件。
- [ ] 路径上下文包含用户可识别名称和受控本地路径，不读取或 base64 内联未获授权的文件。
- [ ] capability 与模型 `inputModalities` 保持一致；不能因模型本身支持图片就假设 CLI 支持上传。

### 8. 输出、Usage 与 Context

- [ ] structured output 由 Core schema 校验/重试；Runtime 不私建不一致的 JSON repair 协议。
- [ ] terminal usage 是 snapshot 还是 delta 已确认；thinking/cache 不重复计数。
- [ ] 精确 usage 优先；缺失时只调用 Core `RuntimeTokenCounter`，并标记 estimated。
- [ ] context window numerator/denominator 来源可靠；未知时返回 unknown，不伪造百分比。
- [ ] 自动/手动 compaction 的 started/completed/failed 事件与 startup reinjection 协同经过测试。

### 9. 生命周期、持久化与安全

- [ ] abort 在生成、工具等待和用户审批期间均生效；升级到强杀的超时有界。
- [ ] close 幂等释放进程、MCP registration、registry lease、Hook relay、listener 和临时资源。
- [ ] 多资源释放使用聚合错误，不因第一个失败跳过后续清理。
- [ ] Runtime Session 由 `PragmaPaths` 和 owner 管理；恢复不扫描宿主 Session 树。
- [ ] 持久 schema/version 遵循 ADR 019 的迁移、fixture、journal 与未来版本拒绝规则。
- [ ] stdout/stderr/log/progress 全链路脱敏，路径和错误消息不暴露 secret。
- [ ] Linux、macOS、Windows 的路径、信号、权限位和 executable 行为逐项标记。

### 10. 合入验证

- [ ] 定向 unit/integration tests、typecheck、lint、build 全部通过。
- [ ] 可显式运行、默认不依赖开发者登录态的真实 Runtime smoke suite 已记录运行方法。
- [ ] fresh 与 resume 各跑一次；长回答验证早于 result 的 delta；至少一个 native tool 和一个 managed MCP tool。
- [ ] Desktop 人工验收正文流、thought、工具卡片、审批、取消、错误提示和附件降级。
- [ ] 架构文档、模型能力和本矩阵同步更新；Unsupported/Degraded 对用户可见。

若真实 CLI smoke 暂时无法运行，相关项只能保持 Degraded 或 Unsupported，不能用 mock 测试提升为
Supported。提升 capability 时应把对应 smoke 作为同一改动的验收条件。

## Actions：缩短下一次 Runtime 适配周期

以下 Action 是后续工程方向，不代表当前仓库已经具备。完成时必须提交实现、测试和使用文档，并在本表更新
状态；不得仅因建了目录或脚本占位就关闭 Action。

| Action               | 优先级 | 后续工作                                                                                                                                        | 完成标准                                                                                                          |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `RUNTIME-ACTION-001` | P0     | 建设版本化 Runtime Probe Harness，将 version/help/models、stream、tool、MCP、Skill、attachment、resume、compaction、cancel 拆成可单独运行的探针 | 一条本地命令可选择 Runtime 和探针，生成脱敏证据包；失败能指出协议、发现、权限或生命周期阶段                       |
| `RUNTIME-ACTION-002` | P0     | 定义真实证据包格式和脱敏规则，按 Runtime/version/platform/auth mode 保存 argv 摘要、stdout NDJSON、stderr、诊断日志和预期断言                   | fixture 可由 parser 测试直接消费；路径、token、cookie、用户名和会话私密内容不可逆脱敏；保留协议字段形状           |
| `RUNTIME-ACTION-003` | P0     | 为注入能力建立 Materialized/Discovered/Executed 三段断言和 silent-fallback 检测                                                                 | system prompt、Agent、MCP、Skill 与模型选择均能报告实际激活身份；配置存在但未加载时 smoke 必须失败                |
| `RUNTIME-ACTION-004` | P1     | 抽取 Runtime 进程诊断基元：有界 stdout/stderr scanner、受管日志证据、terminal semantic-success classifier、取消与强杀升级                       | 至少两个 Runtime 复用；退出码 0 的空输出、内部 timeout、provider error 和缺失 terminal event 有稳定错误码         |
| `RUNTIME-ACTION-005` | P1     | 为 customization/materialization 增加 ownership receipt 或 manifest，记录 Adapter 创建的文件、目录、registration、relay 和 lease                | prepare/close 可重复；只清理当前 Session 拥有的资源；预存文件、并发新增文件和部分失败均不被覆盖或误删             |
| `RUNTIME-ACTION-006` | P1     | 把真实 smoke 拆成快速、单能力用例，并保留一个组合验收用例                                                                                       | 日常定位无需反复运行完整模型流程；组合用例仍覆盖 fresh/resume、长回答、native tool、managed MCP、Skill 和附件降级 |
| `RUNTIME-ACTION-007` | P1     | 建立 Runtime 版本升级审计流程，对公开协议、help、模型目录、事件 fixture 和 customization 加载日志做差异比较                                     | 升级最低支持版本或检测到新版本时自动生成差异报告；未知事件和已移除 flag 不会静默进入正式能力声明                  |
| `RUNTIME-ACTION-008` | P2     | 在适配调研模板中记录官方资料、真实 CLI 证据和外部实现的适用版本                                                                                 | 每个外部结论标注来源版本和“可借鉴/不可照搬”边界，不把旧版纯文本实现当作新版结构化协议基线                         |
| `RUNTIME-ACTION-009` | P0     | 为 Runtime event 与 turn result 定义 observation ownership 测试，重点覆盖 usage、session id、output snapshot 和 compaction                      | 每个事实只有一个累计通道；完整 Driver 测试能发现双计、重复正文和 Session identity 覆盖                            |
| `RUNTIME-ACTION-010` | P0     | 保存各版本真实 Hook/tool 参数 schema fixture，并生成文件工具路径字段、MCP dispatcher 与终态状态的 fail-closed contract tests                    | 供应商字段改名、缺失、非法 URI、namespace 前缀碰撞和审批后参数修改都不能绕过权限边界                              |

下一 Runtime 的推荐顺序是：先完成 `001` 的最小探针和 `002` 的证据包，再写 Adapter；随后逐能力完成
`003` 的行为断言，最后才进入 Desktop 组合验收。这样可以在第一轮就区分“协议不认识”“配置没发现”“权限
拒绝”和“资源未释放”，避免一个长 smoke 串行暴露多个问题。
