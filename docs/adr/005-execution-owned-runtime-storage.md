# ADR 005: Execution-owned Runtime storage

## Status

Accepted.

## Decision

Runtime Session owner 使用判别联合：

- `{ type: "expert-session", ownerId: sessionId, contextId }`
- `{ type: "flow-execution", ownerId: executionId, invocationId }`

`systemSessionId` 在 `state/runtime-session-owners/` 通过独占创建进行原子 claim。Session
记录位于 `state/runtime-sessions/<ownerId>/<systemSessionId>/`，恢复必须同时校验 owner、
Expert、Runtime、RuntimeSessionRef 与 workspace history。

旧状态格式不读取、不扫描、不迁移。
