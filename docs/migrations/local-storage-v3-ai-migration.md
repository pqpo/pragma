# Pragma 本地存储 v3 AI 迁移手册

## 目的

Pragma 本地存储 v3 是 breaking change。Desktop 首次启动时只会把原有、未版本化的
`~/.pragma` 原子重命名为同级的 `~/.pragma-backup-<timestamp>`，然后创建空的 v3 存储；应用本身
不会读取或迁移旧格式。

本文末尾提供一段可以直接交给编码 AI 的迁移提示词。它要求 AI 在本仓库中生成一次性迁移程序，
把旧存储转换成当前代码所接受的格式，完成校验后再原子切换目录。本文不是让用户手工执行一组
`cp` 命令。

迁移仅支持同一台机器、同一操作系统用户。插件和 Capability 的凭据由 Electron
`safeStorage` 加密，直接搬到另一台机器或另一个系统账户后通常无法解密；跨机器迁移应保留定义，
但删除加密凭据并在 Desktop 中重新授权。

存储设计和生命周期见 [ADR 016](../adr/016-local-storage-lifecycle-and-content-addressing.md)。

## 迁移原则

1. 迁移前完全退出 Pragma Desktop，并确认没有 Pragma Worker、Codex、Claude Code 或迁移程序正在
   写入源目录。
2. 旧目录是只读证据。迁移程序不得修改、删除、移动或在其中创建文件。
3. 先在目标目录同级创建 staging，完成结构、引用和逐字节校验后，才允许通过 `rename` 原子切换。
4. 不向已经承载新业务数据的 v3 目录自动合并。目标不是空 v3 存储时必须停止并报告冲突。
5. 持久数据需要迁移；可重建缓存不得迁移。不能识别的目录不得猜测，必须留在备份中并写入报告。
6. Project Revision 必须保持原 revision number。即使两个旧 Revision 内容相同，也要保留两个
   Revision Manifest，使已有 Mission 的固定版本引用仍然有效。
7. 不重新实现 CAS 哈希算法，必须复用当前 `ContentAddressedStore`。CAS 使用带类型和版本域分隔的
   SHA-256，不等于对文件执行普通 `sha256sum`。
8. 所有切换都必须可回滚。成功后也不得自动删除旧备份。

## 旧目录与 v3 目录映射

| 旧路径                                                       | v3 路径                                                           | 处理方式                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `workspace/`                                                 | `workspace/`                                                      | 原样复制，保留文件模式和符号链接                                   |
| `missions/`                                                  | `data/missions/`                                                  | 原样复制；必要时只改写已知的内置 workspace 字段                    |
| `projects/<id>/manifest.yaml`                                | `data/projects/<id>/project.json`                                 | 转换为 v3 Project Manifest                                         |
| `projects/<id>/revisions/<n>/`                               | `data/objects/sha256/` 和 `data/projects/<id>/revisions/<n>.json` | 每个完整目录写入 CAS，Revision 只保存引用                          |
| `projects/<id>/layouts/`                                     | `data/projects/<id>/layouts/`                                     | 原样复制，不放入 Revision CAS                                      |
| `model-providers.json`                                       | `data/model-providers.json`                                       | 原样复制                                                           |
| `capabilities/`                                              | `data/capabilities/`                                              | 原样复制                                                           |
| `context-stores/`                                            | `data/context-stores/`                                            | 原样复制                                                           |
| `capability-credentials.json`                                | `data/credentials/capability-credentials.json`                    | 同机器原样复制，权限设为 `0600`                                    |
| `plugins/`                                                   | `data/plugins/`                                                   | 迁移用户安装的插件实体                                             |
| `state/plugins/`                                             | `data/plugin-state/`                                              | 迁移插件配置和 mutation state                                      |
| `state/plugin-credentials.json`                              | `data/credentials/plugin-credentials.json`                        | 同机器原样复制，权限设为 `0600`                                    |
| `state/expert-sessions/`                                     | `state/expert-sessions/`                                          | 原样复制                                                           |
| `state/executions/`                                          | `state/executions/`                                               | 原样复制；不要在缺少 Mission projection 时擅自归档                 |
| `state/runtime-session-owners/`                              | `state/runtime-session-owners/`                                   | 原样复制并校验 ownership                                           |
| `state/runtime-sessions/`                                    | `state/runtime-sessions/`                                         | 选择性复制 Runtime 实体，并把 Session Manifest 从 v1 转成 v2       |
| `state/runtime-environments/`                                | `state/runtime-environments/`                                     | 原样复制                                                           |
| `state/pragma/`                                              | `state/pragma/`                                                   | 原样复制默认 Agent 的宿主状态                                      |
| `state/desktop-settings.json`                                | 同路径                                                            | 原样复制，并改写已知的旧内置 workspace 路径                        |
| `state/workspace-history.json`                               | 同路径                                                            | 原样复制，并改写已知的旧内置 workspace 路径                        |
| `state/system-experts.json`                                  | 同路径                                                            | 原样复制                                                           |
| `cache/agents/`                                              | 不迁移                                                            | 可重建；v3 只保存 Agent binding，插件实体使用全局 fingerprint 缓存 |
| 每个 Codex Home 内的插件、packages、cache、skills、logs、tmp | 不迁移                                                            | 可重建或诊断数据，不能再按 Session 复制                            |
| 旧锁文件、Project 临时目录和 checkout                        | 不迁移                                                            | 应用必须停止；这些内容不是权威数据                                 |

