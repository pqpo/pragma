# Mission 统一内核实施前性能基线

测量日期：2026-10-02。代码：`main@8fdbd4526d0f62d0b36891165539ed9ec47dc603`。本记录对应[四阶段重构方案](../architecture/local-host-application-kernel-refactor.md)第一阶段的前置基线测量，不额外增加实施阶段。

## 测量范围与环境

本次依次运行两组存储、两组 owner 准备隔离和两组 Electron renderer 基准。生产源码未修改，测试使用独立临时 owner，未改写用户 Mission。每组基准串行执行；未停止用户的其他应用，因此属于当前交互主机环境的可重复参考，不是专用空载实验机。

环境：Intel i7-9750H、12 logical CPU、16 GiB、macOS Darwin 25.6.0 x64、Node 24.18.0、pnpm 10.12.1、Electron 43.7.6。[环境原始记录](local-host-kernel-baseline-environment.json)包含代码版本和记录时 load average；该 load average 不是每个 benchmark 的实时负载。

统计沿用现有脚本的 nearest rank P50/P95，不把两次运行的百分位平均或拼成总体百分位。脚本目前不导出全部原始 latency sample，本次保留每次完整脚本输出；后续同条件对比应继续分组报告，若要置信区间须先补单样本导出。

## Execution 存储

每次运行分别覆盖 canonical 关闭与开启、0/50/500/5,000 历史及四 owner。单 owner 每格 20 样本，四 owner 每格 80 样本；两次运行合计 640 次固定增量提交。下表展示 canonical 开启的生产相关路径。

| 历史事件 | owner | 每组样本 | 提交 P50 第一次/第二次 ms | 提交 P95 第一次/第二次 ms | 控制读取 P95 第一次/第二次 ms |
| -------- | ----- | -------- | ------------------------- | ------------------------- | ----------------------------- |
| 0        | 1     | 20       | 6.33/6.26                 | 6.96/6.92                 | 1.67/1.68                     |
| 50       | 1     | 20       | 6.52/6.73                 | 8.04/10.07                | 1.78/1.75                     |
| 500      | 1     | 20       | 6.48/6.62                 | 7.22/7.76                 | 1.74/1.81                     |
| 5,000    | 1     | 20       | 6.44/6.50                 | 7.05/7.06                 | 1.73/1.72                     |
| 5,000    | 4     | 80       | 13.24/13.17               | 54.56/54.55               | 5.50/4.31                     |

[第一次存储结果](local-host-kernel-baseline-storage-1.json)、[第二次存储结果](local-host-kernel-baseline-storage-2.json)。结果还包含 worker 队列/SQL 写锁时间、worker 请求响应字节、数据库增长及进程内核磁盘字节。后三者口径不同：序列化字节不等于磁盘 I/O，进程 I/O 包含后台投递和延迟刷盘，不归因于单次事务。

500→5,000 十倍历史的提交 P95 分别为 7.22→7.05 ms、7.76→7.06 ms，没有观察到全历史线性放大。四 owner 提交 P95 为 54.56/54.55 ms，接近上一份[整合主线记录](mission-latency-phase-four-storage-merged.json)的 53.27 ms。这是同代码本机复测的局部一致性证据，不能推导首 Token 或证明严格统计意义上的零回退。

## owner 准备隔离

输入是实际 v12 file writer fixture 的合成历史扩展，每个规模每次只转换一个 owner；两次运行每规模共两次转换，不对转换时间报告 P95。四个已就绪 owner 在转换期间并发控制读取；表中“读取批次”是四个 owner 的 Promise.all 完成时间，不是单次读取。prepare 观测从准备启动至准备和最后并发读取批次均完成，可能包含末批读取尾部。

| 旧历史事件 | prepare 观测第一次/第二次 ms | 转换期间读取批次数第一次/第二次 | 四 owner 读取批次 P95 第一次/第二次 ms | 转换后单 owner 读取 P95 第一次/第二次 ms |
| ---------- | ---------------------------- | ------------------------------- | -------------------------------------- | ---------------------------------------- |
| 500        | 496.59/497.58                | 11/11                           | —/—                                    | 2.02/1.88                                |
| 5,000      | 618.89/618.42                | 24/24                           | 84.20/85.60                            | 2.00/1.85                                |
| 50,000     | 1784.51/1773.56              | 137/135                         | 46.67/45.79                            | 2.21/1.91                                |

少于 20 个批次的 500 事件组不报告百分位；其最大批次耗时为 155.44/157.78 ms。所有规模的批次最大值约 155–162 ms，说明有调度/连接初始化成本，不能只报 P95 忽略尾部。转换后读取每组 20 样本。

