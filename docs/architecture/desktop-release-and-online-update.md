# Pragma 桌面发行方案

> 状态：Phase 1 已实现
>
> 基线：2026-08-07
>
> 当前范围：本地构建、未签名的 macOS 双架构安装包、本地创建并上传 GitHub Release

本文记录 Pragma 桌面应用发行能力的背景、当前实现、发布流程和后续计划。产品名称统一为
`Pragma`；`desktop` 只表示应用类型、仓库目录和 workspace package，不属于产品名称。

面向维护者的本地命令见
[Pragma 桌面安装包与本地发行](../usage/desktop-distribution.md)。

## 背景

Pragma 已经使用一套完整的 Electron 构建链：

- pnpm workspace 与 Turborepo 管理 monorepo。
- Electron 43 运行桌面应用。
- electron-vite 编译 main、preload、renderer。
- electron-builder 生成安装包。
- main 入口为 `apps/desktop/src/main/index.ts`。
- preload 入口为 `apps/desktop/src/preload/index.ts`。
- renderer 是位于 `apps/desktop/src/renderer` 的 React 应用。
- preload Bridge、IPC Schema 和结构化日志继续沿用现有实现。

发行流程不依赖仓库内的自动化工作流。维护者在本地完成质量检查和两个 macOS 架构的打包，再用 GitHub CLI
创建 Tag、Draft Release、上传资产并公开版本：

```text
source
  → pnpm check
  → electron-vite build
  → electron-builder --mac --arm64 / --mac --x64
  → release-assets/v0.2.0/
  → SHA256SUMS.txt
  → annotated Git tag v0.2.0
  → GitHub Draft Release
  → GitHub CLI asset upload
  → GitHub Pre-release or stable Release
```

## 当前发行契约

### 应用身份

```text
productName: Pragma
appId: com.pqpo.pragma
version: 0.2.0
tag: v0.2.0
release title: Pragma v0.2.0
```

`appId` 会参与 macOS Bundle Identifier。首个公开安装包发布后，不应在没有迁移方案的情况下修改。

### 平台和产物

| 平台  | 构建环境 | 架构                | 产物     |
| ----- | -------- | ------------------- | -------- |
| macOS | macOS    | Apple Silicon arm64 | DMG、ZIP |
| macOS | macOS    | Intel x64           | DMG、ZIP |

版本 `0.2.0` 的 Release 必须包含：

```text
Pragma-0.2.0-mac-arm64.dmg
Pragma-0.2.0-mac-arm64.zip
Pragma-0.2.0-mac-x64.dmg
Pragma-0.2.0-mac-x64.zip
SHA256SUMS.txt
```

本地发布脚本只接受这四个安装包和一个校验清单，发现缺失、空文件或额外条目时拒绝发布。

Windows 的 `dist:win:x64` 脚本仍可用于开发验证，但不属于 `v0.2.0` Release 契约。

### 明确排除

本次 Release 不包含：

- Windows 或 Linux 安装包。
- macOS Developer ID 签名、公证或 stapling。
- macOS Universal 安装包。
- `electron-updater`。
- `latest-mac.yml`、`latest.yml` 或 blockmap 发布。
- 更新 IPC、更新状态机或 Settings 更新 UI。
- Mac App Store 或自动 OSS 镜像。

如果未来需要 OSS 镜像，应增加独立的本地上传步骤或受控发布工具，并继续使用短期凭证；GitHub Release
资产仍是版本的权威分发来源。

## 实现位置

### Desktop package

`apps/desktop/package.json` 保存应用版本和可复用脚本：

```text
dist:mac:arm64
dist:mac:x64
dist:win:x64
release:desktop
```

两个 macOS `dist:*` 命令都会先执行现有 `build`，因此保留内置插件打包和 preload bundle 验证。命令显式
传递 `--publish never`，防止 electron-builder 自行创建不完整 Release。

`release:desktop` 位于 `apps/desktop/scripts/release-desktop.mjs`，职责是：

- 检查 `--version` 与 `apps/desktop/package.json` 一致。
- 只允许 `mac-arm64` 和 `mac-x64` 两个 Release 平台，并将严格命名的资产复制到被忽略的 staging 目录。
- 汇总全部四个资产并生成确定性 `SHA256SUMS.txt`。
- 仅在显式传入 `--publish` 时检查干净工作区、创建不可覆盖的 `v0.2.0` annotated Tag 并推送。
- 创建 Draft Release、上传资产、校验远端资产，最后公开 Release。
- 默认发布 Pre-release；`--stable` 才发布稳定 Release。

构建两个 macOS 架构：

```bash
pnpm --filter @pragma/desktop run release:desktop -- \
  --version 0.2.0 \
  --platform mac-arm64
```

```bash
pnpm --filter @pragma/desktop run release:desktop -- \
  --version 0.2.0 \
  --platform mac-x64
```

### electron-builder

`apps/desktop/electron-builder.yml` 是唯一安装包配置：

- `productName` 为 `Pragma`。
- `appId` 为 `com.pqpo.pragma`。
- 输出目录为 `apps/desktop/dist`。
- macOS 分别构建 arm64/x64 的 DMG 和 ZIP。
- macOS 使用 `identity: null` 和 `hardenedRuntime: false`，明确当前是未签名构建。

显式关闭 macOS 签名可以避免开发机 Keychain 意外改变产物。后续接入 Developer ID 时，需要在同一改动中
移除这两个 Phase 1 设置并恢复 Hardened Runtime。

### GitHub Release

本地发布使用维护者自己的 GitHub CLI 登录态，不把 Token、证书或私钥写入仓库。脚本先创建 Draft，再上传资产，
最后才公开 Release；上传失败时 Draft 保留，避免公开不完整版本。

