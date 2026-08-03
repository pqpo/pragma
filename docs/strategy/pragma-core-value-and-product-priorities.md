# Pragma 核心价值与未来建设重点

> 文档状态：产品方向讨论结论
>
> 更新日期：2026-07-27
>
> 本文聚焦 Pragma 为什么需要作为独立产品存在，以及未来应优先兑现哪些能力。它补充
> [Pragma 产品定位、核心价值与竞争差异化](./pragma-positioning-and-competitive-differentiation.md)，
> 不替代已经接受的 ADR、运行时 Schema 或仓库工程规则。

## 1. 结论

Pragma 不应把“支持多个 Agent”“可以创建专家团”或“能够调用多个 Harness”作为核心卖点。Codex、
Claude Code 等成熟 Harness 已经支持 subagent、Skill、Plugin、MCP 和脚本扩展；用户也可以通过 CLI
或 MCP 从一个 Harness 调用另一个 Harness。

Pragma 需要解决的是更完整的产品问题：

> **让用户以对话式、可视化的方式沉淀自己的 AI-native 工作方式，将其固化成开放、可版本化的
> DSL 资产，在不同设备上快速恢复，在不同 Agent Harness 之间持续执行和积累记忆，并能够安全地
> 分享、安装和 Fork。**

跨 Harness 是这一价值的技术基础，不是最终价值。最终交付给用户的是可以长期拥有、迁移和改进的
工作方法及工作经验。

可以把 Pragma 理解为四个相互依赖的产品层：

```text
设备可移植的 AI 工作环境
        +
可安装、可分享的 AI-native 工作方式
        +
跨 Harness 的统一执行与交接
        +
跨 Harness、跨会话的长期记忆
```

一句话定位：

> **Pragma 让你的 AI 工作方式和长期经验，不被某一台设备、某一个 Agent Harness 或某一次会话锁定。**

## 2. 用户问题

### 2.1 单个 Harness 很强，但个人工作环境是碎片化的

有经验的用户可以自己组合 Codex、Claude Code、PI、MCP、CLI、Skill 和脚本，但最终配置通常分散在：

- 不同 Harness 的全局配置和项目配置；
- `AGENTS.md`、Skill、Plugin 和自定义 Agent 文件；
- MCP Server、CLI、环境变量和 Secret；
- 本地目录、Shell 脚本和只存在于个人记忆中的调用约定；
- 多个互不关联的 Session、历史记录和记忆系统。

这套环境能够工作，不代表它容易重建。换一台设备、交给另一个人或几个月后重新使用时，用户往往需要
重新安装、重新理解并手工绑定大量配置。

### 2.2 “能够调用”不等于“能够沉淀”

从 Codex 调用 Claude Code CLI，解决了连接问题：

```text
Codex → Claude Code → 返回结果
```

但它不会自然解决：

- 这次任务为什么这样拆解；
- 哪个 Runtime 和模型适合哪个步骤；
- 需要哪些工具、Context、权限和输入；
- 失败后应该如何恢复、返工或替换执行器；
- Claude Code 内部产生的过程、事实和经验如何被 Codex 继续使用；
- 换设备后如何恢复完整工作环境；
- 如何把整套方法交给不熟悉 Agent 配置的使用者。

用户可以继续用 Plugin、MCP 和脚本补齐这些问题，但补齐后实际上已经在建设一套工作方式平台和
跨 Harness 控制面。Pragma 的价值是把这套能力产品化，而不是要求每个用户重复建设。

### 2.3 普通使用者不应学习底层编排

工作方式的创作者可以理解 Runtime、模型、Flow、Context 和权限；普通使用者只应关心：

- 这套方法解决什么问题；
- 需要提供什么输入；
- 会申请什么权限；
- 预计消耗多少时间和费用；
- 最终交付什么；
- 是否经过真实案例验证；
- 是否可以在当前设备上一键安装和运行。

Pragma 必须做到“对创作者足够深，对使用者足够简单”。

## 3. 四个核心价值

### 3.1 设备可移植的 AI 工作环境