[第一次准备结果](local-host-kernel-baseline-preparation-1.json)、[第二次准备结果](local-host-kernel-baseline-preparation-2.json)。暖 owner 读取在旧 owner 转换期间继续推进，观察到现有 lane 隔离机制有效工作；目标旧 owner 仍须等待首次转换，不能据此保证真实页面、所有后台消费者或恢复 Mission 同样无等待。

## renderer 流式绘制

使用真实 Mission composer、live entry store 和 entry view 的 production React bundle，在 offscreen Electron 窗口测量。每次静态/流式各三种 entry 规模，每格 40 样本；两次合计 480 样本。streaming 各格 40/40 样本都有流式进展及输出绘制，脚本已检查场景完整性。

| 模式      | entries | 每组样本 | input→paint P50 第一次/第二次 ms | input→paint P95 第一次/第二次 ms | 两组 long task 数 |
| --------- | ------- | -------- | -------------------------------- | -------------------------------- | ----------------- |
| static    | 100     | 40       | 33.20/33.30                      | 34.30/35.10                      | 0/0               |
| streaming | 100     | 40       | 33.30/33.00                      | 34.50/35.40                      | 0/0               |
| static    | 1,000   | 40       | 33.20/33.30                      | 34.30/35.20                      | 0/0               |
| streaming | 1,000   | 40       | 33.30/33.00                      | 34.60/35.30                      | 0/0               |
| static    | 5,000   | 40       | 33.30/33.20                      | 34.40/34.90                      | 0/0               |
| streaming | 5,000   | 40       | 33.10/32.90                      | 34.80/35.10                      | 0/0               |

[第一次绘制结果](local-host-kernel-baseline-stream-ui-1.json)、[第二次绘制结果](local-host-kernel-baseline-stream-ui-2.json)。流式 P95 范围 34.5–35.4 ms，未观察到 long task，与上一轮 renderer 局部样本接近。此指标包含脚本等待帧绘制的时序，不是裸 React CPU 耗时；也不包含真实模型、Main admission、磁盘读取或完整 Mission 首屏。

## 真实模型与待完成场景

production Desktop 构建已通过，包括 styles、main workspace import、preload Bridge 和打包 storage worker 的耐久打开验证。真实模型先运行 warm 组 1 样本 pilot；native Keychain 准备在 120 秒内未完成，监督进程以 `MISSION_BENCHMARK_KEYCHAIN_TIMEOUT` 和 exit code 1 停止。结果文件未生成，有效样本为 0，未启动后续 cold/new/warm 各 20 轮正式测量。见[模型测量状态](local-host-kernel-baseline-model-status.json)。恢复测量需要系统钥匙串允许测试进程访问现有 provider 凭据；本次没有修改源凭据或用空值绕过认证。局部 benchmark 不能替代三组各至少 20 轮的模型数据。

当前默认 E2E harness 使用真实 provider、隔离的空业务数据和默认后台服务，不含正常 Memory/Automation 合成负载、四实际 Mission 并发、三种立即发送/queue/steer 场景、完整 Mission/Studio 首屏与逐请求读写次数。其首轮计时从实际 Run 按钮开始，Mission 创建/页面导航此前已完成，不能用于创建与冷进程启动全链路 SLA。上述场景仍需扩展 harness 后测量。

## 本次结论与完成边界

已完成四阶段方案第一阶段的局部性能基线：Execution 存储、owner 准备隔离、renderer 流式绘制各两组，production Desktop 构建通过。真实模型 pilot 因 native Keychain 超时失败，无有效端到端样本。暖 Session 接入、模型结束至 Core terminal、Core terminal 至真实 renderer 终态、排队控制可用四项产品目标均尚未取得本次可用测量，不能宣布达标。

这不是整个第一阶段完成：中立契约提取、控制统一、故障覆盖盘点及完整负载 harness 仍未实施；本次只完成可运行的测量部分。后续先解决 Keychain 访问，再扩展缺失场景并记录基准候选的逐样本数据。

## 重跑入口

```bash
pnpm exec turbo run build --filter='@pragma/local-host...'
node packages/local-host/scripts/benchmark-execution-storage.mjs
node packages/local-host/scripts/benchmark-storage-preparation.mjs
node apps/desktop/scripts/benchmark-mission-stream-ui.mjs
pnpm --filter @pragma/desktop build
node apps/desktop/scripts/run-mission-latency-benchmark.mjs \
  --source-home "$HOME/.pragma" --samples 20 --groups cold,new,warm \
  --model deepseek-v4-flash --thinking medium \
  --output /tmp/pragma-kernel-baseline-e2e.json
```

源码修改前后沿用同一 commit/环境记录方式，禁止测量时并行运行其他基准或构建。正常交互主机背景负载须记录，不能人为关闭 Memory/Automation 后把结果当产品目标。
