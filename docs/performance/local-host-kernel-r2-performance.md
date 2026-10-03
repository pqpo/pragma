# Issue #348 R2 同条件局部性能与 Native 验证

日期：2026-10-03。结论：正式局部对照与追加复测完成；初轮 Capability 与最终源码 warm 场景各一次 P95 触发，分别追加两组 60 样本复测均未重复触发。真实 provider pilot 无有效样本，完整产品性能未验收，R2 阶段退出仍未通过。

## 条件与原始证据

基线为最新 origin/main `a2741325ab106b3cbc8f472d4feec98b1367ae55`；R2 为其独立 worktree 上的未提交候选源码。Node 24.18.0、pnpm 10.12.1、Electron 43.7.6，Intel i7-9750H / 12 logical CPUs / 16 GiB / macOS Darwin 25.6.0。使用同一台交互主机，未关闭用户应用；实现、测试、构建均结束后，所有测量串行运行。

两组顺序均为 main → R2；每端每组每编译场景 20 样本，共 320 次正式准备操作。cold 是同一进程内新 Mission 的首次运行，不是 20 次冷进程启动；import 与夹具建立不计入准备耗时。fake Runtime、隔离真实 Project/Mission/Capability/ContextStore/SQLite；真实 Interpreter compile，fixture verifier/credential-generation port。未测模型、正常 Memory/Automation 负载或完整 UI 路径。

[环境](local-host-kernel-r2/environment.json)、[源码摘要](local-host-kernel-r2/source-integrity.json)、[逐命令退出记录](local-host-kernel-r2/measurements.json)、[完整比较](local-host-kernel-r2/comparison-summary.json)保存原始数据和统计。正式测量前后的 production TS/TSX/MJS/JSON 摘要一致；摘要范围明确排除 tests/fixtures/scripts/docs/构建产物。DSL/static fixture 无改动。各 probe 另保存选定路径摘要及自身 checksum。

## 编译准备与缓存

P95 单位 ms。完整准备为 awaited run/send 返回，包含 Inbox/control 接入及 Core prompt admission；不把它填成 UI→dispatch 的 250 ms 产品指标。

| 场景                       | main 组1 | R2 组1 | main 组2 | R2 组2 |
| -------------------------- | -------: | -----: | -------: | -----: |
| cold                       |   274.09 | 280.28 |   263.48 | 265.42 |
| warm                       |   639.54 | 626.41 |   674.03 | 597.93 |
| permission-invalidation    |   637.28 | 635.50 |   638.22 | 641.30 |
| model-invalidation         |   663.14 | 662.07 |   639.04 | 648.46 |
| capability-invalidation    |   658.92 | 668.48 |   657.62 | 823.34 |
| credential-invalidation    |   709.61 | 694.45 |   687.37 | 689.16 |
| system-invalidation        |   667.32 | 669.15 |   641.49 | 655.00 |
| context-mount-invalidation |   683.07 | 703.51 |   713.37 | 705.13 |

真正的编译阶段 P95（production `default_agent_compile` marker）如下；读取、identity 与 Core prompt 的其他 marker 保留在每条原始样本中。

| 场景                       | main 组1 | R2 组1 | main 组2 | R2 组2 |
| -------------------------- | -------: | -----: | -------: | -----: |
| cold                       |    41.79 |  45.54 |    43.24 |  34.31 |
| warm                       |     0.01 |   0.00 |     0.01 |   0.00 |
| permission-invalidation    |    33.71 |  32.59 |    34.26 |  38.26 |
| model-invalidation         |    29.50 |  34.23 |    30.24 |  34.79 |
| capability-invalidation    |    29.43 |  34.06 |    29.11 |  32.36 |
| credential-invalidation    |    30.18 |  31.47 |    32.19 |  32.08 |
| system-invalidation        |    38.56 |  47.68 |    35.20 |  37.83 |
| context-mount-invalidation |    29.27 |  31.72 |    31.40 |  31.03 |

