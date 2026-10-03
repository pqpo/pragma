# Local Host Kernel R3 CR 修复后串行性能对照

2026-10-03。候选 `8387482a0374fd9ac466b387fbb8fd8b478254b2`；基线最新 `origin/main` / `921376a446d9da878b8d9fa5c9f1df69ab323272`。Node 24.18.0、pnpm 10.12.1，macOS x64 / Intel i7-9750H；同机、同 fixture、同存储格式。全部测试、构建和 Agent 工作结束后串行运行。

结论：初始两组有四次指标触发，按场景追加两组每侧 40 次后，原触发项均未持续触发。追加 Capability 第一组的模型结束→Core terminal 指标另触发一次，第二组未持续。存储与准备基准的可比较指标未触发阈值。不证明尾部异常不存在；真实 provider、Electron 和正常后台负载仍未验收。

每侧初始两组、8 场景各 20 次。P50/P95 使用 nearest rank；少于 20 次不填 P95。阈值为候选 P95 同时超过 main 的 110% 且增加超过 20ms，各项分别判断，不使用合并分数。非 cold 定向追加探针含一条 cold 初始化，该条不计入目标场景统计。

## 初始准备 P95（ms）

| 场景                       | 第一组 main / 候选 | 第二组 main / 候选 |
| -------------------------- | ------------------ | ------------------ |
| cold                       | 255.26 / 330.56    | 257.47 / 262.74    |
| warm                       | 600.78 / 619.07    | 602.70 / 623.90    |
| permission-invalidation    | 599.85 / 631.77    | 685.80 / 626.08    |
| model-invalidation         | 629.56 / 633.87    | 644.53 / 707.48    |
| capability-invalidation    | 618.60 / 663.10    | 725.89 / 678.43    |
| credential-invalidation    | 654.68 / 664.19    | 690.51 / 678.53    |
| system-invalidation        | 629.28 / 612.62    | 660.26 / 658.67    |
| context-mount-invalidation | 809.13 / 719.03    | 734.40 / 782.06    |

## 初始触发与定向追加

| 组  | 场景 / 指标                                                  | main P95 | 候选 P95 |
| --- | ------------------------------------------------------------ | -------- | -------- |
| 1   | cold / preparation                                           | 255.26   | 330.56   |
| 1   | model-invalidation / coreTerminalToHostStatus                | 1.70     | 22.07    |
| 1   | capability-invalidation / activeBindingReleaseToNextDispatch | 598.14   | 659.13   |
| 2   | capability-invalidation / activeBindingReleaseToNextDispatch | 727.66   | 862.58   |

| 追加（每侧 40 次）          | 原指标                             | main P95 | 候选 P95 | 该指标触发 |
| --------------------------- | ---------------------------------- | -------- | -------- | ---------- |
| capability-invalidation / 1 | activeBindingReleaseToNextDispatch | 633.11   | 662.06   | 否         |
| capability-invalidation / 2 | activeBindingReleaseToNextDispatch | 683.94   | 661.33   | 否         |
| cold / 1                    | preparation                        | 263.45   | 262.34   | 否         |
| cold / 2                    | preparation                        | 269.72   | 253.76   | 否         |
| model-invalidation / 1      | coreTerminalToHostStatus           | 2.24     | 2.46     | 否         |
| model-invalidation / 2      | coreTerminalToHostStatus           | 2.39     | 2.32     | 否         |

Capability 追加第一组 `fixtureCompletionToCoreTerminal` P95 为 82.33 / 104.60ms，触发阈值；第二组 90.71 / 100.49ms，未触发。初始与追加原始样本完整保留，不能写成所有单组指标均通过。

next dispatch 区间含 fixture 的配置写入；cold 每次创建不同 Mission，无前一轮 release→dispatch 的可比样本。模型结束标记来自 fixture Runtime，API 读取计数不等于文件或 SQLite I/O 次数。不能把这些数字推广为真实模型或完整 Desktop 性能。

## 证据与复算

[原始数据目录](./local-host-kernel-r3-cr/)包含 4 个完整编译探针、12 个定向追加探针、8 个存储/准备基准及串行命令记录。[比较 JSON](./local-host-kernel-r3-cr/comparison.json)保存所有单项 P50/P95、触发与两组追加交集；[源码前后摘要](./local-host-kernel-r3-cr/r3-source-after.json)确认生产源码未变。main 与候选整体源码 hash 分别为 `b10e9b3415a3f4d849ce3e2607681f1965d7da64959e269173d4583b18ccc387` / `87f2b50df48cdbfa482440aacc2d295667867b4ace5ea1615769cd147d66d91d`。各探针自身的 completeProbePassed/sourceUnchanged 也通过。

复算已保存数据：

```sh
python3 docs/performance/local-host-kernel-r3-cr-analyze.py
```

重新采集时，将 main 与候选置于独立 checkout，以 Node 24.18.0 分别安装同一 lockfile 并构建依赖；源码前后使用 `local-host-kernel-r3-source-digest.mjs <checkout>`。按 [串行命令记录](./local-host-kernel-r3-cr/serial-commands.json)的顺序执行 `local-host-kernel-r2-compilation-probe.mjs --checkout <checkout> --samples 20 --lifecycle true --output <file>`，再分别运行该 checkout 的 `benchmark-execution-storage.mjs` 与 `benchmark-storage-preparation.mjs`。定向追加用 `--samples 40 --scenario <场景>`，每场景两组，所有命令串行；路径按实际 checkout 替换。

完整工程门禁见 [CR 报告](../architecture/local-host-kernel-r3-code-review.md)。本报告不将 R3 阶段标记为完成。