Pragma 的“可移植”首先指设备迁移，而不只是替换模型或 Runtime。

理想的新设备恢复流程：

```text
安装 Pragma
→ 登录或导入个人 Profile
→ 恢复已安装的工作方式
→ 检测 Codex / Claude Code / PI 等本地 Runtime
→ 安装或提示补齐 Plugin、Skill 和 Capability
→ 重新绑定 workspace、账号、Secret 和本地权限
→ 执行兼容性检查
→ 恢复工作方式和长期记忆
→ 开始工作
```

设备迁移不能简单复制整个用户目录。需要明确区分：

| 可同步或导出的声明性资产                 | 必须在新设备重新绑定的环境状态           |
| ---------------------------------------- | ---------------------------------------- |
| Project Revision 和 Pragma DSL           | Secret、Token 和本机账号                 |
| Expert、ExpertTeam、Flow 和 Automation   | workspace 绝对路径                       |
| Skill、Capability 要求和 Context 定义    | 本地 Runtime 安装位置                    |
| Runtime 能力要求、推荐版本和兼容性元数据 | 文件、Shell、Git、网络和桌面权限         |
| Plugin 依赖、配置 Schema 和包指纹        | 设备凭据、系统 Keychain 和 OAuth Session |
| 经用户授权同步的长期记忆                 | 可重建的 Runtime Session、缓存和临时文件 |

安装器必须展示缺失能力、替代方案和行为差异，不得静默降级。

### 3.2 可沉淀、可分享的 AI-native 工作方式

用户积累的不是一段 Prompt，而是一套完整方法：

```text
适用任务与边界
+ 输入要求
+ Expert / ExpertTeam / Flow
+ Runtime 与模型选择
+ Skill / Tool / Context / Memory
+ 权限、预算与人工确认
+ 交接、失败和恢复策略
+ 验证方法
+ 交付物定义
+ 推荐案例与已知限制
```

Pragma DSL 是这套工作方式的权威格式，但不应成为普通用户的学习负担：

```text
用户对话
    ↓
可视化 Studio
    ↓
规范化 Pragma DSL
    ↓
Diff / Revision / Validation
    ↓
发布 / 安装 / Fork / 恢复
```

对话和可视化编辑器必须与 DSL 双向一致。用户通过对话修改工作方式时，Studio 应展示受影响的资源、
依赖和权限；用户通过可视化编辑器修改时，必须生成可审查、可重复编译的规范化 DSL。

分享单元不应只是一个 Expert 或 ExpertTeam，而应是完整的工作方式包：

```text
Workstyle Package
├── metadata 与适用场景
├── 输入和交付契约
├── Expert / ExpertTeam / Flow
├── Skill / Capability / Context 要求
├── Runtime 要求与替代方案
├── 权限和预算声明
├── 示例与 Evaluation
├── 兼容性和已知限制
└── 不可变 Revision、依赖锁和 Fork 来源
```

Secret、用户私有文件、Runtime Session、本地绝对路径和未授权的个人记忆不得进入公开包。

### 3.3 跨 Harness 的统一执行

Codex、Claude Code、PI 等 Harness 应是 Pragma 的一等 Runtime，而不是由某个固定主 Harness 管理的
黑盒工具。

这层价值不在于“Pragma 也能调用 Claude Code”，而在于 Pragma 统一拥有：

- Expert 和 Flow step 级 Runtime 路由；
- Runtime Context 与 Session 所有权；
- Invocation、取消、失败、超时和恢复语义；
- Context、文件和 Artifact 交接；
- Usage、成本、权限和审计；
- 不同 Runtime × 模型组合的评测与替换依据。

同一个 Mission 可以使用不同 Harness 完成需求分析、代码实现、独立审查、视觉验证和发布审批。用户看到
的应是一项连续工作，而不是多个互不关联的 Agent 窗口。

Runtime 原生 subagent 仍有价值，适合单个 Harness 内的临时探索和并行工作。Pragma 不需要重复实现每个
Harness 已经擅长的内部协作；只有需要跨 Runtime、长期 Context、统一治理或确定性交付时，才提升为
Pragma Expert Invocation 或 Flow step。

