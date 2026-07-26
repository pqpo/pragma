# Pragma 产品定位、核心价值与竞争差异化

> 文档状态：讨论结论草案
> 更新日期：2026-07-26
> 对比范围：Pragma、Claude Code、Tencent WorkBuddy
> 说明：本文区分当前已经实现的能力与未来产品方向。竞品描述以截至更新日期的公开资料为准，
> 不假设竞品永远不会增加某项能力。

## 1. 结论摘要

Pragma 的核心价值不是“也能创建专家和专家团”，也不是“也有一个分享广场”。这些能力已经被
WorkBuddy 等产品覆盖，不能形成稳定差异化。

Pragma 最值得坚持的方向是：

> **接入不同模型和不同 Agent Harness，针对不同任务选择合适的执行组合，帮助有经验的分享者沉淀并
> 分享自己的 AI-native 工作方式，让普通用户直接使用这些经验。**

Pragma 的产品角色不是另一个封闭 Agent Harness，也不只是一个专家市场，而是位于模型与专业 Agent
Harness 之上的开放组织层：

```text
模型
  ↓
Agent Harness / Runtime
  ↓
Expert / ExpertTeam / Flow
  ↓
Mission / Execution
  ↓
可沉淀、验证和分享的 AI-native 工作方式
```

其中：

- Claude Code、Codex、PI 等是不同的 Agent Harness 或 Runtime；
- Pragma 将这些 Runtime 作为可以安装、替换、路由和组合的一级能力；
- 分享者负责设计和验证工作方式；
- 普通使用者不需要理解底层 Runtime、模型或编排细节，可以直接使用分享者的经验。

## 2. 愿景

> **分享你的 AI-native 工作方式，让人人都能成为 AI 超级个体。**

这句话表达的是 Pragma 的长期愿景，而不是单独的竞争差异化。WorkBuddy 同样支持专家和专家团的
创建、分享和广场，因此“分享工作方式”本身不是 Pragma 独有的能力。

Pragma 的差异化机制是：

> **分享的工作方式可以跨不同模型和不同 Agent Harness 进行组合，而不是只能运行在单一产品内部的
> Agent 执行体系中。**

## 3. 产品定位

### 3.1 定位陈述

> **Pragma 是一个开放的 AI-native 工作方式平台：有经验的分享者可以组合不同模型、Agent Harness、
> 专家、工具和流程，普通用户可以直接使用这些经过验证的执行组合。**

### 3.2 更技术准确的定义

> **Pragma 是面向 AI 超级个体的开放式多 Agent Runtime 平台。**

这一定义适合架构、开发者和生态伙伴沟通。面向普通用户时，不应要求用户理解 Runtime、Harness、
Context 或 Execution 等技术概念。

### 3.3 Pragma 不是什么

Pragma 不应被定位为：

- 另一个通用 AI 聊天工具；
- 另一个 Coding Agent；
- 只有专家头像和 Prompt 的专家市场；
- 只能运行自身 Agent 的封闭工作台；
- 单纯追求 Agent 数量的多 Agent 演示工具；
- 要求普通用户先学习 DSL 才能使用的低代码平台。

## 4. 核心价值

### 4.1 为不同任务选择合适的模型与 Agent Harness

模型不是完整的 Agent 能力。实际工作能力来自以下组合：

```text
模型
+ Agent Loop
+ Runtime Harness
+ 工具系统
+ Context 与 Session 管理
+ 权限机制
+ 子 Agent 能力
+ 执行、恢复和交付机制
= 可用于真实工作的 Agent 能力
```

同一个模型运行在普通对话、Coding Harness、浏览器 Harness 或其他专业 Runtime 中，最终能力可能
完全不同。

Pragma 的核心判断是：

> **不存在一个适合所有任务的模型，也不存在一个适合所有任务的 Agent Harness。**

示例：

