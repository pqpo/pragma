# Pragma 桌面发行方案

> 状态：Phase 1 已实现
>
> 基线：2026-07-30
>
> 当前范围：未签名的 macOS、Windows 安装包、GitHub Pre-release 和 macOS OSS 镜像

本文记录 Pragma 桌面应用发行能力的背景、当前实现、发布 Process 和后续 Plan。产品名称统一为
`Pragma`；`desktop` 只表示应用类型、仓库目录和 workspace package，不属于产品名称。

面向维护者的本地命令见
[Pragma 桌面安装包](../usage/desktop-distribution.md)。

## 背景

Pragma 已经使用一套完整的 Electron 构建链：

- pnpm workspace 与 Turborepo 管理 monorepo。
- Electron 43 运行桌面应用。
- electron-vite 5 和 Vite 7 编译 main、preload、renderer。
- electron-builder 26 生成安装包。
- main 入口为 `apps/desktop/src/main/index.ts`。
- preload 入口为 `apps/desktop/src/preload/index.ts`。
- renderer 是位于 `apps/desktop/src/renderer` 的 React 应用。
- preload Bridge、IPC Schema 和结构化日志继续沿用现有实现。

在 Phase 1 之前，仓库虽然已有本地 `electron-builder` 配置，但版本仍为 `0.0.0`，应用身份尚未冻结，
也没有 Tag 驱动的 GitHub Release workflow。

签名和在线更新会显著增加账户、证书、Secrets、平台验证和客户端状态管理成本。为了先获得真实可安装、
可验证的跨平台产物，Phase 1 有意只实现未签名 Pre-release：

```text
source
  → pnpm quality checks
  → electron-vite build
  → electron-builder
  → per-platform Actions artifacts
  → checksum validation
  → GitHub Draft Release
  → Alibaba Cloud OSS macOS mirror
  → GitHub Pre-release
```

## 当前发行契约

### 应用身份

```text
productName: Pragma
appId: com.pqpo.pragma
version: 0.1.0
tag: v0.1.0
release title: Pragma v0.1.0
```

`appId` 会参与 macOS Bundle Identifier 和 Windows 安装身份。首个公开安装包发布后，不应在没有迁移
方案的情况下修改。

### 平台和产物

| 平台    | Runner           | 架构                | 产物     |
| ------- | ---------------- | ------------------- | -------- |
| macOS   | `macos-15`       | Apple Silicon arm64 | DMG、ZIP |
| macOS   | `macos-15-intel` | Intel x64           | DMG、ZIP |
| Windows | `windows-2025`   | x64                 | NSIS EXE |

版本 `0.1.0` 的 Release 必须包含：

```text
Pragma-0.1.0-mac-arm64.dmg
Pragma-0.1.0-mac-arm64.zip
Pragma-0.1.0-mac-x64.dmg
Pragma-0.1.0-mac-x64.zip
Pragma-0.1.0-win-x64.exe
SHA256SUMS.txt
```

Release 汇总 Job 会检查五个安装包都存在且非空，并拒绝额外的 DMG、ZIP 或 EXE。只有三个平台 Job
全部成功后，才会公开 Pre-release。

### OSS 镜像

Tag 发布还会将下列 macOS DMG 镜像到阿里云 OSS 的版本化路径
`desktop/<tag>/`：

```text
Pragma-0.1.0-mac-arm64.dmg
Pragma-0.1.0-mac-x64.dmg
SHA256SUMS-mac.txt
```

macOS ZIP 和 Windows EXE 不上传 OSS，继续只通过 GitHub Release 分发。`SHA256SUMS-mac.txt` 只覆盖
两个 macOS DMG；GitHub Release 中的 `SHA256SUMS.txt` 继续覆盖全部五个安装包。

### 明确排除

Phase 1 不包含：

- macOS Developer ID 签名、公证或 stapling。
- Windows Authenticode 或 Artifact Signing。
- macOS Universal 安装包。
- `electron-updater`。
- `latest-mac.yml`、`latest.yml` 或 blockmap 发布。
- 更新 IPC、更新状态机或 Settings 更新 UI。
- Linux 安装包。
- Mac App Store、Microsoft Store 或自建更新服务。

