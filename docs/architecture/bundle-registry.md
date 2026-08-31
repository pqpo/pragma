# Bundle Registry 仓库规范

Bundle Registry 是 Pragma 工作室“广场”的 Git 数据源。它可以托管在 GitHub、GitLab 或任意支持 HTTPS/SSH 的 Git 服务中；私有仓库由系统 Git 完成鉴权。

## 目录格式

```text
pragma-registry.yaml
catalog/
  index.json
  packages/
    a.json
    b.json
    ...                         # 按 package id 首字符分片
  categories/
    development.json
    development/
      coding.json
packages/
  development/
    coding/
      review-assistant/
        package.yaml
        README.md
        README.zh-Hans.md       # 可选
        media/                  # 可选图标和截图
objects/
  sha256/
    ab/
      abcd...0123.pragma        # 完整 SHA-256 命名的不可变 Bundle
```

`pragma-registry.yaml` 管理 Registry 身份、最大 Bundle 大小和最多两级的分类目录。`packages/**/package.yaml` 管理包身份、分类、tags、发布者、版本、channel 和对象引用。包目录用于人类审阅；包 ID 在整个仓库内仍须唯一。

`catalog/**` 由 CLI 确定性生成并提交。`catalog/index.json` 只列出分片路径、SHA-256 和数量；Desktop 先校验索引，再按分片读取摘要。这样大量包不会集中在单个 JSON 中，分类页也不需要扫描所有包文件。

`.pragma` 文件只存放一次，路径由其内容 SHA-256 决定。同一个 Bundle 被多个包版本引用时不会重复提交。已经发布的对象视为不可变；修订内容必须发布新版本。

## 分类与检索

- 分类由 Registry 维护者在 `pragma-registry.yaml` 统一治理，最多两级，例如 `development/coding`。
- 每个包有一个 `primaryCategory`，并可属于最多十个分类。
- 发布者可维护自由 tags，用于技术栈、行业和使用场景等长尾检索。
- 不使用任意深度分类，也不通过目录名表达版本或发布者身份。

## CLI 工作流

初始化一个 Registry：

```bash
pragma registry init ./pragma-registry --id official --name "Pragma Official"
```

初始化一个包：

```bash
pragma registry package init review-assistant \
  --directory ./pragma-registry \
  --category development/coding \
  --name "Review Assistant" \
  --publisher "Pragma Community"
```

编辑生成的 `package.yaml` 和 README 后，发布 Bundle：

```bash
pragma registry publish ./review-assistant.pragma \
  --directory ./pragma-registry \
  --package review-assistant \
  --version 1.0.0 \
  --channel stable
```

重新生成目录或在 CI 中检查：

```bash
pragma registry build ./pragma-registry
pragma registry check ./pragma-registry
```

为官方源贡献时，可让 CLI 创建本地提交：

```bash
pragma registry publish ./review-assistant.pragma \
  --directory ./pragma-registry \
  --package review-assistant \
  --version 1.0.0 \
  --channel stable \
  --prepare-pr
```

该命令创建 `registry/review-assistant-1.0.0` 分支并提交 Registry 改动，但不会 push 或创建远端 PR。贡献者应自行检查 diff、推送分支并向官方仓库提交 PR。

## Desktop 同步与安装

设置页可以添加多个源、指定可选 branch/tag、启停和手动刷新。Desktop 将每个源同步到独立 bare Git cache，记录解析成功的 commit 快照。广场把启用源的摘要合并展示；同名 package 来自不同源时仍保留来源身份，不做隐式覆盖。

打开详情时，Desktop 从快照对应的同一 commit 读取 `package.yaml` 和 README。安装时只读取所选版本的对象 blob，并在写入 cache 的同时校验声明大小与 SHA-256，随后交给现有 Pragma Bundle 检查和安装向导。

启动应用不会刷新所有源。网络同步只由添加源或用户刷新触发；同步失败不会破坏此前已验证的目录快照。

## 官方源治理建议

官方仓库应启用分支保护，并在 PR 中至少运行：

```bash
pragma registry check .
```

评审需要确认包 ID、分类、许可证、发布者信息、README、Bundle 权限需求和版本变更。官方标识由 Pragma Desktop 的预置配置赋予，而不是远端仓库中的可伪造字段。
