# ADR 076：正式技能与知识库的 Agent 查询入口

Status: Accepted

## 决策

补充 ADR 067：`pragma manage skill` 和 `pragma manage knowledge-store` 查询所有 Host
受管正式资源，包含未挂载资源与系统技能；仍要求当前 Execution 私有授权通道，不创建普通终端
独立管理 Host，不扩大其他 Expert 的命令授权。只读查询不新增发布或修改权限。

Shared 定义新增命令、查询 DTO 与输入/输出 Schema；Local Host 负责读取、筛选、分页、版本
一致性与输出预算。Built-in Agents 声明端口和命令，Desktop 装配实际 repository，CLI 只负责
参数、传输与展示。默认 Pragma 的 management binding 继续 `tools: []`，不重新注入模型工具目录。

技能默认读取最新正式修订，并分别返回 latestRevision、activeRevision 和实际 revision。
知识库查询使用正式 snapshot。后续请求固定修订号及包/快照 hash；正文续读附带完整文本 hash。
显式固定的历史正式修订可继续读取，不会因发布新修订而切换；丢失、hash 不符或 cursor 过期
明确报错。技能的 DSL 定义与包内容分开按需读取，知识库目录、DSL ref 与 Context namespace
保持独立身份。系统技能来自同一静态注册表，只读约束不变。

新增查询结果使用独立 v1 DTO。分页与正文返回 continuation 的 command/input；调用方原样
提交，无须计算范围。每个结果序列化后不超过 128 KiB，为现有 256 KiB handler 上限和 command
envelope 留余量；根据实际编码字节数缩小分页/正文，并保持 Unicode 字符完整。搜索为指定
库内的大小写不敏感字面量匹配，命中携带文档身份、位置与有界片段，不创建跨库索引。
搜索分页按固定快照身份绑定 cursor，只保留当前页和一条前瞻命中，避免先构造全部命中。

`--describe --format json` 本地输出单个命令的输入/输出 Schema、默认值、只读/授权属性和示例，
不连接 Host。描述能力不证明当前调用已授权。查询沿用既有 receipt：同一 request ID 重放原
结果，刷新查询必须使用新 ID。错误返回稳定 code，失效恢复提供 CLI command/input 与 ID 策略。

manage-pragma 增加独立技能与知识库 references，主入口只导航。允许先读正式内容进行诊断；
需要创建或修改时再委派既有 Revision Agent，保留人工审批/知识库审批设置、原 Context 和草稿恢复。
禁止使用存储扫描或历史草稿替代正式查询。

## 兼容与数据

保留原命令、知识库列表返回结构及无过滤时的正常结果。新增可选 status 过滤。查询的严格目录
读取在损坏条目存在时报告失败，不伪装成完整空列表；保留旧知识库的兼容目录语义：不支持的
旧 note 继续省略，缺失迁移源的旧 file 继续展示 needs_attention。其他既有 repository list 调用
默认行为不变。请求校验失败使用 INVALID_ARGUMENT，存储数据校验失败使用 STORAGE_CORRUPTED。

这是现有管理协议的命令扩展，不改变已有 command、receipt、owner、DSL 或存储 Schema 的合法
数据语义，没有删除迁移链或使用实验 cutover。新增 DTO 与 descriptor 使用独立 v1 标签；未知命令
或未来版本继续拒绝。management capability revision 随命令定义更新，编译 fingerprint 重新计算。

## 验证

Shared 契约、Local Host 真正 repository 查询、CLI describe 及 Desktop 生产 binding 经 Interpreter
编译的回归覆盖未挂载资源、过滤分页、正式版本、失败后重试、Unicode/字节预算和授权失效。
新回归进入 test:business；知识修订仍运行 test:revision。确定性 Runtime 回归不代替真实模型验收。

真实 Codex Runtime 已通过生产 binding、Interpreter 编译和内置 CLI 完成未挂载资源的只读验收。
根据实际调用收紧渐进式说明后，同一验收任务从 8 次查询加 8 次帮助调用变为 6 次查询、0 次帮助调用。
具体命令、返回正文大小和测量范围见[验收证据](../performance/managed-resource-cli-evidence.json)。
这项 native 验收使用完全访问模式，不执行修订或审批；受限 Runtime 沙箱仍必须允许进程访问本地授权通道。
