# ADR 046: 轻量 Git Bundle Source 与工作室广场

## 状态

Accepted

Bundle Source v2 与知识库第四种类型由 ADR 048 修订；本 ADR 的轻量 Git 仓库、精确 commit 快照和
Square 身份模型继续有效。

## 背景

早期的生成式 Registry 方案引入了 catalog 分片、内容寻址对象库、channel 和发布流水线。
这些机制让社区贡献者无法直接理解一个条目，也让普通的“导出 Bundle、写元数据、提交 PR”
变成必须依赖 CLI 构建产物的发布过程。广场的第一阶段不需要对象去重、热度或独立发布系统。

## 决策

以 `pragma.bundle-source/v1` 取代 `pragma.bundle-registry/v1`。Bundle Source 是可直接阅读的 Git
仓库，固定包含专家、专家团、流程三种类型。根 `pragma-source.yaml` 为每种类型治理一层分类；
条目的路径是类型与主分类的权威来源。条目仅含 `config.yaml` 和
`versions/<semver>/bundle.pragma`，不允许 README、媒体或截图。

条目 ID 仅在同一类型中唯一。条目跨 Source 不合并；Square 主键为
`{sourceId, kind, itemId}`。同 ID 分类由 Source 优先级合并显示：官方源优先，其次为设置顺序。

Desktop 继续使用系统 Git、浅 fetch、partial clone 和精确 commit 快照。刷新通过 `git ls-tree`
枚举目录，只批量读取根清单与条目配置，不读取 Bundle blob。任一目录、配置、文件模式或协议错误
都会拒绝整个新 commit，并保留最后有效快照为 stale。下载时才流式读取固定 commit 下的 Bundle，
检查 Source 大小上限、Bundle 内部哈希与 fingerprint、配置的 rootRef 和根资源类型，然后进入既有
导入向导。

公共 CLI 仅提供 `source init` 和交互式 `source add`。前者创建清单与分类目录，不初始化 Git；
后者只修改用户已经 clone/fork 的本地工作树，不 clone、commit、push 或创建 PR。官方 CI 使用
内部只读验证脚本，不增加面向用户的 check/build/publish 命令。

旧 Registry 使用一次性内部迁移器升级。迁移器先在 staging 中完成映射和校验，再写稳定 journal，
备份旧清单、catalog、objects 与 packages，最后安装新结构并生成报告。无法无损映射的媒体字段在
修改原仓库前失败。Desktop v1 快照属于可重建缓存，首次读取失效并在刷新时生成 v2 快照；源地址、
ref、enabled、official 和 order 的持久化语义不变。

## 后果

- 社区贡献是普通文件变更，PR 可以直接审阅 config 和实际 Bundle 版本。
- 仓库可能重复保存相同 Bundle；这是换取透明结构和轻量流程的明确取舍。
- Git 历史继续承担版本不可变性，精确版本目录不得覆盖。
- 第一版只支持“最新”和“名称”排序，不展示没有可信数据来源的“最热”。
- `pragma.bundle-registry/v1`、catalog、对象索引、channel 及旧公共 CLI 命令被删除。
