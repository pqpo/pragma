# Pragma 桌面安装包与 Release 发行

Pragma 使用 `electron-vite` 编译应用代码，使用 `electron-builder` 生成安装包。根命令
`pnpm build` 只做可验证的代码构建；发行包通过 GitHub Actions 工作流或 `@pragma/desktop` package 的 `dist:*` / `release:desktop` 命令生成。

系统支持两种发行方式：**默认使用 GitHub Actions 自动打包与发布**；仅在特殊调试或明确要求使用本地打包时，才使用**本地脚本打包**。

## 1. 默认方式：GitHub Actions 自动 Release（推荐）

GitHub Actions 自动化流水线位于 [.github/workflows/desktop-release.yml](../../.github/workflows/desktop-release.yml)。

### 触发条件

在带有合规格式 `vX.Y.Z` 的 Git Tag 被推送至 GitHub 且对应 Commit 包含在 `main` 分支时触发：

```bash
# 1. 确保在 main 分支更新了 apps/desktop/package.json 中的版本号（例如 0.2.2）
git checkout main
git pull

# 2. 创建并推送匹配的 Tag
git tag v0.2.2
git push origin v0.2.2
```

### 执行流程

1. **源码与契约验证 (`verify`)**：自动校验 Tag 格式与 `package.json` 版本一致性，运行类型检查、规范检查与核心测试 (`pnpm test:core`)。
2. **多平台构建 (`package`)**：在独立的 GitHub Runner 上分别打出 `mac-arm64` (DMG, ZIP)、`mac-x64` (DMG, ZIP) 和 `win-x64` (EXE)。
3. **GitHub Release 发布 (`release`)**：计算 SHA-256 校验和，自动创建 GitHub Pre-release / Draft，上传产物资产并发布。

发布前会将两个 macOS DMG 和对应校验和同步到阿里云 OSS。每个架构上传前独立获取有效期一小时的
OIDC 临时凭据，避免两个大文件共用凭据导致后续上传时凭据过期。OSS 同步失败时 Release 保持草稿。

### 恢复发布

当源码验证和三个平台的打包均已成功，只有发布步骤失败时，可从 main 的最新 workflow 恢复同一个版本：

```bash
gh workflow run desktop-release.yml --ref main \
  -f release_tag=v0.2.47 \
  -f source_run_id=36530460942
```

替换为目标 Tag 与已完成的原始 Tag 发行 run id。恢复会验证原始 run 的源码 commit、Tag、触发方式以及
源码验证与三平台打包的成功结果，再复用其七天内保留的安装包。不会移动 Tag、重建安装包或覆盖已公开
Release。原始产物过期时，省略 `source_run_id`，重新验证并构建 `release_tag` 指定的源码；不指定
`release_tag` 的手动运行只验证和构建，不发布。

GitHub 的 `desktop-release` environment 部署规则必须允许 `v*` Tag，以及恢复 workflow 所在的精确
`main` 分支。恢复仍校验发行源码包含于 `origin/main`，不使用手动运行所在分支的应用代码打包。

---

## 2. 备选方式：本地脚本打包与发布

仅在离线网络限制、需要在本地构建临时调试包或明确指定使用本地打包时使用。

## 环境

安装锁定依赖：

```bash
pnpm install --frozen-lockfile
```

仓库使用 pnpm `10.12.1`，Node.js 要求为 `>=22`。`pnpm-workspace.yaml` 的 `supportedArchitectures`
会准备 macOS x64/arm64 和 Windows x64 的可选原生依赖。

## 本地打包

每个 `dist:*` 命令都会先清空旧的 `apps/desktop/dist`，打包完成后只保留本次生成的安装包和
`packaging-audit-*.json`，并删除 electron-builder 的解包暂存目录。连续打不同平台时，上一批安装包会被
下一次打包清理；本地 `release:desktop` 会先把当前平台安装包复制到 `release-assets/v<version>/`，再清空
`dist`。可单独运行 `pnpm --filter @pragma/desktop run dist:clean` 清空 `dist`。