### 3.4 跨 Harness 的长期记忆

跨 Harness 调用可以通过 CLI 或 MCP 实现，跨 Harness 记忆则需要独立于任何 Runtime 的 Memory Plane。

正确的所有权关系：

```text
Codex Session ─────┐
Claude Code Session ├─→ 持久 Evidence Feed → Dynamic Memory
PI Session ────────┘                       ↓
                             Knowledge / Skill / CodeGraph
                                            ↓
                           注入后续任意 Harness
```

Pragma 应拥有记忆语义，Runtime 只负责产生 Evidence 和消费经过授权、筛选的 Context。

Memory 不是闭合的四类 Record。默认动态投影回答两个基本问题：

- `Episodic Memory`：过去发生过什么、尝试过什么、结果如何；
- `Semantic Memory`：当前相信什么是真的，置信度、时效和冲突是什么。

TODO、共享白板和 Handoff 是可选 Execution working state，只能作为 Evidence 来源之一。Knowledge、
CodeGraph 和未来索引是相对稳定、带不可变 Revision 的 Memory type，由独立 Memory Module
消费同一条 Evidence Feed 后生成。正式 Skill 复用 Capability，不维护平行的 Skill Memory 权威 Store。

记忆不应只是跨 Harness 共享原始聊天记录。Pragma 需要完成：

- 不同 Runtime、Artifact、Repository 和外部来源 Evidence 的规范化；
- Evidence 到动态 Memory、Knowledge、Skill 和可扩展资产的可审计沉淀；
- Host 级静态 Memory Module 注册、独立 checkpoint、重放和失败隔离；
- 用户、项目、工作方式、Expert、Team 和 Mission 的 subject、ownership 与 binding；
- shared/private 可见性和最小权限；
- 冲突、失效、替代、删除和重新提炼；
- 联邦 Memory Context、有界检索和 Context 注入，避免记忆污染；
- 加密同步、导出、导入和设备间冲突处理。

工作方式与记忆应形成持续改进闭环：

```text
工作方式定义“应该怎么做”
→ Mission 记录“这次实际怎么做”
→ Evidence 记录“发生了什么”
→ Memory 沉淀“学到了什么”
→ 用户确认后更新“下次应该怎么做”
```

个人 Memory 默认私有。只有经过用户审查、去敏和明确确认的通用 Skill 或方法，才可以合入可分享的
工作方式 Revision：

```text
个人 Evidence
→ 私有 Experience
→ 候选 Fact / Skill
→ 用户审查和去敏
→ 工作方式新 Revision
→ 发布
```

## 4. 与 Codex 自建方案和 Coze 类产品的关系

### 4.1 与 Codex 自建方案

Codex 是高质量 Coding Harness，也可以通过 Plugin、MCP、CLI 和 subagent 组合复杂能力。Pragma 不应
试图证明这些事情“Codex 做不到”。

区别在于使用成本和资产所有权：

| Codex 中自行搭建                            | Pragma 产品目标                                  |
| ------------------------------------------- | ------------------------------------------------ |
| Codex 是固定主入口，其他 Harness 常作为工具 | 工作方式独立存在，Codex 也可以只是入口或执行器   |
| 配置分散在多个产品和目录                    | DSL、依赖和环境绑定形成统一 Project Revision     |
| 换设备主要依赖手工安装、Git 和个人文档      | 声明性安装、兼容性检查、权限重绑和记忆恢复       |
| 跨 Harness 结果由主 Agent 临时整理          | Context、Artifact、Execution 和 Usage 有统一语义 |
| 记忆通常属于 Codex Session 或自建 MCP       | Pragma Memory Plane 面向所有 Runtime             |
| 适合具备较强工程能力的个人                  | 创作者可以深入配置，普通使用者可以直接安装和使用 |