不在表中的内容必须列入 `unclassified`，保留在旧备份中，不能静默丢弃或复制到错误的生命周期分类。

## 必须执行的格式转换

### Project Revision

旧 Project Manifest 是 `projects/<projectId>/manifest.yaml`：

```yaml
apiVersion: pragma/v2
kind: DesktopProject
projectId: studio
revision: 12
entry: revisions/12/pragma.yaml
updatedAt: 2026-01-01T00:00:00.000Z
```

迁移后写为 `data/projects/<projectId>/project.json`：

```json
{
  "schemaVersion": "pragma.desktop-project/v3",
  "projectId": "studio",
  "headRevision": 12,
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

对 `1..headRevision` 的每个 Revision：

1. 要求 `revisions/<n>/pragma.yaml` 和 `pragma.lock.yaml` 存在；中间 Revision 缺失时停止迁移。
2. 读取所有普通文件的原始 bytes，路径统一为 `/` 分隔的相对路径。拒绝路径逃逸和保留路径
   `.pragma-snapshot`。
3. 使用 `ContentAddressedStore.putSnapshot()` 写入 `data/objects/sha256/`。
4. 从该 Revision 的 `pragma.lock.yaml` 读取 `projectFingerprint` 和 `compilerVersion`。
5. 写入 `data/projects/<projectId>/revisions/<n>.json`：

```json
{
  "schemaVersion": "pragma.project-revision/v3",
  "projectId": "studio",
  "revision": 12,
  "parentRevision": 11,
  "snapshotHash": "<64 hex>",
  "projectFingerprint": "<64 hex>",
  "compilerVersion": "<non-empty string>",
  "createdAt": "<ISO datetime>"
}
```

Revision 1 不写 `parentRevision`。旧格式没有逐 Revision 的可靠创建时间；head Revision 优先使用旧
Manifest 的 `updatedAt`，其他 Revision 使用目录 `mtime`，并在迁移报告中声明这是推断值。

只迁移 `1..headRevision`。超过 head、非数字或不完整的旧 revision 作为 orphan 报告并留在旧备份中。
不得因为 snapshotHash 相同而删除 Revision Manifest。

### Runtime Session Manifest

每个 `state/runtime-sessions/<owner>/<system-session>/session.json` 从
`pragma.runtime-session/v1` 转成 `pragma.runtime-session/v2`：

| v1 `status` | v2 `processState` |
| ----------- | ----------------- |
| `creating`  | `starting`        |
| `active`    | `stopped`         |
| `closed`    | `stopped`         |
| `failed`    | `failed`          |

迁移发生时所有进程都已停止，因此不能把旧 `active` 写成 `running`。新增
`retentionState: "retained"`，删除旧 `status`，其他 identity、owner、Runtime ref、workspace history 和
时间字段保持不变。每个 Session 必须与
`state/runtime-session-owners/<encoded-systemSessionId>.json` 的 owner 完全一致。

### Codex Runtime Session

对每个 `runtime/codex/`，只迁移不可重建的差异：

- 保留 `home/sessions/` 和存在时的 `home/archived_sessions/`，因为 Codex 原生 thread resume 依赖这些
  JSONL 文件。
- 把旧 `home/` 根下的 `state*.sqlite`、`state*.sqlite-wal`、`state*.sqlite-shm` 等 SQLite 文件迁入
  同一 Runtime Context 的 `runtime/codex/sqlite/`。
- 保留 `runtime/codex/` 下无法归类为 Home 缓存的 Runtime checkpoint metadata，并在报告中逐项列出。
- 不迁移 `home/plugins/`、`home/packages/`、`home/cache/`、`home/skills/`、`home/logs/`、`home/tmp/`、
  Session 级 `auth.json`、复制的 `.env`、`config.json`、`config.toml` 或 `instructions.md`。
- 不创建共享 Codex base、skills cache、链接或 `layout.json`；下一次 Runtime 恢复时由当前代码从用户
  `CODEX_HOME` 生成最小私有 Home，仅链接可重建的 `plugins/cache`，并将当前 Agent Skills 单独复制
  到该 Context。
- 如果当前用户的 `~/.codex/auth.json` 存在，可将其快照到
  `data/credentials/codex/auth.json`；不得从多个 Session 盲目选择互相冲突的 auth 副本。
- 对每个非空 Codex `runtimeSessionRef.id`，必须在迁移后的 `home/sessions/` 或
  `home/archived_sessions/` 找到以该 ID 结尾的 `.jsonl`；找不到则报告该 Session 无法精确恢复，不能
  伪造一个文件。

其他 Runtime 的 owner 和 checkpoint 模型未发生本次内容寻址变化，应保留其 `runtime/<kind>/` 数据。

### Execution 与 Mission

旧 Execution Record 和事件文件仍可由 v3 读取，迁移时保留在 `state/executions/`。不要只为缩小目录就
直接 gzip 或删除 `events.jsonl`：v3 要求先生成
`data/missions/<missionId>/execution-projections/<executionId>.jsonl`，再归档事件。一次性迁移器如果没有
复用当前 Mission chat projection 代码，就必须选择保留原始事件，不能生成不完整 projection。

后续新完成的 Execution 会由 v3 自动生成 projection 并归档。迁移报告应单独列出保留的 legacy
terminal executions，便于未来使用正式 compactor 处理。

如果旧 Mission、Runtime Session 或 Desktop 设置的 workspace 字段恰好等于旧内置 workspace，或位于
其子目录中，应把该已知字段的前缀从 `<legacy>/workspace` 改为 `<target>/workspace`。不得对 JSON、
YAML、JSONL 和用户文件执行全局字符串替换。

## AI 迁移提示词

复制下面整个代码块交给能够访问本仓库和本机文件系统的编码 AI。把两个占位符替换为绝对路径；如果
尚未启动新版 Desktop，建议先启动一次，使旧目录自动成为 dated backup，再退出 Desktop 后迁移。

```text
你正在 /Users/linminqiu/Workspace/expert-mesh 仓库中执行一次 Pragma 本地存储 breaking migration。

