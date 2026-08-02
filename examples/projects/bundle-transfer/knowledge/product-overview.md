---
description: Pragma portable bundle 的产品知识。
trigger: always_on
priority: high
trustLevel: workspace
sensitivity: internal
---

# Pragma Bundle

`.pragma` 是跨 Host 的 portable bundle。Interpreter 负责统一格式、校验、依赖闭包、加载和编译；
Host 负责持久化、资源选择、权限确认和本地资产安装。

同一个 `pragma.bundle/v1` 在 Desktop、Server 和第三方 Agent Host 中具有相同语义。
环境绑定通过 immutable overlay 应用，不改写 bundle 中的 portable DSL。