如果用户只需要同一 Harness 内的一次性并行任务，应优先使用 Runtime 原生 subagent。Pragma 的价值只在
长期拥有、迁移、分享、治理和持续学习时成立。

### 4.2 与 Coze 类产品

Pragma 与 Coze 类产品在产品闭环上相似：

```text
自然语言创建
→ 可视化编辑
→ 固化为结构化资产
→ 发布到商店
→ 其他用户安装
→ Fork 和改进
```

这种相似不是问题，也不应被否认。Pragma 需要占据更明确的细分位置：

> **面向本地专业 Agent Harness 的、设备可移植、记忆可延续的 AI-native 工作方式平台。**

重点差异应来自：

- 本地代码库、文件、Shell、Git、浏览器和桌面应用等真实工作环境；
- Codex、Claude Code、PI 等完整 Harness 作为一等 Runtime；
- 开放、可导出、可审查、可版本化的 DSL；
- 设备环境的检测、依赖恢复和权限重新绑定；
- 跨 Runtime、跨会话、跨设备的 Memory Plane；
- 用户拥有工作方式和记忆，而不是只能在单一平台内部使用。

“对话式创建”“可视化 Flow”“专家商店”本身均不是稳定壁垒。

## 5. 产品闭环

Pragma 应建立两个相互增强的循环。

### 5.1 工作方式供给循环

```text
完成一次真实任务
→ Pragma 协助提炼初始工作方式
→ 创作者通过对话和 Studio 调整
→ 添加示例、权限声明和验收标准
→ 在真实任务上验证
→ 发布不可变 Revision
→ 使用者一键安装并匹配本地环境
→ 产生经授权、最小化的质量反馈
→ 创作者改进或使用者 Fork
```

创建工作方式不应要求用户从空白 YAML 开始。内置 Pragma Agent 应能基于成功 Mission 生成资源草案、
解释变更、修复校验问题，并在发布前引导用户补齐输入、权限、交付和验证信息。

### 5.2 记忆学习循环

```text
跨 Harness 执行
→ 持久采集并重放 Evidence
→ 形成 Episodic / Semantic Dynamic Memory
→ 有价值的部分形成 Knowledge / Skill / CodeGraph Candidate
→ 验证后发布不可变 Asset Revision
→ 后续任务按绑定与权限检索
→ 结果质量提升
→ 稳定经验经用户确认进入 Knowledge、Skill 或工作方式
→ 工作方式再次被执行和验证
```

工作方式是可分享的编排，Dynamic Memory 是持续变化的当前认知，Knowledge 与 Skill 是相对稳定、
可绑定和可发布的核心资产。它们必须关联，但不能默认混在同一个发布包中。

## 6. 当前基础与尚未兑现的价值

### 6.1 已有基础

当前工程已经具备与该方向一致的内核：

- PI、Codex、Claude Code Runtime Adapter；
- Expert、ExpertTeam、Flow、Mission、Execution 和 Invocation；
- Runtime Context、Session 所有权、Canonical Event 和 Usage；
- Pragma YAML DSL、Project Revision 和环境指纹；
- Plugin、Capability、Context System 和本地凭据边界；
- 当前插件实现的 Task、Experience、Fact、Skill Memory 原型；
- Evidence-based distillation 和统一 memory Context；
- Desktop 的对话入口、Studio 和本地持久化。

这些能力证明 Pragma 已经不只是产品概念，但不能等同于完整产品价值。

### 6.2 尚未闭环

当前仍缺少：

- 一键导出、导入和跨设备恢复工作方式；
- Runtime、Plugin、Skill、Capability 的依赖解析和安装计划；
- Secret、OAuth、workspace 和权限的安全重绑体验；
- 工作方式发布、安装、升级、回滚、兼容性检查和 Fork；
- Memory 的用户/项目/团队 scope、加密同步、迁移和冲突合并；
- 跨 Runtime Memory 的完整产品体验和质量验证；
- fail-closed 的统一本地权限闸门；
- 跨 Runtime Artifact 和 Context 的直观交接；
- Runtime × 模型评测和工作方式回归测试；
- 分享者信誉、版本质量和真实使用反馈；
- 云端控制面、设备连接、队列和恢复。

