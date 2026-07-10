# 专家 Agent 标准协议详细设计

## 1. 目标

专家 Agent 标准协议用于把单个专家能力声明成可发现、可校验、可编排、可审计、可版本化的能力单元。

该协议首先解决以下问题：

1. Playbook 可以稳定识别和调用专家 Agent；
2. 调度官可以基于结构化能力描述选择专家；
3. Runtime 可以根据协议准备输入、上下文、MCP、Skills、AGENTS.md 和 workspace；
4. 发布系统可以校验专家配置是否完整、安全、可回滚；
5. 后续可以从协议直接生成管理页面、调用表单、评测用例和运行审计记录。

本文只定义协议和边界，不实现运行时、数据库、MCP、Skills 或 Desktop 本地桥接。

## 2. 设计原则

### 2.1 Manifest 是专家能力的唯一入口

每个专家 Agent 必须有一个 Expert Manifest。Manifest 是专家 Agent 的标准声明文件，描述专家身份、能力边界、输入输出协议、上下文加载策略和运行依赖。

Manifest 不直接存放大段知识正文。长期知识应放在用户自定义上下文路径中，并通过渐进式加载策略引用。

### 2.2 协议优先于自然语言

展示名称、描述、tags 和能力说明用于理解和检索；`inputSchema` 与 `outputSchema` 用于真正的运行前校验、编排连接和输出验收。

Playbook 调用专家时，必须先根据 `inputSchema` 校验输入；专家返回结果后，必须根据 `outputSchema` 校验输出。

### 2.3 配置只声明能力，不授予最终权限

Manifest 可以声明专家希望使用的 MCP、Skills、AGENTS.md、context 和 workspace。实际运行时仍需要经过租户策略、用户权限、Playbook 权限、Runtime 权限和本地 Desktop 权限闸门共同裁决。

### 2.4 上下文渐进式加载

专家上下文不应一次性注入 Runtime。Manifest 只声明上下文源、索引方式、初始加载入口和懒加载规则。运行时根据任务、schema、上下文预算和权限逐步加载。

### 2.5 Workspace 明确收敛

专家 Agent 只能在声明且被授权的 workspace scope 内读取、写入或生成 artifact。workspace 既可以是云端沙箱目录，也可以是未来 Desktop App 选择的本地目录映射。

## 3. 协议文件

建议 Manifest 文件命名为：

```text
expert.manifest.yaml
```

也可以支持 JSON 形式：

```text
expert.manifest.json
```

协议版本由 `schemaVersion` 表示。专家自身版本由 `version` 表示。

```yaml
schemaVersion: pragma.expert/v1
id: com.examplemesh.order.domain-expert
displayName: 订单业务专家
description: 负责订单领域的业务规则、流程、异常场景和历史决策分析
version: 1.3.0
tags:
  - order
  - business
  - domain-expert
```

## 4. 顶层结构

