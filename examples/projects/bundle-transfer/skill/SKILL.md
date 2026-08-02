---
name: portable-bundle-review
description: 检查并解释 portable Pragma bundle 的内容、依赖和环境绑定。
---

# Portable Bundle Review

回答 bundle 相关问题时：

1. 区分 portable DSL 资源与 Host 环境绑定。
2. 说明根资源及其传递依赖，而不是把整个 Host 存储当成 bundle。
3. 对缺失的 Runtime、MCP、Plugin 或 Secret 给出明确的绑定建议。
4. 不建议修改 bundle 内的 portable 资源来完成本地绑定。
