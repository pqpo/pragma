# Issue #438：CR 与复审

范围：本次未提交的 #438 改动。先检查调用链和历史执行入口，再复核候选问题并修复。

## 确认的问题与修复

### P1：历史草稿执行被要求调用未提供的学习工具

证据：`application-container.ts` 的 `system-store-revision` / `system-skill-revision` 在请求来源为
`memory-learning` 时同样使用 `unattendedMemoryRevisionResource`，但只有直接提炼 executor 才会装配
`select_learning_sources`、`finish_memory_learning` 等任务工具。初版共用后台指令无条件要求这些调用，
会使保留的历史任务收到无法执行的工具协议；原实现对应要求带有工具可用条件。

复核结论：确认是兼容性问题，保留的历史草稿入口不能按新任务工具集处理。

修复：后台共用专业要求与质量策略；直接提炼 executor 在装配任务工具后显式传入 `learningTools: true`，
追加来源选择和 finish/wait 回执协议。历史执行使用默认分支，只按已有授权来源和修订工具继续原草稿，
不要求未提供的工具或虚构无变更回执。没有改历史数据、升级链、调度或重试身份。

回归：普通/直接提炼/历史草稿六种指令组合均通过当前资源 Schema；新增历史模式的真实 Interpreter
编译检查，验证没有学习工具或提问工具，且指令不要求该协议。直接 executor 的实际 binding 编译验证
工具和指令同时包含学习协议；Host 首次执行、手动重试和续执行继续验证无人值守约束。

### P2：压缩专业指令丢失 Knowledge 提交前的 stale 检查

证据：原 Knowledge 专业指令在提交前明确要求无 fileId 获取草稿，确认 `stale=false` 且仅有预期修改。
初版保留了发现 stale 后 rebase 的过程，却遗漏了提交前主动检查这一前置要求。

复核结论：确认是专业校验要求的回退。Host 仍会拒绝过期提交，不能用 Host 拒绝替代 Agent 提交前检查。

修复：在专业部分恢复获取草稿及 `stale=false` 检查，使普通、直接后台及历史草稿三个模式共同继承。
版本/CAS、rebase 和人工审批实现保持原有约束。

## 修复后的验证

- 重新运行 `pnpm test:revision`：54 + 252 + 17 = 323 项通过；定向未选择的 74 项不计为通过。
- 重新运行 Desktop 的直接 executor、学习绑定、历史 observer 与系统执行资源四个测试文件：71 项通过。
- Built-in Agents 与 Desktop main 类型检查、受影响 TS 文件 ESLint、格式检查及 `git diff --check` 通过。
- 普通、历史后台、直接提炼两种 Agent 共六种指令均小于 5,000 字符，最长 4,606 字符。

本轮重新执行 394 项测试。Memory 的 97 项已在实施阶段通过，本轮没有修改其实现或重复计算测试数量。

## 复审范围与限制

再次核对所有 `unattendedMemoryRevisionResource` 调用方、默认注册/物化、任务工具装配、指纹、指令
长度、原草稿恢复及审批边界。已确认的两项问题均已修复；未发现其他需要修改的代码阻塞项。

真实 Runtime 的草稿语义质量对比仍未执行，不能据此宣称已证明低价值提案减少。用例与状态见
[质量验收记录](issue-438-memory-revision.md)。确定性测试不替代实际模型及人工审阅。
