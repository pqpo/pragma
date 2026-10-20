# ADR 006: Runtime Session ownership and leases

## Status

Superseded in part by [ADR 049](049-runtime-session-sqlite-catalog-and-host-storage-binding.md) for storage and
[Context-addressed collaboration](043-context-addressed-expert-collaboration.md) for delegation.

ADR 016 extends this decision with owner-scoped deletion and separates Runtime process state from
storage retention state. ADR 049 replaces the per-Session metadata and ownership-claim file layout.

## Decision

An `ExpertSession` owns reusable Runtime Sessions for its full lifetime. A `FlowExecution` owns its
Runtime Sessions until the Flow reaches a terminal state. `ExecutionController` borrows active
Runtime Sessions only for cancellation, steering, and human interaction.

Runtime reuse is keyed exclusively by a stable identity containing `owner`, `contextId`,
`expertId`, and `runtimeId`. `ContextIdResolver` is the named/versioned selection abstraction for Flow Expert steps. Delegation
uses explicit intent: `spawn_expert` creates a fresh Context and `continue_expert` reuses an
explicit `contextId`; it does not accept a Context policy.

`RuntimeContextRecord` is the sole persisted source for Context identity, lifecycle, and Runtime
snapshot. Invocation and AgentInstance reference only `contextId`; neither stores a snapshot copy.
Once created, a Context cannot change owner, Expert, or Runtime. A fixed string therefore cannot
cross FlowExecution or ExpertSession ownership boundaries.

An ExpertSession creates exactly one root Runtime Context atomically with the Session. Every root
prompt in that Session references the same Context; callers create another ExpertSession when they
need a fresh root conversation. This fixed root binding is not delegation and does not invoke a
`ContextIdResolver`. `CreateExpertSessionOptions.runtime` is only the routing input used to bind the
root Context. After binding, execution reads Runtime identity exclusively from
`RuntimeContextRecord.runtimeId`.

Context provenance is explicit: an ExpertSession root Context has an ExpertSession origin, while
Flow and delegated Contexts have an Invocation origin. Runtime Context snapshots contain only the
system and native Runtime Session references; Expert and Runtime identity remain on the containing
Runtime Context record.

Agent ownership is distinct from Runtime Context identity. `ownerContextId` grants list, wait,
follow-up, and interrupt authority; `createdByInvocationId` records provenance; `agentId` identifies
the FIFO task lane. Concurrent dispatches that resolve to the same Context are atomically folded
into one open AgentInstance.

Execution context is submitted atomically with each Runtime submission. The submission carries the
current Execution, Invocation, delegation, and human-interaction bindings; there is no separate
bind-before-submit protocol.

Each active ExpertSession holds a renewable filesystem lease. Only the lease owner may process its
prompt queue or restore its Runtime Sessions. The lease is renewed while the in-process session is
active, released on close, and may be reclaimed after expiration when a process crashes.

## Consequences

- Multiple prompts in one ExpertSession reuse the same root Context and native Runtime process until the Session closes.
- A second Worker cannot concurrently resume and execute the same ExpertSession.
- Flow default resolution uses `pragma.context.fresh@v1`; delegation follows explicit spawn/continue identity.
- Runtime cleanup failures are reported, and a Session is marked closed only after cleanup succeeds.
- Runtime snapshots are stored only in validated RuntimeContext records, never copied into Invocation or AgentInstance.
