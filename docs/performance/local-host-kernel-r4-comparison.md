# Issue #348 R4 串行性能对照（CR 前）

2026-10-04，macOS，同机 Node 24.18.0 / pnpm 10.12.1；baseline 为 `cc1103ecae55c5ec28d98f7e4e54f1165c4bfc8a`。
测试、构建及子 Agent 停止后，按 main→R4 顺序串行执行两组。生产源码冻结；两侧前后摘要均一致：

- main（1181 文件）：`5de2487c846c077d0ea68760bc02c7307395104df007988d3854a987783d93ce`。
- R4（1159 文件）：`42919e9181cc0ccab79d62d9284b7749975995813203c2fd36f3a3965a920492`。

本报告保留 CR 前证据，不能作为修复后源码的性能结论。修复后记录见 [CR followup](../architecture/local-host-kernel-r4-cr-followup.md)。

## 范围与方法

复用 `local-host-kernel-r2-compilation-probe.mjs`；baseline 使用旧 Desktop facade，R4 使用共享 application factory 与真实 Desktop resources，两侧使用相同 controller/lease composition。
Project/Mission/Capability/ContextStore/SQLite/Interpreter 为真实实现；Runtime、凭据与 health 为 fixture。每组八场景各 20 次，双方共 640 次。
暖运行零 DSL 编译、请求内 pinned Revision 只读一次、source pin、实际 compile miss 等断言全部通过。
P50/P95 使用 nearest-rank；不足 20 样本不计算百分位。回退触发规则为 R4 P95 同时 >main×1.1 和 >main+20ms；不把不触发等同于完全等效。
API read 计数不等于磁盘 I/O；Core terminal/Host status 不等于 renderer paint。场景准备时间也不能替代真实模型暖接入指标。

## 编译与 lifecycle

单位 ms；单元格为 main→R4。准备耗时记录两组 P95；核心 lifecycle 记录 fixture completion→Core terminal P95。

| 场景                       | 准备 P95 第 1 组 | 准备 P95 第 2 组 | terminal P95 第 1 组 | terminal P95 第 2 组 |
| -------------------------- | ---------------- | ---------------- | -------------------- | -------------------- |
| cold                       | 309.91→327.73    | 645.07→299.24    | 25.35→77.61          | 28.26→28.64          |
| warm                       | 723.28→649.64    | 708.27→661.26    | 122.65→137.27        | 123.96→127.31        |
| permission-invalidation    | 719.52→664.73    | 723.83→665.52    | 107.20→119.08        | 112.51→108.90        |
| model-invalidation         | 727.61→659.58    | 753.29→672.42    | 122.97→120.30        | 120.94→111.98        |
| capability-invalidation    | 1123.60→750.85   | 1113.48→740.26   | 22.01→22.18          | 25.07→22.16          |
| credential-invalidation    | 772.13→764.89    | 723.39→748.13    | 44.37→21.73          | 21.82→22.66          |
| system-invalidation        | 756.01→705.51    | 758.03→792.68    | 123.35→113.85        | 129.72→124.43        |
| context-mount-invalidation | 1157.80→811.50   | 1159.90→852.92   | 20.94→24.65          | 22.50→20.48          |

冷启动第一组 terminal 触发阈值（25.35→77.61ms），第二组为 28.26→28.64ms。原始异常保留，追加两组各 40 次冷启动，断言均通过：

| 复测            | 准备 P95 main→R4 | terminal P50 main→R4 | terminal P95 main→R4 |
| --------------- | ---------------- | -------------------- | -------------------- |
| cold-resample-1 | 334.51→342.71    | 20.62→20.66          | 38.84→40.03          |
| cold-resample-2 | 339.74→325.67    | 21.20→20.95          | 25.63→28.74          |

两组复测均未触发回退阈值，没有复现稳定回退；不能据此抹去第一次尾部异常。

## SQLite 与 storage preparation

`benchmark-execution-storage.mjs`：每 owner 20 样本，四 owner 为 80；WAL/FULL 未改变。单元格为 commit/read P95（main→R4），单位 ms。

