# 多专家 Agent 编排系统设计文档

## 1. 背景与目标

随着大模型和 Agent 技术的发展，企业内部越来越多复杂流程可以被 Agent 化，例如需求讨论、技术方案生成、代码编写、代码评审、测试分析、知识问答、业务规则检查等。

但单个通用 Agent 很难稳定完成复杂企业任务，主要原因包括：

1. 企业知识分散在代码仓库、文档、流程规范、历史决策和人员经验中；
2. 不同业务领域需要不同专家能力；
3. 不同任务需要不同执行流程；
4. Agent 运行过程需要权限、评测、发布、回滚和审计；
5. 专家能力需要持续进化，但不能直接污染线上知识。

因此，需要设计一个**多专家 Agent 编排系统**，通过标准化专家 Agent、Playbook 剧本编排、运行时适配、上下文管理、插件扩展、自进化治理等能力，构建一个面向企业复杂流程的 Agent 平台。

---

## 2. 产品定位

本系统定位为：

> 面向企业复杂流程的多专家 Agent 编排与发布平台。

系统核心不是单个 Agent，而是将多个具备领域知识和专业能力的专家 Agent，通过 Playbook 剧本进行低代码编排，形成可发布、可复用、可治理的统一服务。

典型场景包括：

| 场景           | 编排方式                                        | 输出                           |
| -------------- | ----------------------------------------------- | ------------------------------ |
| 需求讨论与分析 | 需求讨论调度官 + 多个业务专家                   | 澄清问题、需求分析、业务影响面 |
| 技术方案生成   | 技术方案调度官 + 架构专家 + 业务专家 + 代码专家 | 技术方案、改造点、风险点       |
| 代码编写       | 代码编写专家 + 业务专家 + 仓库专家              | 代码分支、Commit、PR           |
| 代码评审       | CR 专家 + 业务专家 + 规范专家                   | Review 意见、风险列表          |
| 测试分析       | 测试专家 + 业务专家 + 代码专家                  | 测试用例、回归范围、测试报告   |
| 业务知识问答   | 问答调度官 + 多领域专家                         | 结构化答案、引用来源           |

---

## 3. 总体架构

系统整体分为三大部分：

```text
多专家 Agent 编排系统
├── 专家 Agent 创建与发布系统
├── 专家团 Playbook 编排与发布系统
└── 统一服务与运行治理系统
```

### 3.1 专家 Agent 创建与发布系统

负责创建、配置、测试、评测、审核和发布单个专家 Agent。

专家 Agent 是系统中的基础能力单元，类似一个小型自进化 Agent。每个专家 Agent 拥有自己的配置、文档、技能、工具、Hook、插件和运行时适配能力。

### 3.2 专家团 Playbook 编排与发布系统

负责将多个专家 Agent 编排成一个完整工作流。

Playbook 类似 Dify、Coze 这类平台中的低代码工作流编排能力，但编排对象不是普通 LLM 节点，而是具备完整上下文、工具、文档和自进化能力的专家 Agent。

### 3.3 统一服务与运行治理系统

负责对外提供统一服务，包括 API 调用、权限控制、运行调度、日志追踪、成本控制、灰度发布、回滚、租户隔离等能力。

---

## 4. 核心概念

### 4.1 专家 Agent

专家 Agent 是一个面向特定领域或特定能力的智能执行单元。

一个专家 Agent 可以是：

| 类型     | 示例                                         |
| -------- | -------------------------------------------- |
| 领域专家 | 交易专家、订单专家、会员专家、营销专家       |
| 职能专家 | 前端专家、服务端专家、测试专家、安全专家     |
| 流程专家 | 需求讨论调度官、技术方案调度官、代码编写专家 |
| 仓库专家 | App 仓库专家、后端服务仓库专家、网关仓库专家 |
| 规范专家 | 代码规范专家、架构规范专家、发布规范专家     |

专家 Agent 本身不等同于底层模型，而是一个完整的能力封装：

```text
专家 Agent =
  专家配置
  + 专家文档
  + Skills
  + MCP 工具
  + Hooks
  + 插件
  + 上下文加载策略
  + Runtime Agent
  + 权限策略
  + 评测集
  + 发布版本
```

底层 Runtime Agent 可以自由切换，例如：

| Runtime    | 说明                               |
| ---------- | ---------------------------------- |
| Claude     | 适合复杂推理、长上下文分析         |
| Codex      | 适合代码编辑、仓库任务             |
| PI Agent   | 适合特定内部执行环境               |
| 自研 Agent | 适合深度定制、企业内控、私有化部署 |

---

### 4.2 Playbook 剧本

Playbook 是专家团编排后的业务流程定义。

它描述：

1. 调用哪些专家；
2. 专家之间如何协作；
3. 上下文如何传递；
4. 是否需要人工审核；
5. 失败后如何重试或降级；
6. 最终产物如何生成；
7. 以什么形式对外提供服务。

示例：

```text
需求分析 Playbook
├── 需求讨论调度官
├── 订单业务专家
├── 会员业务专家
├── 营销业务专家
├── 技术影响面专家
└── 需求总结专家
```

Playbook 编排后可以对外发布成统一服务，例如：

```text
POST /agent-service/requirement-analysis
POST /agent-service/tech-design
POST /agent-service/code-generation
```

