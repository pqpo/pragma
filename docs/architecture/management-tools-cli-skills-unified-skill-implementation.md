# 管理 CLI 统一 Skill 实施记录

2026-10-09，Issue #368 三阶段实施后的用户补充要求：六个内置 Skill 合并为一个
`manage-pragma`。46 条 CLI 管理命令与 Pi 默认 13 个工具保持不变。

## 入口与内容

主 `SKILL.md` 保留六组工作流导航、Execution 授权、审批、请求身份、冲突和恢复规则。
DSL、Flow、Evaluation、Mission、资源发现、Automation 的详细流程进入六份 references；
原领域 Schema、示例与操作说明进入对应子目录。链接按新的相对路径修复，旧 Skill
目录和旧 UI metadata 删除，不维护第二份正文。默认 Agent 只绑定统一入口；工作台目录
只展示 Manage Pragma，文件阅读与 mutation 拒绝继续使用已有静态源和 Host 边界。

## 单一身份

统一入口使用 `capability:1h2j3k4m5n6p7q8r`。用户明确确认该版本尚未发布、不需要兼容，
因此删除其他五个 Capability 定义、旧 ID 解析和历史多绑定去重。注册、Bundle 和目录
只有一个 Skill 身份，不保留迁移期别名或适配分支。

没有改变存储或 wire Schema，也没有增加升级脚本或自动清理本地实验数据。旧 ID 不再由
内置注册表解析。内容 hash 与编译 fingerprint 随静态文件改变，原物化缓存仍按 hash
隔离。命令 handler、受控通道、grants/hooks、授权、审批、幂等恢复与原用户 CLI 均复用
三阶段实现。

## 验证

- Built-in Agents 完整测试：8 文件、68 项通过；包括唯一默认 Skill、物化、显式
  工具绑定、领域规则与 YAML 示例。
- Desktop 定向测试：3 文件、63 项通过；包括目录、文件读取、禁止编辑、
  所有管理命令集成和默认零管理工具时的真实授权通道装配/撤销。
- 合并入口时 `pnpm check` 与完整 `pnpm build` 通过，Desktop main/preload/storage-worker/
  样式验证通过。随后移除未发布版本兼容，再次通过 Built-in Agents 的 lint、typecheck、
  build、完整测试及上述 Desktop 定向回归；未重复整个发行矩阵。
- Skill Creator validator 通过；所有 Markdown reference 链接均指向存在的文件。
- 真实 Codex Runtime：读取 manage-pragma 与 Missions reference，执行
  `pragma manage mission list --format json`，Host receipt 为 succeeded，模型可见 managed
  tools 为两个 Revision 调用。三个 native exec_command 调用、46.036 秒；上报 input 512、
  cacheRead 16,256、output 209。此为读取/发现 smoke，没有重跑六组完整模型业务链路。

## 成本与门禁

使用 Core RuntimeTokenCounter/o200k_base，同一 frontmatter name + description 口径，
索引参考量从六 Skill 合计 206 tokens 降到一个 Skill 的 34 tokens；主 SKILL.md 含
frontmatter 为 499 tokens。该口径不包含 Core 完整索引格式或供应商包装，不证明真实
任务输入减少；按需读取 references 和模型行动仍影响实际成本。

三阶段成本与 Runtime 结论对应测试时的六 Skill 配置，完整证据与逐项估算不提交仓库。本轮没有重跑真实
Electron UI、所有 Runtime、签名发行和平台矩阵；前一轮记录的发行、性能、真实审批/
恢复及 Runtime 未通过门禁继续有效，不因 Skill 合并宣称 Issue #368 全部完成。