| 任务         | 可能适合的执行方式                                                     |
| ------------ | ---------------------------------------------------------------------- |
| 需求共创     | 对话型 Runtime + 擅长推理与沟通的模型 + 持续复用的上下文               |
| 技术方案     | 架构 Expert + 项目 Context + 结构化交付要求                            |
| 代码实现     | Codex、Claude Code 等 Coding Harness + 编码模型 + Repo/Shell/Test 能力 |
| 代码审查     | 独立 Runtime Context + 不同模型 + 只读权限                             |
| 网页视觉验证 | 具备浏览器控制和视觉反馈的 Runtime                                     |
| 市场调研     | 搜索、浏览器和长上下文能力 + 引用验证 Flow                             |
| 发布上线     | 确定性 Flow + 自动测试 + HumanTask 审批 + 失败恢复                     |

### 4.2 将个人 AI 经验沉淀为可运行资产

有经验的 AI 使用者积累的不只是 Prompt，而是：

- 如何识别任务；
- 哪类任务应该直接对话；
- 哪类任务应该交给专业 Expert；
- 哪类任务需要 ExpertTeam；
- 哪类任务需要确定性 Flow；
- 不同任务使用什么 Runtime 和模型；
- 如何装配工具、知识、记忆和上下文；
- 如何控制权限、预算和人工确认；
- 如何判断结果是否合格；
- 失败后如何重试、恢复或切换执行方式。

Pragma 应将这些经验保存为可以运行、验证、版本化、分享和改进的完整工作方式。

### 4.3 让普通用户直接获得成熟经验

普通使用者不应被迫理解模型供应商、Runtime Adapter、Flow graph 或 Context policy。他只需要知道：

- 这套工作方式解决什么问题；
- 需要提供什么输入；
- 会申请哪些权限；
- 预计需要多少时间和费用；
- 最终会交付什么；
- 是否有经过验证的案例；
- 点击后是否可以直接执行。

因此 Pragma 必须做到：

> **对分享者足够深，对使用者足够简单。**

### 4.4 避免被单一模型或 Harness 锁定

模型和 Agent Harness 都处于快速变化阶段。今天适合编码、研究或办公的最佳组合，未来可能被新的
模型或 Runtime 替代。

Pragma 应把 Runtime 设计成开放适配器，把工作方式的语义要求与机器上的具体环境绑定分离：

- 分享者可以声明推荐的 Runtime 和模型；
- 工作方式可以声明所需能力，例如 Coding、Browser、Vision、Long Context；
- 安装环境负责绑定本地实际可用的 Runtime；
- 高级场景可以固定精确 Runtime、模型和版本以保证复现；
- 找不到完全匹配的环境时，Pragma 应明确提示替代方案和差异，而不是静默降级。

## 5. 双边用户模型

Pragma 的核心用户不是单一群体，而是分享者与使用者共同组成的双边生态。

| 维度     | 分享者 / 创作者                                 | 使用者                       |
| -------- | ----------------------------------------------- | ---------------------------- |
| AI 经验  | 有成熟的 AI 使用经验                            | 不要求具备专业 AI 经验       |
| 核心任务 | 设计、验证、发布和改进工作方式                  | 发现、安装和直接使用工作方式 |
| 需要理解 | Agent、Runtime、模型、工具、Flow、Context、权限 | 自己需要完成什么任务         |
| 产品诉求 | 深度定制、组合、评测、版本管理、反馈            | 简单、安全、稳定、成本透明   |
| 主要入口 | Studio                                          | Home、广场、任务入口         |
| 获得价值 | 放大和传播自己的 AI 经验                        | 直接获得成熟分享者的 AI 能力 |

准确的用户定义是：

> **Pragma 的供给侧是有经验的 AI 超级个体，消费侧是希望直接使用这些经验的普通用户。**

Pragma 不是只给高手使用，而是由高手创造，让所有人使用。普通用户在使用、调整和 Fork 工作方式的
过程中，也可以逐渐成为新的分享者。

## 6. AI-native 工作方式的组成

一个可以分享的完整工作方式，不应只包含一个专家 Prompt。它至少需要表达：