---

### 4.3 专家调度官

专家调度官本质上也是一个普通专家 Agent。

它的特殊之处在于：它主要负责流程调度、任务拆解、专家选择、上下文分发、结果汇总和质量判断。

但调度官本身不应该“凭空拥有所有知识”，它的能力应该依赖于：

1. 自身专家配置；
2. Playbook 中配置的专家列表；
3. 每个专家暴露的能力描述；
4. 专家 inputSchema / outputSchema；
5. 当前任务上下文；
6. 可用工具和权限。

也就是说，调度官是一个“会调度的专家”，而不是系统级硬编码逻辑。

---

## 5. 专家 Agent 标准协议

为了让专家 Agent 可以被 Playbook 稳定编排，需要定义统一的专家标准协议。

每个专家 Agent 都应该具备一个 Manifest 文件，用于声明专家身份、能力、输入输出、依赖、权限和版本信息。

详细协议设计见：

```text
docs/architecture/expert-agent-standard-protocol.md
```

### 5.1 Expert Manifest

示例结构：

```yaml
id: order-domain-expert
name: 订单业务专家
description: 负责订单领域的业务规则、流程、异常场景和历史决策分析
version: 1.3.0
owner: order-team

tags:
  - order
  - business
  - domain-expert

capabilities:
  - 订单链路分析
  - 订单状态机解释
  - 订单异常场景判断
  - 订单需求影响面分析

inputSchema:
  type: object
  properties:
    task:
      type: string
      description: 当前需要专家处理的问题
    businessContext:
      type: string
      description: 需求背景或业务上下文
    relatedFiles:
      type: array
      items:
        type: string
      description: 相关代码文件或文档路径
  required:
    - task

outputSchema:
  type: object
  properties:
    conclusion:
      type: string
      description: 专家结论
    risks:
      type: array
      items:
        type: string
      description: 风险点
    impactedModules:
      type: array
      items:
        type: string
      description: 影响模块
    references:
      type: array
      items:
        type: string
      description: 引用的文档或代码路径
  required:
    - conclusion

runtime:
  supported:
    - claude
    - codex
    - self-hosted-agent
  default: claude

permissions:
  context:
    read:
      - ./context/**
    write:
      - ./context/evolution/**
  mcp:
    - code-search
    - doc-search
  git:
    read: true
    write: false

skills:
  - business-impact-analysis
  - order-state-machine-analysis

hooks:
  - context-sanitizer
  - output-schema-validator

evalCases:
  - ./eval/order-impact-cases.yaml

lifecycle:
  status: published
  createdAt: 2026-06-19
  updatedAt: 2026-06-19
```

---

### 5.2 inputSchema 和 outputSchema

`inputSchema` 和 `outputSchema` 是专家标准协议中非常关键的部分。

它们的核心价值是：**让专家能力可以被稳定编排，而不是完全依赖自然语言描述。**

#### inputSchema 的作用

| 作用             | 说明                                        |
| ---------------- | ------------------------------------------- |
| 规范输入         | 明确专家需要什么输入                        |
| 支持编排         | Playbook 可以根据 Schema 自动连接上下游节点 |
| 降低歧义         | 避免调度官不知道如何调用专家                |
| 支持校验         | 运行前可以检查输入是否完整                  |
| 支持自动生成表单 | 后续可用于低代码配置界面                    |

#### outputSchema 的作用

| 作用         | 说明                              |
| ------------ | --------------------------------- |
| 规范输出     | 专家输出结构稳定                  |
| 方便聚合     | 调度官可以自动合并多个专家结果    |
| 方便路由     | 后续节点可以读取指定字段          |
| 方便评测     | 评测系统可判断字段是否完整        |
| 方便产物生成 | 直接生成报告、PR 描述、测试用例等 |

没有 Schema 时，多专家协作会大量依赖自然语言传递，稳定性较差。

有 Schema 后，Playbook 可以像低代码工作流一样编排专家。

---

## 6. 专家 Agent 创建与发布系统

### 6.1 创建流程

专家创建流程如下：

```text
创建专家
→ 填写基础信息
→ 配置 Runtime
→ 配置 MCP
→ 配置 Skills
→ 配置 Hooks
→ 上传或关联 context 文件夹
→ 配置 inputSchema / outputSchema
→ 配置权限
→ 配置评测集
→ 本地调试
→ 提交审核
→ 发布版本
```

### 6.2 专家配置内容

专家配置主要包括：

| 配置项      | 说明                   |
| ----------- | ---------------------- |
| 名称        | 专家展示名称           |
| 描述        | 专家能力描述           |
| 标签        | 用于搜索和调度         |
| 能力声明    | 专家能解决什么问题     |
| 输入 Schema | 专家输入协议           |
| 输出 Schema | 专家输出协议           |
| Runtime     | 默认运行时和可选运行时 |
| MCP         | 可使用的外部工具       |
| Skills      | 专家可加载的技能       |
| Hooks       | 专家运行过程中的扩展点 |
| Contexts    | 专家长期知识目录       |
| 权限        | 可读、可写、可调用范围 |
| 评测集      | 发布前自动评测         |
| Owner       | 负责人或团队           |
| Version     | 当前版本               |

---

## 7. Context 文件夹管理

### 7.1 Context 的定位