GitHub Release 是不可覆盖的版本边界：已存在的本地 Tag、远程 Tag 或 Release 都会令脚本 fail closed，修复
必须使用新的 SemVer。

## Release Process

### 1. 准备版本

当前桌面版本为 `0.2.0`。发布前运行：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
gh auth login
```

将版本修改、发行配置和 Release Notes 提交到目标 commit。发布脚本要求工作区没有未提交的 tracked change。

### 2. macOS 构建和汇总

在 macOS 环境分别执行 `mac-arm64` 和 `mac-x64`。脚本默认把资产写入：

```text
release-assets/v0.2.0/
```

全部四个资产汇总后，脚本生成 `SHA256SUMS.txt` 并拒绝额外文件。不要把 `apps/desktop/dist`、node_modules
或运行时私有配置作为 Release 资产。

### 3. 创建 Tag 和 Release

在含有全部资产的干净 checkout 中执行：

```bash
pnpm --filter @pragma/desktop run release:desktop -- \
  --version 0.2.0 \
  --publish \
  --notes-file release-notes.md
```

没有 `--notes-file` 时，GitHub CLI 使用自动生成的 Release Notes。`--stable` 可将默认 Pre-release 改为稳定
Release。

脚本的远程步骤严格按以下顺序执行：

1. 检查 GitHub CLI 登录态、远程地址、`v0.2.0` Tag 和 Release 均可创建。
2. 创建并推送 `v0.2.0` annotated Tag。
3. 创建 `Pragma v0.2.0` Draft Release。
4. 上传四个 macOS 安装包和 `SHA256SUMS.txt`。
5. 读取远端资产清单并确认 Release 已非 Draft。

### 4. 失败恢复

如果 Tag 已推送但 Release 创建失败，不要删除或重建同名 Tag；先修复本地认证或网络问题，再按 GitHub CLI
的 Release 状态继续处理。若 Draft 已创建但上传失败，Draft 会保留，可使用以下命令补传并公开：

```bash
gh release upload v0.2.0 release-assets/v0.2.0/* --clobber
gh release edit v0.2.0 --draft=false
```

发布后的版本不可覆盖；任何修复都应提升版本号。

### 5. 安装验证

发布后至少在 Apple Silicon macOS 和 Intel macOS 上分别执行 Smoke Test：

- 下载文件的 SHA-256 与 `SHA256SUMS.txt` 一致。
- 安装包架构与文件名一致。
- 应用和窗口标题显示 `Pragma`。
- 主窗口可以启动，preload Bridge 正常注入，renderer 不出现白屏。
- 内置插件可以加载。

未签名包会触发 macOS 安全提示：用户需要在系统设置的“隐私与安全性”中允许打开。

## 后续 Plan

### Phase 2：安装包稳定性

- 使用 `hdiutil` 和 `unzip` 补充本地结构验证。
- 在真实 Intel 和 Apple Silicon 机器完成回归矩阵。
- 验证 Runtime 原生可选依赖随目标架构正确进入安装包。
- 评估 macOS Universal 合并；在原生依赖验证通过前保留双架构包。

### Phase 3：平台签名

- macOS 接入 Developer ID Application、Hardened Runtime、公证和 stapling。
- Secrets 只保存在本地受控密钥链或受控签名服务。
- 签名 Release 缺少证书时 fail closed。
- 完成签名后再将发行状态从 Pre-release 调整为稳定 Release。

### Phase 4：在线更新

- 引入 `electron-updater` 和 GitHub Releases provider。
- 由 electron-builder 生成并发布平台更新元数据。
- 在主进程实现更新状态机、去重、错误恢复和安全退出。
- 通过类型化 preload Bridge 暴露最小更新 API。
- 在 Settings 中增加版本、检查、下载进度和重启安装 UI。
- macOS 自动更新只在签名、公证和跨版本真机验证通过后启用。

## 安全与维护规则

- 不提交 Token、证书、私钥、临时 Keychain 或密码。
- 不在本地发布脚本中写入长期云服务凭据。
- 发布者必须在发布前检查 Tag 指向的 commit、版本字段和全部资产。
- 不覆盖已存在的 Tag、Release 或公开资产；修复必须提升 SemVer。
- 校验和用于验证下载完整性，但不能替代平台代码签名。
- 仓库为私有时，Release 也只对授权用户可见；公开下载前需要先确认仓库可见性和许可证表述。
- 当前许可证属于仓库自己的 source-available 条款，对外材料不应把它误称为 OSI 认证的开源许可证。

## 完成定义

本次 `0.2.0` Release 完成需要同时满足：

- 产品名称在运行时和安装包中统一为 `Pragma`。
- 两个 macOS 架构命令可以生成四个安装包。
- 本地发布脚本可以创建唯一 Tag、Draft Release、完整资产和 `SHA256SUMS.txt`。
- 任一资产缺失、非空校验失败、Tag/Release 已存在或远端上传校验失败时不公开 Release。
- 发布后的 GitHub Release 包含四个 macOS 安装包和 `SHA256SUMS.txt`。
- 安装包不包含自动更新实现或签名凭据。
- 文档与 package scripts、electron-builder 和本地发布脚本保持一致。

## 参考资料

- [Pragma 桌面安装包与本地发行](../usage/desktop-distribution.md)
- [electron-builder Architecture](https://www.electron.build/docs/architecture/)
- [electron-builder macOS](https://www.electron.build/docs/mac/)
- [GitHub CLI release create](https://cli.github.com/manual/gh_release_create)