`package:dir` 会先清空旧产物，再有意保留本次未封装的应用目录，供本地调试；不再需要时运行
`pnpm --filter @pragma/desktop run dist:clean`。

### 未封装目录

构建当前系统的 unpacked 应用：

```bash
pnpm --filter @pragma/desktop run package:dir
```

### macOS Apple Silicon

必须在 macOS 环境执行：

```bash
pnpm --filter @pragma/desktop run dist:mac:arm64
```

输出：

```text
apps/desktop/dist/Pragma-<version>-mac-arm64.dmg
apps/desktop/dist/Pragma-<version>-mac-arm64.zip
```

### macOS Intel

必须在 macOS 环境执行：

```bash
pnpm --filter @pragma/desktop run dist:mac:x64
```

输出：

```text
apps/desktop/dist/Pragma-<version>-mac-x64.dmg
apps/desktop/dist/Pragma-<version>-mac-x64.zip
```

Windows 的 `dist:win:x64` 命令仍可用于单独验证 Windows 安装包，但 `release:desktop` 不会收集或发布 Windows 产物。

## 本地 GitHub Release

`apps/desktop/scripts/release-desktop.mjs` 将两个 macOS 架构的打包和 GitHub Release 串起来。它不会覆盖已有
Tag 或 Release；构建产物暂存于被 Git 忽略的 `release-assets/v<version>/`。

### 1. 准备版本

桌面版本以 `apps/desktop/package.json` 为唯一来源，发布脚本按仓库既有习惯生成 `v<version>` Tag。发布前从
package.json 读取版本并运行：

```bash
VERSION="$(node -p "require('./apps/desktop/package.json').version")"
printf 'Release version: %s\n' "$VERSION"
pnpm lint
pnpm typecheck
pnpm test
pnpm build
gh auth login
```

### 2. 打包并暂存两个 macOS 架构

在 macOS 环境执行：

```bash
VERSION="$(node -p "require('./apps/desktop/package.json').version")"
pnpm --filter @pragma/desktop run release:desktop -- \
  --version "$VERSION" \
  --platform mac-arm64
```

```bash
VERSION="$(node -p "require('./apps/desktop/package.json').version")"
pnpm --filter @pragma/desktop run release:desktop -- \
  --version "$VERSION" \
  --platform mac-x64
```

脚本会将四个安装包复制到 `release-assets/v<version>/`，检查文件名称和大小，并在全部产物到齐后生成
`SHA256SUMS.txt`。

### 3. 创建 Tag、Release 并上传产物

在包含全部四个产物、且工作区没有未提交修改的 checkout 中执行：

```bash
VERSION="$(node -p "require('./apps/desktop/package.json').version")"
pnpm --filter @pragma/desktop run release:desktop -- \
  --version "$VERSION" \
  --publish
```

该命令依次执行：

- 验证 package version、质量检查、完整 macOS 产物和 SHA-256 校验和。
- 创建并推送 annotated Tag `v<version>`。
- 创建 GitHub Draft Pre-release。
- 上传四个 macOS 安装包和 `SHA256SUMS.txt`。
- 校验远端资产后公开 Release。

默认创建 Pre-release；需要稳定版本时追加 `--stable`：

```bash
VERSION="$(node -p "require('./apps/desktop/package.json').version")"
pnpm --filter @pragma/desktop run release:desktop -- \
  --version "$VERSION" \
  --publish \
  --stable
```

也可以通过 `--notes-file release-notes.md` 提供发行说明；不提供时由 GitHub 自动生成。

如需在已完成检查后跳过重复检查，必须显式使用 `--skip-checks`。不要把它作为常规发布默认项。

### Release 产物

每个 Release 必须包含：

```text
Pragma-<version>-mac-arm64.dmg
Pragma-<version>-mac-arm64.zip
Pragma-<version>-mac-x64.dmg
Pragma-<version>-mac-x64.zip
SHA256SUMS.txt
```

