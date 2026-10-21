# 性能历史与测量证据

本目录是按提交、环境和时间保存的测量档案，不是当前性能承诺或开发计划。
保留原路径以便既有 JSON、探针和外部报告能够重放。旧脚本可能依赖当时的 API，运行前核对其注明的提交与前提。
当前测试预算见[测试与发布规范](../conventions/testing-and-release-performance.md)，系统边界见[当前架构](../architecture/current-architecture-overview.md)。

- `issue-254/255/256` 报告：Mission 输入、流式更新和投影的阶段测量。
- `mission-latency-*`：延迟优化阶段方案与测量；尚未验收的声明只反映记录时状态。
- `local-host-kernel-*`：共享内核 R1–R4 的对照、源完整性、原生运行及成本证据。

目录中的样本量、分位数、mock/真实 Runtime 区分和验收缺口不得因整理而删除或提升为全产品结论。
