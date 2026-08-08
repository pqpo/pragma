# Pragma 桌面安装包与本地发行

Pragma 使用 `electron-vite` 编译应用代码，使用 `electron-builder` 生成安装包。根命令
`pnpm build` 只做可验证的代码构建；发行包通过 `@pragma/desktop` package 的 `dist:*` 或
`release:desktop` 命令显式生成。

Release 只发布 macOS Apple Silicon 和 macOS Intel 两个版本，不使用 GitHub Actions：构建、校验、Tag、GitHub
Draft Release、产物上传和发布均由维护者在本地完成。Windows 打包脚本仍保留供开发验证，但不属于 Release。

## 环境

安装锁定依赖：

```bash
pnpm install --frozen-lockfile
```

仓库使用 pnpm `10.12.1`，Node.js 要求为 `>=22`。`pnpm-workspace.yaml` 的 `supportedArchitectures`
会准备 macOS x64/arm64 和 Windows x64 的可选原生依赖。

## 本地打包

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

## 未签名安装提示

当前产物没有系统代码签名：

- macOS Gatekeeper 可能阻止常规双击启动。用户需要在系统设置的“隐私与安全性”中选择仍要打开。
- SHA-256 校验只能验证下载完整性，不能替代代码签名。

当前 ZIP 只是人工分发产物，不用于自动更新。接入 macOS 签名、公证后，才会开始实现 `electron-updater` 和稳定 Release。

## 发布后验证

在 Apple Silicon macOS 和 Intel macOS 上分别检查：

- 下载文件的 SHA-256 与 `SHA256SUMS.txt` 一致。
- 安装包架构与文件名一致。
- 应用名称和窗口标题均为 `Pragma`。
- 主窗口正常打开，preload Bridge 正常注入，renderer 没有白屏。
- 内置插件可以加载。

相关资料：

- [Pragma 桌面发行方案](../architecture/desktop-release-and-online-update.md)
- [electron-builder architecture](https://www.electron.build/docs/architecture/)
- [electron-builder macOS](https://www.electron.build/docs/mac/)
