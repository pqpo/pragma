# Issue #326 验证记录

日期：2026-09-29。实现基于远程 main `858ae1abaa3116694a708f6f906c5e639ede8137`，分支 `feat/issue-326-memory-retrieval`。技术决策见 [ADR 061](../adr/061-memory-vector-retrieval-and-task-attention.md)。

## 自动检查

使用 Node.js 24.18.0、pnpm 10.12.1。全仓 `pnpm lint`（19 个任务）、`pnpm typecheck`（19 个任务）和 `pnpm test:core`（11 个任务）通过；后续收尾改动补跑受影响包的类型与回归检查。Desktop 生产构建和 CLI tarball audit 通过。新增测试纳入 Memory 和 Local Host 的核心回归；没有运行 `test:all`。

重点覆盖：

- Unicode 正文完整切片、统一 token 上限、凭据脱敏和 Evidence 正文排除；Embedding 响应顺序、维度、有限非零向量、空间变化和稳定错误码。
- authority 事务 outbox、ID + sequence 确认、真实旧数据库升级、断点回填、同 generation hash 复用、失败重试、未完成 generation 保留旧索引、过期向量定向维护。
- 授权 ID + revision 在 top-K 前筛选；发布前重新读取 authority/hash；跨 scope、忘记、配置/端点变化和权限撤回不暴露过时结果。
- Desktop 通过真实 SecretStore 加密凭据构建索引；CLI 只读现有索引，不创建 cache、不消费 outbox；无授权记录时不发 Embedding 请求。同端点替换模型保留原 generation/原模型查询，完成后才切换。显式重建后，上报空间变化会刷新查询向量缓存。
- 无 Jev 时最多三条高相似度未评估记录；封闭 Choice、实际正文扩展、visited 去重、Score 相关性与来源置信度分离、HTTP/输入预算、取消与 Lens 原文。Mission 取消信号传到向量候选请求，阻止后续判断和发布。
- provider v5 → v6 → v7、Attention v1 → v2 的相邻/链式升级、当前版本 no-op、备份、未完成 journal 重放和未来版本拒绝。SQLite 数据迁移在已有 aggregate 锁/备份和事务机制内执行。历史数据由实际旧 writer 产生，详见 [provenance](../../packages/memory/test/fixtures/retrieval/README.md)。

Desktop 额外检查供应商 store/discovery/connectivity/IPC/boundary、模型编辑组件、Memory Plane 和 Mission Memory 界面。Pi 检查 Embedding 不进入生成模型注册与列表，Core 检查供应商发现协议。

Desktop build 检查 renderer 样式归属、main 无外部 `@pragma/*` import、preload 自包含并注入 `pragmaDesktop`。CLI `package:pack` 真正打包并审计 tarball，在隔离目录启动包内向量 worker，分别验证可写初始化和只读打开；未发布 npm 包。

供应商编辑和 Memory 检索设置使用生产 React 组件及隔离 IPC fixture 进行浏览器验证：检查模型选择过滤、启停、连接测试、输入/批次限制、正常与键盘焦点状态及控制台错误。此检查未使用用户实际 Memory 数据库，也不替代 Electron 实机供应商联调。

## Worker 性能

通过真实 SQLite cache/worker 执行精确 cosine 扫描，在 top-K 前传入授权 ID/revision；每个规模十二次检索，每条记忆一个片段。数据为确定性合成归一化向量，没有网络调用。

环境：Node.js 24.18.0，darwin x64。以下为本机观测值，不是延迟承诺。

| 片段数 | 维度 | p50 (ms) | p95 (ms) | 主线程最大间隔 (ms) | RSS (MiB) | 原始向量 (MiB) |
| -----: | ---: | -------: | -------: | ------------------: | --------: | -------------: |
|  1,000 |  256 |       10 |       35 |                  12 |       148 |           0.98 |
| 10,000 |  256 |      107 |      135 |                  14 |       253 |           9.77 |
| 50,000 |  256 |      551 |      579 |                  21 |       340 |          48.83 |
|  1,000 | 1536 |       20 |       71 |                  12 |       170 |           5.86 |
| 10,000 | 1536 |      190 |      231 |                  13 |       289 |          58.59 |
| 50,000 | 1536 |      988 |     1061 |                  22 |       355 |         292.97 |

RSS 包含宿主进程、worker 和 fixture 构建，不是 worker 单独占用；原始向量大小不含 SQLite 页、WAL、字段索引和元数据。多片段记忆应按片段数估算容量。该实验不测量真实 Embedding 请求、冷回填或 Electron 启动时间。

原始结果：[256 维](./retrieval/benchmark-256.json)、[1536 维](./retrieval/benchmark-1536.json)。复现：

```sh
pnpm --filter @pragma/memory benchmark:retrieval
pnpm --filter @pragma/memory benchmark:retrieval 1536
```

## 中英文离线案例

八条人工标注的中文/英文任务覆盖数据库写入竞争、凭据轮换、worker 检索和事实冲突；另放入一条高度相似但未授权的记忆，验证授权筛选。

| 方法                   | Top-1 命中 | 范围                                         |
| ---------------------- | ---------: | -------------------------------------------- |
| 全 query 子串 baseline |        1/8 | 与任务改写对应的简单文字检索基线             |
| 向量 + 等权 RRF        |        8/8 | 固定概念词表参考 encoder，真实 SQLite worker |
| Jev                    |     未执行 | 需要真实评测凭据                             |

八条结果均未返回未授权条目。这是检索接线、排序和授权的离线回归案例；参考 encoder 与题目共享概念词表，**不能据此推断真实模型质量或宣称混合检索的生产准确率**。生产正文/Attention 的行为还由上面的集成测试验证。

[原始离线结果](./retrieval/evaluation-offline.json)。复现：

```sh
pnpm --filter @pragma/memory evaluate:retrieval
```

评测脚本提供 `--live`，使用显式设置的 `PRAGMA_EVALUATION_EMBEDDING_KEY` 与 `PRAGMA_EVALUATION_JEV_KEY`，并可通过 `PRAGMA_EVALUATION_EMBEDDING_MODEL` / `PRAGMA_EVALUATION_EMBEDDING_URL` 选择供应商。它会把上述合成记忆和任务发送至该供应商与 Jev。本次没有提供评测凭据，因此未执行 live 评测；真实供应商质量与网络耗时仍需该独立步骤确认。

## Code Review

后续 CR 确认并修复七项问题，新增九个回归案例；最终 lint、typecheck、核心测试、构建及 CLI 打包审计通过。逐项证据见 [CR 报告](./issue-326-code-review.md)。
