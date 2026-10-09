# 管理 CLI 统一 Skill 实施记录

2026-10-09，Issue #368 三阶段实施后的用户补充要求：六个内置 Skill 合并为一个
`manage-pragma`。46 条 CLI 管理命令与 Pi 默认 13 个工具保持不变。

## 入口与内容

主 `SKILL.md` 保留六组工作流导航、Execution 授权、审批、请求身份、冲突和恢复规则。
DSL、Flow、Evaluation、Mission、资源发现、Automation 的详细流程进入六份 references；
原领域 Schema、示例与操作说明进入对应子目录。链接按新的相对路径修复，旧 Skill
目录和旧 UI metadata 删除，不维护第二份正文。默认 Agent 只绑定统一入口；工作台目录
只展示 Manage Pragma，文件阅读与 mutation 拒绝继续使用已有静态源和 Host 边界。

## 历史身份

统一入口沿用原 DSL Capability ID `1h2j3k4m5n6p7q8r`。其余五个既有 Capability ID
保留在静态权威 ref 表中，供历史 Project/Revision、定制 Expert 和显式 binding 解析，
全部指向同一份 `skills/manage-pragma`。旧名称仅保留在这些身份的资源 metadata，避免
Bundle 的名称唯一性冲突；它们不会作为额外入口出现在默认 Skill 或工作台列表中。

没有变更存储或 wire Schema，也不扫描、重写或删除历史 Project。内容 hash 与编译
fingerprint 随静态文件改变，原不可变物化缓存继续按 hash 隔离。定制 Pragma 的历史六 Skill binding 在编译物化副本中
归一到一个入口，调用方对象和持久化 Project 不改写，避免重复注入同一内容。历史绑定的物化、真实
CapabilityStore 读取及只读拒绝均有回归覆盖。命令 handler、受控通道、grants/hooks、
授权、审批、幂等恢复与原用户 CLI 均复用三阶段实现。

## 验证

- Built-in Agents 完整测试：8 文件、70 项通过；包括唯一默认 Skill、历史身份物化、六绑定去重、显式
  工具绑定、领域规则与 YAML 示例。
- Desktop 定向测试：3 文件、64 项通过；包括目录、文件读取、禁止编辑、历史身份读取、
  所有管理命令集成和默认零管理工具时的真实授权通道装配/撤销。
- `pnpm check` 与完整 `pnpm build` 通过，Desktop main/preload/storage-worker/样式验证通过；
  最后补充的历史多绑定归一逻辑另通过 Built-in Agents 的 lint、typecheck、build 和完整测试。
- Skill Creator validator 通过；所有 Markdown reference 链接均指向存在的文件。
- 真实 Codex Runtime：读取 manage-pragma 与 Missions reference，执行
  `pragma manage mission list --format json`，Host receipt 为 succeeded，模型可见 managed
  tools 为两个 Revision 调用。三个 native exec_command 调用、46.036 秒；上报 input 512、
  cacheRead 16,256、output 209。此为读取/发现 smoke，没有重跑六组完整模型业务链路。
  [原始结果与 receipt](management-tools-cli-skills-unified-skill-runtime-evidence.json)。

## 成本与门禁

使用 Core RuntimeTokenCounter/o200k_base，同一 frontmatter name + description 口径，
索引参考量从六 Skill 合计 206 tokens 降到一个 Skill 的 34 tokens；主 SKILL.md 含
frontmatter 为 499 tokens。该口径不包含 Core 完整索引格式或供应商包装，不证明真实
任务输入减少；按需读取 references 和模型行动仍影响实际成本。
[合并后独立静态估算](management-tools-cli-skills-unified-skill-token-estimate.json)。

原三阶段报告与成本/Runtime/UI 证据仍保留测试时的六 Skill 配置。本轮没有重跑真实
Electron UI、所有 Runtime、签名发行和平台矩阵；前一轮记录的发行、性能、真实审批/
恢复及 Runtime 未通过门禁继续有效，不因 Skill 合并宣称 Issue #368 全部完成。