`context` 文件夹是专家 Agent 的长期知识载体。

它可以包含：

| 类型           | 示例                         |
| -------------- | ---------------------------- |
| 业务知识       | 订单规则、交易流程、会员权益 |
| 技术知识       | 架构约束、接口说明、模块职责 |
| 历史决策       | 为什么采用某种方案           |
| 代码知识       | 仓库结构、核心链路、关键文件 |
| 流程规范       | 发布流程、CR 规范、测试规范  |
| 常见问题       | FAQ、历史故障、踩坑记录      |
| 专家自进化内容 | 运行后沉淀的新知识           |

### 7.2 Git 管理

Context 文件夹需要使用 Git 管理。

核心原因：

1. 专家自进化会修改文档，需要可追踪；
2. 多人协作维护专家知识，需要版本控制；
3. 错误知识可能污染专家，需要可回滚；
4. 发布专家版本时，需要锁定文档版本；
5. Playbook 运行复盘时，需要知道当时使用的知识版本。

建议每个专家有独立的 Context Store，或在统一知识仓库中按专家目录隔离。

示例：

```text
expert-docs-repo
├── order-domain-expert
│   ├── business-rules
│   ├── architecture
│   ├── code-map
│   ├── faq
│   └── evolution
├── member-domain-expert
│   ├── business-rules
│   ├── architecture
│   ├── code-map
│   └── evolution
└── marketing-domain-expert
    ├── business-rules
    ├── architecture
    └── evolution
```

### 7.3 文档元信息

建议文档支持 metadata：

```yaml
title: 订单状态机规则
owner: order-team
source: human
confidence: high
trustLevel: team-trusted
lastVerifiedAt: 2026-06-19
writableByAgent: false
tags:
  - order
  - state-machine
  - business-rule
```

关键字段：

| 字段            | 说明                               |
| --------------- | ---------------------------------- |
| source          | 来源，例如人工、代码扫描、运行沉淀 |
| confidence      | 可信度                             |
| trustLevel      | 信任等级                           |
| lastVerifiedAt  | 最后验证时间                       |
| writableByAgent | 是否允许 Agent 修改                |
| tags            | 用于检索和上下文加载               |

---

## 8. 上下文管理系统

### 8.1 上下文管理目标

上下文管理系统负责从专家的 context 文件夹、当前任务、历史运行记录、工具结果、代码仓库、插件文档中选择合适内容注入给 Runtime Agent。

目标是：

1. 不一次性加载所有文档；
2. 根据任务渐进式加载；
3. 优先加载高相关、高可信、最新的知识；
4. 支持摘要优先，必要时加载原文；
5. 保留上下文快照，方便审计和复盘。

### 8.2 上下文分层

建议上下文分为：

```text
系统约束上下文
专家身份上下文
专家长期知识上下文
Playbook 任务上下文
当前会话上下文
外部工具结果上下文
临时运行上下文
```

不同上下文有不同优先级。

| 层级                | 优先级 | 示例                 |
| ------------------- | ------ | -------------------- |
| 系统约束上下文      | 最高   | 权限、安全、输出格式 |
| 专家身份上下文      | 高     | 专家角色、能力边界   |
| 专家长期知识        | 高     | context 文件夹内容   |
| Playbook 任务上下文 | 中     | 上游专家输出         |
| 当前会话上下文      | 中     | 用户输入和澄清信息   |
| 工具结果上下文      | 中     | MCP 查询结果         |
| 临时运行上下文      | 低     | 中间推理、草稿信息   |

### 8.3 渐进式加载策略

上下文加载建议分为三步：

```text
第一步：加载专家基础身份和任务上下文
第二步：检索 context 摘要和相关文档片段
第三步：根据 Runtime 需要继续加载原文、代码、历史记录
```

可以定义 ContextPlan：

```yaml
mustLoad:
  - expert-profile.md
  - safety-policy.md

shouldLoad:
  - related-business-rules
  - related-code-map

lazyLoad:
  - historical-decisions
  - long-tail-faq

forbiddenLoad:
  - archived-docs
  - unauthorized-docs
```

---

## 9. 专家 Agent 自进化机制

### 9.1 自进化定义

自进化是指专家 Agent 在运行过程中，根据任务结果、人工反馈、评测失败、代码变化、知识缺失等情况，生成对 context 文件夹的更新建议。

自进化不是让 Agent 直接修改线上知识，而是形成受控的知识更新流程。

### 9.2 自进化触发场景

| 触发场景 | 示例                   |
| -------- | ---------------------- |
| 用户反馈 | 用户指出专家回答错误   |
| 任务复盘 | 某次需求分析遗漏影响面 |
| 评测失败 | 专家未通过某条测试用例 |
| 代码变化 | 仓库结构发生变化       |
| 文档缺失 | 专家发现当前知识不足   |
| 人工补充 | 业务同学新增规则       |
| 运行沉淀 | 多次任务中出现重复知识 |

### 9.3 自进化流程

推荐流程：

```text
运行中发现知识缺失或错误
→ 生成文档变更建议
→ 创建知识变更 PR
→ 自动评测
→ 人工审核
→ 合并 Context Store
→ 发布专家新版本
→ 灰度验证
→ 正式发布
```

重点原则：

