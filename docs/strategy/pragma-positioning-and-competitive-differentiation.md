# Pragma 定位与差异化

## 产品定位

> Pragma 是跨模型、跨 Agent Harness 的 Agent Team 与 AI-native 工作方式平台。

Pragma 组织 Codex、Claude Code、PI、Qoder CLI、Antigravity 及其他 Runtime，使不同 Expert 和 Flow step
可以在同一 Mission 中使用合适的执行环境。用户复用的是包含流程、工具、Context、Memory、权限、评测
和交付标准的完整工作方式。

## 核心差异

### Runtime 与模型是两个维度

模型决定基础推理能力，Agent Harness 决定规划、工具、Session、上下文和交互语义。Pragma 将两者分别
建模，并允许 Expert、Team member 或 Flow step 独立绑定 Runtime × Model 组合。

### 跨 Harness 仍是一项 Mission

不同 Runtime 的工作统一进入 Mission、Execution 和 Invocation。Context 交接、Artifact 引用、消息、
HumanTask、取消、恢复、Usage 与事件记录使用同一套上层协议，用户不需要手工拼接多个孤立 Session。

### 工作方式是一等可移植资源

Expert、ExpertTeam、Flow、Capability、ContextStore、RuntimeProfile、Automation 与 Evaluation 使用
Pragma YAML DSL 表达。Project Revision、Interpreter、bundle protocol 和 Host binding 共同支持版本化、
迁移、验证、导入与运行。

### 经验形成长期资产

执行事件可以转为 Evidence、Episodic 与 Semantic Memory；经过审阅的内容可以提升为 Knowledge 或 Skill。
Evaluation 保存任务和标准，用于验证工作方式的新 revision。工作流、知识和评测集因重复使用而共同积累。

### 开放的扩展边界

Runtime Adapter、Plugin、Capability、ContextStore 与 Memory Module 都有明确接口和依赖方向。开发者可以
接入新的 Harness、工具、知识源或检索系统，而不改变 Expert 与 Flow 的上层语义。

## 与相邻产品类别的关系

| 产品类别 | 擅长的核心对象 | Pragma 的组合方式 |
| --- | --- | --- |
| Coding Agent Harness | 代码理解、终端、编辑器与工程 Session | 作为专业 Runtime 参与 Expert 或 Flow step |
| 通用 AI 工作台 | 一体化对话、内容和办公体验 | 通过可移植工作方式与 Host 集成连接 |
| Workflow 平台 | 确定性节点、集成与自动化 | 由 Flow 组合 Expert、Team、SubFlow 和 HumanTask |
| 模型 API / Gateway | 模型访问、路由与计费 | 作为 Runtime 的模型供应层 |
| 知识库 / RAG | 检索与内容管理 | 通过 ContextStore 和 Memory Module 接入 |

Pragma 不替代专业 Harness，而是把它们变成可组合的执行环境。例如，需求分析、代码实现、视觉验证、独立
审查和发布检查可以使用不同 Runtime，同时共享同一 Mission 的目标、决策、产物和 Evaluation 标准。

## 用户体验

### 创作者

创作者在 Studio 或 DSL 中组合 Expert、ExpertTeam 与 Flow，配置 Runtime、模型、Capability、Context、
Memory、权限和 Evaluation，并发布不可变 revision 或 bundle。

### 使用者

使用者从目标出发选择 Agent Team，确认输入、工作区和权限后启动 Mission。执行过程统一展示各专家的
进展、HumanTask、产物、Usage 与最终结果。

### 开发者

开发者可以通过 `@pragma/interpreter` 加载工作方式，通过 `@pragma/core` 嵌入执行，或实现 Runtime、
Plugin、ContextStore 与 Host adapter 扩展系统。

## 对外表达

推荐使用以下描述：

> Build your Agent Team once. Use it everywhere.

> Pragma lets different models and Agent Harnesses work together in one Mission, while keeping the
> workflow, context, knowledge, evaluation, and governance portable.

> Pragma turns proven AI working methods into runnable and reusable Agent Teams.

表达重点应始终落在用户价值：跨 Harness 组合、工作方式复用、知识积累、系统级评测和可恢复执行。对比
相邻产品时描述类别边界和组合关系，不依赖对竞品功能缺失、成熟度或长期路线的推测。

## 源码与生态

Pragma 使用 source-available 许可。源码可阅读、修改并用于授权范围内的内部运行和自托管；第三方托管
服务与商业嵌入遵循仓库 `LICENSE`。Runtime、DSL、Plugin 和本机 Host 的公开实现为安全审阅、协议集成与
社区扩展提供共同基础。

详细许可与商标边界见[源码可用许可证与商标](./source-available-licensing-and-trademarks.md)。

## 相关文档

- [核心价值](./pragma-core-value-and-product-priorities.md)
- [当前架构概览](../architecture/current-architecture-overview.md)
- [使用文档](../usage/README.md)
- [ADR 索引](../adr/README.md)