```text
适用任务与边界
+ 输入要求
+ Expert / ExpertTeam / Flow
+ Runtime 与模型选择
+ Skills / Tools / Context / Memory
+ 权限、预算与人工确认
+ 执行与失败处理
+ 验证方法
+ 交付物定义
+ 推荐案例与已知限制
```

Pragma Project 可以作为底层保存、发布和修订边界；“AI-native 工作方式”是用户理解、发现和分享的
产品对象。

## 7. 核心差异化

### 7.1 Harness 中立

Pragma 不把某个模型或某个 Agent Harness 视为唯一执行环境。Codex、Claude Code、PI 只是第一批
Runtime，未来第三方可以实现新的 Runtime Adapter。

### 7.2 Expert 与 Flow step 级 Runtime 路由

Pragma 的目标不是在整个应用中切换一次模型，而是允许：

- 不同 Expert 使用不同 Runtime 和模型；
- 同一个 Flow 的不同步骤使用不同 Runtime 和模型；
- 团队中的成员使用不同 Harness；
- 运行时根据任务、能力、成本和环境选择合适组合；
- 必要时定义明确的 fallback 或人工确认。

### 7.3 跨 Runtime 交接

需求共创的结果可以结构化交给 Coding Harness，代码实现可以交给独立 Review Runtime，最终再进入
测试和发布 Flow。

Pragma 需要统一处理：

- Context 交接；
- 文件和 Artifact 交接；
- Session 与 Runtime Context 所有权；
- Execution 与 Invocation 关系；
- 取消、失败、超时和恢复；
- Usage、成本和审计。

### 7.4 统一的 Mission 与 Execution

不同 Runtime 产生的事件、输出、工具调用、子 Agent 和 Usage，需要进入统一的 Mission、
Execution 和 Invocation 视图。用户看到的是一项完整工作，而不是多个互不关联的 Agent 窗口。

### 7.5 Runtime × 模型组合验证

Pragma 应支持在真实任务上比较：

- 结果质量；
- 成功率；
- 执行时间；
- Token 与费用；
- 人工干预次数；
- 恢复成功率；
- 不同模型与 Harness 的适配程度。

最终需要回答的不是“哪个模型排行榜更高”，而是：

> **在这类任务、这套工具和这个工作环境中，哪一个 Runtime × 模型组合效果最好？**

### 7.6 源码可用和可扩展

Pragma 的 Runtime Adapter、执行协议、DSL、插件边界和本地运行能力应通过公开源码建立信任和生态，使
社区能够：

- 审查执行与权限逻辑；
- 增加新的 Runtime Adapter；
- 增加插件、Capability 和 Context Store；
- 为个人或组织内部自托管关键执行能力；
- 避免平台锁定；
- 共同演进工作方式的开放格式。

源码可审查、Runtime 可扩展和格式开放是 Pragma 构建跨 Harness 生态的基础机制。源码许可同时禁止
未经授权的第三方提供 Pragma 托管或管理服务，或将 Pragma 嵌入面向第三方商业分发的产品与服务。

## 8. 与 Claude Code、WorkBuddy 的对比

### 8.1 一句话理解三者

- **Claude Code 是一个专业 Coding Agent Harness。**
- **WorkBuddy 是一个内置专家生态的一体化 AI 工作台。**
- **Pragma 是组织多个模型和 Agent Harness 的开放平台。**

### 8.2 对比表

