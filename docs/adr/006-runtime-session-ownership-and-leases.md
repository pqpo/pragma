# ADR 006: Runtime Session ownership and leases

## Status

Accepted

## Decision

An `ExpertSession` owns reusable Runtime Sessions for its full lifetime. A `FlowExecution` owns its
Runtime Sessions until the Flow reaches a terminal state. `ExecutionController` borrows active
Runtime Sessions only for cancellation, steering, and human interaction.

Runtime reuse is keyed by a stable context identity containing `contextId`, `expertId`, and
`runtimeId`. A reusable context cannot change Expert or Runtime; callers must request a fresh
context instead.

Team context policies define resource lifetime:

- `reuse` is ExpertSession-scoped and remains available across prompts.
- `fresh` is Invocation-subtree-scoped, stores its recovery snapshot on the Invocation, and closes
  when that delegated subtree reaches a terminal state. Fresh contexts are not added to the
  ExpertSession reusable-context map.

Execution context is submitted atomically with each Runtime submission. The submission carries the
current Execution, Invocation, delegation, and human-interaction bindings; there is no separate
bind-before-submit protocol.

Each active ExpertSession holds a renewable filesystem lease. Only the lease owner may process its
prompt queue or restore its Runtime Sessions. The lease is renewed while the in-process session is
active, released on close, and may be reclaimed after expiration when a process crashes.

## Consequences

- Multiple prompts in one ExpertSession reuse the same native Runtime process and isolated MCP Gateway registration.
- A second Worker cannot concurrently resume and execute the same ExpertSession.
- Fresh delegation cannot accumulate Runtime processes for the entire conversation.
- Runtime cleanup failures are reported, and a Session is marked closed only after cleanup succeeds.
- Runtime and Invocation snapshots use validated schemas instead of hidden Flow state fields.
