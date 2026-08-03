# Pragma 桌面安装包

Pragma 使用 `electron-vite` 编译应用代码，使用 `electron-builder` 生成安装包。根命令
`pnpm build` 只做可验证的代码构建；发行包通过 `@pragma/desktop` package 的 `dist:*` 命令显式生成。

当前阶段发布未签名的 GitHub Pre-release，并将 macOS DMG 镜像到阿里云 OSS；不包含自动更新。
背景、完整 Plan 和 Release Process 见
[Pragma 桌面发行方案](../architecture/desktop-release-and-online-update.md)。

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

仓库使用 pnpm `10.12.1`。Release workflow 使用 Node.js `22.19.0`，避免低版本 Node 不满足当前依赖的
engine 要求。

`pnpm-workspace.yaml` 的 `supportedArchitectures` 会准备 macOS x64/arm64 和 Windows x64 的可选原生
依赖。不要移除这项配置后再尝试跨架构打包。

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
apps/desktop/dist/Pragma-0.1.0-mac-arm64.dmg
apps/desktop/dist/Pragma-0.1.0-mac-arm64.zip
```

### macOS Intel

必须在 macOS 环境执行：

```bash
pnpm --filter @pragma/desktop run dist:mac:x64
```

输出：

```text
apps/desktop/dist/Pragma-0.1.0-mac-x64.dmg
apps/desktop/dist/Pragma-0.1.0-mac-x64.zip
```

一次构建两种 macOS 架构仍可使用：

```bash
pnpm --filter @pragma/desktop run dist:mac
```

### Windows x64

必须在 Windows 环境执行：

```bash
pnpm --filter @pragma/desktop run dist:win:x64
```

输出：

```text
apps/desktop/dist/Pragma-0.1.0-win-x64.exe
```

原有别名仍可使用：

```bash
pnpm --filter @pragma/desktop run dist:win
```

## GitHub Pre-release

`.github/workflows/desktop-release.yml` 有两种入口。

### 手动验证

在 GitHub Actions 中运行 `Desktop Release` 的 `workflow_dispatch`。它会：

1. 执行 lint、typecheck、test 和 build。
2. 在原生 macOS arm64、macOS Intel、Windows x64 runner 上打包。
3. 上传保留七天的 Actions artifacts。
4. 不创建 GitHub Release。

### Tag 发布

应用 version 和 Tag 必须一致：

```bash
git tag -a v0.1.0 -m "Pragma v0.1.0"
git push origin v0.1.0
```

成功后 workflow 创建 `Pragma v0.1.0` Pre-release，包含：

```text
Pragma-0.1.0-mac-arm64.dmg
Pragma-0.1.0-mac-arm64.zip
Pragma-0.1.0-mac-x64.dmg
Pragma-0.1.0-mac-x64.zip
Pragma-0.1.0-win-x64.exe
SHA256SUMS.txt
```

如果任一平台失败，Release 不会公开。同一 Tag 已经存在公开 Release 时，workflow 拒绝覆盖。

### 阿里云 OSS macOS 镜像

Tag workflow 使用 `desktop-release` GitHub Environment 的 OIDC 身份换取阿里云短期 STS 凭证，
不保存长期 AccessKey。Environment 必须配置：

```text
ALIYUN_OIDC_PROVIDER_ARN
ALIYUN_RELEASE_ROLE_ARN
ALIYUN_OSS_BUCKET
ALIYUN_OSS_REGION
```

版本 `v0.1.0` 上传到 OSS 的对象为：

```text
desktop/v0.1.0/Pragma-0.1.0-mac-arm64.dmg
desktop/v0.1.0/Pragma-0.1.0-mac-x64.dmg
desktop/v0.1.0/SHA256SUMS-mac.txt
```

macOS ZIP 和 Windows EXE 不上传 OSS。OSS 上传使用明确的 DMG allowlist，并在公开 GitHub Pre-release
前逐个校验远端对象大小；任一上传或校验失败都会保留 GitHub Draft Release 并终止发布。

## 未签名安装提示

当前产物没有系统代码签名：

- macOS Gatekeeper 会阻止常规双击启动。用户需要在系统设置的“隐私与安全性”中选择仍要打开。
- Windows 可能显示“未知发布者”或 Microsoft Defender SmartScreen 提示。
- SHA-256 校验只能验证下载完整性，不能替代代码签名。

当前 ZIP 只是人工分发产物，不用于自动更新。接入 macOS 签名、公证和 Windows 签名后，才会开始实现
`electron-updater` 和稳定 Release。

## 验证清单

发布后在对应真实系统检查：

- 文件 SHA-256 与 `SHA256SUMS.txt` 一致。
- 应用名称、窗口标题和快捷方式均为 `Pragma`。
- 安装包架构与文件名一致。
- 主窗口正常打开。
- preload Bridge 正常注入。
- renderer 没有白屏。
- 内置插件可以加载。
- Windows 可以正常卸载。

相关资料：

- [electron-builder architecture](https://www.electron.build/docs/architecture/)
- [electron-builder macOS](https://www.electron.build/docs/mac/)
- [electron-builder NSIS](https://www.electron.build/nsis.html)