以下均为每请求 instrumented API 调用数，不是物理磁盘读取；两组计数一致。DSL 计数来自 Interpreter prototype，不能再与 Store/openedProject entrypoint 数相加。

| 请求     | main head / pinned Revision | R2 head / pinned Revision | active Capability / credential fingerprint | DSL compile | R2 cache hit  |
| -------- | --------------------------- | ------------------------- | ------------------------------------------ | ----------- | ------------- |
| cold     | 1 / 1                       | 0 / 1                     | 4 / 3                                      | 2           | 0/20 每组     |
| warm     | 1 / 1                       | 0 / 1                     | 1 / 1                                      | 0           | 20/20 每组    |
| 六类失效 | 1 / 1                       | 0 / 1                     | 5 / 4                                      | 2           | 0/20 每类每组 |

每次 miss 包含 root 与被调用 system Expert 两个 DSL compile，warm 无新编译、Project open、Runtime health probe 或 model catalog read。本 fixture 没有 plugin，plugin reads=0 不能证明真实 Plugin 查询成本。source pin 全部保持。Node cold consumer 的一次 Revision/compile 与暖复用另由真实确定性测试验证，不与 Desktop probe 混算；完整 Node acquisition preflight 尚可能重复 resolve/compile。

## 触发与增加样本

第2组 Capability 失效 P95 为 main 657.62 → R2 823.34 ms（+165.73 ms/+25.20%），触发同时 >10% 且 >20 ms 的检查线。R2 sample 19 的 Revision read=146.64 ms、readiness=201.27 ms；sample 0 的 Session open=223.01 ms。main sample 0 Session open=232.10 ms。计数、authority、pin 与缓存断言全部通过，不能仅由这些 outlier 判定原因。

保留原始触发，增加两个 main→R2 交替定向复测，每端每组 60 Capability 变更样本。定向模式是一次 cold seed 后仅测选定场景，固定模型；不与完整8组池化。probe 新增 --scenario 参数后 checksum 改变，每对使用同一脚本；生产源码没有改动。

| 复测     | main P95 | R2 P95 | main compile P95 | R2 compile P95 | 回退阈值 |
| -------- | -------: | -----: | ---------------: | -------------: | -------- |
| 3，60/端 |   673.90 | 664.95 |            32.07 |          34.63 | 未触发   |
| 4，60/端 |   688.17 | 668.37 |            32.56 |          33.60 | 未触发   |

[复测统计](local-host-kernel-r2/repeat-summary.json)和[逐命令结果](local-host-kernel-r2/repeat-ledger.json)保留全部样本。两次复测均未复现阈值触发；没有修改生产性能算法、耐久级别或超时预算，不宣称普遍性能收益。

## 最终源码删除复核与编译重测

最后删除无调用方的 Desktop `PragmaProjectStore.compile` 方法、类型声明及两个 type import；Interpreter API 保留。Desktop Node typecheck/lint、完整 build（88.25s）与 compilation gate（57+13=70项，42.70s）再次通过，见[删除后工程验证](local-host-kernel-r2/final-cleanup-validation.json)。

随后冻结最终源码，重跑两组全8场景、每端每组20样本（组5/6）；附加两组每端60个 warm 样本（组7/8）。[最终源码摘要](local-host-kernel-r2/final-source-integrity.json)证明整个重测/暖复测期间源码未变，且相对初轮仅该 Desktop Store 文件改变；Node/Core/存储/renderer代码均不变，先前对应数据继续单列，不伪称它们使用同一完整源码摘要。

| 场景                       | main 组5 | R2 组5 | main 组6 | R2 组6 |
| -------------------------- | -------: | -----: | -------: | -----: |
| cold                       |   603.34 | 264.37 |   290.10 | 275.09 |
| warm                       |   608.19 | 715.36 |   727.78 | 623.09 |
| permission-invalidation    |   643.49 | 644.99 |   678.92 | 623.28 |
| model-invalidation         |   657.51 | 647.90 |   653.94 | 651.09 |
| capability-invalidation    |   695.82 | 681.61 |   679.33 | 725.15 |
| credential-invalidation    |   709.36 | 706.34 |   707.38 | 700.99 |
| system-invalidation        |   669.47 | 630.87 |   670.54 | 634.72 |
| context-mount-invalidation |   710.86 | 699.25 |   737.01 | 741.52 |