输入：
- LEGACY_PRAGMA_HOME=<旧目录或 .pragma-backup-时间戳的绝对路径>
- TARGET_PRAGMA_HOME=<v3 .pragma 的绝对路径，通常是 /Users/<user>/.pragma>

目标：把 legacy Pragma storage 转成当前仓库实现所接受的 pragma.storage/v3。不要只给方案；请创建并
运行一次性迁移程序、完成校验、输出报告。迁移代码不是产品兼容层，不要把 legacy reader 接入 Desktop
启动流程。完成后保留迁移程序和报告供审计，除非我明确要求清理。

开始前必须完整阅读并以当前代码为准：
- AGENTS.md
- docs/migrations/local-storage-v3-ai-migration.md
- docs/adr/016-local-storage-lifecycle-and-content-addressing.md
- packages/core/src/storage/pragma-paths.ts
- packages/core/src/storage/content-addressed-store.ts
- packages/core/src/runtime/session-record.ts
- apps/desktop/src/main/storage-bootstrap.ts
- apps/desktop/src/main/pragma-project-store.ts
- packages/runtime/codex/src/codex-home.ts
- packages/core/src/execution/execution-store.ts
- apps/desktop/src/main/mission-store.ts

安全约束：
1. 先确认 Pragma Desktop、Worker 以及由 Pragma 启动的 Codex/Claude Code 进程均已停止；不能可靠确认时
   停止并让我处理。不要 kill 不属于 Pragma 的进程。
