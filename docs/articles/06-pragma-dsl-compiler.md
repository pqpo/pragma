# 当 YAML 成为一门语言：Pragma DSL 与编译器的设计

> 《构建跨 Harness 的多 Agent 系统：Pragma 技术实践》第六篇

如果一套 Agent 工作方式只存在于 TypeScript 初始化代码中，它可以运行，却很难被普通用户查看、编辑、版本化和分享。如果把它改成一份任意结构的 YAML，虽然更容易修改，却又会失去类型、引用、迁移和执行语义。

Pragma DSL 要解决的问题不是“用 YAML 少写几行代码”，而是建立一种工作方式的可移植表示：Expert、ExpertTeam、Flow、Capability、ContextStore、RuntimeProfile、Automation 和 Evaluation 能够被解析、链接、验证、编译、迁移、打包和重新生成。

当配置开始拥有这些能力时，它实际上已经成为一门领域语言。

## 工作方式不只是一段 Prompt

一套可复用的 AI 工作方式至少包含：

```text
适用任务与角色边界
+ Expert / ExpertTeam / Flow
+ Runtime 和模型需求
+ Tools / MCP / Skill
+ Context 与 Memory
+ 输入输出契约
+ 权限和人工确认
+ 失败与恢复策略
+ Evaluation
+ 交付物定义
```

只保存 Prompt 会丢失绝大部分运行条件；只导出应用数据库则无法跨 Host 使用。Pragma DSL 因此只保存可移植语义，把机器相关环境留给 Host Binding。

当前代码中的语言版本是 `pragma/v5`，支持八种闭合语义资源：

```text
Expert
ExpertTeam
Flow
Automation
Capability
ContextStore
RuntimeProfile
Evaluation
```

每个语义资源拥有 16 位小写 Crockford Base32 ID。引用使用精确 ref，例如 `expert:<id>`、`flow:<id>`。项目 Revision 保存历史定义，因此资源本身不再维护另一套容易混淆的语义版本号。

## Interpreter 是语言实现，不是 Core 的辅助函数

Pragma 把语言层放在独立的 `@pragma/interpreter` package：

```text
YAML Source
   ↓ parse
严格 AST / Zod Schema
   ↓ link
资源身份与引用图
   ↓ validate
结构、Graph、Adapter、Lock、Artifact
   ↓ inspect environment
Host Binding 与健康状态
   ↓ compile
@pragma/core Expert / Team / Flow 对象
```

依赖方向是 Interpreter → Core，而不是 Core → Interpreter。Core 只负责执行对象和运行协议，不需要知道这些对象来自 YAML、数据库还是代码。

这条边界带来两个结果：

1. SDK 用户仍然可以直接用 TypeScript 构造和运行 Core 对象；
2. Desktop、Server 或未来 Host 可以复用同一个 Interpreter，不必各自重新解释 DSL。

应用层通过 `PragmaProjectService` 执行 load、validate、publish、checkout 和 compile，而不是直接拼装 Runtime 对象。

## 严格语义与同版本向前兼容

Portable DSL 对已知字段使用严格 Zod 约束；从 `pragma/v5` 开始，资源和 Bundle 中任意对象深度的未知
字段默认会被保留并产生 warning，包括嵌套对象和数组元素。旧客户端可以读取、运行和原样转存同版本
新增的可忽略字段。未知 `kind`、method type 等 discriminator，已知字段的非法值，以及 Lock、迁移
journal 和完整性元数据仍然 fail closed。

`apiVersion` 表示最低安全读取代际，而不是每次增加字段都递增。只有删除、重命名、改变既有语义，
或旧客户端忽略某字段会造成执行、权限、安全或数据错误时才升级版本。普通可选字段保持当前版本；
当前代码通过 `PRAGMA_DSL_WRITE_API_VERSION`、direct-read 和 upgrade-from 能力表统一声明版本，不在
Host 中复制常量。Host 的更新路径必须合并已有资源，不能因为旧编辑器重建已知字段而丢弃未知字段。

新的语义也不能靠“在 YAML 中多放一个字段，然后由某个 Host 猜测”。需要扩展的部分使用具名、带版本的 Adapter 或 Registry，例如：

```text
pragma.tool.call@v1
pragma.tool.delegate@v1
pragma.capability.mcp@v1
context-policy:pragma.fresh@v1
```

语义资源使用稳定 ID；环境扩展使用带版本引用。这让编译器可以验证当前环境是否认识某种语义，而不是把任意对象原样传给运行时。

Flow 也不是任意的节点连线。普通边必须组成 DAG，回边只能是声明了 `maxIterations` 的具名 repeat transition；输入、输出、state reducer、route 和 JSON Schema 都在编译前验证。复杂控制流因此是语言的一部分，不是运行时碰到某个字段后的临时约定。

## Portable Definition 与 Host Binding 分离

工作方式可以声明它需要一个 Repository Capability、一份项目知识或某种 RuntimeProfile，但不应该把本机路径、Token 和在线连接写进可分享文件。

Pragma 使用 Binding Ref 表达这个分离：

```yaml
spec:
  adapter: pragma.capability.host@v1
  binding: binding:repository-tools
  config:
    key: repository-tools
```

同一份项目可以安装在不同 Desktop 或未来 Server 中。每个 Host 用自己的环境把 `binding:repository-tools` 解析成实际工具、凭据和权限。

因此验证分成两阶段：

- Portable Validation：不需要本机环境，检查语言、引用、Graph 和 Artifact 声明；
- Environment Validation：解析 Binding，检查实际 Runtime、Store、工具和外部 Artifact。

环境检查为每个资源返回 `ready` 或 `needs_attention`。只有 ready 的依赖才能参与编译；缺失能力不会被静默忽略。

## 编译目标依赖闭包，而不是被无关错误拖垮