第5组 warm P95 608.19→715.36 ms（+107.16ms/+17.62%）触发检查线；R2 sample2的 pinned Revision read150.14ms、readiness173.21ms，sample0完整准备715.36ms。main sample0完整准备715.20ms。DSL compile仍为0，计数/pin断言通过，原因未由这些样本确证。第6组 warm 为727.78→623.09ms，所有场景均未触发检查线。

追加暖复测为单次 cold seed 后60个 warm，保留完整setup/冷样本但不与全8组池化：

| 暖复测   | main P95 | R2 P95 | 回退阈值 |
| -------- | -------: | -----: | -------- |
| 7，60/端 |   605.28 | 623.10 | 未触发   |
| 8，60/端 |   624.35 | 621.74 | 未触发   |

最终全场景与暖复测的 head/pinned reads=0/1、warm DSL=0、各失效DSL=2及cache hit/miss保持，全部断言通过。60个暖样本跨越30秒TTL后，每请求Runtime health/model catalog读取集合为{0,1}；目标availability重新探测可间接触发model discovery，不能泛称整个发送调用链永远没有model catalog读取。这是原Runtime/Host探测链行为，主线与R2均保留，readiness服务自身不调用全Runtime/model list。两组暖复测未重复触发，保留第5组原始结果；局部波动记录不能变成稳定性能收益或真实产品验收。[最终比较与计数](local-host-kernel-r2/final-comparison-summary.json)、[逐命令记录](local-host-kernel-r2/final-cleanup-ledger.json)、[暖复测](local-host-kernel-r2/warm-repeat-ledger.json)保存原始证据。

## 存储与准备隔离

SQLite canonical 开启的提交 P95；单 owner 每配置20样本，四 owner 共80样本。canonical 关闭、读取、worker queue/lock/serialization、数据库增长及 processDiskIo 完整结果在 execution-storage-*.json 中。

| history / owners | main 组1 | R2 组1 | main 组2 | R2 组2 |
| ---------------- | -------: | -----: | -------: | -----: |
| 0 / 1            |     6.90 |   6.85 |     6.83 |   7.44 |
| 50 / 1           |     7.21 |   7.00 |     7.06 |   7.30 |
| 500 / 1          |     6.71 |   7.17 |     6.82 |   7.40 |
| 5000 / 1         |     7.43 |   7.14 |     8.00 |   7.07 |
| 5000 / 4         |    55.22 |  52.65 |    69.97 |  59.98 |

提交/读取 P95 未触发回退线。processDiskIo 是整个 benchmark 进程（含 worker/后台 delivery）的 OS 累计差值，排除 seeding，可能含延迟写；不归因单事务，payload bytes 也不是物理 I/O。

实际 v12 fixture 合成扩展至500/5,000/50,000 events，四个已准备 owner 并行读与另一个 owner 转换。转换总耗时每轮只有1值，明确不算 P95；四 owner batch 少于20个时 percentile=null。第2组500/5,000转换总耗时 +54/+83 ms，追加两轮对照，保留单次波动而不伪称 P95 回退。

| history | main 转换总耗时组1/2 | R2 转换总耗时组1/2 |
| ------- | -------------------- | ------------------ |
| 500     | 494.24 / 494.44      | 494.24 / 548.87    |
| 5000    | 624.00 / 621.58      | 618.73 / 704.68    |
| 50000   | 1786.29 / 1783.52    | 1759.31 / 1781.18  |

foreground batch P95 与 converted-owner read P95 未触发回退线，没有观察到前台读取随转换历史线性放大。追加转换数据保存于 preparation-repeat-*.json；无模型/UI，不能代替后台正常产品负载。

## Renderer 局部验证