```yaml
schemaVersion: pragma.expert/v1
id: com.examplemesh.order.domain-expert
displayName: 订单业务专家
description: 负责订单领域的业务规则、流程、异常场景和历史决策分析
version: 1.3.0
tags:
  - order
  - business
  - domain-expert

capability:
  summary: 订单领域需求、规则、状态机和影响面分析
  scopes:
    - id: order-state-machine
      name: 订单状态机分析
      description: 解释订单状态流转、异常状态和业务约束
    - id: requirement-impact
      name: 需求影响面分析
      description: 分析订单相关需求对业务流程、接口和数据的影响
  limitations:
    - 不直接修改代码
    - 不做最终发布审批

inputSchema:
  type: object
  additionalProperties: false
  properties:
    task:
      type: string
      minLength: 1
      description: 当前需要专家处理的问题
    businessContext:
      type: string
      description: 需求背景或业务上下文
    relatedFiles:
      type: array
      items:
        type: string
      description: 相关代码文件或上下文路径
  required:
    - task

outputSchema:
  type: object
  additionalProperties: false
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
      description: 引用的上下文或代码路径
  required:
    - conclusion

mcp:
  servers:
    - id: doc-search
      displayName: 上下文检索
      transport: stdio
      packageRef: "@company/doc-search-mcp"
      enabledByDefault: true
      allowedTools:
        - searchContext
        - readContext
      config:
        index: order-docs
    - id: code-search
      displayName: 代码检索
      transport: http
      endpointRef: secret://mcp/code-search/url
      enabledByDefault: false
      allowedTools:
        - searchCode
        - readFile

skills:
  entries:
    - id: business-impact-analysis
      displayName: 业务影响面分析
      source: registry
      ref: skill://company/business-impact-analysis@1.2.0
      enabledByDefault: true
    - id: order-state-machine-analysis
      displayName: 订单状态机分析
      source: context
      ref: docs://order/rules/state-machine.md
      enabledByDefault: true

context:
  roots:
    - namespace: host
      path: context/order-domain-expert
      load:
        preloadPaths:
          - context/order-domain-expert/profile.md
          - context/order-domain-expert/safety.md
        forbiddenLoad:
          - context/order-domain-expert/archive/**
        priorityRules:
          - pattern: context/order-domain-expert/safety.md
            priority: critical

workspace:
  mode: cloud-sandbox
  roots:
    - id: task-workspace
      path: ./workspace
      access: readwrite
      purpose: 当前任务临时工作目录
    - id: source-repo
      path: ./repositories/order-service
      access: read
      purpose: 订单服务代码仓库
  defaultRoot: task-workspace
  artifactPath: ./workspace/artifacts
```

## 5. 字段定义

### 5.1 `schemaVersion`

Manifest 协议版本。

规则：

- 必填；
- 当前建议值为 `pragma.expert/v1`；
- 只表示协议结构版本，不表示专家能力版本；
- 破坏性协议变更必须提升协议版本。

### 5.2 `id`

专家 Agent 的全局唯一名称 ID。

规则：

- 必填；
- 全局唯一；
- 发布后不可复用给另一个专家；
- 建议使用反向域名 + 领域 + 专家类型格式；
- 只能包含小写字母、数字、点号和短横线；
- 不包含版本号，不包含展示名称。

推荐格式：

```text
{reverseDns}.{domain}.{expertType}
```

示例：

```text
com.examplemesh.order.domain-expert
com.examplemesh.frontend.code-reviewer
com.examplemesh.requirement.dispatcher
```

ID 的唯一性由专家注册中心保证。Manifest 本地校验只能检查格式，不能单独保证全局唯一。

### 5.3 `displayName`

专家展示名称。

规则：

- 必填；
- 面向用户、调度官和管理后台展示；
- 可以使用中文；
- 可以随版本调整；
- 不参与唯一性判断。

### 5.4 `description`

专家描述。

规则：

- 必填；
- 描述专家负责什么、不负责什么、典型输入和典型输出；
- 调度官可以将它作为专家选择的语义信号；
- 不替代 `capability.scopes` 和 schema。

### 5.5 `tags`

专家标签。

规则：

- 必填，允许为空数组；
- 用于搜索、筛选、Playbook 推荐和权限分组；
- tag 使用小写短横线命名；
- tag 不表达权限，只表达分类。

示例：

```yaml
tags:
  - order
  - business
  - impact-analysis
```

### 5.6 `version`

专家能力版本。

规则：

- 必填；
- 使用 SemVer；
- 同一个 `id` 可以发布多个 `version`；
- Playbook 应绑定明确版本或版本范围；
- 运行审计必须记录实际使用的专家版本。

建议：

- patch：上下文修正、提示词细化、非破坏性评测补充；
- minor：新增兼容能力、新增可选输入或输出字段；
- major：input/output schema 破坏性变更、能力范围显著变化。

### 5.7 `capability`

能力范围声明。

`capability.summary` 用一句话说明专家核心能力。`capability.scopes` 用结构化列表声明可被调度的能力单元。`capability.limitations` 明确专家不应该做的事。

