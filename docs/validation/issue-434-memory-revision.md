# Issue #434：直接 Revision 提炼验收

日期：2026-10-26。实现范围仅第一阶段；Knowledge/Skill 调度未合并，Curator 与正式发布审批保留。

## 自动化证据

- Revision 业务门禁通过：Built-in Agents 52 项、Desktop 249 项、定向 Mission 集成 17 项。定向脚本另外排除的测试不计作已验证。
- Knowledge/Skill 原有与新增观察预算回归通过，合计 93 项。
- 受影响 Desktop 回归 94 项、Host 来源/执行边界 29 项通过；最后的直接执行与旧任务观察补充回归 17 项通过，包含退役前释放工具锁再取消 Native 执行。
- lint、Desktop main / Memory / Local Host / Built-in Agents 类型检查、快速 `pnpm test:core` 门禁通过。
- 新 Host binding 经真实 Interpreter 编译，覆盖无变更回执、越权引用修正、已有目标读取与复用、重复提交、原上下文重试、未知投递和重启预算。
- 旧 Planner 测试替换为只读观察回归；保留服务层草稿、审批、迁移与恢复测试。
- Local Host kernel 首次运行在既有 `file-lock.test.ts` 的 reclaim-marker-claimed 竞争测试失败；单独复跑 22 项通过。完整门禁随后运行 1294 项，1287 项通过、2 项跳过、5 项失败。失败文件单独串行复跑后 owner scope/deletion 通过（23 项），M10 子进程测试的 3 项 5 秒超时仍可复现；默认 kernel 门禁未通过。没有修改该测试或生产租约。

## 真实 Runtime：质量验收未完成

使用 Codex CLI `0.159.0-alpha.3` 和隔离的临时 Pragma home，通过实际 Desktop 执行资源、Memory Revision executor、Context Store 与草稿服务尝试验收。输入是合成的成功 journal replay Episode；已有目标为 Migration handbook，预期向其补充复用 command UUID 的增量草稿。

真实执行未生成草稿：Codex 的本地登录状态显示已登录，但服务端模型发现/Responses 返回 HTTP 401，诊断为登录令牌无法解析/刷新。独立最小连通性检查复现同一认证失败。没有重新登录、替换凭据或绕过网络策略。

因此，**已有资产复用的真实模型选择、实际草稿 diff、模型调用次数和人工交互情况均未通过质量验收**。自动化 mock/契约成功不能替代该项。认证恢复后仍需使用现有资产重跑，检查：一个 Revision Mission、同上下文读取和编辑、目标为原 Store、实际增量 diff、待审状态、无中途人工交互、正式内容未自动发布。

## 删除与兼容说明

删除了独立 Planner 的生产执行器、JSON inspection 协议、格式/业务纠错循环及对应旧协议测试。新任务不产生中间 Knowledge/Skill Plan 或计划缓存，不再执行 plan → Revision prompt 转换。

历史 Plan Schema、缓存与旧交接逻辑仍服务已存在的缓存计划；注册的 Planner 仅观察原 execution，读取终态结果。业务 decision 持久化后写结算标记，再尝试清理。旧 Revision 的待审草稿和原有迁移链继续保留。

兼容路径退役条件及新状态命名空间见 [ADR 080](../adr/080-direct-memory-revision-extraction.md)。未改变旧 Schema 的语义，也没有删除支持窗口内的数据或升级链。