2. resolve 两个路径并验证它们不同。拒绝空路径、根目录、HOME、本仓库根目录及任何父子路径重叠。
3. LEGACY_PRAGMA_HOME 全程只读：不得 rename、delete、chmod、写 marker 或创建临时文件。
4. 若 TARGET_PRAGMA_HOME 的 data/ 已有 Mission、Project 或 plugin 等新业务数据，或根目录
   workspace/ 已有任务数据，停止迁移，
   不做自动 merge。目标只允许是空 v3 bootstrap 目录及其派生 storage state。
5. 如果 TARGET 中有 state/storage/legacy-backup.json，先把 retain 原子更新为 true，避免备份被到期清理。
6. 在 TARGET 同级创建唯一 staging；禁止直接覆盖 TARGET。所有写入先进入 staging。
7. 不使用 rm -rf 清理任何用户目录；失败时保留 staging 和源目录，报告恢复路径。
8. 不读取或输出 token、secret、auth 文件内容。日志只记录路径、大小和 hash；凭据权限必须为 0600。

实现要求：
1. 使用 TypeScript、Node.js >=22 和仓库现有依赖。优先把一次性脚本放到
   scripts/migrate-local-storage-v3.ts，并为纯转换函数补 Vitest 测试。所有文件修改使用 apply_patch。
2. 参数必须通过显式 CLI flags 或环境变量传入，不能在脚本中硬编码 HOME。提供 --dry-run；dry-run 不得
   写源、目标或 staging，只输出 inventory 和计划。
3. 遍历时拒绝路径逃逸。复制持久目录时保留 bytes、合理的文件模式和 workspace 内的符号链接；绝不
   跟随一个符号链接写出目标根。记录所有 absolute symlink 和指向 legacy root 的 symlink。
4. 按 docs/migrations/local-storage-v3-ai-migration.md 的映射分类 persistent/state/cache/unknown。
   unknown 必须写入 unclassified，不能猜测迁移；cache/agents 和各 Session 重复缓存不得复制。
5. Project 迁移必须复用 @pragma/core 的 ContentAddressedStore.putSnapshot；不要重写或简化哈希算法。
   保留 1..head 的全部 revision number，即使 snapshotHash 重复。使用 @pragma/interpreter 的 YAML parser
   读取旧 manifest 和 pragma.lock.yaml。保留 layouts，但 layouts 不进入 CAS。
6. 把 RuntimeSessionRecord v1 严格转成 v2。旧 active 在离线迁移后映射为 stopped，全部新增
   retentionState=retained。校验 owner claim 唯一且一致。
7. Codex Session 只迁移 native sessions、archived_sessions、私有 SQLite 和不能重建的 checkpoint
   metadata。不要迁移 Session 级插件、packages、cache、skills、logs、tmp、auth 或配置副本。验证每个
   runtimeSessionRef.id 的 native JSONL 是否存在。
8. 原样保留 legacy execution state/events。没有用当前代码生成完整 Mission projection 前，不得归档或
   删除 events.jsonl。报告 terminal legacy execution 数量和 bytes。
9. 仅在 schema 明确的 workspace 字段中，把 legacy 内置 workspace 前缀改成 TARGET/workspace；
   禁止全文替换。
10. 写 staging/storage.json，schemaVersion 必须是 pragma.storage/v3。写
    staging/state/storage/migration-report.json，至少包含：source/target/staging、开始结束时间、工具 git
    commit、各分类文件数与 logical bytes、Project/revision/CAS 统计、重复节省估算、Runtime Session
    转换数、Codex 可恢复/不可恢复列表、Execution 保留统计、unclassified、orphans、warnings、errors、
    每个直接复制树的确定性 checksum。报告不能包含 secret 内容。
11. storage catalog 是派生状态；不要从旧目录复制 catalog.sqlite。迁移验证完成后，调用当前
    rebuildStorageCatalog 或 runStorageMaintenance 生成新 catalog。GC 必须在所有 Revision Manifest
    落盘后运行，不能提前回收新 CAS object。