本地脚本只负责 GitHub Release 上传，不自动镜像到阿里云 OSS。若未来仍需 OSS 镜像，应使用独立的、受控的
短期凭证流程；不得在仓库或脚本中保存长期 AccessKey。

## macOS Gatekeeper 安装

从官方 GitHub Release 下载后，先使用 `SHA256SUMS.txt` 校验文件完整性。如果 macOS
Gatekeeper 显示安全提示，请在“系统设置 → 隐私与安全性”中核对应用名称与来源后选择
“仍要打开”。不需要修改系统的全局应用来源设置。

## 发布后验证

在 Apple Silicon macOS 和 Intel macOS 上分别检查：

- 下载文件的 SHA-256 与 `SHA256SUMS.txt` 一致。
- 安装包架构与文件名一致。
- 应用名称和窗口标题均为 `Pragma`。
- 主窗口正常打开，preload Bridge 正常注入，renderer 没有白屏。
- 内置插件可以加载。

相关资料：

- [electron-builder architecture](https://www.electron.build/docs/architecture/)
- [electron-builder macOS](https://www.electron.build/docs/mac/)

## 随包 CLI 与终端集成

Desktop 携带同一源码提交构建的完整 CLI，使用应用内 Electron 的 Node 模式执行，无需另装 Node。
CLI 使用自身版本号，随 Desktop 安装包更新，不独立跟踪 npm latest。可用 `pragma version` 查看版本，
`pragma doctor` 的文本输出展示执行路径和 PATH 中其他安装；JSON/JSONL 协议保持不变。

macOS 首次打开安装后的 Desktop 时注册 `~/.pragma/bin/pragma` 和 `pragma-desktop`；开发模式、DMG
临时运行和 App Translocation 不注册。Zsh、Bash 和 Fish 的启动配置会加入有明确标记的 PATH 片段。
配置修改保留权限和内容，首次修改留下 `.pragma-backup`。变更后打开新终端。

Windows 安装器使用管理员权限执行整机安装，把 `<安装目录>\bin` 放到系统 PATH 最前面；升级时
复用 NSIS 旧版本卸载流程，保留用户数据并迁移当前用户已有的用户级安装。其他用户自己的用户级
安装不扫描，需由所属用户手动卸载。卸载删除自身 PATH 项，不修改其他 CLI。

默认 `pragma` 使用 Desktop 版，`pragma-desktop` 明确使用内置版。npm、pnpm 等安装的其他版本继续
保留，可通过绝对路径或 `npx --package=@pqpo/pragma@版本 pragma …` 调用。用户 alias、function、
Windows 当前目录查找和主动调整 PATH 仍可覆盖默认优先级。

设置 → 通用提供终端集成的状态、修复和移除。Windows 修复/移除需管理员确认并影响所有用户。
macOS 移除会保留显式停用状态，后续启动不自动恢复；修复可重新启用。应用被拖入废纸篓后，旧脚本
提示重新安装或打开应用修复，不会删除其他版本或 Pragma 数据。Agent 的 `manage-pragma` 始终使用
Execution 私有命令通道，终端注册不会赋予管理权限。

发行打包的 `afterPack` 门禁运行解包 CLI、SQLite/向量/代码 worker 和原生 keyring，使用空 PATH
验证不依赖用户 Node；检查 CLI/应用版本、源码提交、外部 workspace import 和构建路径泄漏。
Windows 提权安装、旧用户级安装迁移和三种 macOS Shell 需补真实安装验收记录。

Native 打包 job 还会执行 Windows 安装器的首次安装、重复升级、CLI 共存、移除/修复和卸载检查，
以及 macOS 的 Zsh/Bash/Fish 注册测试。Windows 检查脚本只适合隔离且已提权的测试机；它会安装
临时 Desktop、短暂修改系统 PATH，并在 finally 中恢复 PATH。旧用户级发行版迁移及交互式 UAC
仍需使用真实旧安装包补发布验收，不以同版本重复安装代替。