规则：

- 必填；
- `scopes[].id` 在当前专家内唯一；
- 调度官可以按 scope 选择专家；
- scope 不等于权限，具体工具和文件访问仍由后续配置控制。

### 5.8 `inputSchema`

专家输入协议。

规则：

- 必填；
- 使用 JSON Schema 子集；
- 顶层必须是 object；
- 必须显式声明 `required`；
- 推荐 `additionalProperties: false`；
- 运行前必须校验；
- TypeScript 类型应由 schema 推导，不手写重复 interface。

建议保留通用输入字段：

| 字段               | 说明               |
| ------------------ | ------------------ |
| `task`             | 当前任务，通常必填 |
| `businessContext`  | 业务背景           |
| `technicalContext` | 技术背景           |
| `constraints`      | 约束条件           |
| `relatedFiles`     | 相关文件路径       |
| `upstreamOutputs`  | 上游专家输出       |

### 5.9 `outputSchema`

专家输出协议。

规则：

- 必填；
- 使用 JSON Schema 子集；
- 顶层必须是 object；
- 必须显式声明 `required`；
- 推荐 `additionalProperties: false`；
- 运行后必须校验；
- 调度官、Playbook 和产物生成器只能依赖 schema 中声明的字段。

建议保留通用输出字段：

| 字段         | 说明           |
| ------------ | -------------- |
| `conclusion` | 专家结论       |
| `confidence` | 置信度         |
| `risks`      | 风险点         |
| `questions`  | 需要澄清的问题 |
| `actions`    | 建议动作       |
| `references` | 引用来源       |

## 6. MCP 配置对象

`mcp` 声明专家可请求使用的 MCP Server 和工具集合。

```yaml
mcp:
  servers:
    - id: doc-search
      displayName: 上下文检索
      transport: stdio
      packageRef: "@company/doc-search-mcp"
      enabledByDefault: true
      allowedTools:
        - searchContext
        - readContext
      config:
        index: order-docs
```

字段规则：

| 字段                    | 必填 | 说明                                            |
| ----------------------- | ---- | ----------------------------------------------- |
| `servers[].id`          | 是   | 当前专家内唯一的 MCP Server ID                  |
| `servers[].displayName` | 是   | 展示名称                                        |
| `servers[].transport`   | 是   | `stdio`、`http`、`websocket` 或后续扩展值       |
| `packageRef`            | 否   | stdio 类 MCP 的包引用                           |
| `endpointRef`           | 否   | 远程 MCP 的端点引用，敏感值必须使用 secret 引用 |
| `enabledByDefault`      | 是   | 默认是否启用                                    |
| `allowedTools`          | 是   | 专家可使用的工具白名单                          |
| `config`                | 否   | 非敏感配置                                      |

安全约束：

- Manifest 不直接写入明文 token；
- 远程地址、token、租户凭证使用 `secret://`、`env://` 或平台托管引用；
- `allowedTools` 必须是白名单，不允许默认全部工具；
- Runtime 启动 MCP 前必须再次经过权限策略裁决；
- MCP tool call 必须进入运行 Trace。

## 7. Skills 配置对象

`skills` 声明专家可以加载的技能。Skill 是可复用的能力说明、流程模板、提示词、脚本或工具使用规范。

```yaml
skills:
  entries:
    - id: business-impact-analysis
      displayName: 业务影响面分析
      source: registry
      ref: skill://company/business-impact-analysis@1.2.0
      enabledByDefault: true
    - id: order-state-machine-analysis
      displayName: 订单状态机分析
      source: context
      ref: docs://order/rules/state-machine.md
      enabledByDefault: true
```

字段规则：

| 字段                         | 必填 | 说明                                           |
| ---------------------------- | ---- | ---------------------------------------------- |
| `entries[].id`               | 是   | 当前专家内唯一的 Skill ID                      |
| `entries[].displayName`      | 是   | 展示名称                                       |
| `entries[].source`           | 是   | `registry`、`context`、`workspace` 或 `inline` |
| `entries[].ref`              | 是   | Skill 引用地址                                 |
| `entries[].enabledByDefault` | 是   | 默认是否加载                                   |
| `entries[].loadWhen`         | 否   | 按任务条件延迟加载的规则                       |