实际 Mission components + offscreen Electron，100/1,000/5,000 entries，static/streaming每配置40样本。未包含 Main→renderer terminal、queue控件或真正模型输出。

| entries / mode   | main 组1 | R2 组1 | main 组2 | R2 组2 |
| ---------------- | -------: | -----: | -------: | -----: |
| 100 / static     |    33.90 |  34.70 |    35.20 |  35.30 |
| 100 / streaming  |    34.20 |  35.50 |    35.30 |  35.40 |
| 1000 / static    |    34.00 |  35.00 |    35.10 |  35.20 |
| 1000 / streaming |    34.10 |  35.40 |    35.30 |  35.30 |
| 5000 / static    |    34.10 |  34.80 |    35.00 |  35.20 |
| 5000 / streaming |    34.50 |  35.40 |    34.70 |  35.30 |

## Native 与真实模型

真实 Codex Native Mission：18/18断言，72.92秒，退出0；[原始报告](local-host-kernel-r2/native-mission.json)与[独立退出确认](local-host-kernel-r2/native-mission.supervisor.json)。probe直接装配已解析 Core executor 与共用 run/control，验证 Inbox、SQLite、ExpertSession、queue/steer、暖记忆和正常释放后重开；不覆盖新默认 Node compiler 的 Native资源接线、crash takeover、Team/Flow 或 Desktop UI。默认 Node compiler 的 Expert/Team/Flow 资源环境由真实Interpreter/CAS/SQLite+fake Runtime测试验证。

真实provider：main 与R2使用相同 source-home、warm、samples=1、deepseek-v4-flash、thinking=medium。逐次结果见[model-pilots.json](local-host-kernel-r2/model-pilots.json)。两端均在 native credentials-read 阶段120秒超时、退出1，主进程退出已确认；有效模型样本各0，无P50/P95，不当作provider性能或Secret跨进程通过。

四项产品指标（暖UI→dispatch<250ms、模型完成→Core terminal<500ms、Core terminal→renderer paint<200ms、enqueue耐久接受→queue可用<200ms）、总首Token、尾部、四Mission并发和正常 Memory/Automation 负载仍没有完整可比较报告。R1/R2均不得因此标记全部验收完成。

## 重跑

先构建对应 checkout，所有运行串行；性能期间不启动实现/测试/build进程。原始失败pilot（fixture Runtime ID错误、R2外部refs漏传）保留且不进入统计；修复见R2实施报告。

```sh
pnpm exec tsx docs/performance/local-host-kernel-r2-compilation-probe.mjs --checkout <checkout> --samples 20 --output <output.json>
pnpm exec tsx docs/performance/local-host-kernel-r2-compilation-probe.mjs --checkout <checkout> --samples 60 --scenario capability-invalidation --output <output.json>
node packages/local-host/scripts/benchmark-execution-storage.mjs
node packages/local-host/scripts/benchmark-storage-preparation.mjs
node apps/desktop/scripts/benchmark-mission-stream-ui.mjs
node --import tsx docs/performance/local-host-kernel-r1-native-mission-probe.mts <output.json>
node apps/desktop/scripts/run-mission-latency-benchmark.mjs --source-home <pragma-home> --samples 1 --groups warm --model deepseek-v4-flash --thinking medium --output <output.json>
```

## CR 后冻结源码对照

CR 修复后的生产摘要为 `e064f7e657f9736c782d1847ecb7fbb55a8c2cb446d407ffdea3c5735bef052d`（1,148 文件），与最终工程门禁完全相同，所有测量前后保持；main 工作区干净且仍为 `a2741325ab106b3cbc8f472d4feec98b1367ae55`，生产摘要 `d9c5a7f493826556a8443a07c2f6d28d498a420a1f2aa05ea3382cf1fe11159e`。此批不覆盖旧报告中的存储/renderer/Native 探针；未重新取得真实模型样本，不声明完整性能验收。测试/build 结束后串行运行同一 unchanged compilation probe，Node24.18.0，两组每端8场景×20样本（共640），随后系统失效两组每端60样本（共240；另4个setup cold样本不计入目标P95）。所有进程退出0、pin/cache断言与源码不变断言通过。

