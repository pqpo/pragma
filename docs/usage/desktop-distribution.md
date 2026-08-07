# Pragma 桌面安装包与本地发行

Pragma 使用 `electron-vite` 编译应用代码，使用 `electron-builder` 生成安装包。根命令
`pnpm build` 只做可验证的代码构建；发行包通过 `@pragma/desktop` package 的 `dist:*` 或
`release:desktop` 命令显式生成。

当前发行流程不使用 GitHub Actions：构建、校验、Tag、GitHub Draft Release、产物上传和发布均由维护者在本地完成。

## 图标资源

图标位于 `apps/desktop/build/`：

```text
icon-mac.png          macOS 图标，1024×1024
icon-windows.png      Windows 图标，1024×1024
```

macOS 和 Windows 使用独立 PNG。electron-builder 会据此生成目标平台图标格式。修改图标后，需要检查
16、24、32、48、256 和 1024 像素下的显示效果。

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
apps/desktop/dist/Pragma-0.1.10-mac-arm64.dmg
apps/desktop/dist/Pragma-0.1.10-mac-arm64.zip
```

### macOS Intel

必须在 macOS 环境执行：

```bash
pnpm --filter @pragma/desktop run dist:mac:x64
```

输出：

```text
apps/desktop/dist/Pragma-0.1.10-mac-x64.dmg
apps/desktop/dist/Pragma-0.1.10-mac-x64.zip
```

### Windows x64

必须在 Windows 环境执行：

```bash
pnpm --filter @pragma/desktop run dist:win:x64
```

输出：

```text
apps/desktop/dist/Pragma-0.1.10-win-x64.exe
```

## 本地 GitHub Release

`apps/desktop/scripts/release-desktop.mjs` 将跨平台打包和 GitHub Release 串起来。它不会覆盖已有
Tag 或 Release；构建产物暂存于被 Git 忽略的 `release-assets/v<version>/`。

### 1. 准备版本

修改 `apps/desktop/package.json` 的 `version`，例如 `0.1.10`，并将版本修改提交到目标分支：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git add apps/desktop/package.json
git commit -m "chore: release v0.1.10"
```

发布前先登录 GitHub CLI：

```bash
gh auth login
```

### 2. 在原生平台打包并暂存

在 macOS Apple Silicon、macOS Intel 和 Windows x64 环境分别执行对应命令：

```bash
pnpm --filter @pragma/desktop run release:desktop -- \
  --version 0.1.10 \
  --platform mac-arm64
```

```bash
pnpm --filter @pragma/desktop run release:desktop -- \
  --version 0.1.10 \
  --platform mac-x64
```

```bash
pnpm --filter @pragma/desktop run release:desktop -- \
  --version 0.1.10 \
  --platform win-x64
```

如果三个构建环境不是同一台机器，将 `release-assets/v0.1.10/` 目录中的产物汇总到发布机器的
同一路径。脚本会检查产物名称、非空文件和平台匹配；全部五个产物到齐后生成 `SHA256SUMS.txt`。

### 3. 创建 Tag、Release 并上传产物

在包含全部产物、且工作区没有未提交修改的 checkout 中执行：

```bash
pnpm --filter @pragma/desktop run release:desktop -- \
  --version 0.1.10 \
  --publish
```

该命令依次执行：

- 验证 package version、质量检查、完整产物和 SHA-256 校验和。
- 创建并推送 annotated Tag `v0.1.10`。
- 创建 GitHub Draft Pre-release。
- 上传五个安装包和 `SHA256SUMS.txt`。
- 校验远端资产后公开 Release。

默认创建 Pre-release；需要稳定版本时使用：

```bash
pnpm --filter @pragma/desktop run release:desktop -- \
  --version 0.1.10 \
  --publish \
  --stable
```

也可以通过 `--notes-file release-notes.md` 提供发行说明；不提供时由 GitHub 自动生成。

如需在已完成检查后跳过重复检查，必须显式使用 `--skip-checks`。不要把它作为常规发布默认项。

### Release 产物

每个版本必须包含：

```text
Pragma-0.1.10-mac-arm64.dmg
Pragma-0.1.10-mac-arm64.zip
Pragma-0.1.10-mac-x64.dmg
Pragma-0.1.10-mac-x64.zip
Pragma-0.1.10-win-x64.exe
SHA256SUMS.txt
```

本地脚本只负责 GitHub Release 上传，不再自动镜像到阿里云 OSS。若未来仍需 OSS 镜像，应使用独立的、受控的
短期凭证流程；不得在仓库或脚本中保存长期 AccessKey。

## 未签名安装提示

当前产物没有系统代码签名：

- macOS Gatekeeper 会阻止常规双击启动。用户需要在系统设置的“隐私与安全性”中选择仍要打开。
- Windows 可能显示“未知发布者”或 Microsoft Defender SmartScreen 提示。
- SHA-256 校验只能验证下载完整性，不能替代代码签名。

当前 ZIP 只是人工分发产物，不用于自动更新。接入 macOS 签名、公证和 Windows 签名后，才会开始实现
`electron-updater` 和稳定 Release。

## 发布后验证

在对应真实系统检查：

- 下载文件的 SHA-256 与 `SHA256SUMS.txt` 一致。
- 安装包架构与文件名一致。
- 应用名称、窗口标题和快捷方式均为 `Pragma`。
- 主窗口正常打开，preload Bridge 正常注入，renderer 没有白屏。
- 内置插件可以加载。
- Windows 可以正常卸载。

相关资料：

- [Pragma 桌面发行方案](../architecture/desktop-release-and-online-update.md)
- [electron-builder architecture](https://www.electron.build/docs/architecture/)
- [electron-builder macOS](https://www.electron.build/docs/mac/)
- [electron-builder NSIS](https://www.electron.build/nsis.html)
