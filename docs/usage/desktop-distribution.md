# Desktop 图标与发行包

Pragma Desktop 使用 `electron-vite` 编译应用代码，使用 `electron-builder` 生成可分发的应用和安装包。两者职责不同：根命令 `pnpm build` 仍只做可验证的代码构建，发行包通过 Desktop package 的 `dist:*` 命令显式生成。

## 图标资源

图标母版位于 `apps/desktop/build/`：

```text
icon-mac.svg          macOS 1024×1024 矢量母版
icon-mac.png          macOS 开发态 Dock 与运行时图标
icon-windows.svg      Windows 1024×1024 矢量母版
icon-windows.png      Windows 开发态窗口与运行时图标
```

macOS 和 Windows 使用独立母版，不能用同一个已栅格化的小图机械放大：

- macOS 版采用更大的外部留白、圆角矩形轮廓和更柔和的层次，1024×1024 母版由打包器生成完整 ICNS 尺寸集。
- Windows 版采用透明画布、更高的图形占用率和更明确的边缘；打包器生成包含 Win32 常用尺寸的 ICO。Windows 最低覆盖要求是 16、24、32、48 和 256 像素。
- “P” 的主轮廓在 16 像素下仍需可辨。修改母版后必须重新检查 16、24、32、48 和 256 像素预览。

官方规范：

- [Apple App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
- [Microsoft: Construct your Windows app's icon](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)
- [Electron nativeImage](https://www.electronjs.org/docs/latest/api/native-image)

## 构建命令与产物

先安装依赖并准备 Electron：

```bash
pnpm install --frozen-lockfile
pnpm --filter @pragma/desktop run prepare:electron
```

`pnpm-workspace.yaml` 的 `supportedArchitectures` 会同时安装 macOS x64/arm64 与 Windows x64 打包所需的可选原生依赖。不要删除这项配置后再从单一平台交叉打包，否则目标平台的原生模块可能不会进入发行包。

构建当前系统的未封装目录，用于快速检查应用内容、图标和元数据：

```bash
pnpm --filter @pragma/desktop run package:dir
```

生成 macOS Intel 与 Apple Silicon 原生发行包：

```bash
pnpm --filter @pragma/desktop run dist:mac
```

产物位于 `apps/desktop/dist/`，每种架构都会生成 DMG 和 ZIP：

```text
Pragma Desktop-<version>-mac-x64.dmg
Pragma Desktop-<version>-mac-x64.zip
Pragma Desktop-<version>-mac-arm64.dmg
Pragma Desktop-<version>-mac-arm64.zip
```

生成 Windows x64 NSIS 安装包：

```bash
pnpm --filter @pragma/desktop run dist:win
```

产物：

```text
Pragma Desktop-<version>-win-x64.exe
```

`dist` 按当前操作系统与 `electron-builder.yml` 的目标生成发行包。正式流水线应在 macOS runner 构建 macOS，在 Windows runner 构建 Windows；这样更容易验证平台原生行为、签名和安装流程。macOS 的 DMG/ZIP 必须在 macOS 上生成。

## 签名与正式发布

当前配置允许无证书的本地测试构建，但无签名包不应直接公开发布。

- macOS 正式包需要 Developer ID Application 证书、Hardened Runtime、Apple notarization 和 stapling。仓库已启用 Hardened Runtime；签名身份和公证凭据必须由 CI secret 注入，不能提交到仓库。
- Windows 正式 EXE 需要受信任的 Authenticode 代码签名证书或 Microsoft Trusted Signing。自签名证书只适合受控测试环境。
- `appId` 固定为 `dev.pragma.desktop`，同时用作 macOS bundle identifier 与 Windows Application User Model ID。发布后不要随意改变，否则会影响系统身份、快捷方式、通知和后续升级。

相关文档：

- [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Microsoft code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [electron-builder architecture guide](https://www.electron.build/docs/architecture/)
