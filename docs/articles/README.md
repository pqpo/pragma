# 构建跨 Harness 的多 Agent 系统：Pragma 技术实践

这个系列讨论 Pragma 在构建多 Agent 系统过程中遇到的六个核心问题。它不从 Prompt 技巧出发，而是从一个长期运行的 Agent 系统需要具备的工程能力出发：执行环境如何替换，上下文如何组织，多个专家如何协作，经验如何积累，复杂任务如何组合，以及整套工作方式如何成为可以版本化和分享的资产。

## 文章目录

1. [模型不是 Agent：如何构建跨 Harness 的统一 Runtime 层](./01-runtime-across-agent-harnesses.md)
2. [上下文工程不只是拼 Prompt：Pragma ContextSystem 的设计](./02-context-system.md)
3. [专家团如何共享上下文：Mission Board 的白板协作模型](./03-mission-board.md)
4. [让经验跨 Harness 流动：从执行事件到长期记忆的沉淀与提炼](./04-cross-harness-memory.md)
5. [统一 Expert、ExpertTeam 与 Flow：如何组合复杂的 Agent 系统](./05-unified-execution-model.md)
6. [当 YAML 成为一门语言：Pragma DSL 与编译器的设计](./06-pragma-dsl-compiler.md)

## 阅读路径

六篇文章依次回答以下问题：

```text
Runtime       Agent 在哪里执行？
Context       Agent 带着什么信息执行？
Mission Board 多个 Agent 如何共享任务状态？
Memory        一次次执行如何沉淀为长期经验？
Execution     Expert、团队和流程如何组合成一个系统？
DSL           这套工作方式如何被验证、版本化和分享？
```

这些能力最终形成同一条技术主线：模型和 Agent Harness 可以变化，但经过验证的工作方式、知识和评估资产应当能够持续积累。

> 说明：Pragma 当前仍处于 Preview 阶段。文章描述的是仓库现有实现及其架构取舍；尚未闭合的统一本地权限闸门和云端控制面会明确标注为后续工作。
