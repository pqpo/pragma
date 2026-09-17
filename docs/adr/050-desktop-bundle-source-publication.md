# ADR 050: Desktop 直接发布 Bundle Source

## 状态

Accepted

本 ADR 修订 ADR 046 中 Desktop 只读 Bundle Source 的假设；公共 CLI 的本地工作树职责保持不变。

## 背景

专家、专家团、流程和知识库已经能导出为 Bundle，但发布者仍需手工 clone Source、运行 CLI、提交并
推送。Desktop 已经具有系统 Git、Bundle 导出、项目修订和 Source 快照边界，可以在不引入服务端
Registry 或托管凭据的前提下完成同一工作。

## 决策

Desktop 为项目中的 Expert、ExpertTeam、Flow 和 ContextStore 提供“发布到源”。发布必须锁定当前
Project Revision；编辑器存在未保存内容时，先走原有保存/离开保护。系统内置资源只有在已物化为
Project 资源后才能发布。

发布配置由所有目标共享条目 ID、名称、摘要、描述、作者、许可证、主页、标签、Bundle 模块和版本，
分类按 Source 独立选择。已有 rootRef 必须保留其条目 ID、分类和 createdAt；新增版本更新公共元数据、
updatedAt 与 latestVersion。同版本相同 Bundle fingerprint 是幂等成功，不同 fingerprint 是稳定冲突。

Source 配置升级为 `pragma.desktop-bundle-registry-sources/v2`，只保存可选 `branch`，不再接受 tag 或
任意 ref。未配置时优先解析远端符号 `HEAD`；空仓库使用 `main`，远端 `HEAD` 不可解析但只有一个分支时
使用该唯一分支。v1 的 `ref` 在首次 owner 读取前经文件锁、带 Schema 的稳定 journal、v1 备份和原子
替换迁移为 `branch`。历史 tag 值不会被猜测，刷新时以
`source_branch_not_found` 失败。

发布继续调用系统 Git，继承进程的 `HOME`、SSH agent 和系统凭据；网络交互关闭终端提示并启用 SSH
BatchMode。commit 的 author/committer 取全局 `user.name` 与 `user.email`，缺失时拒绝发布并给出可操作
错误。每个 Source 使用独立临时工作树和 Source 级跨进程锁，最多并发三个目标。空仓库在首次发布时
初始化 Bundle Source v2；非空仓库在写入前后都执行完整 Source 验证。提交通过 Git tree 生成并执行
普通非 force push，远端竞争保留为该目标的失败结果。

一次发布只生成一个 Bundle。多源结果逐项记录 `published`、`already_published` 或 `failed`；部分成功
不会回滚，界面只重试失败目标。成功 push 后定向刷新该 Source 的可重建快照。

## 后果

- SSH key、credential helper、用户名和邮箱仍完全由用户本机 Git 管理，Pragma 不保存 Git secret。
- 多源发布不是分布式事务；已成功的 Git commit 不因其他源失败而撤销。
- Source 版本目录继续不可覆盖，Git 非 force push 保留远端并发安全边界。
- Desktop 与 CLI 共用 `@pragma/local-host` 的 Source 写入和验证实现，避免产生第二套协议写入器。
