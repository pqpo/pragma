# Issue 399 共享运行配置交付与范围

本轮共享部署服务与 CLI 配置接线已完成。需求及范围调整见
[Issue 399](https://github.com/pqpo/pragma/issues/399)、
[维护者确认](https://github.com/pqpo/pragma/issues/399#issuecomment-6269368075)、
[PR 408](https://github.com/pqpo/pragma/pull/408) 与
[PR 409](https://github.com/pqpo/pragma/pull/409)。
原独立部署、Linux 和 Memory Headless 目标暂缓，不计作已完成。

## 最终交付

- Project、Capability、ContextStore、Plugin 写入，Bundle 安装/导出/恢复/绑定修复，模型连接和
  Runtime Environment 服务由 Local Host 共享，Desktop 使用同一服务；边界见
  [ADR 075](../adr/075-shared-deployment-and-environments.md)。
- CLI production composition 读取与 Desktop 相同的环境、模型连接、SecretRef 和设置。
  具体 Runtime 工厂仍由应用入口装配，复用既有 Mission application 和 owner。
- 新 Mission 使用保存的 Environment；已有 Session 保留原 Runtime identity。
  旧静态绑定只按历史证明读取，当前错误或未来 revision 不得回退成默认模型。
- 同一 OS 用户、同一 Pragma home 下，Desktop 配置并导入资源后关闭，CLI 可使用已有配置执行、
  查询并继续任务。`--detach` 仍只承诺持久入队，不承诺进程退出后持续执行。

## 必须保留的恢复与兼容边界

- 安装请求 UUID 与内容身份分离；publication receipt 和 journal 支持丢失回执/中断重放，
  revision CAS 防止覆盖并发修改。ready 与安装完成分开。
- 安装 v8→v9 保留静态相邻迁移、备份、journal 和真实历史 owner fixture，不改 Bundle/DSL 协议。
- 无 transaction 的历史失败安装仍进入恢复；清理受共用资源/资产引用保护，失败保留数据与诊断。
- 显式模型选择优先；缺少连接、锁定钥匙串、迁移要求和 Runtime 不可用准确报错。
- 新建 Mission 的事件已写入而 pin 未写入时，重试复用精确 Project/Revision；改变 payload 仍拒绝。
- 历史 RuntimeProfile 别名仅在持久 ID 不存在时使用；显式同名配置优先，删除后明确失败。
- PI context budget 参与 preparation 与缓存身份；设置存储沿用原迁移、锁、journal 和备份。
- stop-only 按持久权限选择 resolver，不准备工具/Memory，不重发 Native Invocation。

## 验证范围

2026-10-19 至 20 的本机工程验证包括 lint、typecheck、build、共享内核、CLI adapter、
Desktop 接线/UI、历史安装/设置迁移及 SIGKILL 恢复；各轮细项与构建 hash 从 PR 和 Git 历史追溯。
测试通过不能替代真实 Runtime、凭据与平台验收。

真实链路使用 macOS Intel、Node 23.11.0、Electron 43.7.6、隔离 home 与原生 Codex 认证：
Desktop 生产 container/IPC 导入后退出，构建的 CLI 使用 `openai/gpt-5.6-sol` 完成任务并独立查询结果。
还验证了 owner Worker、继续既有 Mission、修改前 CLI 创建的静态绑定 Session 恢复，原身份保持不变。
该链路使用自动化隐藏窗口，不代表人工 UI 验收；原始输出与凭据留在仓库外。

未新增真实 PI、Windows 或 ARM64 验收声明。阶段一业务测试曾超过八分钟目标，
CI 冷/暖缓存性能未验收；不能据此宣称性能达标。

## 暂缓范围

- 空 home 的 CLI 完整配置与独立部署、Bundle 管理/修复命令、可移植绑定、Linux、
  SecretStore 文件模式/helper、Web/云端沙箱和常驻后台进程。
- Memory/Embedding/Learning Headless。CLI 按策略保存 Evidence、提交持久提炼任务并召回已有记忆；
  提炼、索引维护与 Learning 继续由同一 home 的 Desktop 承载。入队不等于生成 Memory，
  Knowledge/Skill 发布仍需人工批准。
- Plugin 依赖 Bundle 继续采用既有拒绝策略；不新增第二套 Mission 内核。
