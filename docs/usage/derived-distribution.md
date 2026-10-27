# 派生发行版：配置、构建与隔离

开源默认值保持不变。派生发行身份在构建时固定，运行时不读取发行配置文件；企业配置放在私有仓库，通过 `PRAGMA_DISTRIBUTION_CONFIG` 指定绝对路径。配置仅包含非敏感身份，不放证书、密码或业务配置。

## 配置与构建

以 `examples/distribution.acme.json` 为完整示例。每个字段均由 `@pragma/shared/distribution` 的 `DistributionConfigSchema` 校验；除可选的 `desktopVersion`、`cliVersion` 外，其余字段必填。版本未指定时分别使用 Desktop 和 CLI 的 package 版本。

```sh
export PRAGMA_DISTRIBUTION_CONFIG=/absolute/path/private/distribution.json
pnpm build
pnpm --filter @pragma/desktop dist:mac:arm64 --prepared
# 在 Windows 原生 runner 上使用 dist:win:x64；macOS x64 使用 dist:mac:x64。
pnpm --filter @pqpo/pragma package:pack --prepared
```

Windows PowerShell 先设置 `$env:PRAGMA_DISTRIBUTION_CONFIG = 'C:\private\distribution.json'`，再执行相同 pnpm 命令。使用仓库指定的 pnpm 10.12.1 与 Node >=22；独立 CLI 与 Desktop 仍仅支持 macOS、Windows。

- `id` 是长期稳定的发行标识；`applicationId` 同时用于 Windows 应用身份与安装器 GUID 派生。
- `productName` 用于安装器与快捷方式；`executableName` 同时决定 `.app` 文件名及应用可执行文件名。
- `applicationName` 是 Electron 内部名称及历史 Safe Storage 身份，不随日常品牌文案调整。
- `userDataDirectory`、`userDataDevelopmentDirectory` 位于 Electron 的系统 appData 下，分别用于正式版、开发版，并在单实例锁之前设置。
- `homeDirectory`、`developmentHomeDirectory` 位于用户主目录下。正式 Desktop、内置 CLI、独立 CLI 共享本发行版业务目录；Desktop 开发模式默认使用开发目录。
- `homeEnvironmentVariable` 是本发行版唯一的数据根目录覆盖变量；Acme 示例使用 `ACME_PRAGMA_HOME`，忽略 `PRAGMA_HOME`。空白值使用默认目录。需要开发 Desktop 与 CLI 访问同一目录时，显式设置本版目录变量。
- `credentialNamespace` 必须长期稳定。密钥账户由规范化数据目录与该命名空间共同确定，Desktop 和 CLI 使用相同规则。改动命名空间不会自动迁移密钥或现有数据。
- `cliPackageName` 只改变发布暂存包；源码 workspace 仍为 `@pqpo/pragma`。`cliCommand` 与 `desktopCliCommand` 分别控制普通和显式 Desktop 命令，派生版不会注册 `pragma` 或 `pragma-desktop`。

当前身份字段使用受约束的 ASCII 标识与名称，拒绝路径分隔符和脚本元字符；实际用户主目录、安装目录支持空格、中文。同一机器上的其他派生产品也应各自使用独立身份。

## 打包、缓存与溯源

通过现有 `dist:*`、`package:dir` 入口打包。脚本在 `.packaging/` 生成构建器配置和发行元数据，不改写源码 package.json。业务协议、内置资源 ID、内部 `@pragma/*` 包名保持稳定。

同一次构建使用不可变发行配置快照，主程序、内置 CLI 与 Worker 不再分别读取外部文件。主程序与内置 CLI 分别写入发行摘要；prepared 记录及打包同时核对两者，拒绝把旧产物重新标记为新发行身份。

配置内容摘要进入源码身份、prepared 清单及内置 CLI 的 `distribution.json`。即使配置路径不变，只修改内容也会使旧产物验证失败。打包阶段再次核对内置 CLI 与当前配置摘要；不能用 electron-builder 的 `-c` 参数覆盖发行身份。

根 `pnpm build` 将配置摘要传给 Turbo。Desktop 和 CLI 应用构建禁用 Turbo 输出缓存，确保直接调用 Turbo 时也不会漏掉仓库外同路径配置的变化；其他 workspace 包仍使用构建缓存。外部配置路径必须在构建与打包机器上分别正确设置。

CLI 平台 smoke 从下载产物的报告中读取发行描述并校验摘要，只依赖 Node 内置模块，可在没有仓库依赖的干净 checkout 和 Node 20 负向验证中运行。

开源发布工作流固定使用默认身份；Desktop 原生打包前验证默认配置，npm 发布前检查 tarball 的包名、版本、命令与发行标识。企业 registry、签名、品牌资源、私有发布流水线由企业仓库管理。本阶段保留现有签名行为；不会自动签名或发布。

## 共存验收

1. 在 macOS、Windows 的隔离 runner 分别构建默认版和示例派生版，保留各自安装包及 CLI tarball；两版构建需要依次进行，输出目录不支持并行写入。
2. 两版同时安装并启动；再次启动任一版本，只唤起本版窗口。正式版与开发版的 Electron 数据目录分别隔离。
3. 为两版分别写入设置、Mission 和模型凭据，使用各自 Desktop、内置 CLI 和独立 CLI 验证版内可读、版间不可见；默认版升级后历史凭据仍可读取。
4. 检查两组终端命令。修复、升级、移除入口和卸载任一版本，不得删除另一版的 Shell 配置块、PATH 项、注册表或启动脚本。卸载保留业务数据。覆盖中文及含空格的安装目录。
5. 修改同一配置文件的版本后尝试 `--prepared`，应明确拒绝旧产物；重新构建后，安装器和 CLI 的版本、发行摘要一致。

自动回归覆盖目录选择、Electron 身份、Shell 文件所有权、密钥账户隔离和产物摘要。macOS 的真实钥匙串授权、Windows 系统凭据、原生安装器和实际单实例行为，需在对应平台验收；Linux 上的单元测试不能替代这些证据。

默认目录和变量保证隔离。用户主动把两版的目录变量指向同一位置属于显式共享，本阶段不引入目录归属协议；由于凭据命名空间不同，也不支持将业务目录直接复制给另一版来共享凭据。