1. 自进化不能直接覆盖线上版本；
2. 所有变更必须有 diff；
3. 所有变更必须有来源和原因；
4. 关键知识必须人工审核；
5. 合并后要生成专家新版本；
6. 线上 Playbook 不应自动使用未发布版本。

### 9.4 自进化权限控制

专家对 context 的写入权限应分级：

| 权限     | 说明                         |
| -------- | ---------------------------- |
| 只读     | 只能读取，不能提出修改       |
| 建议修改 | 可以生成变更建议，但不能提交 |
| 创建 PR  | 可以创建知识变更 PR          |
| 自动合并 | 仅限低风险文档或沙箱环境     |
| 禁止访问 | 无权读取或修改               |

一般建议：

```text
业务核心规则：只允许建议修改，需要人工审核
代码索引类文档：可自动更新，但需要评测
FAQ 类文档：可创建 PR，轻量审核
临时经验文档：可自动写入 evolution 目录
```

---

## 10. Runtime Agent 适配层

### 10.1 Runtime 抽象

专家 Agent 底层可以运行在不同 Runtime Agent 上。

系统需要提供 Runtime Adapter，将不同 Runtime 封装为统一接口。

```text
Runtime Adapter
├── Claude Adapter
├── Codex Adapter
├── PI Agent Adapter
└── Self-hosted Agent Adapter
```

统一能力包括：

| 能力            | 说明              |
| --------------- | ----------------- |
| run             | 启动一次专家运行  |
| stream          | 返回流式输出      |
| cancel          | 中断运行          |
| resume          | 恢复运行          |
| toolCall        | 调用工具          |
| fileEdit        | 文件编辑          |
| getCapabilities | 查询 Runtime 能力 |
| getCost         | 获取成本信息      |

### 10.2 Runtime 能力差异

不同 Runtime 能力不一致，需要显式声明。

例如：

| 能力           | Claude     | Codex      | 自研 Agent |
| -------------- | ---------- | ---------- | ---------- |
| 长上下文分析   | 强         | 中         | 可控       |
| 代码编辑       | 中         | 强         | 可控       |
| Shell 执行     | 取决于环境 | 强         | 可控       |
| MCP 支持       | 取决于适配 | 取决于适配 | 可控       |
| 中断恢复       | 不一定     | 不一定     | 可控       |
| 权限细粒度控制 | 中         | 中         | 强         |
| 私有化部署     | 弱         | 弱         | 强         |

Playbook 在选择 Runtime 时，需要基于专家声明和任务特征进行选择。

---

## 11. Skills、MCP、Hooks 与插件系统

### 11.1 Skills

Skill 是专家可加载的能力包。

示例：

| Skill                | 说明                     |
| -------------------- | ------------------------ |
| 需求影响面分析 Skill | 分析需求涉及哪些业务模块 |
| 技术方案生成 Skill   | 输出方案结构和改造点     |
| 代码检索 Skill       | 检索代码链路             |
| CR Skill             | 进行代码评审             |
| 测试用例生成 Skill   | 根据需求生成测试点       |

Skill 更偏向“能力模板”和“操作方法”。

---

### 11.2 MCP

MCP 用于接入外部工具和系统。

示例：

| MCP         | 能力           |
| ----------- | -------------- |
| code-search | 搜索代码       |
| git         | 操作 Git 仓库  |
| issue       | 查询需求和缺陷 |
| doc-search  | 查询文档       |
| ci          | 查询构建和测试 |
| database    | 查询业务数据   |
| deploy      | 查询发布状态   |

MCP 必须受权限系统控制，不能让专家默认拥有所有工具权限。

---

### 11.3 Hooks

Hook 是专家运行过程中的事件扩展机制。

每个 Hook 可以打成安装包，通过配置注入专家 Agent。

常见 Hook 点：

```text
beforeContextLoad
afterContextLoad
beforeRuntimeStart
onRuntimeStream
afterToolCall
beforeMemoryWrite
afterMemoryWrite
beforeExpertPublish
afterExpertPublish
onError
onTimeout
```

Hook 类型可以分为：

| 类型           | 说明                     |
| -------------- | ------------------------ |
| Policy Hook    | 权限、安全、合规、拦截   |
| Extension Hook | 日志、通知、指标、同步   |
| Transform Hook | 上下文改写、输出格式转换 |
| Eval Hook      | 运行后自动评测           |

Hook 需要考虑：

1. 执行顺序；
2. 超时控制；
3. 失败策略；
4. 权限声明；
5. 数据脱敏；
6. 审计日志；
7. 版本兼容。

---

### 11.4 插件系统

插件是更高层的扩展机制，可以一次性注入配置、Skills、MCP、Hooks 和文档。

例如：

| 插件         | 注入内容                              |
| ------------ | ------------------------------------- |
| 记忆系统插件 | Memory MCP、记忆文档、记忆写入 Hook   |
| 代码仓库插件 | Git MCP、代码检索 Skill、仓库结构文档 |
| 企业规范插件 | 代码规范文档、CR Skill、安全 Hook     |
| 需求系统插件 | 需求查询 MCP、PRD 解析 Skill          |

插件 Manifest 示例：