约束：

- Skill 不应绕过 `inputSchema` 和 `outputSchema`；
- Skill 只能扩展专家行为，不能扩大权限；
- Skill 内容需要纳入版本和审计；
- 来自上下文系统的 Skill 应遵守 context 的权限和加载规则。

## 8. AGENTS.md 上下文约定

`AGENTS.md` 不作为独立 Manifest 字段，也不在 Core 中按 ID 特判。它和其他 context 使用相同的 trigger、root preload 和 priority 规则：

- Context ID 是 Store 内的 opaque string，不要求扩展名；
- 需要常驻加载时，由 metadata `trigger: always_on` 或 root `preloadPaths` 显式声明；
- 需要靠前装配并在预算收缩时最后截断时，声明 `priority: critical` 或使用 root `priorityRules`；
- 上下文工具通过标准 `readContext` / `editContext` 访问，权限由 Store 裁决。

加载顺序：

1. 平台系统约束；
2. 租户或组织级指令；
3. 配置为 critical preload 的工程上下文（可以是 `AGENTS.md`）；
4. 其他 `always_on` 上下文；
5. 当前任务临时约束。

冲突规则：

- 越靠前的系统和平台安全约束优先级越高；
- 工程上下文可以补充更具体的工程规范，但不能放宽前序安全规则、权限规则或 schema 规则；
- 实际加载、截断或省略的上下文必须进入运行快照。

## 9. 上下文路径与渐进式加载

`context` 声明用户自定义上下文源。它是专家长期知识的入口，不是运行时一次性 prompt。

```yaml
context:
  roots:
    - id: order-docs
      displayName: 订单专家上下文
      uri: docs://order-domain-expert
      path: ./context/order-domain-expert
      access: read
      index:
        strategy: hybrid
      load:
        preloadPaths:
          - ./context/order-domain-expert/profile.md
          - ./context/order-domain-expert/safety.md
        forbiddenLoad:
          - ./context/order-domain-expert/archive/**
```

字段规则：

| 字段                         | 必填 | 说明                                     |
| ---------------------------- | ---- | ---------------------------------------- |
| `roots[].namespace`          | 否   | Store namespace，默认 `host`             |
| `roots[].path`               | 否   | namespace 内的 Context ID 前缀           |
| `roots[].load.preloadPaths`  | 否   | 每次运行预加载的 ID 或 pattern           |
| `roots[].load.forbiddenLoad` | 否   | 不参与默认装配的 ID 或 pattern           |
| `roots[].load.priorityRules` | 否   | 通用 critical/high/normal/low 路径优先级 |

渐进式加载流程：

```text
读取 Manifest
→ 校验任务输入
→ 加载专家身份、能力范围、schema 和配置为 preload 的工程上下文
→ 加载 context.preloadPaths 中的短上下文
→ 根据任务检索 summary/index
→ 加载相关片段
→ 必要时由 Runtime 申请读取原文
→ 记录 Context Snapshot
```

当前上下文元信息：

```yaml
description: 订单状态机规则
trigger: model_decision
trustLevel: workspace
sensitivity: internal
priority: high
```

约束：

- Context ID 是 Store 内的 opaque string；文件 Store 负责 include/exclude 和 canonical root 边界；
- `forbiddenLoad` 优先级高于 `preloadPaths`；
- Agent 自进化只能写入被授权的上下文路径；
- 发布版本应锁定上下文源版本、commit 或快照 ID；
- 运行审计必须记录实际加载的上下文列表和摘要。

## 10. Workspace 目录

`workspace` 声明专家运行时可见的工作目录。

