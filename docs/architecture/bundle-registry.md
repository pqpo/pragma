# Bundle Source 仓库规范

Bundle Source 是 Pragma 工作室“广场”的 Git 数据源。它可以托管在 GitHub、GitLab 或支持
HTTPS/SSH 的 Git 服务中；私有仓库复用系统 Git 凭据。协议刻意保持为可直接阅读、复制和提交 PR
的文件结构。

## 固定目录

```text
pragma-source.yaml

experts/<category>/<item>/
  config.yaml
  versions/<semver>/bundle.pragma

expert-teams/<category>/<item>/
  config.yaml
  versions/<semver>/bundle.pragma

flows/<category>/<item>/
  config.yaml
  versions/<semver>/bundle.pragma

knowledge-bases/<category>/<item>/
  config.yaml
  versions/<semver>/bundle.pragma
```

Source 根目录可以保留 README、许可证和 `.github/`。四种类型目录内只允许上述条目文件：不放
README、图片、截图、catalog 或对象索引。路径是条目类型和唯一主分类的权威来源，`config.yaml`
不重复声明。tags 只用于长尾搜索。

## 根清单

`pragma-source.yaml` 的当前 `schemaVersion` 为 `pragma.bundle-source/v2`，包含 Source ID、多语言
名称和描述、`maxBundleBytes`，以及 `expert`、`expert-team`、`flow`、`knowledge-base` 四个 section。每个 section
分别维护一层分类的 ID、多语言名称、说明和排序。推荐初始分类为：

- `general`
- `software-development`
- `research`
- `product-design`
- `content-creation`
- `productivity`
- `education`

不同 Source 出现相同分类 ID 时，Desktop 使用官方源优先、随后设置顺序的首个名称和排序。

## 条目配置

`config.yaml` 使用 `pragma.bundle-source-item/v2`，包含 `id`、`rootRef`、多语言 name/summary、
Markdown description、author、license、可选 homepage、tags、可选内置 avatarId、latestVersion、
createdAt 和 updatedAt。

版本目录必须是合法 SemVer，文件名固定为 `bundle.pragma`，`latestVersion` 必须存在。条目 ID 在
同一类型内唯一，因此不能通过换分类重复创建；不同 Source 的同名条目继续独立展示。

## CLI

初始化一个目录：

```bash
pragma source init ./awesome-pragma --id awesome-pragma --name "Awesome Pragma"
```

该命令只创建清单和默认分类目录，不执行 `git init`。将 Desktop 导出的 Bundle 加入已 clone/fork
的工作树：

```bash
pragma source add ./my-expert.pragma --directory ./awesome-pragma
```

交互流程会选择可调用根、类型分类并收集元数据。新增条目写 config 和版本；已有条目只增加版本并
更新 latestVersion/updatedAt。命令不 clone、commit、push 或创建 PR，也绝不覆盖已有版本。

v1 Source 必须先显式升级；`source add` 会拒绝直接修改旧协议并给出指引：

```bash
pragma source upgrade ./awesome-pragma
```

升级命令备份 v1 manifest/config，写入稳定 journal，并通过原子替换升级为 v2；重复执行可恢复
中断的升级。知识库分类初始复制专家分类，原有三类条目语义不变。

维护者和 CI 使用内部只读验证入口：

```bash
pnpm --filter @pragma/local-host build
node scripts/validate-bundle-source.mjs /path/to/source
```

## Desktop 同步与下载

Desktop 对每个启用源执行 shallow fetch + partial clone，锁定 `FETCH_HEAD` commit。刷新时通过
`git ls-tree` 校验文件模式和路径，只读取 `pragma-source.yaml` 与 `config.yaml` blob；不会读取
`.pragma`。成功后保存包含 manifest 和 items 的可重建快照。新 commit 无效时保留上一快照并标记
stale。

用户选择版本后，Desktop 才从该固定 commit 流式读取 `bundle.pragma`，实施大小限制，并由 Bundle
decoder 校验内部文件哈希、fingerprint 和协议。随后核对 config 的 rootRef 与根资源类型，再把缓存
文件交给导入向导。

## v1 Registry 迁移

旧 `pragma.bundle-registry/v1` 使用内部一次性迁移器，不属于公共 CLI：

```bash
pnpm --filter @pragma/local-host build
node scripts/migrate-bundle-registry-v1.mjs /path/to/legacy-registry
```

迁移器使用 staging、稳定 journal、`.pragma-registry-v1-backup/` 和迁移报告。无法无损映射的媒体
字段会在移动旧文件前中止。迁移成功后应运行只读验证器，并人工审阅报告和 Git diff。