```yaml
id: code-repo-plugin
name: 代码仓库插件
version: 1.0.0
description: 为专家注入代码仓库理解和操作能力

permissions:
  git:
    read: true
    write: false
  mcp:
    - code-search
    - git

inject:
  skills:
    - code-search-skill
    - code-map-analysis-skill
  mcp:
    - code-search
    - git
  hooks:
    - code-context-loader
  context:
    - ./docs/repo-structure.md
    - ./docs/code-style.md
```

插件需要支持：

1. 安装；
2. 升级；
3. 禁用；
4. 卸载；
5. 权限声明；
6. 版本兼容；
7. 冲突检测。

---

## 12. Playbook 编排与发布系统

### 12.1 Playbook 定位

Playbook 是专家团的低代码编排产物。

它类似 Dify 或 Coze 的工作流编排，但节点可以是更强的专家 Agent。

Playbook 不是简单的 prompt 串联，而是一个有状态的执行流程。

```text
Playbook =
  Nodes
  + Edges
  + State
  + Expert Bindings
  + Input/Output Schema
  + Permissions
  + Runtime Policy
  + Failure Policy
  + Release Version
```

---

### 12.2 Playbook 节点类型

| 节点类型        | 说明               |
| --------------- | ------------------ |
| StartNode       | 入口节点           |
| ExpertNode      | 调用某个专家 Agent |
| RouterNode      | 根据条件选择分支   |
| MergeNode       | 汇总多个专家结果   |
| HumanReviewNode | 人工审核           |
| ToolNode        | 直接调用工具       |
| EvalNode        | 自动评测           |
| ArtifactNode    | 生成产物           |
| EndNode         | 结束节点           |

---

### 12.3 Playbook 示例：需求分析

```text
用户提交需求
→ 需求讨论调度官
→ 判断涉及领域
→ 并行调用相关业务专家
    ├── 订单业务专家
    ├── 会员业务专家
    └── 营销业务专家
→ 汇总影响面
→ 生成澄清问题
→ 人工确认
→ 输出需求分析报告
```

输出产物：

```text
需求背景
业务影响面
技术影响面
待澄清问题
风险点
相关专家结论
引用来源
```

---

### 12.4 Playbook 示例：技术方案生成

```text
用户输入需求分析结果
→ 技术方案调度官
→ 识别相关系统和仓库
→ 调用业务专家补充规则
→ 调用代码仓库专家分析代码链路
→ 调用架构专家生成方案
→ 调用测试专家补充测试范围
→ 汇总技术方案
→ 人工审核
→ 发布方案文档
```

输出产物：

```text
背景
目标
非目标
现状分析
改造方案
接口设计
数据结构变更
影响范围
风险点
测试建议
发布策略
回滚策略
```

---

### 12.5 Playbook 示例：代码编写

```text
用户输入技术方案
→ 代码编写专家
→ 读取相关仓库和任务拆分
→ 调用业务专家确认业务规则
→ 调用代码仓库专家定位文件
→ Runtime Agent 执行代码修改
→ 自动运行测试
→ CR 专家评审
→ 生成 PR
→ 人工 Review
```

输出产物：

```text
代码分支
Commit 列表
PR 链接
修改文件
测试结果
CR 意见
风险说明
```

---

### 12.6 Playbook 发布

Playbook 发布时需要锁定：

1. Playbook 自身版本；
2. 引用的专家版本；
3. 专家 Context Store 版本；
4. 插件版本；
5. Hook 版本；
6. Runtime 策略版本；
7. 权限策略版本。

避免线上 Playbook 自动引用“最新专家”导致行为不可控。

推荐发布流程：

```text
编辑 Playbook
→ 本地调试
→ 绑定专家版本
→ 自动评测
→ 权限检查
→ 人工审核
→ 灰度发布
→ 正式发布
```

---

## 13. 权限系统

### 13.1 权限目标

权限系统需要保证：

1. 用户只能操作有权限的专家和 Playbook；
2. 专家只能访问被授权的文档、工具和仓库；
3. 插件和 Hook 不能越权；
4. Runtime 不能无限制执行文件、网络和 Shell 操作；
5. 自进化不能绕过审核流程。

### 13.2 权限分层

```text
用户权限
专家权限
Playbook 权限
插件权限
Hook 权限
Runtime 权限
文档权限
工具权限
```

### 13.3 用户权限

| 权限             | 说明           |
| ---------------- | -------------- |
| expert:create    | 创建专家       |
| expert:edit      | 编辑专家配置   |
| expert:publish   | 发布专家       |
| expert:delete    | 删除专家       |
| playbook:create  | 创建 Playbook  |
| playbook:edit    | 编辑 Playbook  |
| playbook:publish | 发布 Playbook  |
| run:view         | 查看运行记录   |
| trace:view       | 查看详细 Trace |
| context:approve  | 审核知识变更   |

### 13.4 专家权限

| 权限          | 说明         |
| ------------- | ------------ |
| context:read  | 读取指定文档 |
| context:write | 修改指定文档 |
| mcp:call      | 调用指定 MCP |
| expert:call   | 调用其他专家 |
| repo:read     | 读取代码仓库 |
| repo:write    | 修改代码仓库 |
| memory:read   | 读取记忆     |
| memory:write  | 写入记忆     |

### 13.5 Runtime 权限