```yaml
workspace:
  mode: cloud-sandbox
  roots:
    - id: task-workspace
      path: ./workspace
      access: readwrite
      purpose: 当前任务临时工作目录
    - id: source-repo
      path: ./repositories/order-service
      access: read
      purpose: 订单服务代码仓库
  defaultRoot: task-workspace
  artifactPath: ./workspace/artifacts
```

字段规则：

| 字段              | 必填 | 说明                                           |
| ----------------- | ---- | ---------------------------------------------- |
| `mode`            | 是   | `cloud-sandbox`、`desktop-local` 或 `readonly` |
| `roots[].id`      | 是   | 当前专家内唯一的 workspace root ID             |
| `roots[].path`    | 是   | 相对路径或平台映射路径                         |
| `roots[].access`  | 是   | `read`、`readwrite`、`write-artifacts`         |
| `roots[].purpose` | 是   | 为什么需要这个目录                             |
| `defaultRoot`     | 是   | 默认工作目录 ID                                |
| `artifactPath`    | 否   | 运行产物输出目录                               |

约束：

- 所有相对路径必须解析到声明的 workspace root 内；
- `readwrite` 不代表自动允许任意写入，仍需运行权限裁决；
- `desktop-local` 模式必须经过 Desktop App workspace scope 授权；
- Artifact 输出必须记录路径、类型、大小、hash 和来源 run id；
- Playbook 调用多个专家时，每个专家应获得隔离的临时 workspace，除非显式共享。

## 11. 最小 JSON Schema 草案

后续进入实现阶段时，建议在 `packages/shared` 中定义 Zod schema，并从 Zod 推导 TypeScript 类型。这里先给出字段形状，作为协议实现参考。

```ts
type ExpertManifest = {
  schemaVersion: "pragma.expert/v1";
  id: string;
  displayName: string;
  description: string;
  version: string;
  tags: string[];
  capability: ExpertCapability;
  inputSchema: JsonObjectSchema;
  outputSchema: JsonObjectSchema;
  mcp?: ExpertMcpConfig;
  skills?: ExpertSkillsConfig;
  context?: ExpertContextConfig;
  workspace?: ExpertWorkspaceConfig;
};
```

实现要求：

- `inputSchema` 和 `outputSchema` 使用 JSON Schema 对象；
- Manifest 自身 schema 使用 Zod 定义；
- DTO 类型从 Zod 推导；
- 协议类型放在 `@pragma/shared`；
- Runtime 执行抽象放在 `@pragma/core`；
- 不在 shared contracts 中引入 Node、Fastify、React 或具体 MCP SDK。

## 12. 校验规则

发布前必须校验：

1. `schemaVersion` 支持；
2. `id` 格式合法且全局唯一；
3. `version` 为合法 SemVer；
4. `displayName`、`description`、`capability.summary` 不为空；
5. `capability.scopes[].id` 当前专家内唯一；
6. `inputSchema` 与 `outputSchema` 是合法 object schema；
7. MCP、Skill、context、workspace 的 ID 在各自作用域内唯一；
8. 所有相对路径不能逃逸声明根目录；
9. secret 不以明文出现在 Manifest；
10. 所有 preload 和 priority rule 必须指向合法的 Store Context ID 或 pattern；
11. `workspace.defaultRoot` 指向已声明 root；
12. `context.forbiddenLoad` 不被默认加载规则覆盖。

运行前必须校验：

1. 输入满足 `inputSchema`；
2. 调用方有权使用该专家版本；
3. Playbook 有权启用声明的 MCP 和 Skills；
4. Runtime 有可用 workspace；
5. 上下文加载结果生成 Context Snapshot。

运行后必须校验：

1. 输出满足 `outputSchema`；
2. 所有 tool call、上下文加载、workspace 写入都有 Trace；
3. artifact 位于授权输出目录；
4. schema 校验失败时返回结构化错误，而不是自然语言成功结果。

## 13. 与 Playbook 的关系

Playbook 不应该复制专家内部配置。Playbook 只引用专家：

```yaml
experts:
  - id: com.examplemesh.order.domain-expert
    version: 1.3.0
    alias: orderExpert
    enabledScopes:
      - order-state-machine
      - requirement-impact
```

