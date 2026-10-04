# Local Host Kernel R3 串行性能对照

2026-10-03；macOS x64，Intel i7-9750H 2.60GHz，Node 24.18.0，pnpm 10.12.1。

main `921376a446d9da878b8d9fa5c9f1df69ab323272`；R3 工程提交 `dba3405a94edc22fc6042c7297f0fdcb04025f8a`。测量时所有 Agent、测试及构建已停止，两组依次 main→R3；生产源码前后摘要一致。仓库仅保留核心指标与结论，原始采样 JSON 不随 PR 提交。

实际 Desktop factory、Project/Mission/Capability/ContextStore/SQLite/Interpreter；Runtime、凭据验证与 health 使用 fixture。没有真实模型、renderer、正常 Memory/Automation 负载。下面的 Host 状态通知不等于 UI 显示，Core active-binding 释放不等于 Native 进程或 Mission lease 释放。

## 准备耗时

每场景每侧每组 20 次；单位 ms，单元格为 P50 / P95。暖调用 DSL compiler 为零，失效场景重新编译；每请求一次 pinned Revision 读取、零 head 读取的断言均通过。计数是 API 调用，不是物理 I/O。

| 组  | 场景                       | main            | R3              | 触发阈值 |
| --- | -------------------------- | --------------- | --------------- | -------- |
| 1   | cold                       | 243.85 / 267.20 | 246.70 / 309.14 | 是       |
| 1   | warm                       | 581.44 / 652.25 | 574.88 / 628.20 | 否       |
| 1   | permission-invalidation    | 600.98 / 642.30 | 587.55 / 623.92 | 否       |
| 1   | model-invalidation         | 604.97 / 641.78 | 603.47 / 649.50 | 否       |
| 1   | capability-invalidation    | 639.63 / 715.63 | 641.06 / 673.66 | 否       |
| 1   | credential-invalidation    | 660.08 / 691.17 | 669.94 / 719.31 | 否       |
| 1   | system-invalidation        | 624.52 / 640.39 | 597.94 / 638.67 | 否       |
| 1   | context-mount-invalidation | 678.21 / 752.23 | 672.18 / 733.22 | 否       |
| 2   | cold                       | 246.42 / 262.49 | 243.79 / 266.29 | 否       |
| 2   | warm                       | 569.20 / 624.94 | 568.21 / 579.63 | 否       |
| 2   | permission-invalidation    | 598.66 / 646.00 | 594.11 / 631.02 | 否       |
| 2   | model-invalidation         | 633.81 / 659.37 | 608.94 / 692.37 | 否       |
| 2   | capability-invalidation    | 642.39 / 790.04 | 629.10 / 670.82 | 否       |
| 2   | credential-invalidation    | 658.49 / 686.04 | 668.60 / 710.68 | 否       |
| 2   | system-invalidation        | 615.80 / 665.44 | 603.45 / 662.18 | 否       |
| 2   | context-mount-invalidation | 672.42 / 730.56 | 678.94 / 794.04 | 否       |

## 生命周期

下表汇总每组 160 次；单场景触发及追加复测见下文，不能用汇总掩盖单场景异常。相同 Mission 的后续 dispatch 各 140 次；不同 Mission 的 cold 不计算下一轮。

| 组  | 边界                               | main            | R3              | 样本数/侧 |
| --- | ---------------------------------- | --------------- | --------------- | --------- |
| 1   | fixtureCompletionToCoreTerminal    | 87.08 / 118.26  | 87.60 / 121.94  | 160 / 160 |
| 1   | coreTerminalToHostStatus           | 1.75 / 21.84    | 1.72 / 21.61    | 160 / 160 |
| 1   | activeBindingReleaseToNextDispatch | 544.91 / 747.95 | 537.44 / 722.74 | 140 / 140 |
| 2   | fixtureCompletionToCoreTerminal    | 88.66 / 122.74  | 85.86 / 122.98  | 160 / 160 |
| 2   | coreTerminalToHostStatus           | 1.73 / 19.46    | 1.74 / 20.36    | 160 / 160 |
| 2   | activeBindingReleaseToNextDispatch | 552.59 / 734.19 | 544.14 / 754.51 | 140 / 140 |