| 权限           | 说明       |
| -------------- | ---------- |
| file:read      | 文件读取   |
| file:write     | 文件写入   |
| shell:execute  | Shell 执行 |
| network:access | 网络访问   |
| secret:read    | 密钥读取   |
| git:commit     | Git 提交   |
| git:push       | Git 推送   |

Runtime 权限应该尽量最小化，默认禁止高风险能力。

---

## 14. 评测与发布系统

### 14.1 评测目标

系统中有两个核心评测对象：

1. 专家 Agent；
2. Playbook。

专家评测关注单点能力，Playbook 评测关注端到端流程质量。

### 14.2 专家评测维度

| 维度     | 说明                          |
| -------- | ----------------------------- |
| 正确性   | 结论是否正确                  |
| 完整性   | 是否覆盖关键点                |
| 边界意识 | 是否知道自己不能处理什么      |
| 文档引用 | 是否正确使用 context          |
| 工具使用 | MCP 调用是否合理              |
| 输出格式 | 是否符合 outputSchema         |
| 稳定性   | 多次运行结果是否稳定          |
| 成本     | Token、耗时、工具调用是否可控 |

### 14.3 Playbook 评测维度

| 维度         | 说明                       |
| ------------ | -------------------------- |
| 路由准确性   | 是否选择正确专家           |
| 协作质量     | 多专家输出是否合理融合     |
| 端到端正确性 | 最终产物是否满足要求       |
| 人工节点     | 是否在关键风险点要求审核   |
| 失败恢复     | 某专家失败后是否有降级策略 |
| 成本控制     | 是否超过预算               |
| 输出产物     | 是否符合服务协议           |

### 14.4 发布流程

统一发布流程：

```text
配置变更
→ Schema 校验
→ 权限校验
→ 自动评测
→ 安全扫描
→ 人工审核
→ 灰度发布
→ 线上监控
→ 正式发布
```

发布对象包括：

1. 专家 Agent；
2. Playbook；
3. 插件；
4. Hook；
5. Skill；
6. Runtime Adapter；
7. 文档版本。

---

## 15. 可观测性与审计

### 15.1 运行追踪

每次 Playbook Run 都需要完整记录：

| 信息          | 说明                  |
| ------------- | --------------------- |
| 用户输入      | 原始请求              |
| Playbook 版本 | 当前运行的剧本版本    |
| 专家版本      | 实际调用的专家版本    |
| Runtime       | 使用的底层运行时      |
| 上下文快照    | 实际注入的上下文      |
| MCP 调用      | 工具调用记录          |
| Hook 执行     | Hook 执行记录         |
| 专家输出      | 每个专家的输出        |
| 中间状态      | 工作流状态变化        |
| 最终产物      | 输出结果              |
| 成本          | Token、耗时、工具次数 |
| 错误          | 异常、重试、降级信息  |

### 15.2 核心 Trace 对象

```text
RunTrace
├── PlaybookTrace
├── StepTrace
├── ExpertTrace
├── ContextSnapshot
├── ToolCallTrace
├── HookTrace
├── PermissionDecisionTrace
├── ContextChangeTrace
└── ArtifactTrace
```

其中 `ContextSnapshot` 非常关键，用于排查：

1. 专家为什么这么回答；
2. 是否加载了错误文档；
3. 是否遗漏了关键上下文；
4. 是否被低可信文档污染；
5. 是否用了过期知识。

---

## 16. 安全治理

### 16.1 主要风险

| 风险             | 说明                      |
| ---------------- | ------------------------- |
| Prompt Injection | 文档或代码中包含恶意指令  |
| 工具越权         | 专家调用未授权 MCP        |
| 插件越权         | 插件注入高风险能力        |
| Hook 篡改        | Hook 修改上下文或输出     |
| 自进化污染       | 错误知识被写入 context    |
| 数据泄露         | 专家读取不该读取的数据    |
| Runtime 逃逸     | Shell、网络、文件系统越权 |

### 16.2 安全机制

建议引入：

```text
Instruction Hierarchy
Permission Engine
Policy Hook
Context Sanitizer
Tool Call Gate
Context Trust Level
Runtime Sandbox
Secret Manager
Audit Log
```

### 16.3 文档信任等级

文档可以分为：

| 等级              | 说明           |
| ----------------- | -------------- |
| system-trusted    | 系统级可信文档 |
| team-trusted      | 团队维护文档   |
| repo-derived      | 从代码仓库提取 |
| user-provided     | 用户输入       |
| runtime-generated | Agent 运行生成 |
| web-derived       | 外部网络来源   |
| archived          | 已归档或过期   |

上下文加载时，应优先加载高可信文档，低可信文档进入上下文前需要清洗和标记。

---

## 17. 成本与资源控制

多专家系统天然容易产生高成本，因此需要内置成本治理。

### 17.1 成本来源

| 成本         | 示例                        |
| ------------ | --------------------------- |
| 模型调用     | Claude、Codex、大模型 API   |
| Token        | 上下文、输出、工具结果      |
| 工具调用     | MCP 查询、代码搜索、CI 查询 |
| Runtime 资源 | 沙箱、容器、机器资源        |
| 存储         | Trace、文档、产物、日志     |
| 评测         | 自动回归测试                |

### 17.2 控制策略

