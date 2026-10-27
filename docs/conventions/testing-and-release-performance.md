# 测试与发布性能约定

## 分级与资源预算

`pnpm test` / `pnpm test:core` 只运行 Shared、Core、Interpreter 的快速契约与领域测试、Desktop 最小启动/打包断言；目标为一分钟以内。Turbo 不递归执行依赖包的 `test:core`，避免偷偷扩大快速选集。

`pnpm test:business` 先准备一次产物，再执行必需业务门禁。CI 已准备后调用 `node scripts/run-business-tests.mjs --prepared`。该清单包含原 Local Host kernel、CLI adapters、Mission chat、Desktop 接线、Knowledge revision、Runtime contracts、Memory 与 Claude external CLI 回归。同一包的重叠文件合并为一次 Vitest 调用；没有把恢复、迁移、权限或真实边界测试移出必需门禁。

`pnpm --filter @pqpo/pragma test` 仍执行完整共享 kernel 和 CLI adapters。直接运行 production-process / doctor 集成文件前，先执行 `pnpm build`；测试文件不自行构建。

全量 `pnpm test:all` 供显式本地验证使用。真实外部 Runtime 场景继续需要其已有环境开关与认证，不将跳过的场景作为成功证据。

每台 runner 的测试 worker 最多两个；Turbo 测试包 concurrency 为一个；Local Host 重型集成测试固定单 worker、文件串行。构建/检查最多两个 Turbo task。CLI 所有正向/负向平台检查共用 max-parallel=2；Desktop 原生打包保留三个独立 runner。这个预算不是整个仓库所有 PR 的全局 runner 限额。

## 已清理与保留的覆盖

全仓按 package 边界、测试入口、源码字符串断言、进程启动与等待模式扫描。未设删除比例；读取 fixture、迁移 schema 或真实文件内容的测试不因为使用 readFile 就被删除。

| 清理项                                                                                          | 保留的行为证据                                                                                                       |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| CLI doctor 与 production-process 测试内的重复 build；CLI pretest 的重复 build                   | 命令级一次 prepare，普通 Node bin、stdin、doctor、迁移诊断与真实 Project composition 用例                            |
| collection 检查的十次串行与三次并发重复                                                         | 一次执行 imports 的动态收集检查，以及完整 SIGKILL replay 场景                                                        |
| Local Host harness 中对编译文本包含 node:crypto 的断言                                          | 编译后公开 application 的真实调用与 DTO 断言；canonical tarball 和 Desktop bundle 审计                               |
| mission-chat 与 kernel 重复的 Local Host lifecycle；revision/chat 与 Desktop adapter 的重复选中 | 统一业务清单完整执行这些文件，每个用例一次                                                                           |
| 三个 SIGKILL 场景的生产租约墙钟等待                                                             | 真实子进程与 SIGKILL，活租约拒绝接管，读取持久 expiresAt 后偏移测试 Date，Session/context/native dispatch 不重复断言 |

集成配置使用与发布 CLI 相同的 JS Worker bundle，仍启动真实 Node Worker 和 SQLite；另保留一条源码 Worker 启动门禁。架构 boundary guard 复用同一个 ESLint 实例，对原来的全部合法/非法示例执行真实 lintText，避免重复启动 ESLint CLI。

测试 Date 保持随真实时间推进，不能冻结到期条件所依赖的墙钟；setTimeout、进程和文件 I/O保持真实。全部 Host 关闭后恢复 Date。不得缩短生产租约来满足性能目标。

## 构建、缓存与发布复用

通用构建一次产生 Desktop out、插件包与 CLI metafile，以及 CLI dist/staging/metafile。prepared 模式检查提交、包含未提交修改的 source hash、完整文件集合及 SHA-256；缺失、过期或改动产物直接失败。

发行身份由外部构建配置决定，配置内容摘要进入源码身份和 prepared 清单。Desktop/CLI 应用构建禁用 Turbo 输出缓存，以覆盖直接调用 Turbo 时无法散列仓库外配置内容的情况；中立依赖包继续缓存。根构建同时传入发行摘要，详见[派生发行版](../usage/derived-distribution.md)。

Turbo 缓存包含上述完整副产物，按 OS/arch/Node/pnpm/lockfile 隔离；不共享 node_modules、原生依赖或整机钥匙串。Desktop 构建散列包含 source commit，因为内置 CLI 的 distribution.json 记录提交。根 `pnpm build` 自动提供该值。