阈值为 R3 P95 同时比 main 增加 >10% 且 >20ms。初始触发：组 1 cold 准备 267.20→309.14ms；组 2 model-invalidation fixture 完成→Core terminal 121.21→144.83ms。两项均追加两组、每侧每场景 40 次，原异常结论保留。

cold 组 1 的 P95 样本定位到 expert_session_open（main 样本 4 为 12.27ms，R3 样本 6 为 91.15ms），而 compile/prompt 未同步变慢；第一个样本两侧均约 1055ms，不作为 R3 特有差异。模型失效异常样本伴随 terminal 提交与 active-binding 释放延迟（样本 14：terminal commit 36.24ms、active release 120.08ms）。观测只定位到这些阶段，不能证明具体 OS/worker 抖动原因；Core/Runtime 生产源码未改。复测未再触发，未宣称消除完整产品退化风险。

| 复测 | 场景               | 准备 main→R3                      | fixture 完成→terminal main→R3     | 仍触发 |
| ---- | ------------------ | --------------------------------- | --------------------------------- | ------ |
| 1    | cold               | 233.55 / 285.77 → 239.02 / 266.98 | 20.08 / 23.86 → 20.67 / 23.60     | 否     |
| 2    | cold               | 243.94 / 266.76 → 242.65 / 264.23 | 21.24 / 26.67 → 20.71 / 23.03     | 否     |
| 1    | model-invalidation | 617.58 / 645.75 → 602.37 / 636.45 | 106.02 / 124.30 → 106.43 / 123.20 | 否     |
| 2    | model-invalidation | 607.28 / 645.90 → 595.23 / 656.79 | 106.32 / 122.37 → 106.75 / 124.39 | 否     |

## SQLite 与首次准备

WAL/FULL、真实 storage worker；每项 20 次。保留提交/读取与首次准备的核心结果。进程 I/O 含 worker 和后台 delivery，不作单事务归因。下表为各存储 case 的 P95 范围；阈值判断按逐项比较计算。

| 组  | 指标            | main 范围  | R3 范围    | 阈值触发 |
| --- | --------------- | ---------- | ---------- | -------- |
| 1   | commitLatencyMs | 6.53–50.89 | 6.59–56.86 | 否       |
| 1   | readLatencyMs   | 1.70–4.23  | 1.70–4.31  | 否       |
| 2   | commitLatencyMs | 6.68–53.03 | 6.74–60.47 | 否       |
| 2   | readLatencyMs   | 1.64–4.65  | 1.69–4.91  | 否       |

使用真实 v12 writer fixture 扩展为四个 owner；准备耗时是单次转换，不能称为 P95。前台四-owner batch 少于 20 样本时省略分位数。

| 组  | 历史量 | 转换 main→R3 (ms) | 前台读取 main→R3 (P50/P95)  | 前台样本 main/R3 |
| --- | ------ | ----------------- | --------------------------- | ---------------- |
| 1   | 500    | 506.47 → 480.71   | — → —                       | 11 / 11          |
| 1   | 5000   | 628.97 → 622.20   | 7.04 / 84.96 → 6.83 / 83.75 | 24 / 24          |
| 1   | 50000  | 1801.36 → 1762.42 | 6.41 / 47.39 → 6.20 / 45.93 | 137 / 138        |
| 2   | 500    | 495.95 → 493.59   | — → —                       | 11 / 11          |
| 2   | 5000   | 631.84 → 614.50   | 6.93 / 69.53 → 6.88 / 84.26 | 24 / 24          |
| 2   | 50000  | 1776.65 → 1785.87 | 6.34 / 47.63 → 6.37 / 47.21 | 138 / 136        |

转换后的 owner 读取各 20 次；存储与准备可比较分位数未触发阈值。少样本和单次转换继续作为证据限制。

## 结论与限制

两组测量、两项触发后的两组复测均完成；复测范围内没有持续触发阈值的退化。fixture 性能证据不能关闭 R1/R2 或 R3 的真实模型、OS 凭据、原生 SDK 全链路、Electron UI 与正常后台负载验收缺口。首次基线启动因缺 Runtime 构建产物失败，补建后重新开始，失败未计入样本。

复算脚本：`python3 docs/performance/local-host-kernel-r3-analyze.py <外部采样目录>`。脚本只读取显式指定的采样目录，统计与生成的报告也写入该目录；采样与验证日志不提交到仓库。