| 策略            | 说明                                 |
| --------------- | ------------------------------------ |
| Token Budget    | 控制最大上下文和输出                 |
| Expert Budget   | 限制最多调用专家数量                 |
| Tool Budget     | 限制工具调用次数                     |
| Runtime Timeout | 控制最大运行时间                     |
| Cache           | 缓存文档摘要、检索结果、专家中间结论 |
| 降级策略        | 使用低成本模型或减少专家调用         |
| 运行前估算      | 执行前估算成本                       |

示例配置：

```yaml
budget:
  maxTokens: 200000
  maxExperts: 20
  maxToolCalls: 100
  maxRuntimeMinutes: 30
  fallbackRuntime: self-hosted-agent
```

---

## 18. 多租户与组织结构

企业场景需要支持多租户、多空间、多项目隔离。

推荐模型：

```text
Tenant
└── Workspace
    └── Project
        ├── ExpertAgent
        ├── Playbook
        ├── ContextRepo
        ├── PluginConfig
        ├── RuntimeConfig
        └── RunTrace
```

隔离对象包括：

| 对象              | 是否需要隔离 |
| ----------------- | ------------ |
| 专家 Agent        | 是           |
| Playbook          | 是           |
| Context Store     | 是           |
| 运行日志          | 是           |
| MCP 配置          | 是           |
| Secrets           | 是           |
| 插件配置          | 是           |
| 评测集            | 是           |
| Runtime Workspace | 是           |

---

## 19. 产物管理

Playbook 的输出不一定是普通文本，而是结构化产物。

### 19.1 产物类型

| 场景     | 产物                   |
| -------- | ---------------------- |
| 需求分析 | 需求分析报告、澄清问题 |
| 技术方案 | 技术方案文档、接口设计 |
| 代码编写 | 分支、Commit、PR       |
| 代码评审 | Review 评论、风险列表  |
| 测试分析 | 测试用例、测试报告     |
| 知识沉淀 | 文档变更 PR            |

### 19.2 Artifact 模型

```yaml
id: artifact-001
type: tech-design-doc
sourceRunId: run-123
creator: tech-design-playbook
version: 1.0.0
status: draft
content: ...
metadata:
  relatedExperts:
    - order-domain-expert
    - architecture-expert
  relatedContext:
    - order/business-rules/order-state.md
```

产物需要支持：

1. 草稿；
2. 审核；
3. 发布；
4. 修改；
5. 版本管理；
6. 关联运行记录；
7. 关联专家和文档来源。

---

## 20. 对外服务层

Playbook 编排发布后，对外提供统一服务。

### 20.1 服务形式

| 形式       | 说明               |
| ---------- | ------------------ |
| API        | 系统间调用         |
| Web 控制台 | 用户交互           |
| Chat 入口  | 对话式使用         |
| IDE 插件   | 编程场景集成       |
| CI/CD 集成 | 自动代码检查、测试 |
| Webhook    | 被外部系统触发     |

### 20.2 服务能力

统一服务层需要支持：

| 能力       | 说明                      |
| ---------- | ------------------------- |
| 鉴权       | 用户、应用、租户鉴权      |
| 参数校验   | 基于 Playbook inputSchema |
| 任务创建   | 创建一次 Run              |
| 流式输出   | 实时返回执行状态          |
| 中断       | 用户主动停止任务          |
| 恢复       | 长任务断点恢复            |
| 查询结果   | 获取最终产物              |
| 查看 Trace | 查看运行过程              |
| 反馈       | 用户对结果进行评价        |

---

## 21. 产品模块划分

### 21.1 专家 Agent 管理

核心功能：

1. 创建专家；
2. 编辑专家配置；
3. 配置 Runtime；
4. 配置 Skills；
5. 配置 MCP；
6. 配置 Hooks；
7. 安装插件；
8. 管理 context；
9. 配置 Schema；
10. 配置权限；
11. 调试专家；
12. 发布专家。

---

### 21.2 Playbook 管理

核心功能：

1. 创建 Playbook；
2. 选择专家；
3. 拖拽式编排节点；
4. 配置节点输入输出；
5. 配置条件分支；
6. 配置人工审核节点；
7. 配置失败策略；
8. 配置预算；
9. 测试运行；
10. 发布服务。

---

### 21.3 文档与知识管理

核心功能：

1. Context Store 管理；
2. 文档编辑；
3. 文档检索；
4. 文档版本；
5. 文档审核；
6. 文档回滚；
7. 自进化 PR；
8. 文档可信等级；
9. 文档引用追踪。

---

### 21.4 插件与 Hook 管理

核心功能：

1. 插件安装；
2. 插件配置；
3. 插件升级；
4. 插件卸载；
5. Hook 配置；
6. Hook 执行日志；
7. 权限声明；
8. 冲突检测。

---

### 21.5 运行中心

核心功能：

1. 查看运行任务；
2. 查看 Playbook 执行状态；
3. 查看专家调用链路；
4. 查看上下文快照；
5. 查看工具调用；
6. 查看错误和重试；
7. 查看成本；
8. 中断或重跑任务。

---

### 21.6 评测中心

核心功能：

1. 管理专家评测集；
2. 管理 Playbook 评测集；
3. 自动执行评测；
4. 查看通过率；
5. 对比不同版本；
6. 失败用例分析；
7. 发布准入控制。

---