Desktop 开发模式允许从不含 Git 元数据的源码目录启动，此时内置 CLI 的 distribution.json 中 sourceCommit 为 null；正式构建与发行仍要求有效 Git HEAD，不允许缺失来源提交。

Desktop 开发启动先通过 Turbo 构建 workspace 依赖，main 再通过 Node 加载这些包的 `dist`，避免 Rollup 重复打包整个 Runtime SDK 依赖图。正式构建仍内联 workspace 包并执行 bundle 审计；preload/renderer 的浏览器边界不变。修改 workspace 包源码后需重新构建依赖并重启开发进程。Vite 日志记录构建耗时，`desktop.services_ready` 和 `desktop.window_loaded` 分别记录服务就绪与窗口加载耗时；`startupDurationMs` 从应用入口函数开始计时，不含前置构建和静态模块加载。

Release 只接受本仓库 push main 的同 SHA 最新成功 CI 与验证 receipt，缺失时调用共享验证；已有运行未完成时等最多三十分钟，失败/取消直接阻止发布。产物过期时重建与验证。Desktop 在原生主机重新生成安装包、平台审计与许可证资料；CLI 发布前仍执行平台矩阵，发布后仍检查 Registry 完整性、公开安装与 provenance。

## 测量与验收

业务入口输出 `.test-results/business-timing.json` 与每包 Vitest JSON，并作为 CI artifact 保留十四天。优化测量执行真实测试，test/test:core 不使用结果缓存。

性能目标：快速测试一分钟以内；必需业务阶段八分钟以内；main CI 十五分钟以内；已有验证结果的 Desktop release 二十分钟以内；CLI 发包前门禁五分钟以内。上述目标排除排队、审批、上游 CI 等待及 Registry 可见性等待，须在 GitHub runner 的冷/暖缓存运行后确认。

CI 的两条验证 lane 按耗时平衡：quality 负责静态检查、快速契约和 Desktop 接线/UI 回归；business 负责共享 Host、CLI、Memory 与 Runtime 门禁。Desktop 回归不是从 CI 删除，而是利用 quality 的剩余时间并行执行；本地 test:business 默认仍执行全部选集。Node 内置模块审计使用 node:module 的 isBuiltin，识别 Node 22 的 node:sqlite 等必须带前缀的模块，同时拒绝未知 node: 名称。

原生 Desktop job 还原同一 CI 的 workspace-build 归档，包括用于原生审计的已编译 Core/Shared 模块；只传递运行环境中立的编译产物，不传递 node_modules。归档与 receipt 保留十四天，任一必需 artifact 缺失/过期都重新验证。

workspace-build 的独立清单绑定提交、源码散列及整个归档的 SHA-256，消费者先校验再解包，覆盖业务测试与原生审计依赖的全部 workspace dist。Windows 构建和业务入口直接启动 pnpm JavaScript 入口，保留含空格的测试筛选参数。

## 开发验证与回归要求

- Host binding、工具协议或编译身份修改必须让 Host 实际生成的 binding 经过真实 Interpreter 编译校验，
  并覆盖首次执行和失败后的手动重试；禁止只直接读取 `binding.value` 调工具或用手写合法 fingerprint
  代替集成验证。fingerprint 纳入版本等新维度时必须重新计算 SHA-256，不能给摘要追加文本。
  对应业务回归必须纳入 `test:business` 的所属 lane，不能仅留在未执行的测试文件中。

- Bugfix 必须保留既有支持的用户入口；删除入口、收紧支持范围或把成功断言改为失败，必须在 PR 中列出明确的需求依据，禁止作为修复的隐含变化。
- claim、恢复、删除与迁移修改必须同时验证正常首次使用和异常恢复路径。
- 知识库修订修改执行 `pnpm test:revision`，独立于快速 `test:core`；PR CI 和 Desktop Release 必须执行该业务回归门禁。
- 关键 Runtime 业务链路发布前记录真实 Runtime 的入口、目标、实际写入及审核结果，不能以 mock 成功代替。

- 修改共享 Mission 控制、编译、执行、恢复或持久化时运行 `pnpm test:local-host-kernel`，不能用 adapter mocks 或 `test:core` 代替。Desktop 的 IPC、UI、平台接线与打包仍需对应验证。
- 优先执行受影响模块的测试；清理废弃或重叠断言，保留真实边界、迁移和异常恢复证据。
- 构建或应用入口改动运行对应 build；发行检查见[Desktop 发行](../usage/desktop-distribution.md)和[CLI 发行](../usage/cli-release.md)。
