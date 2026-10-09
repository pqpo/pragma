# Issue #348 R4：PR 评论修复后的性能对照

2026-10-05，macOS x64，Node 24.18.0 / pnpm 10.12.1。同机 main→R4 串行测量；所有门禁和专项进程先结束。基线 `cc1103e`；R4 基于 `cf5f935` 的本次修复源码。

生产源码 SHA-256：`4ff92e8dd60d7ca28e36b5a6f3f5dae5f07b3e0c3dbd0c10c5576443bdcf7539`，1160 文件；完整业务门禁、测量前后及追加复测后摘要相同。两组八场景，每侧每场景 20 次，共 640 次；全部 probe 完整通过、无 errors。SQLite 与 storage preparation 同样完成两组对照。

阈值：R4 P95 > main P95 × 1.1 **且**差值 > 20 ms；不足 20 个样本不计算或汇总 P50/P95。fixture 不代表真实模型或 renderer 产品性能。

## 两组 preparation P95（ms）

| 场景                       | 第 1 组 main / R4 | 第 2 组 main / R4 |
| -------------------------- | ----------------- | ----------------- |
| cold                       | 302.30 / 371.58   | 308.91 / 323.01   |
| warm                       | 738.26 / 660.36   | 734.14 / 647.80   |
| permission-invalidation    | 739.56 / 706.91   | 734.11 / 663.30   |
| model-invalidation         | 735.60 / 674.27   | 743.22 / 698.73   |
| capability-invalidation    | 1145.12 / 717.04  | 1141.34 / 701.66  |
| credential-invalidation    | 739.09 / 747.47   | 740.01 / 737.72   |
| system-invalidation        | 711.57 / 751.78   | 782.40 / 705.49   |
| context-mount-invalidation | 1124.64 / 853.96  | 1169.69 / 801.46  |

## 初轮触发与追加复测

初轮异常保留：第 1 组 cold preparation、system invalidation 的 active binding release→next dispatch；第 2 组 permission invalidation 的 fixture completion→Core terminal。三个场景各追加两组、双方各 40 次，共 480 次。

| 场景 / 初轮指标                                           | 初轮 main / R4 P95 | 追加 1 main / R4 P95 | 追加 2 main / R4 P95 |
| --------------------------------------------------------- | ------------------ | -------------------- | -------------------- |
| cold / preparation                                        | 302.30 / 371.58    | 350.61 / 377.21      | 319.26 / 329.93      |
| system-invalidation / activeBindingReleaseToNextDispatch  | 690.29 / 762.60    | 671.44 / 658.14      | 662.98 / 641.45      |
| permission-invalidation / fixtureCompletionToCoreTerminal | 125.52 / 155.94    | 108.21 / 121.52      | 121.35 / 125.19      |

SQLite 第 2 组 canonical 开启、四 owner、5000 历史的 commit P95 初轮 `36.19 / 81.86 ms`。该配置追加两组、每侧各 40 rounds × 4 owners，共 640 个提交样本；全部保留原 commit/read 原始样本。

| 追加组 | 样本数（每侧） | commit P50 main / R4 | commit P95 main / R4 | read P95 main / R4 |
| ------ | -------------- | -------------------- | -------------------- | ------------------ |
| 1      | 160            | 12.51 / 12.19        | 51.91 / 48.51        | 4.24 / 5.07        |
| 2      | 160            | 11.95 / 13.55        | 52.15 / 53.08        | 5.72 / 6.72        |

三项编译/生命周期和一项存储初轮异常均未在两组追加中形成稳定阈值回退。其余初轮 lifecycle、read 和 preparation 指标未触发阈值；storage preparation 低于 20 样本的桶不作统计结论。

## 证据与验收边界

原始命令、probe、存储样本、源码身份、初轮及追加统计保存在仓库外 `/tmp/pragma-pr356-followup-performance/`；分析脚本 `/tmp/pragma-pr356-analyze.py`，编译追加 `/tmp/pragma-pr356-resample.py`，存储追加 `/tmp/pragma-pr356-storage-resample.py`。所有命令成功。

本次只证明上述工程 fixture 对照未发现稳定回退。真实模型、OS Keychain、暖接入、模型完成→terminal、terminal→renderer paint、queue 控件四项产品性能验收仍待补齐；不标记 R4 或整体重构完成。评论、门禁与关闭边界见 [PR followup](../architecture/local-host-kernel-r4-pr-review-followup.md)。
