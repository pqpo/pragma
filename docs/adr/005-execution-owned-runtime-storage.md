# ADR 005: Execution-owned Runtime storage

## Status

Superseded in part by ADR 049.

## Decision

Runtime Session owner 使用判别联合：

- `{ type: "expert-session", ownerId: sessionId, contextId }`
- `{ type: "flow-execution", ownerId: executionId, invocationId }`

`systemSessionId` 在 `state/runtime-sessions/catalog.sqlite` 通过主键约束进行原子 claim。Session
结构化记录位于同一 catalog；Runtime 原生数据位于 `state/runtime-sessions/<ownerId>/<systemSessionId>/`。恢复必须同时校验 owner、
Expert、Runtime、RuntimeSessionRef 与 workspace history。

旧 JSON Session 与 claim 文件仅由 ADR 049 定义的一次性迁移读取，业务代码不保留兼容分支。