## 实现位置

### Desktop package

`apps/desktop/package.json` 保存应用版本和可复用脚本：

```text
dist:mac:arm64
dist:mac:x64
dist:win:x64
```

三个命令都先执行现有 `build`，因此保留内置插件打包和 preload bundle 验证。命令显式传递
`--publish never`，防止各平台构建进程自行创建不完整 Release。

### electron-builder

`apps/desktop/electron-builder.yml` 是唯一安装包配置：

- `productName` 为 `Pragma`。
- `appId` 为 `com.pqpo.pragma`。
- 输出目录为 `apps/desktop/dist`。
- macOS 分别构建 arm64/x64 的 DMG 和 ZIP。
- Windows 构建 x64 NSIS。
- NSIS 允许用户选择安装目录，并创建桌面和开始菜单快捷方式。
- macOS 使用 `identity: null` 和 `hardenedRuntime: false`，明确当前是未签名构建。

显式关闭 macOS 签名可以避免开发机 Keychain 或 runner 环境意外改变产物。后续接入 Developer ID 时，
需要在同一改动中移除这两个 Phase 1 设置并恢复 Hardened Runtime。

### GitHub Actions

`.github/workflows/desktop-release.yml` 支持：

- `workflow_dispatch`：构建并保留 Actions artifacts，不发布 Release。
- `v*` Tag push：验证、构建、镜像 macOS 资产到 OSS 并发布 Pre-release。

workflow 权限默认为 `contents: read`，只有最终 Release Job 使用 `contents: write`。发布使用 GitHub
自动提供的短期 `GITHUB_TOKEN`。Release Job 绑定 `desktop-release` Environment，通过 GitHub OIDC
换取 30 分钟有效的阿里云 STS 凭证；仓库不保存个人 Token 或阿里云长期 AccessKey。

Release Environment 必须提供以下非敏感 Variables：

```text
ALIYUN_OIDC_PROVIDER_ARN
ALIYUN_RELEASE_ROLE_ARN
ALIYUN_OSS_BUCKET
ALIYUN_OSS_REGION
```

阿里云 RAM 角色只能列出目标 Bucket 的 `desktop/` 前缀，并对该前缀执行上传、读取校验、列举分片和
中止未完成分片；不得获得对象删除、Bucket 管理或 ACL 修改权限。

## Release Process

### 1. 准备版本

在普通分支中更新 `apps/desktop/package.json` 的版本，并运行：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

版本修改、发行配置和 Release Notes 应通过普通 Pull Request 合入 `main`。

### 2. 可选的手动构建

在 GitHub Actions 中手动运行 `Desktop Release`：

1. 完成完整质量检查。
2. 在三个原生 runner 上构建安装包。
3. 将安装包保存为保留七天的 Actions artifacts。
4. 不创建 Tag 或 GitHub Release。

此步骤适合在创建正式版本 Tag 前验证构建环境。

### 3. 创建版本 Tag

在已经合入 `main` 的版本 commit 上创建带注释 Tag：

```bash
git tag -a v0.1.0 -m "Pragma v0.1.0"
git push origin v0.1.0
```

workflow 会在下载依赖前后执行完整验证，并在打包前确认：

- Tag 满足 `vX.Y.Z`。
- 去除 `v` 后与 `apps/desktop/package.json` 的 version 完全一致。
- Tag 指向的 commit 属于 `origin/main` 历史。

### 4. 构建与汇总

三个原生 runner 独立执行 frozen-lockfile 安装和目标平台打包。安装包先上传为 Actions artifacts，
而不是直接写入 GitHub Releases。

最终 Release Job：

1. 下载并合并三个 Actions artifacts。
2. 检查五个预期安装包。
3. 生成 `SHA256SUMS.txt`。
4. 为两个 macOS DMG 生成 `SHA256SUMS-mac.txt`。
5. 创建 Draft Release，并向 GitHub 上传全部跨平台产物。
6. 通过 GitHub OIDC 换取阿里云短期 STS 凭证。
7. 只向 OSS 的 `desktop/<tag>/` 上传两个 macOS DMG 和 macOS 校验清单。
8. 逐个读取 OSS Object metadata，确认远端大小与本地文件一致。
9. 将 Draft 发布为 Pre-release。

