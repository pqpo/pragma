# Home 项目

Home 的「项目 / 收藏」可快速切换常用任务配置。

- 项目绑定一个默认执行者（专家、专家团或流程）、零个或多个知识库，以及一个明确选择的工作区。
- 点击项目会一起带入这些配置，保留已输入的任务文字；流程的结构化输入按该流程的 Schema 初始化。
- 项目配置中的执行者和工作区复用 Home 选择器并排展示；知识库通过现有搜索/分页弹窗选择，配置页只展示已选数量和最多两个名称。
- 「+」新建项目；区域齿轮打开项目管理，条目齿轮编辑对应项目。超过六个项目可展开查看。
- 绑定资源缺失或工作区不可用时，提示重新配置，整组配置不会部分应用。
- 项目保存后仍可临时调整本次任务的选项；修改任务选项不会改写项目。删除项目只删除快捷配置。
- 收藏继续支持原有的全局 / 工作区收藏和排序。

## 通过内置 Pragma Agent 选择任务配置

Pragma 可以使用以下只读工具查询 Desktop 保存的配置：

- `list_workspaces`：合并默认工作区、最近使用记录、首页项目绑定、首页工作区收藏、执行者使用记录和当前 Mission 的目录，按真实目录去重并标明可用状态。`workspaceId` 是绝对路径，不是目录名称。
- `list_home_projects` / `get_home_project`：查询首页项目的名称、执行者、工作区和 `contextStoreIds`。首页项目与 DSL Project 不同。
- `list_knowledge_stores`：查询托管知识库的名称、描述、`storeId` 和状态。这里的 ID 与 DSL `ContextStore` ref 不同。

列表支持 `query`、`limit` 和 `cursor`。按名称找到项目后，将其 `workspaceId`、`executorRef`、`contextStoreIds` 连同任务 `goal` 传给 `create_mission`；也可以从这些目录中自行选择组合。查询不会改变首页当前选择或项目配置。

`create_mission` 的 `contextStoreIds` 为可选数组，省略或传空数组表示不额外挂载知识库。只能选择 `ready` 的托管知识库；重复、缺失或不可用的选择不会启动新任务。创建时在知识库修订锁内定向复核所选知识库，不扫描无关知识库。所选知识库随 Mission 的 Context mounts 持久化，创建结果和 `get_mission` 返回实际挂载的 ID。启动任务继续使用现有审批流程。

## 工程边界

Home Project 是 Desktop 的任务预设，独立于 DSL `PragmaProject` 及其 Revision 聚合，不改变资源编译或 Mission 协议。

权威数据保存在 `~/.pragma/data/home-projects.json`，使用独立的
`pragma.desktop-home-projects/v1` Schema。所有 IPC 输入输出均通过 Zod 校验；写入受跨进程文件锁保护，并使用临时文件和原子替换。损坏数据和未来版本拒绝读取及覆盖，不按空列表自动重置。

该功能不修改既有持久协议，不需要转换旧收藏数据。项目绑定通过现有 Mission 创建入口传入实际执行者、工作区和 Context Store mounts。

验证：Home project store 的真实文件读写/并发/错误保护测试、Home 页面回归、多语言检查，以及隔离浏览器预览中的选择、配置和提交参数检查。浏览器预览不运行真实 Agent。