## 22. 关键技术设计

### 22.1 核心领域模型

```text
ExpertAgent
ExpertVersion
ExpertManifest
ContextRepo
ContextVersion
Skill
MCPServer
HookPackage
PluginPackage
RuntimeAdapter
Playbook
PlaybookVersion
PlaybookRun
RunTrace
Artifact
EvalCase
EvalResult
PermissionPolicy
```

---

### 22.2 专家调用链路

```text
Playbook Node 触发专家调用
→ 读取 Expert Manifest
→ 校验 inputSchema
→ 校验权限
→ 生成 ContextPlan
→ 加载 context 和插件上下文
→ 执行 beforeContextLoad Hook
→ 执行 Runtime Agent
→ 调用 MCP / Skill
→ 执行输出校验
→ 校验 outputSchema
→ 记录 Trace
→ 返回结构化结果
```

---

### 22.3 Playbook 运行链路

```text
接收外部请求
→ 校验 Playbook inputSchema
→ 创建 PlaybookRun
→ 加载 PlaybookVersion
→ 初始化状态
→ 执行 StartNode
→ 调用 ExpertNode / RouterNode / ToolNode
→ 处理中间状态
→ 生成 Artifact
→ 执行评测或人工审核
→ 输出最终结果
→ 记录完整 Trace
```

---

### 22.4 自进化链路

```text
专家运行
→ 发现知识缺失或错误
→ 生成文档变更建议
→ 创建 Context Change
→ 生成 Git PR
→ 自动评测
→ 人工审核
→ 合并 Context Store
→ 生成 Expert 新版本
→ 灰度发布
```

---

## 23. MVP 范围建议

第一阶段不建议一次性做完整系统，可以先实现最小闭环。

### 23.1 MVP 必须包含

| 模块            | 是否必须 | 说明                            |
| --------------- | -------- | ------------------------------- |
| 专家 Agent 创建 | 必须     | 支持基础配置                    |
| Expert Manifest | 必须     | 包含 inputSchema / outputSchema |
| Context Store   | 必须     | Git 管理                        |
| Context Manager | 必须     | 支持基础检索和加载              |
| Runtime Adapter | 必须     | 先支持 1 到 2 个 Runtime        |
| Playbook 编排   | 必须     | 支持低代码节点编排              |
| 专家调度官      | 必须     | 作为普通专家 Agent              |
| Run Trace       | 必须     | 能排查问题                      |
| 专家发布        | 必须     | 支持版本                        |
| Playbook 发布   | 必须     | 支持版本                        |
| 权限基础版      | 必须     | 用户、专家、工具权限            |
| 自进化 PR       | 建议     | 可以先半自动                    |
| 评测基础版      | 建议     | 先支持固定用例                  |

### 23.2 MVP 可暂缓

| 模块           | 说明                      |
| -------------- | ------------------------- |
| 插件市场       | 初期只做内置插件          |
| 复杂 Hook 编排 | 先支持几个关键事件        |
| 多租户复杂隔离 | 初期支持 Workspace 级隔离 |
| 自动回滚       | 初期手动回滚              |
| 成本计费       | 初期只做统计              |
| 高级安全扫描   | 初期做基础权限和日志      |

---

## 24. 推荐建设路径

### 阶段一：专家 Agent 标准化

目标：让单个专家可以被创建、运行、调试和发布。

建设内容：

1. Expert Manifest；
2. inputSchema / outputSchema；
3. Context Store；
4. Runtime Adapter；
5. Context Manager；
6. 基础权限；
7. 单专家运行 Trace。

---

### 阶段二：Playbook 编排

目标：让多个专家可以被低代码编排成流程。

建设内容：

1. Playbook DSL；
2. 可视化编排；
3. ExpertNode；
4. RouterNode；
5. MergeNode；
6. HumanReviewNode；
7. Playbook Run；
8. Playbook 发布。

---

### 阶段三：自进化与评测

目标：让专家知识可以持续迭代，但可控发布。

建设内容：

1. 自进化建议；
2. Context PR；
3. 专家评测集；
4. Playbook 评测集；
5. 发布准入；
6. 灰度发布；
7. 回滚。

---

### 阶段四：插件生态与企业治理

目标：形成可扩展、可治理的平台能力。

建设内容：

1. 插件系统；
2. Hook 系统；
3. 多租户；
4. 安全策略；
5. 成本控制；
6. 审计系统；
7. 专家市场；
8. 插件市场。

---

## 25. 总结

多专家 Agent 编排系统的核心价值，是将企业中分散的领域知识、流程经验、代码能力和工具能力，封装成可治理、可复用、可编排的专家 Agent，再通过 Playbook 形成统一服务。

系统的关键设计点包括：

1. 专家 Agent 标准协议；
2. inputSchema / outputSchema；
3. Context 文件夹 Git 化管理；
4. 受控自进化流程；
5. Playbook 低代码专家编排；
6. 专家调度官作为普通专家 Agent；
7. Runtime Agent 可切换；
8. Hook 和插件扩展；
9. 权限、评测、发布、回滚；
10. Trace、上下文快照和审计。

最终形态上，它不是一个简单 Agent 平台，而是一个：

> 可创建专家、可沉淀知识、可编排流程、可持续进化、可企业级治理的专家 Agent 操作系统。