验证要求：
1. 校验 storage.json 和所有当前 schema；确保没有 v1 Runtime Session Manifest 留在 staging。
2. 对每个 Project 的每个 1..head Revision，从 CAS materialize 到 staging 外的临时校验目录，逐文件
   比较 path、bytes 和 executable bit；不得把 .pragma-snapshot 算作项目文件。
3. 校验 project.json head、parentRevision、lock 中 projectFingerprint/compilerVersion 与 Revision
   Manifest 一致；校验 Mission 固定引用的 Project revision 全部存在。
4. 校验 ExpertSession 引用的 Execution、Mission timeline 引用的 Execution、Runtime owner claim 和
   owner-scoped Session；缺失项写入 errors。不要伪造 owner 或 Execution 来让校验通过。
5. 对直接复制的 authoritative tree 在源和 staging 计算相同的确定性 checksum。checksum 必须包含
   relative path、entry type、mode、文件 bytes 或 symlink target，不能只比较总大小。
6. 扫描 staging，确认 cache/agents 未迁移、Project revision 全量目录未残留、Codex Home 没有重复
   plugins/packages/cache/skills/logs/tmp、没有链接指向 legacy backup。
7. 运行迁移脚本的测试、相关 package typecheck，以及一个只读 smoke test：用当前 Project、Mission、
   Execution 和 Runtime Session reader 打开所有迁移实体。不要通过启动 Desktop 来代替结构校验。

原子切换：
1. 只有 errors 为空、所有强校验通过且 TARGET 仍未出现新业务数据时才允许切换。
2. 把当前空 TARGET rename 为同级 TARGET-v3-empty-backup-<timestamp>，再把 staging rename 为 TARGET；
   两次 rename 必须位于同一 filesystem。任一步失败时立即恢复原 TARGET，不能删除任何备份。
3. 在新 TARGET/state/storage/legacy-backup.json 中记录 LEGACY_PRAGMA_HOME，retain=true。不得自动删除
   legacy 或 empty-v3 backup。
4. 切换后再执行一次只读验证并重建 catalog。不要运行会清理 legacy backup 的旧 bootstrap 流程。

最终回复必须给出：
- dry-run inventory 摘要；
- 实际迁移与校验结果；
- 新旧目录和回滚目录的绝对路径；
- Project logical bytes、CAS physical bytes 与去重比例；
- 可精确恢复和不可精确恢复的 Codex Session 数量；
- 保留的 legacy terminal Execution 数量/bytes；
- unclassified、orphan、warning 和 error 列表；
- 实际运行的测试/typecheck 命令；
- 明确说明旧备份没有被删除，如何回滚。

如果任何输入、schema、ownership 或引用关系有歧义，停止在 dry-run/validation 阶段并给出证据，不要
自行选择一个可能破坏历史的解释。
```

## 迁移完成后的人工验收

1. 保留旧备份和 `retain: true`，首次只验证，不立即释放磁盘。
2. 启动 Desktop，确认 Project 历史版本、Mission 列表与聊天、插件配置、Capability、Context Store、
   Runtime Environment 和模型供应商均可读取。
3. 对至少一个原 Codex Mission 执行恢复，确认 native thread 能继续；没有对应 JSONL 的 Session 只能
   作为历史记录保留，不能承诺恢复。
4. 新建一个 Project Revision，确认只增加 Revision Manifest、变更 blob 和祖先 tree，而不是完整目录。
5. 新建并完成一个 Execution，确认 Mission projection 存在且事件被移到 `archives/executions/`。
6. 验证数日后再由用户决定是否把旧备份移入系统废纸篓。在此之前不要把
   `state/storage/legacy-backup.json` 的 `retain` 改为 `false`。

## 回滚

完全退出 Desktop 后，把当前 v3 目录重命名为一个新的诊断目录，再把原来的空 v3 backup 恢复成
目标目录。不要直接把 legacy backup 恢复到新版 Desktop 的活动 `~/.pragma`：新版会再次把无
`storage.json` 的目录判定为 legacy 并创建一个新备份。若要运行旧版本 Desktop，应显式把 legacy
backup 配置为旧版本的 `PRAGMA_HOME`，或在确认旧版本行为后再单独切换。