| 维度               | Claude Code                                           | WorkBuddy                                               | Pragma                                                           |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| 产品定位           | Agentic Coding Harness                                | 全场景 AI 办公工作台                                    | 开放式多 Agent Runtime 与 AI-native 工作方式平台                 |
| 核心用户           | 开发者和工程团队                                      | 普通职场用户、个体创业者、企业团队                      | 分享经验的 AI 超级个体 + 使用经验的普通用户                      |
| 核心对象           | Coding Session、Subagent、Agent Team                  | 专家、专家团、Skill、项目                               | Runtime、Expert、ExpertTeam、Flow、Mission                       |
| 主要任务           | 编码、调试、代码审查和 Git 工作                       | 办公、内容、数据、设计和开发                            | 不限定领域，根据任务选择专业 Harness                             |
| Agent Harness      | Claude Code 自身                                      | WorkBuddy 自身的 Agent 执行体系                         | Codex、Claude Code、PI 及其他 Runtime Adapter                    |
| 跨 Harness 编排    | 不属于其产品定位；Worker 均为 Claude Code Session     | 当前公开产品模型未把外部 Agent Harness 作为一级编排对象 | 核心产品方向                                                     |
| 模型支持           | 主要围绕 Claude 模型，可通过不同云平台和 Gateway 接入 | 多模型、Auto 选型、自定义模型端点                       | 模型由各 Runtime 提供，可按 Expert 或步骤绑定                    |
| Runtime 与模型关系 | Harness 固定，模型可选择                              | 工作台执行体系固定，模型可选择                          | Runtime Harness 与模型都可以选择和组合                           |
| 多 Agent           | Subagent、并行 Session、实验性 Agent Team             | 专家团由团长拆解、并行执行和汇总                        | 受治理的 Expert delegation，未来扩展持久化 Fork/Join             |
| 自定义方式         | CLAUDE.md、Skills、Subagent、Hooks、Plugins、MCP      | 专家、专家团、Skill、MCP、知识库、自定义模型            | Expert、Team、Flow、Capability、Context、Plugin、Runtime Adapter |
| 流程能力           | Skills、Hooks、脚本和插件                             | 自动化与专家团协作流程                                  | 一等 Flow、HumanTask、循环、状态持久化和恢复                     |
| 分享方式           | Git 配置、Skills、Plugins 和 Marketplace              | 专家广场、专家团广场、SkillHub                          | 分享包含 Runtime 要求、流程、权限和验证方法的完整项目            |
| 主要复用边界       | Claude Code 环境                                      | WorkBuddy 产品                                          | Desktop、Server 或其他 Host，并可绑定不同 Runtime                |
| 源码状态           | **非开源**；核心产品采用 Anthropic 商业许可           | **非开源**；商业闭源产品                                | **源码可用方向**；限制第三方托管服务与商业嵌入                   |
| 最大优势           | 成熟、深入的软件工程 Harness                          | 低门槛、一体化体验、专家与渠道生态                      | Harness 中立、跨 Runtime 组合、开放扩展和深度定制                |
| 当前成熟度         | 成熟产品                                              | 成熟且快速迭代的商业产品                                | 本地执行内核较完整，分享生态和云端控制面仍在建设                 |

### 8.3 与 Claude Code 的关系

Claude Code 不是 Pragma 需要替代的产品。它是 Pragma 可以使用的高质量 Coding Harness。

Claude Code 已支持 Subagent、Agent Team、Skills、Hooks、MCP 和插件市场，但这些协作单元仍然是
Claude Code Session。Pragma 的差异在于将 Claude Code 与 Codex、PI 或其他专业 Runtime 放入统一的
Mission 和 Execution 中。

因此两者更接近上下层关系：

```text
Pragma
  ├── Claude Code Runtime
  ├── Codex Runtime
  ├── PI Runtime
  └── Future Runtime Adapters
```

### 8.4 与 WorkBuddy 的关系

WorkBuddy 也能：

- 创建和分享专家；
- 创建和使用专家团；
- 使用专家广场和 SkillHub；
- 配置多种模型和自定义模型端点；
- 使用 MCP、插件、知识库和自动化；
- 将个人经验沉淀为团队资产。

因此以下说法不准确，不应使用：

- “WorkBuddy 只能使用别人做好的专家”；
- “WorkBuddy 不能创建专家”；
- “只有 Pragma 能分享 AI 工作方式”；
- “只有 Pragma 支持多模型”；
- “只有 Pragma 支持多 Agent”。

从当前公开产品模型看，WorkBuddy 的专家以“人设 + 方法论 + 工具链”为核心，专家团由团长自动拆解、
并行执行和整合结果；模型是工作台中的可选择能力。Pragma 则从架构上把外部 Agent Harness 本身提升为
一级 Runtime，使不同 Expert 和 Flow step 可以选择不同执行环境。

