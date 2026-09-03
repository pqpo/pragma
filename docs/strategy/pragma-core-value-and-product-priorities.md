# Pragma 核心价值

## 一句话定位

> Pragma 将成熟的 AI 使用经验沉淀为可运行、可复用、可验证、可分享的 Agent Team。

Pragma 的复用单位不是一段 Prompt，也不是绑定某个供应商的聊天 Session，而是一套完整的 AI-native
工作方式：它包含 Expert、ExpertTeam、Flow、Runtime 与模型选择、工具、Context、Memory、权限、人工
检查点、Evaluation 和交付物定义。

## 为什么是 Agent Team

同一种模型放在 Coding Agent、Browser Agent 或领域工具中，会获得不同的规划、工具调用、上下文处理和
Session 能力。复杂任务通常也需要需求分析、实现、验证、审查和交付等不同角色。Pragma 将这些能力放入
统一的 Mission 与 Execution 中，使每个步骤都能选择合适的 Expert、Harness 和模型，同时保留稳定的
上下文、产物和运行记录。

```text
Agent Team
├── Expert / ExpertTeam / Flow
├── Runtime × Model bindings
├── Skills / Tools / Capability
├── Context / Mission Board / Memory
├── Permissions / HumanTask
├── Evaluation
└── Inputs / outputs / delivery contract
```

## 四类可积累资产

### 工作方式

Pragma YAML DSL 将 Expert、Team、Flow 和依赖关系保存为可解析、可校验、可编译的资源。不可变 Project
Revision、环境 fingerprint 和 `.pragma` bundle 让同一工作方式可以被版本化、迁移和交付。

### 私有知识

ContextStore 提供 Host-owned 的上下文边界。不同 Runtime 的事件进入统一 Evidence Feed，并由 Memory
Module 生成 Episodic 与 Semantic 资产。经过候选、审阅和 revision 激活的内容可进入 Knowledge Store 或
Skill，形成可治理的长期积累。

### 私有评测集

Evaluation 保存真实任务、输入和判定标准，用于比较 Prompt、Flow、Runtime、模型、Context 或 Capability
revision。评测关注完整交付结果，而不是只比较单轮回答。

### 可恢复运行记录

Mission、Execution、Invocation、Canonical Event、Runtime Session 与 Usage 使用统一身份和持久语义。
任务可以被观察、取消、恢复和审计，多个 Harness 的输出也能在同一运行视图中解释。

## 面向创作者与使用者

Pragma 同时服务两类角色：

| 角色 | 主要动作 | 获得的价值 |
| --- | --- | --- |
| 创作者 | 设计、验证、发布和迭代 Agent Team | 将个人方法与领域经验产品化 |
| 使用者 | 发现、安装并运行 Agent Team | 直接使用成熟的 AI 工作方式 |

创作者可以深入配置 Runtime、模型、工具、Context、权限和 Evaluation；使用者以目标、输入、权限确认和
交付物为中心完成 Mission。相同的底层资源既支持深度定制，也支持直接运行。

## 产品原则

1. **Harness 中立。** 工作方式依赖能力与协议，不绑定单一模型或 Agent 产品。
2. **执行环境可替换。** Runtime binding 与可移植 DSL 分离，Host 负责把语义需求绑定到实际环境。
3. **组合保持治理。** Expert、Team、Flow 与 HumanTask 共用 Execution / Invocation、Context、Usage 和
   恢复边界。
4. **资产默认私有。** Context、Memory、Evaluation 和执行数据由其 owner 管理，分享需要显式动作。
5. **变更可验证。** 不可变 revision、Evaluation、环境 fingerprint 和事件记录共同说明“运行了什么”。
6. **人保持控制。** 权限、人工检查点、Knowledge/Skill 激活与敏感操作由 Host policy 管理。
7. **协议可演进。** DSL、bundle 和持久状态使用权威版本能力、相邻迁移、备份与恢复机制。

## 使用形态

- Desktop 提供可视化 Studio、Mission、Context、Memory、Capability 与 Evaluation 管理；
- CLI 通过 `@pqpo/pragma` 为终端、脚本和其他 Agent 提供本机 Host 能力；
- SDK 通过 `@pragma/interpreter` 与 `@pragma/core` 嵌入应用；
- Runtime Adapter 将 Codex、Claude Code、PI、Qoder CLI、Antigravity 等 Harness 接入同一执行模型；
- `.pragma` bundle 与 Git bundle source 承载可移植资源和分发。

## 价值判断

Pragma 的价值由工作方式能否稳定复用来衡量，重点包括：

- Agent Team 的首次运行与重复运行质量；
- 交付物是否满足 Evaluation 定义的标准；
- Context、Memory 与 Skill 是否持续提升后续任务；
- Runtime 或模型替换后，工作方式是否保持可解释和可验证；
- 中断后的恢复、人工介入和最终交付是否处于同一治理链；
- 创作者的经验是否能被其他使用者直接采用并继续迭代。

## 相关文档

- [定位与差异化](./pragma-positioning-and-competitive-differentiation.md)
- [当前架构概览](../architecture/current-architecture-overview.md)
- [技术实践系列](../articles/README.md)
- [ADR 索引](../adr/README.md)