如果同 Tag 已经存在公开 Release，workflow 会失败且不会覆盖。失败运行留下的 Draft 可以由同 Tag
重新运行补齐；GitHub 资产上传使用 `--clobber` 只作用于尚未公开的 Draft。OSS 使用版本化路径，重试
只会补齐或覆盖当前尚未公开版本的同名 DMG。OSS 上传或校验失败时，GitHub Release 保持 Draft，
不会公开一个缺少镜像的版本。

### 5. 安装验证

发布后至少在下列真实系统执行 Smoke Test：

- Apple Silicon macOS。
- Intel macOS。
- Windows x64。

检查项：

- 下载文件的 SHA-256 与 `SHA256SUMS.txt` 一致。
- 安装包架构与文件名一致。
- 应用、窗口标题和快捷方式显示 `Pragma`。
- 主窗口可以启动。
- preload Bridge 正常注入。
- renderer 不出现白屏。
- 内置插件可以加载。
- 用户可以完成卸载。

未签名包会触发系统安全提示：

- macOS 需要用户在系统设置的“隐私与安全性”中允许打开。
- Windows 可能显示“未知发布者”或 SmartScreen 提示。

这些提示是 Phase 1 的已知限制，不应在文档或 UI 中描述为受信任的正式安装体验。

## 后续 Plan

### Phase 2：安装包稳定性

- 使用 `hdiutil`、`unzip` 和 Windows 安装器静默模式补充 CI 结构验证。
- 在真实 Intel、Apple Silicon 和 Windows 机器完成回归矩阵。
- 验证 Runtime 原生可选依赖随目标架构正确进入安装包。
- 评估 macOS Universal 合并；在原生依赖验证通过前保留双架构包。

### Phase 3：平台签名

- macOS 接入 Developer ID Application、Hardened Runtime、公证和 stapling。
- Windows 根据实际主体资格选择 Authenticode 证书或 Microsoft Artifact Signing。
- Secrets 只保存在 GitHub Environment 或受控签名服务。
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

- 不提交 Token、证书、私钥、密码、临时 Keychain 或 Azure 凭据。
- 不创建或提交阿里云长期 AccessKey；GitHub Actions 只通过受限 OIDC 角色取得短期 STS 凭证。
- Pull Request workflow 不获得 Release 写权限。
- 平台 Job 不直接发布 Release，防止出现单平台半成品。
- OSS 上传使用显式 DMG allowlist，不使用包含 ZIP 和 Windows 产物的目录递归同步。
- OIDC Action 固定到完整 commit；`ossutil` 固定版本并在执行前校验官方 SHA-256。
- 已公开版本不可覆盖；修复必须提升 SemVer。
- 校验和用于验证下载完整性，但不能替代平台代码签名。
- 仓库为私有时，Release 也只对授权用户可见；公开下载前需要先确认仓库可见性和许可证表述。
- 当前许可证属于仓库自己的 source-available 条款，对外材料不应把它误称为 OSI 认证的开源许可证。

## 完成定义

Phase 1 完成需要同时满足：

- 产品名称在运行时和安装包中统一为 `Pragma`。
- `v0.1.0` 可以触发完整质量检查。
- 三个原生 runner 可以生成五个安装包。
- 任一平台失败时不发布 Pre-release。
- Pre-release 包含五个安装包和 `SHA256SUMS.txt`。
- OSS 版本路径只包含两个 macOS DMG 和 `SHA256SUMS-mac.txt`，不包含 ZIP 或 Windows EXE。
- OSS 上传与 metadata 校验成功后才公开 GitHub Pre-release。
- 安装包不包含自动更新实现或签名凭据。
- 文档与 package scripts、electron-builder 和 workflow 保持一致。

## 参考资料

- [electron-builder Architecture](https://www.electron.build/docs/architecture/)
- [electron-builder macOS](https://www.electron.build/docs/mac/)
- [electron-builder NSIS](https://www.electron.build/nsis.html)
- [electron-builder GitHub Actions](https://www.electron.build/docs/features/github-actions/)
- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub automatic token authentication](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication)