即使 WorkBuddy 将来增加调用外部 Agent 的能力，Pragma 仍应把以下能力做到平台级深度：

- 开放的第三方 Runtime Adapter 标准；
- Expert 和 Flow step 级 Runtime 路由；
- 跨 Runtime Context 和 Artifact 交接；
- 跨 Runtime Session 所有权与恢复；
- Runtime × 模型组合评测；
- 可移植的环境绑定；
- 社区可修改和扩展的执行内核。

差异化不应建立在“WorkBuddy 永远不会支持某项功能”的假设上，而应建立在 Pragma 的 Harness 中立架构、
开放生态和长期产品重心上。

## 9. 产品结构

### 9.1 Studio：面向分享者

Studio 用于：

- 组合 Runtime 与模型；
- 创建 Expert、ExpertTeam 和 Flow；
- 配置工具、知识、Context、权限和交付标准；
- 比较不同 Runtime × 模型组合；
- 验证真实任务；
- 发布、升级和回滚工作方式；
- 查看使用反馈与质量指标。

### 9.2 广场：连接分享者与使用者

广场展示的不应只是专家头像和角色描述，还应包括：

- 适用任务；
- 分享者及其可信度；
- 推荐 Runtime 和模型；
- 支持的替代 Runtime；
- 所需权限；
- 预计时间和成本；
- 输入与交付物；
- 验证案例和成功指标；
- 已知限制；
- 版本历史；
- 安装、使用和 Fork 入口。

### 9.3 Home：面向普通使用者

普通用户描述目标后，Pragma 应：

1. 推荐合适的工作方式；
2. 检查本地或云端所需 Runtime；
3. 自动完成环境绑定；
4. 解释权限、费用和预期交付；
5. 创建 Mission；
6. 统一展示执行过程和结果。

普通用户不需要先理解 Expert、Flow、Runtime 或 DSL。

## 10. 生态增长模型

```text
分享者形成有效 AI 经验
→ 在 Pragma 中设计和验证
→ 发布工作方式
→ 普通用户直接使用
→ 产生结果、评价和经授权的质量信号
→ 分享者改进新修订
→ 更多用户使用
→ 部分使用者开始调整和 Fork
→ 新的分享者出现
```

需要严格保护用户数据。执行内容、文件和敏感上下文默认不应回传给分享者；产品只在用户明确授权后
提供必要、最小化、去敏感的质量反馈。

## 11. 源码可用许可策略

### 11.1 当前状态

Pragma 的许可方向是 source-available：允许查看、修改、内部使用和自托管，但禁止未经授权的第三方提供
Pragma SaaS、托管服务或管理服务，也禁止将 Pragma 嵌入面向第三方销售、许可或商业分发的产品与服务。

这不是 OSI 认可的开源许可证。仓库已采用 Pragma Source Available License 1.0，根 `package.json`
通过 `SEE LICENSE IN LICENSE` 指向自定义许可证。

### 11.2 已补齐的许可治理

- 根 `LICENSE` 与 `NOTICE`；
- 根 `package.json` 许可证声明；
- `CONTRIBUTING.md` 与贡献授权提示；
- `TRADEMARKS.md` 与官方发行版标识规则；
- 安全漏洞报告方式；
- 源代码许可证、贡献规则与商标政策的独立边界。

### 11.3 许可证方向

当前方向是以 Apache-2.0 的基础权利与义务为底座，增加 Pragma Additional Conditions，禁止未经授权
的第三方提供 Pragma SaaS、托管服务和商业嵌入。增加限制后，该许可证属于 source-available 自定义
许可证，不能标记为标准 Apache-2.0 或 OSI 开源许可证。

许可证与商标边界见
[源码可用许可证与商标边界](./source-available-licensing-and-trademarks.md)。

## 12. 当前基础与关键缺口

### 12.1 已有基础

Pragma 当前已经具备：