当前 Memory 默认持久化到 `~/.pragma/memories/<agentId>/`，已经能够脱离单个 Runtime Session 保存，
但仍主要是本机、Agent 级实现。它还不能代表用户已经获得跨设备、跨 Expert 和跨组织的记忆产品。

## 7. 未来建设优先级

### P0：先让“可拥有、可恢复、安全运行”成立

#### 7.1 完成工作方式包与设备恢复闭环

- 定义可发布的 Workstyle Package、依赖清单和 lock 格式；
- 明确 Project Revision、安装副本、环境绑定和用户覆盖之间的边界；
- 支持导出、导入、备份和恢复；
- 实现 Runtime、Plugin、Skill、Capability 的兼容性检测；
- 生成可审查的安装计划，不静默安装或降级；
- 在新设备重新绑定 Secret、OAuth、workspace 和权限；
- 以“新设备首次运行成功”为验收标准，而不是“文件成功复制”。

#### 7.2 完成统一、本地、fail-closed 的权限边界

- 文件、Shell、Git、网络、Secret 和桌面操作统一经过 Desktop Permission Guard；
- 工作方式在安装前声明最小权限，在执行时显示实际申请来源；
- Runtime 或 Plugin 不能绕过宿主权限；
- 被拒绝、无法询问或缺少授权时 fail closed；
- 权限声明参与发布检查和环境兼容性判断。

#### 7.3 将跨 Harness Memory 提升为产品级 Memory Plane

- 按 ADR 031 建立 Host 内置的持久 Evidence Feed、Memory Module SPI 和联邦 Memory Context；
- 明确用户、项目、工作方式、Expert、Team、Mission、Execution 的 subject、ownership 和 binding；
- 统一不同 Runtime 的 Evidence identity 和 provenance；
- 保持可选 Execution working state 与 Memory 生命周期隔离；
- 实现 Dynamic Memory 到私有、共享、可发布 Knowledge/Skill/CodeGraph Asset 的显式 promotion；
- 用 CodeGraph 验证新增类型不修改 Core union、默认 Store 或联邦 Context 实现；
- 支持加密同步、导出、导入、删除和设备间冲突处理；
- 为记忆注入建立预算、相关性、时效和权限策略；
- 用跨 Runtime、跨设备恢复测试验证，而不只验证文件 Store。

### P1：让创作、分享和质量证明成立

#### 7.4 做好对话式、可视化、DSL 三者的统一编辑体验

- 从成功 Mission 提炼工作方式草案；
- 用自然语言创建和修改 Expert、Team、Flow、Skill 和 Runtime 要求；
- 所有自然语言修改显示结构化 Diff、依赖变化和权限影响；
- Studio 与规范化 DSL 可逆，不维护两套语义；
- 发布前自动检查输入、交付、权限、依赖、循环和失败路径。

#### 7.5 完成发布、安装、升级和 Fork

- 不可变 Revision 和可读版本历史；
- 依赖、兼容性、权限、成本和已知限制展示；
- 安装环境预检和替代 Runtime 提示；
- 用户可锁定版本、选择升级、回滚或 Fork；
- 发布者更新不得静默改变已安装用户的执行行为；
- 私有数据和 Memory 默认不进入发布内容。

#### 7.6 建立 Evaluation 和执行证据

- 工作方式携带代表性案例和验收标准；
- 比较不同 Runtime × 模型组合的质量、成本、耗时和人工干预；
- Runtime、模型、Plugin 或工作方式升级后执行回归评测；
- 广场展示可解释的验证证据，不只展示点赞和安装量；
- 质量下降时明确警告、阻止发布或保留经过验证的旧绑定。

### P2：形成生态和规模化运行能力

#### 7.7 建立公共 Runtime Adapter 与 Plugin 开发生态