Playbook 可以收窄专家能力，例如禁用某个 MCP、只允许 read-only workspace 或只启用部分 scopes。Playbook 不应放宽专家 Manifest 中声明的限制。

## 14. 与 Runtime 的关系

Runtime Adapter 根据 Manifest 准备执行环境：

1. 选择 Runtime；
2. 创建 workspace；
3. 加载 context，并按通用 preload 和 priority 规则装配；
4. 加载必要上下文；
5. 注册允许的 MCP；
6. 加载 Skills；
7. 校验 input；
8. 执行专家；
9. 校验 output；
10. 生成 Trace 和 Context Snapshot。

Manifest 不绑定具体 Claude、Codex 或自研 Agent SDK。具体 Runtime 能力应由后续 `RuntimeAdapter` 协议声明。

## 15. 流式输出协议

专家 Agent 的运行结果仍然以 `IExpertAgentRunResult` 作为最终验收对象；流式输出用于 UI 实时展示、Trace 记录、运行审计、取消反馈和 subAgent 过程桥接。流式输出不替代最终 `outputSchema` 校验。

统一事件对象定义在 `@pragma/shared` 的 `ExpertAgentStreamEventSchema`，协议版本为：

```text
pragma.stream/v1
```

事件公共字段：

| 字段            | 含义                                        |
| --------------- | ------------------------------------------- |
| `schemaVersion` | 流式事件协议版本，当前为 `pragma.stream/v1` |
| `eventId`       | 事件唯一 ID，用于幂等写入和客户端去重       |
| `sequence`      | 同一个 `runId` 内单调递增的序号             |
| `runId`         | 当前事件所属运行                            |
| `parentRunId`   | 可选；嵌套运行或工具事件指向父运行          |
| `emittedAt`     | Runtime 产生事件的 ISO 时间                 |
| `source`        | 事件来源，包括 agent、runtime 或 tool       |
| `type`          | 事件类型                                    |
| `payload`       | 事件负载，由 `type` 决定                    |

首批标准事件类型：

```text
run.started
run.completed
run.failed
run.cancelled
message.delta
message.completed
thought.delta
progress
tool.started
tool.delta
tool.approval_requested
tool.completed
tool.failed
artifact.created
```

设计规则：

1. `message.delta` 只表达增量片段，客户端按 `runId + sequence` 追加；
2. `message.completed` 表示该消息已经结束，可以带完整 `text` 供校验或补偿；
3. `run.completed` 只表示 Runtime 执行完成，不代表业务输出已经通过 `outputSchema`；
4. `run.failed` 表示 Runtime 或 Adapter 执行失败，应保留可读 `message`；
5. `run.cancelled` 表示用户或系统主动取消，不与失败混用；
6. `tool.delta` 是工具执行过程输出，Agent 委派工具输出也通过该事件表达；
7. Agent 委派使用普通工具事件，不定义独立的子 Agent 事件族；
8. 事件负载只放展示、审计、路由需要的摘要，不把大 artifact 或完整文件内容塞进事件。

### 15.1 Runtime Adapter 接入方式

`adapter.createSession()` 在创建会话时绑定 agent 和 run context；会话创建后可多次
`submit()`，提交会在 Runtime 内部串行执行。`RuntimeSubmitRequest` 可以携带
可选 `runId`，并可为单次提交指定 Zod output schema；未指定 `runId` 时在
`submit()` 阶段生成，未指定 output 时默认为 string。

Session 标识分为三层：

- `systemSessionId` 是 Pragma 系统级会话标识，用于系统任务关联、审计和跨 runtime
  追踪；`createSession()` 未传入时由系统自动生成。
- `runtimeSession` 是 runtime 返回的会话引用，结构为 `{ type, id }`；Adapter 只在
  `type` 与当前 runtime 匹配时复用该会话，否则必须新建 runtime session。
- `runId` 是单次提交的运行标识，仍由 `submit()` 阶段生成或使用调用方传入值。