- PI、Codex、Claude Code Runtime Adapter；
- Expert、ExpertTeam 和 Flow；
- Runtime Context 与 Session 所有权；
- Execution、Invocation 和 Canonical Event；
- Context、Plugin、MCP 和 Capability；
- Pragma YAML DSL；
- 不可变项目修订和环境指纹；
- Desktop Mission 与本地持久化；
- Automation 的基础模型。

这些基础与多 Runtime 战略具有较高一致性。

### 12.2 关键缺口

在对外兑现定位前，需要优先补齐：

1. fail-closed 的本地权限边界；
2. Runtime Adapter 的公共开发规范；
3. 跨 Runtime Artifact 和 Context 交接体验；
4. Runtime × 模型评测能力；
5. 工作方式的发布、安装、兼容性检查与 Fork；
6. 分享者和使用者的双边产品体验；
7. 云端控制面、设备连接、队列和恢复能力。

当前架构风险与演进顺序详见
[当前架构概览](../architecture/current-architecture-overview.md)。

## 13. 建议的核心指标

Pragma 不应以专家数量或 Agent 数量作为首要成功指标。建议关注：

- 工作方式安装后首次运行成功率；
- 可接受交付物比例；
- 相同工作方式的重复成功率；
- 人工干预次数与时间；
- 单次合格交付成本；
- Runtime 切换或替代后的成功率；
- Execution 恢复成功率；
- 工作方式复用率；
- 使用者转化为 Fork 者或分享者的比例；
- 分享者发布新修订后的质量提升。

## 14. 对外表达建议

### 14.1 推荐表达

> Pragma 可以接入不同的模型和 Agent Harness，让你针对不同任务选择合适的执行组合，沉淀并分享自己的
> AI-native 工作方式。

> Claude Code 是一个专业 Coding Harness；WorkBuddy 是一个集成式 AI 工作台；Pragma 负责组织多个
> 模型和 Agent Harness，让它们在同一项工作中协同。

> Pragma 的供给侧是分享 AI 经验的超级个体，使用侧是直接获得这些经验的普通用户。

### 14.2 不建议使用

- “WorkBuddy 只提供别人做好的专家”；
- “只有 Pragma 能分享工作方式”；
- “Pragma 是更强大的专家团”；
- “Pragma 只是更深度的专家编辑器”；
- “WorkBuddy 永远不会支持其他 Agent”；
- “AI 工作方式即代码”；
- “支持更多配置项”；
- “一个 Agent 可以完成所有工作”。

### 14.3 表达原则

- 不通过虚构竞品缺失能力建立差异；
- 不把技术复杂度本身包装成价值；
- 强调不同任务与不同 Harness 的适配；
- 强调分享者深度与使用者简单之间的桥梁；
- 强调开放、可替换和可验证；
- 对当前能力与未来方向保持诚实。

## 15. 参考资料

### Pragma

- [Pragma 当前架构概览](../architecture/current-architecture-overview.md)
- [Pragma YAML DSL v3](../architecture/pragma-yaml-dsl.md)
- [Pragma 默认通用 Agent](../adr/015-pragma-default-general-purpose-agent.md)
- [Flow 并行与持久化 Fork/Join](../adr/017-flow-parallelism-requires-fork-join.md)
- [Automation 与 Trigger Adapter](../adr/020-automation-integrations-and-trigger-adapters.md)
- [语义资源身份与项目修订](../adr/023-semantic-resource-identity-and-project-revisions.md)

### Claude Code

- [Claude Code Overview](https://github.com/anthropics/claude-code)
- [Run agents in parallel](https://code.claude.com/docs/en/agents)
- [Agent teams](https://code.claude.com/docs/en/agent-teams)
- [Custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code extensions](https://code.claude.com/docs/en/features-overview)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code license](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)

### WorkBuddy

- [WorkBuddy 产品页](https://cloud.tencent.cn/product/workbuddy)
- [WorkBuddy 专家与专家团](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Expert-Center)
- [WorkBuddy 更新日志](https://www.workbuddy.cn/docs/workbuddy/Changelog)
- [WorkBuddy Skill、专家与专家团说明](https://cloud.tencent.cn/act/pro/workbuddy)
