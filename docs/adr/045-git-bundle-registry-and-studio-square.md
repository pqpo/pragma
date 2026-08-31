# ADR 045: Git Bundle Registry 与工作室广场

## 状态

Accepted

## 背景

Pragma Bundle 已经具备可校验、可安装的传输协议，但缺少可发现、可版本化、可由组织自行托管的分发层。该分发层既要支持未来预置的官方源，也要支持 GitHub、GitLab 和私有通用 Git 仓库，并允许社区通过 Pull Request 参与官方目录维护。

## 决策

Bundle Registry 是普通 Git 仓库。权威输入为 `pragma-registry.yaml`、`packages/**/package.yaml`、说明文件和内容寻址的 `.pragma` 对象；`catalog/**` 是必须提交的确定性生成物。Desktop 只读取某个精确 Git commit，不把分支工作区当作一致性边界。

Registry 使用官方治理的最多两级分类和发布者自由维护的 tags。分类负责稳定导航，tags 负责长尾检索，避免随着 Bundle 数量增长形成任意深度目录树。包 ID 在一个 Registry 内全局唯一；Bundle 对象按 SHA-256 去重，包元数据只引用对象。

Desktop 使用系统 `git` 获取 HTTPS 或 SSH 源，因此私有仓库沿用用户已有的 credential helper、SSH agent 和主机信任配置。源配置不得保存 token、密码或私钥，URL 也不得内嵌 HTTPS 凭据。同步失败时保留最后一个通过 Schema、索引 hash 和计数校验的 commit 快照，并明确展示 stale 状态。

CLI 提供初始化、包脚手架、发布、目录构建和 CI 检查。`--prepare-pr` 只创建本地 `registry/<package>-<version>` 分支并提交，不推送、不调用 GitHub/GitLab API；用户仍通过标准 Git 和代码托管平台创建 PR。

未来官方源通过 Desktop composition root 注入，使用与用户源相同的协议、缓存和安全边界。官方标记是 Host 配置，不由任意远端仓库自我声明。当前未写死官方 URL。

## 后果

- Registry 不需要独立服务、数据库或 forge 专属集成，离线时可继续使用已验证快照。
- 发布者需要提交生成的 catalog；CI 应运行 `pragma registry check`。
- Git 仓库大小会随 Bundle 历史增长，但 Desktop 使用浅 fetch、partial clone 与按需 blob 读取，目录浏览不会下载全部 Bundle。
- 删除版本元数据不等于立即删除已缓存对象；对象回收属于独立的 cache retention 策略。
- Registry v1 协议发生不兼容变化时必须升级 `schemaVersion` 并提供明确迁移，不得静默改变既有目录语义。