完整项目验证仍然是发布闸门，但运行某个 Expert、Team 或 Flow 时，编译器只验证目标及其传递依赖闭包。

这解决了一个实际问题：一个项目可以同时包含多套工作方式，其中某个尚未配置的 Automation 不应该阻止一个完全无关的 Expert 运行。

不过并非所有错误都能局部忽略。Compiler 不兼容、Lock 损坏、Source topology 不可读或资源身份歧义会破坏整个项目的可信度，必须 fail closed。

这种区分让系统既不会因为一个无关资源而整体瘫痪，也不会在项目完整性已经失效时勉强执行。

## Lock、Fingerprint 与 Artifact Integrity

`pragma.lock.yaml` 记录规范资源内容哈希和 Artifact Integrity，并生成 `projectFingerprint`。它描述的是可移植语义，不依赖资源文件放在哪个目录。

项目还会产生 `environmentFingerprint`，包含：

- Environment ID；
- Project Fingerprint；
- 所有已解析 Binding 的 Revision 与验证指纹。

两者用途不同：

```text
projectFingerprint      这套可移植工作方式是什么
environmentFingerprint 这次安装实际绑定了什么环境
```

外部 Artifact 必须声明 URI 和 SHA-256 integrity。Adapter 需要提前枚举 Artifact 依赖，未声明读取会失败；目录哈希包含名称、类型和子哈希，符号链接解析后也必须留在允许的根目录内。

读取一个已发布 Revision 时，如果 Lock 缺失、过期、格式错误或版本不兼容，Interpreter 不会现场合成一份新 Lock 来“修好”它。因为那会把验证失败悄悄变成另一份内容。

## 四条版本轴必须分开

Agent 平台通常同时存在多种版本。如果共用一个 `version` 字段，后续迁移会迅速失控。

Pragma 明确区分：

```text
DSL apiVersion          语言格式版本，当前为 pragma/v5
compilerVersion         编译语义版本，当前写入 pragma.dsl/v9
Project revision        不可变项目内容序号
Host schemaVersion      Execution、Session、IPC 等持久协议版本
```

修改 DSL 语法，不等于修改 Execution 存储；同一 DSL 也可能因为编译语义变化产生新的 Compiler 版本；用户编辑一个 Expert 只会产生新的 Project Revision，不应该升级语言版本。

当前 Compiler 只直接读取自己写出的 `pragma.dsl/v9`，并为 `v2` 到 `v8` 提供静态、相邻、前向升级链。DSL 自身提供 `pragma/v2 → v3 → v4 → v5` 的独立迁移。

普通 parser 和业务编译器只处理当前 Schema，历史 Schema 与字段转换留在迁移模块。Host 在目标 Revision 首次访问时执行必要升级，并把结果保存为可重建缓存；不会在应用启动时扫描和改写全部项目历史，也不会改变权威 Revision number。

未来版本和缺失迁移必须 fail closed。兼容不是让严格 Schema “顺便试着读取”旧数据，而是提供明确、可测试的升级机制。

## Evaluation 是独立资源

Evaluation 不嵌入 Flow 定义，而是一个引用目标 Flow 的独立资源。这使测评生命周期和业务 Flow 生命周期解耦：删除或修改 Evaluation 不会改变 Flow 的运行语义，Flow 也不需要携带仅用于测试的分支。

当前 Run Dry 可以在不解析 Runtime 或 Host Binding 的情况下验证：

- 输入和输出 JSON Schema；
- 节点 input 与渲染后的 prompt；
- node result、state reducer 和 terminal value；
- route、array route、repeat 与 loop limit；
- 所有声明 transition 的覆盖率。

这不是对模型质量的完整评估，但它为 Flow 的确定性部分提供了快速回归信号。未来针对真实 Runtime × Model 的质量评测，可以继续沿独立 Evaluation 边界扩展，而不重新把测试逻辑塞回 Flow。

## `.pragma` Bundle：分享语义，而不是复制机器

Interpreter 可以导出目标资源的传递依赖闭包，形成可移植 `.pragma` Bundle。Bundle 携带 DSL、Lock、Artifact 和选定项目资产，但不会包含本机 Secret、绝对路径或在线连接。

导入到另一个 Host 后，系统重新执行完整性验证和 Host Binding。相同工作方式可以使用目标环境已有的 Runtime 与 Capability，也可以明确报告缺失依赖，而不是静默替换成一个“差不多”的执行组合。

这使分享对象从一段 Prompt 上升为：

> 一套拥有明确依赖、输入输出、执行结构、评测资源和完整性指纹的 AI-native 工作方式。

## 结语

为 Agent 工作流设计 DSL，真正困难的不是 YAML 语法，而是决定什么属于可移植语义，什么属于环境绑定；什么错误必须全局拒绝，什么错误可以限制在一个依赖闭包；历史数据如何升级，当前运行如何复现，以及测试如何成为资源的一部分。

Pragma DSL 与编译器最终希望建立的是一条资产化链路：

```text
声明
→ 链接
→ 验证
→ 编译
→ 执行
→ Evaluation
→ Revision
→ Bundle
→ 分享和再安装
```

当工作方式具备这条链路后，它才不再是某个人电脑上的一段初始化代码，而成为可以长期演进的技术资产。

## 延伸阅读

- [Pragma YAML DSL 架构](../architecture/pragma-yaml-dsl.md)
- [Pragma Bundle 架构](../architecture/pragma-bundle.md)
- [DSL Migration ADR](../adr/024-interpreter-owned-dsl-migrations.md)
- [Compiler Compatibility ADR](../adr/029-interpreter-compiler-compatibility-and-scoped-validation.md)
- [独立 Evaluation 资源 ADR](../adr/028-independent-evaluation-resources.md)