| 历史长度 / owner / canonical feed | 第 1 组 commit | 第 2 组 commit | 第 1 组 read | 第 2 组 read |
| --------------------------------- | -------------- | -------------- | ------------ | ------------ |
| 0 / 1 / off                       | 7.13→9.52      | 6.88→6.92      | 1.80→2.27    | 1.82→1.88    |
| 50 / 1 / off                      | 6.85→7.06      | 6.83→7.61      | 1.79→1.85    | 1.84→1.92    |
| 500 / 1 / off                     | 7.18→6.76      | 6.86→6.70      | 1.82→1.92    | 1.83→1.80    |
| 5000 / 1 / off                    | 7.10→6.80      | 6.71→6.61      | 1.89→1.78    | 1.73→1.77    |
| 5000 / 4 / off                    | 15.83→14.49    | 14.05→14.14    | 4.43→4.08    | 4.26→4.07    |
| 0 / 1 / on                        | 7.53→7.00      | 7.06→7.22      | 1.82→1.67    | 1.74→1.73    |
| 50 / 1 / on                       | 7.83→9.16      | 8.05→9.57      | 1.89→2.06    | 1.81→1.90    |
| 500 / 1 / on                      | 10.75→6.85     | 7.03→8.32      | 1.79→1.73    | 1.72→2.04    |
| 5000 / 1 / on                     | 7.04→6.96      | 8.21→6.97      | 1.75→1.73    | 2.21→2.00    |
| 5000 / 4 / on                     | 59.12→53.22    | 63.45→54.26    | 4.88→4.20    | 4.22→4.59    |

`benchmark-storage-preparation.mjs`：准备四 owner 时并发读取；下表保留有效样本数，括号为样本数 main/R4。

| 历史长度 | 第 1 组前台 read P95 main→R4 | 第 2 组前台 read P95 main→R4 | 第 1 组转换后 read P95 | 第 2 组转换后 read P95 |
| -------- | ---------------------------- | ---------------------------- | ---------------------- | ---------------------- |
| 500      | 不足 20，未计算 (11/11)      | 不足 20，未计算 (11/10)      | 1.91→1.87              | 1.90→1.71              |
| 5000     | 85.71→85.29 (24/24)          | 84.21→65.85 (23/23)          | 1.71→1.91              | 2.45→1.92              |
| 50000    | 47.39→47.26 (142/133)        | 47.37→46.48 (138/140)        | 1.94→1.90              | 1.79→2.26              |

存储与准备路径没有触发既定阈值。原始 500 历史的准备期间样本不足；追加两组、每侧三次隔离准备（仍为真实 fixture 升级和四 owner 并发读），汇总相同条件下的读样本：

| 追加组 | 样本 main/R4 | P50 main→R4 | P95 main→R4   |
| ------ | ------------ | ----------- | ------------- |
| 1      | 34/33        | 24.66→41.57 | 155.44→153.19 |
| 2      | 34/32        | 42.15→42.98 | 135.88→140.94 |

两组均未触发阈值；该百分位汇总三次隔离准备，不能冒充单次准备的 20 个样本。追加 harness 仅在仓库外将原脚本的历史循环改为三次 500 并保留原始读样本；`preparation-500-resample-summary.json` 保存计算结果。
worker payload、队列/锁等待、数据库增长与 macOS 进程 I/O 原始计数保留在外部样本；进程 I/O 包含后台线程和延迟写，不做单事务归因。

## 复现与产品验收边界

探针命令：`pnpm exec tsx docs/performance/local-host-kernel-r2-compilation-probe.mjs --checkout <checkout> --samples 20 --lifecycle true --output <external.json>`；冷启动追加 `--samples 40 --scenario cold`。
源码身份用 `local-host-kernel-r3-source-digest.mjs`；完整原始采样、命令/日志与比较 JSON 位于仓库外 `/tmp/pragma-r4-performance/`。首次探针导入已删除转发文件而启动失败，日志另存 `/tmp/pragma-r4-performance-probe-import-failed/`，不纳入有效对照。

本报告仅证明已采样内核路径未发现可复现的阈值回退。真实模型、OS 凭据、renderer 与正常 Memory/Automation 负载的产品四目标由 [R4 验收报告](../architecture/local-host-kernel-r4-implementation.md)单列；fixture 不作为替代证据。