| 场景                       | main/R2 准备 P95 组1 ms | main/R2 准备 P95 组2 ms | main/R2 编译 phase P95 组1/2 ms |
| -------------------------- | ----------------------: | ----------------------: | ------------------------------- |
| cold                       |         264.29 / 268.04 |         259.40 / 258.74 | 41.08/44.75 · 40.39/34.21       |
| warm                       |         677.75 / 605.18 |         610.64 / 601.72 | 0.01/0.00 · 0.02/0.00           |
| permission-invalidation    |         621.39 / 627.98 |         645.83 / 658.09 | 30.08/33.85 · 30.03/35.68       |
| model-invalidation         |         654.90 / 678.54 |         658.03 / 648.48 | 27.94/59.44 · 29.10/30.62       |
| capability-invalidation    |         670.64 / 686.66 |         833.94 / 801.51 | 31.49/35.42 · 31.90/31.48       |
| credential-invalidation    |         723.57 / 695.83 |         701.26 / 708.50 | 31.57/31.41 · 29.80/31.91       |
| system-invalidation        |         618.81 / 644.27 |         602.20 / 672.11 | 36.24/36.32 · 33.75/37.02       |
| context-mount-invalidation |         635.51 / 689.32 |         689.67 / 691.45 | 29.09/32.24 · 29.70/35.25       |

组2系统失效 602.20→672.11 ms，+69.91 ms/+11.61%，触发 >10% 且 >20ms 阈值，原始结果保留。追加两组60样本结果为669.25→675.88 ms（+0.99%）及689.34→648.48 ms（−5.93%），均未重复触发；编译phase P95分别38.92→41.51与38.49→40.23 ms。未调整生产逻辑或延长超时，不能据此宣称稳定性能收益。

每组R2暖owner20/20命中、DSL编译0，cold及六类失效均miss且DSL编译2（root+system）；main等同缓存断言通过。R2每请求head/pinned Revision读取0/1，main为1/1；R2暖project open0、失效1（cold {1,2}），main暖0、失效0并经store compile。暖active Capability/credential fingerprint读取1/1，system失效5/4，其余完整计数保存在JSON。Context mount失效仅读取目标store；此probe无Plugin/inline Secret，Plugin读取0，不能证明重Plugin workload性能。新增guard正确性由真实存储/DSL的轮换、删除、编译期间变化与映射交换回归证明，非OS Keychain验收。读取数为API调用，不是物理I/O。全场景暖组health/model读取0；系统复测因TTL/Runtime探测链health/model读取{4,5}，不把readiness自身不调model list扩大为全链零读取。

[全场景摘要](local-host-kernel-r2/cr/comparison-summary.json)、[系统复测摘要](local-host-kernel-r2/cr/repeat-summary.json)、[全场景逐命令退出](local-host-kernel-r2/cr/measure-ledger.json)、[复测逐命令退出](local-host-kernel-r2/cr/system-repeat-ledger.json)、[最终工程门禁](local-host-kernel-r2/cr/validation.json)与同目录逐样本raw JSON保存原始证据。此前真实provider每端0有效样本、OS凭据/完整产品指标和正常Memory/Automation负载缺口继续保留；R1/R2均未标记全部验收完成。

## PR #354 评论修复后的独立测量批次

本批对应 [评论裁决与实现](../architecture/local-host-kernel-r2-pr-354-followup.md)，不覆盖此前 R2/CR 数据。冻结 production 摘要 `4502e1a76d1ed74014c80112a7406c0cd146e0fad9b2f148e131650962ecb55d`（1,149 文件），工程门禁、两组完整测量与两类追加复测前后均一致；基线仍为 `a2741325ab106b3cbc8f472d4feec98b1367ae55`，main 摘要 `d9c5a7f493826556a8443a07c2f6d28d498a420a1f2aa05ea3382cf1fe11159e`。Node 24.18.0，同一 unchanged probe、隔离真实存储/Interpreter、fake Runtime；测试与构建结束后 main→候选串行运行。每端每组 8 场景×20 样本，两组共 640 次准备操作；system 与 Capability 各追加两组每端 60 样本，共 480 次目标操作（另 8 个 setup cold 不计目标 P95）。所有命令退出 0，pin/cache/source assertions 通过。