- 稳定 Runtime Adapter SPI、能力发现和兼容性规范；
- 提供第三方 Runtime 的 conformance tests；
- 规范 Plugin、Capability、Context Store 和 Memory Store 的扩展边界；
- 支持社区贡献专业 Harness、行业能力和存储后端；
- 保持 Core 不依赖任何具体 Runtime。

#### 7.8 建设可信的工作方式市场

- 按任务和交付发现工作方式，而不是按 Agent 数量排序；
- 展示作者、版本、依赖、权限、兼容性、成本和真实验证；
- 提供签名、包指纹、恶意内容检查和供应链撤销机制；
- 支持私有、团队和公开发布；
- 建立 Fork 谱系、改进记录和经授权的质量反馈；
- 保护执行内容，默认不向作者回传用户文件和敏感上下文。

#### 7.9 补齐云端控制面和设备连接

- 用户、设备、安装状态和同步元数据；
- Desktop 主动连接云端，不暴露本机端口；
- Mission 下发、事件回传、断线重连和恢复；
- 有界队列、重试、取消、预算和审计；
- 工作方式与 Memory 的端到端加密或等价用户控制方案；
- 保持本地执行和自托管能力，不把云端变成新的强制锁定。

## 8. 设计原则

后续产品和架构决策应遵循：

1. **用户拥有工作方式和记忆。** 必须可导出、可备份、可删除、可迁移。
2. **Pragma 拥有跨 Runtime 语义，Runtime 拥有自身执行细节。** 不复制 Harness 已经擅长的内部能力。
3. **DSL 是权威格式，UI 和对话是编辑方式。** 不允许三套模型长期漂移。
4. **声明与环境绑定分离。** 可分享包不携带 Secret、本机绝对路径和 Runtime Session。
5. **不静默降级。** 缺少 Runtime、工具、权限或兼容版本时必须解释差异。
6. **Memory 基于 Evidence，而不是模型随意写入长期真相。**
7. **记忆默认私有、最小注入、显式分享。**
8. **分享的是经过验证的工作方式，不是专家头像和 Prompt 数量。**
9. **对创作者足够深，对使用者足够简单。**
10. **当前能力与未来方向必须明确区分。**

## 9. 不应作为核心卖点的能力

以下能力可以是基础功能，但不构成稳定竞争力：

- Agent 或 Expert 数量更多；
- 也能创建专家团；
- 也支持 subagent；
- 可以通过 CLI 或 MCP 调用 Claude Code；
- 支持多个模型；
- 有一个可视化 Flow 编辑器；
- 有一个专家或模板广场；
- 提供更多配置字段；
- 将 Prompt 包装成 DSL。

真正有价值的是这些能力组合后，用户能否低成本地拥有、恢复、执行、学习、验证和分享一套工作方法。

## 10. 核心指标

产品指标应直接验证核心价值：

- 新设备恢复到首次成功执行所需时间；
- 新设备恢复需要的人工配置步骤数；
- 工作方式安装后首次运行成功率；
- 依赖或权限问题在执行前被发现的比例；
- 跨 Runtime Context、Artifact 和 Memory 交接成功率；
- Memory 在后续任务中的有效复用率和错误注入率；
- 相同工作方式的重复成功率；
- 可接受交付物比例；
- 单次合格交付成本和人工干预次数；
- Runtime 或模型升级后的回归通过率；
- 工作方式复用、升级和 Fork 比例；
- 使用者转化为创作者或分享者的比例。

不应把专家数量、Agent 数量、DSL 文件数量或商店条目数量作为首要成功指标。

## 11. 对外表达

面向普通用户：

> **把你的 AI 工作方法和经验带到任何设备，也能一键使用别人验证过的成熟方法。**

面向创作者：

> **通过对话和可视化，把你组合模型、Agent Harness、工具、流程和记忆的经验沉淀成可安装、可验证、
> 可分享的 AI-native 工作方式。**

面向开发者和生态伙伴：

> **Pragma 是 Harness 中立的本地 Agent 工作方式平台，以开放 DSL、统一 Execution 和跨 Runtime
> Memory Plane 连接 Codex、Claude Code、PI 及未来的专业 Agent Harness。**
