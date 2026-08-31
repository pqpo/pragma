# Pragma CLI 分发与发布运维手册

本文是 `@pqpo/pragma` 的安装、升级、冲突诊断和首次发布 runbook。CLI 的包名是
`@pqpo/pragma`，安装后的命令名是 `pragma`。

## 用户安装与版本策略

运行环境要求：Node.js 22 或更高版本；当前发行包支持 macOS arm64、macOS x64 和 Windows
x64。Linux、其他 CPU 和其他操作系统由 package manifest 的 `os` 字段拒绝。CLI 不安装
第二份 Node.js、不在安装期下载 payload、不发布 consumer lockfile。

稳定版和预发行版分别使用 `latest` 与 `next` dist-tag。发布后版本不可覆盖，回滚使用
明确的已发布版本：

```bash
# 稳定版
npm install --global @pqpo/pragma@latest

# 预发行版
npm install --global @pqpo/pragma@next

# 精确升级或回滚
npm install --global @pqpo/pragma@0.1.0

# 卸载
npm uninstall --global @pqpo/pragma
```

升级后确认实际执行的是目标版本：

```bash
node --version
pragma version
pragma doctor
```

Node.js 20 可能在非 strict npm 配置下安装并输出 `EBADENGINE` 警告，但 `pragma` bootstrap
会在任何主 bundle import 之前返回退出码 2；启用 `engine-strict` 时 npm 安装应直接失败。
这两种情况都应安装 Node.js 22+，而不是使用 `--force`。

## PATH 冲突与 binary 诊断

先确定 npm global prefix 和所有候选命令：

```bash
npm prefix --global
npm root --global
command -v pragma
type -a pragma
ls -l "$(npm prefix --global)/bin/pragma"
```

Windows PowerShell：

```powershell
npm prefix --global
npm root --global
Get-Command pragma -All
where.exe pragma
Get-Item "$(npm prefix --global)\pragma.cmd"
```

常见冲突来源包括旧 npm prefix、Homebrew/Chocolatey 安装、仓库的
`node_modules/.bin`、旧的 `pragma.exe`/`pragma.cmd`，以及 shell 的 command hash 或
PowerShell function/alias。若候选列表中另一个目录排在 npm prefix 前，调整 PATH 或清理
已确认的旧副本，重新打开 shell 后再次运行 `pragma version`。

`pragma doctor` 只检查 SecretStore 与凭据迁移状态，不报告 PATH 顺序。若需要绕过 PATH
确认某个安装：

```bash
"$(npm prefix --global)/bin/pragma" version
```

Windows：

```powershell
& "$(npm prefix --global)\pragma.cmd" version
```

直接调用成功而裸命令失败，说明是 PATH 或 shell 缓存问题；两者都失败时再检查 Node
版本、操作系统、npm 安装输出和 `pragma doctor`。不要用 `--force` 隐藏 binary 冲突，
也不要递归删除未确认的用户目录。

## CI 验证产物

`.github/workflows/cli-package.yml` 负责验证，`.github/workflows/cli-publish.yml` 负责发布。
前者只打包一次 canonical tarball，macOS arm64/x64、Windows x64 在 Node 22/24 上都下载
并验证同一 tarball 的 SHA-256；同时覆盖 Node 20 负向、Linux `EBADPLATFORM` 负向、隔离
global prefix、Unicode prefix、重复安装、PATH precedence、version/doctor/discover/mission
只读命令以及卸载。

build job 会上传以下审计文件：

- `SHA256SUMS.txt` 与 `artifact-manifest.json`：实际 tarball digest、大小、版本、构建身份
  （版本、git commit、打包后的 `dist/cli.js` SHA-256）和文件清单；
- `sbom.cdx.json`：CycloneDX SBOM；
- `license-report.txt`：bundle metafile 发现的 package license 报告；
- `pack-files.json` 与 npm `pack.json`：allowlist 打包明细。

在 npm scope ownership 和 trusted publisher 尚未确认时，可以只做本地 publish dry-run；该
命令不会创建 npm 版本：

```bash
pnpm --filter @pqpo/pragma package:pack
npm publish apps/cli/.release/pqpo-pragma-<version>.tgz \
  --dry-run --access public --tag next
```

dry-run 之后仍应保留 package audit、digest、SBOM 和 license report 作为交接证据；不要用
dry-run 的结果代替 package/platform matrix。

发布 workflow 不重新打包。它只接受 `cli-v<semver>` tag，要求 tag 版本等于
`apps/cli/package.json`，tag commit 已包含在默认分支，并等待完整 package/platform gates
成功后才进入受保护的 `npm-release` environment。

## 首次发布 bootstrap（P0，一次性管理员操作）

新 package 尚不存在时，npm trusted publishing 无法直接替代首次 package 建立。首次
bootstrap 只能由 npm package 管理员执行，开发者不应持有或创建长期 publish token。

1. 在受保护的默认分支准备一个已通过 `cli-package.yml` 的 `cli-v<semver>` release commit，
   保存 canonical tarball、SHA-256、SBOM、license report 和 pack audit 结果。
2. npm 管理员使用一次性、最小权限、短时有效的 granular credential，并按组织要求完成
   2FA。该凭据只用于首次公开创建 `@pqpo/pragma` 和对应的 `next` 或 `latest` 版本；不得
   写入 GitHub secret、workflow、`.npmrc`、仓库文件或日志。
3. 管理员在受控环境中重新核对 tarball digest、package manifest、`os`/`engines`、文件
   allowlist 和 provenance 要求，然后执行一次性 bootstrap publish。若组织策略要求先
   在 `next` 建立预发行版本，先使用预发行版本完成 package 创建。
4. package 创建成功后立即在 npm 配置 trusted publisher：仓库必须精确为
   `pqpo/pragma`，workflow 必须精确为 `.github/workflows/cli-publish.yml`，GitHub
   environment 必须精确为 `npm-release`，并只允许该 workflow 进行 `npm publish`。同时
   配置 package 的 public access 与组织要求的 publisher allowlist。
5. 撤销一次性凭据、删除临时 `.npmrc` 和机器上的 token，确认 npm 不再接受该 bootstrap
   凭据；检查 GitHub environment 没有 token secret，workflow 只声明
   `contents: read` 与 `id-token: write`。
6. 用下一个 `cli-v<semver>` tag 做一次 OIDC dry validation/release，确认 workflow 能在
   `npm-release` environment 获取短时身份、生成 provenance，并按规则把预发行版发到
   `next`、稳定版发到 `latest`。已发布版本存在时，workflow 必须在 publish 前失败。

### `npm-release` protected environment 配置清单

- 仅允许受保护默认分支产生的 `cli-v*` tag 部署；配置至少一名 required reviewer；
- 不配置长期 `NPM_TOKEN`、`NODE_AUTH_TOKEN` 或其他 npm publish secret；
- npm trusted publisher 的 repository/workflow/environment 三元组与上文完全一致；
- workflow 权限保持 `contents: read`、`id-token: write`，不授予 package verification
  workflow OIDC 写权限；
- 稳定版走 `latest`，预发行版走 `next`；不使用 `npm dist-tag add` 移动已发布版本。
  紧急 dist-tag 处理必须由管理员按组织 2FA 流程人工执行并留下审计记录。

真实 npm scope ownership、trusted publisher allowlist 和首次 bootstrap 仍是外部 npm
管理员前置条件；在确认前只运行 package verification、dry-run 和本地 smoke，不执行真实
publish 或 dist-tag 变更。