| 场景                       | main/候选 准备 P95 组1 ms | main/候选 准备 P95 组2 ms | main/候选 编译 phase P95 组1/2 ms |
| -------------------------- | ------------------------: | ------------------------: | --------------------------------- |
| cold                       |             292.20/274.31 |             257.66/259.96 | 41.17/41.11 · 41.20/34.80         |
| warm                       |             717.22/580.83 |             619.51/620.88 | 0.01/0.00 · 0.01/0.00             |
| permission-invalidation    |             628.18/629.97 |             656.97/634.05 | 27.71/32.20 · 33.86/34.33         |
| model-invalidation         |             659.24/632.67 |             687.72/653.40 | 31.76/33.33 · 31.30/31.79         |
| capability-invalidation    |             697.99/711.68 |             660.49/845.86 | 30.39/38.69 · 30.17/31.72         |
| credential-invalidation    |             745.31/697.22 |             719.31/678.56 | 30.14/31.09 · 29.94/34.47         |
| system-invalidation        |             636.94/707.53 |             674.00/652.48 | 35.46/37.02 · 36.34/38.64         |
| context-mount-invalidation |             670.75/699.78 |             725.57/723.22 | 29.76/35.50 · 30.36/32.85         |

组1 system 636.94→707.53 ms（+11.08%）、组2 Capability 660.49→845.86 ms（+28.07%）触发既有 >10% 且 >20ms 阈值，原始数据保留。追加结果：

| 场景/复测组               | main/候选 准备 P95 ms |   差异 | main/候选 编译 phase P95 ms |
| ------------------------- | --------------------: | -----: | --------------------------: |
| system-invalidation/3     |         651.24/647.07 | -0.64% |                 37.88/41.92 |
| system-invalidation/4     |         639.48/698.75 | +9.27% |                 37.73/45.10 |
| capability-invalidation/3 |         713.15/667.37 | -6.42% |                 33.18/35.24 |
| capability-invalidation/4 |         668.97/673.80 | +0.72% |                 31.78/37.57 |

四组均未重复触发准备耗时阈值，未改超时/性能预算；编译 phase 成本仍有波动，不宣称稳定性能收益或完整性能验收通过。

每组暖 owner 20/20 命中、DSL=0；cold 与六类失效均 miss、DSL=2（root+system）。候选每请求 head/pinned Revision=0/1，main=1/1；候选暖 Project open=0、失效=1、cold={1,2}。暖 active Capability/credential fingerprint=1/1，失效=5/4；候选暖 health/model=0，system 复测={4,5}，Capability 复测 health={5,6}/model={4,5}。这是真实 API 调用计数，不是物理 I/O；该夹具 Plugin、ContextStore port 计数为 0，未测 Plugin 重负载或 inline Secret，不能把正确性回归当作相应性能证明。全部计数/P50/P95/逐样本 phase 保存在原始 JSON。

[完整摘要](local-host-kernel-r2/pr-354-followup/comparison-summary.json)、[复测摘要](local-host-kernel-r2/pr-354-followup/repeat-summary.json)、[工程门禁](local-host-kernel-r2/pr-354-followup/validation.json)、[完整测量命令](local-host-kernel-r2/pr-354-followup/measure-ledger.json)、[system 复测命令](local-host-kernel-r2/pr-354-followup/system-repeat-ledger.json)、[Capability 复测命令](local-host-kernel-r2/pr-354-followup/capability-repeat-ledger.json)及同目录原始 JSON/日志可复核。本轮未取得新真实模型样本；此前每端 0 有效样本及 OS 凭据、产品 UI/terminal、正常 Memory/Automation 负载和并发缺口均继续保留，R1/R2 完整验收仍未通过。
