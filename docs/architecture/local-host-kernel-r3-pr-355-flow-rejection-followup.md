# PR #355：Flow result 拒绝观察时序修复

2026-10-04。复核[最新评论](https://github.com/pqpo/pragma/pull/355#issuecomment-5976510624)，审查源码 `2a89780a14f73d2cb8319e1bc96cd6fbc7cdff43`。结论：问题成立。

## 证据与修复

[原 CI verify](https://github.com/pqpo/pragma/actions/runs/37174256448/job/111353468774) 的 Host 生命周期 196 个断言通过，但 Vitest 捕获 1 个 unhandled rejection，步骤退出 1；Revision 和 Build 随后跳过。原本地通过记录仅证明其冻结源码与当次环境，不能代替这次远程门禁。

Core Flow 的 result 在 handle 创建后立即开始观察 durable Execution。Local Host 恢复取得 handle 后，还等待 Memory accepted 登记及 owner 持久投影，之后才安装业务 observer。恢复快速失败时，原 result 会先拒绝，CI 的 `PromiseRejectionHandledWarning` 也证明处理器后来才安装。SIGKILL 用例本来就断言恢复返回 `EXECUTION_FAILED`，因此不能把恢复失败改成成功。底层幂等冲突是否属于新增回归，此次证据不能确定；原诊断与安全失败继续保留。

唯一生产改动在共用 `openLocalHostFlowExecution`：取得 start/recover 的真实 handle 后立即安装 `void execution.result.catch(() => undefined)`，返回原 handle。它只提前观察拒绝，不替换、await 或返回 catch 后的 Promise；后续消费者仍收到原 result 的失败。两种持久格式与 Desktop/Node 经同一 kernel 入口受保护。Expert 原有即时结果观察保持，不扩入 R4。

没有新增 await、持久写入、版本/迁移变更或 Native 执行；cold stop 与 release 路径保持。

## 确定性回归

在既有 Host kernel 核心测试补两项，使用真实 Core、SQLite 与 File ExpertSession：

- 首轮 Flow Runtime 快速失败，Memory accepted 登记被 gate 阻塞。
- 原 Expert→Human checkpoint Flow 恢复，owner 投影中响应人工后，后续 Task 快速失败；持久投影被 gate 阻塞。

durable failed 后跨事件循环才让下游观察 result；不安装全局 unhandled listener、不放宽 Vitest 设置。断言真实 handle 与 result Promise 的对象身份、原诊断、Native create/dispatch 一次、恢复前后完整 Context snapshots，以及 Native/owner/lease 释放。

把生产 helper 恢复为原提交实现、保持新测试不变：2 个断言通过，但捕获 2 个 unhandled rejection，命令退出 **1**，复现成功。随后恢复修复：完整 kernel **19 项通过、退出 0**。原真实 SIGKILL 接管用例在 `CI=true` 下 **1 项通过**，原 `EXECUTION_FAILED`、Context/Runtime refs 与 Native 副作用次数断言未修改。

修复提交 `2265bed1` 的首轮 [CI](https://github.com/pqpo/pragma/actions/runs/37179215302/job/111368161618) 又发现新增测试使用默认 1 秒 `waitFor`，Memory gate 尚未进入即超时；该次聊天门禁 75 通过、1 失败，无 unhandled 报告。改为明确的 Memory/projectOwner 进入信号，并与原 operation 的拒绝或意外提前完成竞争；不提前观察 result，不只延长进入门禁的超时。等待 durable.failed 保留有界条件检查。

同步调整后再次用原生产 helper 跑新测试：仍复现 2 个 unhandled、退出 1；恢复修复后完整 kernel 19 项、Host lint/typecheck 均通过。独立复核确认没有遮蔽原操作错误或削弱任何断言。生产源码 SHA-256 保持 `b099fd7588578a628d8a972cca0e314c5bbc9acff9c84f8cb7baa10982cfc6a2`。本地完整生命周期（Host 198、Desktop 87）和 Revision（13 + 69 + 6）在同一生产源码下通过；同步调整只改测试。

## 工程门禁与边界

本轮 `pnpm check` 和 `pnpm build`（19/19 tasks）均退出 0，生产源码前后摘要一致。命令、退出码、unhandled 数量、日志摘要及源码摘要见 [验证记录](../performance/local-host-kernel-r3-pr-355/flow-rejection-verification.json)。完整远程 CI（聊天、控制、编译、生命周期、Revision 和 Build）以 [PR #355 checks](https://github.com/pqpo/pragma/pull/355/checks) 的最新提交结果为准；不能把通过断言数单独当作门禁通过。

本次未重测 fixture 性能；没有增加等待、I/O 或持久事务。[上一轮性能](./local-host-kernel-r3-pr-355-followup.md)仅对应其记录的冻结源码，不扩大为新提交的完整产品性能证据。真实 Runtime、OS 凭据、完整 Electron/背景负载性能缺口继续保留；R3 验收未完成，不关闭 #348。
