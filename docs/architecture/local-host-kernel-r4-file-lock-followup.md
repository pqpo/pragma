# PR #356：完整组合失败与文件锁竞争复查

2026-10-05；基于 `4b954411`，先读 AGENTS.md。已修复的 catch-up、claim/dispose、关闭入口及共享 Mission 内核保持原实现。

## 两类失败明确区分

用户日志 `/tmp/pr356-final-recheck-host.log` 存在，另存 `/tmp/pragma-pr356-round3-review-first.log`。原七文件 108 passed / 1 failed，294.28s：**第二条 send 等待 rejected 超时**。同 Mission 的 interrupt `74490224-009b-4612-943d-05397807380f` 已完成 applied 与 identity 断言，否则不会提交 send `9c7fb4d3-2caa-4d46-95f1-071d88de7cf2`。send 于 04:54:11.756Z 被消费、11.826Z 完成 executor readiness；源码随后拒绝 Flow chat，尚未 prepare 新 Execution/Native。原日志不足以区分 Memory admission rollback 与 rejected 持久化阻塞。

两处等待均补 kind/requestId、operation 状态、lease/current guard、真实 Inbox consumer、最近 admission/rollback/apply 阶段和 Execution/Invocation 错误；不输出凭据、私有 Context 或完整快照。包装原方法保留 receiver，诊断读取全部排空；原 5 秒及用例预算不变，不加测试重试或放宽断言。

首次诊断包装漏传 controller receiver 的失败单独保存为 instrumentation failure，不算用户问题复现。修正透明性后，原组合捕获到另一项真实失败：**初始 Human Execution 因 `.lock/.reclaim/owner.json` ENOENT 而 failed**，Expert 子 Invocation 已 succeeded、root version 12。该轮尚未执行 interrupt/send，不能冒充原 send 超时复现。

## 确认的 Core 根因与最小修复

Core FileLock 每个 worker/module 独立以 `Date.now() - floor(process.uptime() * 1000)` 估算启动时刻。worker 共享 PID，估算却可有毫秒差异；原 own-PID 严格等值检查将活 owner 判为 dead，允许回收其锁。真实 Worker 回归稳定证明旧代码会重叠进入临界区。

- 同 PID 保守判 alive，与其他存活 PID 的保护一致；保留 owner metadata 格式、跨 PID 检测、原锁超时，不以时间容差猜测进程身份。
- reclaim 初始化核对原 parent/marker generation；正常释放导致目录消失或替换时回到现有 acquisition 检查，不把瞬时竞争当作 Execution 失败。
- claim 后 generation mismatch / rename ENOENT 不触碰 canonical marker，防止旧 reclaimer 删除 successor；初始化异常仅在原 namespace/marker 身份可确认时清理，保留同进程失败后恢复。身份预检查不宣称为原子 CAS。

未改变持久状态 Schema、Native ownership、Mission lease fencing、审批、Runtime/Context 身份或后台任务边界；没有绕开 Flow 拒绝路径、重做内核或把整套内核注入测试。

稳定回归覆盖真实 Worker 互斥、初始化期间 parent 消失、claim 前后真实 successor marker 保留、初始化失败后同进程恢复；旧代码 red、修复后 green。原锁回归全部保留。

## 验证与证据

- Core 文件锁 22/22 passed；相关 typecheck、ESLint、build、diff check 通过；最终 `pnpm check` 通过。
- 最终业务源码冻结后，各 Node 均先执行 `pnpm exec turbo run build --filter='@pragma/local-host...'`，再原七文件组合；`NODE_NO_WARNINGS=1`、不设置 `PRAGMA_LOG_LEVEL`，顺序串行。
- Node 23.11.0：109/109 passed，290.17s。
- Node 22.23.3：109/109 passed，318.59s。
- Node 24.18.0：109/109 passed，294.29s。

原失败、诊断错误、真实 Core 失败、中间版本与最终复测均保留在 `/tmp/pragma-pr356-round3-*.log`。确定性 red/green 与锁检查为 `/tmp/pragma-pr356-worker-lock-*.log`、`/tmp/pragma-pr356-marker-successor-before.log`、`/tmp/pragma-pr356-marker-*.log`。最终 Node 日志为 `/tmp/pragma-pr356-round3-final-node{23,22,24}-{build,host}.log`。

Core 锁回归接入 CLI 的共享底层门禁，主 CI 与 CLI PR/push gate 都执行，快速 `test:core` 不扩展为长集成门禁。最终提交对应的 CI run URL 与结果记录在 [PR #356](https://github.com/pqpo/pragma/pull/356) Verification；旧提交绿灯不替代。

## 尚未闭合的验收

已确认并修复上述 Core 活锁误回收和 marker 换代竞争；**原第二次 send 超时尚未取得直接根因，不能因组合重跑通过宣布已解决**。诊断、原预算和全部业务断言保留，仍作为合并验收缺口。真实模型、Keychain 和产品性能继续由 #348 跟踪，不关闭 issue，不标记 R4 或整体重构验收完成。
