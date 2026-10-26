# 性能测量入口

当前性能预算与门禁见[测试与发布规范](../conventions/testing-and-release-performance.md)。
阶段测量、源码快照、重复采样 JSON 和一次性分析探针不再随源码保留；历史记录可从 Git 历史追溯。
旧测量只适用于当时的提交与环境，不能证明当前产品性能。

## 可复用基准

- [Mission 端到端](../../apps/desktop/scripts/benchmark-mission-end-to-end.mjs)与[延迟测量](../../apps/desktop/scripts/run-mission-latency-benchmark.mjs)。
- [输入框](../../apps/desktop/scripts/benchmark-mission-composer.mjs)、[流式投影](../../apps/desktop/scripts/benchmark-mission-stream.mjs)、[Renderer 流式绘制](../../apps/desktop/scripts/benchmark-mission-stream-ui.mjs)与[会话投影](../../apps/desktop/scripts/benchmark-mission-projection.mjs)。
- [Execution 存储](../../packages/local-host/scripts/benchmark-execution-storage.mjs)与[存储准备](../../packages/local-host/scripts/benchmark-storage-preparation.mjs)。

运行前核对脚本参数和环境前提；生成结果留在仓库外或 CI artifact，PR 只记录必要结论、方法与限制。

## 历史验收缺口

Mission 延迟优化与 Issue 348 的局部基准、fixture 和工程门禁不等于完整产品验收。
当时真实 Pi/DeepSeek 测量受 native Keychain 阻塞，未取得有效端到端样本；以下目标未获完整验证：

- 暖 Session 接入额外开销 P95 < 250 ms。
- 模型完成到 Core terminal P95 < 500 ms。
- terminal 到 Renderer paint P95 < 200 ms，queue 控件可用 P95 < 200 ms。
- 真实模型、Electron 绘制与正常后台负载重叠下的整体性能。

复测须区分冷启动、暖 Mission、暖 Session、上轮收尾期间立即发送；每场景至少 20 个样本，
串起点击、IPC、Inbox、dispatch、模型结束、耐久终态与 UI 绘制，报告 P50/P95 和等待时间。
不得通过扣除真实等待、mock 吞吐或局部缓存命中宣布达标。清理记录不改变这些验收状态。