```ts
import { z } from "zod";

const session = await adapter.createSession({
  agent,
  context,
  systemSessionId: "system-session-1",
  runtimeSession: {
    type: "cloud-pi-agent",
    id: "runtime-session-1",
  },
});

const sessionInfo = session.info();

const run = session.submit({
  query: "Summarize the current workspace status.",
  output: z.object({
    summary: z.string(),
    confidence: z.number(),
  }),
});

for await (const event of run.events) {
  // Server/Worker 可写入 Trace、推送 SSE/WebSocket 或转发给 Desktop Bridge。
}

const result = await run.result;
```

Adapter 必须遵守：

1. `submit()` 必须立即返回 `{ runId, events, result, cancel }`；
2. `events` 必须是 `AsyncIterable<ExpertAgentStreamEvent>`，可用 `for await` 消费；
3. `result` 必须返回最终结构化结果，流式事件不替代 output schema 校验；
4. Runtime 原生事件必须先映射成 `ExpertAgentStreamEvent`，再向外暴露；
5. 不把具体 SDK 的事件结构泄漏给上层。

### 15.2 Agent 委派流式桥接

Agent 委派不定义独立事件族。父运行调用 `launch_agent` 时，Runtime 应将它视为普通工具调用；child Agent 的 workflow run 由编排层创建，并通过 `parentWorkflowRunId` / `parentTaskRunId` 关联到父运行：

```json
{
  "type": "tool.started",
  "runId": "parent-run",
  "source": {
    "kind": "tool",
    "runId": "parent-run",
    "toolCallId": "tool-call-1"
  },
  "payload": {
    "toolCallId": "tool-call-1",
    "toolName": "launch_agent",
    "kind": "tool",
    "inputPreview": {
      "agentId": "reviewer-agent",
      "task": "Review this change"
    }
  }
}
```

`launch_agent` 的过程输出使用 `tool.delta`，最终成功或失败使用 `tool.completed` /
`tool.failed`。child run 的状态、任务、失败和取消由同一个 Workflow / StateManager
协议管理，客户端可以通过递归 run tree 或 watch API 查询。

### 15.3 传输边界

事件协议不规定传输层。Server 可以把事件写入数据库 Trace、通过 SSE 或 WebSocket 推给 Web；未来 Desktop 本地桥接可以通过双向安全通道转发同一事件对象。传输层只负责可靠性、背压、鉴权和重放，不改变事件语义。

## 16. 示例：最小专家

```yaml
schemaVersion: pragma.expert/v1
id: com.examplemesh.requirement.summary-expert
displayName: 需求总结专家
description: 将上游专家意见整理成结构化需求分析摘要
version: 0.1.0
tags:
  - requirement
  - summary

capability:
  summary: 汇总需求讨论结论、风险和待澄清问题
  scopes:
    - id: summarize-requirement
      name: 需求总结
      description: 汇总多专家输出并生成结构化摘要
  limitations:
    - 不直接做技术方案决策

inputSchema:
  type: object
  additionalProperties: false
  properties:
    task:
      type: string
    upstreamOutputs:
      type: array
      items:
        type: object
  required:
    - task
    - upstreamOutputs

outputSchema:
  type: object
  additionalProperties: false
  properties:
    conclusion:
      type: string
    openQuestions:
      type: array
      items:
        type: string
    references:
      type: array
      items:
        type: string
  required:
    - conclusion
```

## 17. 后续实施建议

1. 在 `@pragma/shared` 增加 `ExpertManifestSchema`；
2. 在 `@pragma/core` 定义 `ExpertAgent`、`ExpertInvocation`、`ExpertResult`、`RuntimeAdapter`；
3. 增加 Manifest fixture 和 schema 单元测试；
4. 增加非法路径、非法 secret、非法 schema 的测试；
5. 再设计 Playbook 对专家 Manifest 的引用协议；
6. 最后再进入 Runtime、MCP、Skills、Context Store 和 Desktop 本地桥接实现。
