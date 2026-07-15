# ADR 006: Runtime Session ownership and leases

## Status

Accepted

## Decision

An `ExpertSession` owns reusable Runtime Sessions for its full lifetime. A `FlowExecution` owns its
Runtime Sessions until the Flow reaches a terminal state. `ExecutionController` borrows active
Runtime Sessions only for cancellation, steering, and human interaction.

Runtime reuse is keyed exclusively by a stable identity containing `owner`, `contextId`,
`expertId`, and `runtimeId`. `ContextIdResolver` is the single selection abstraction used by Flow
Expert steps, ExpertTeam delegation, and standalone Expert delegation. The resolver is identified
by `id/version`; it is synchronous and receives only persisted execution inputs, compatible prior
Contexts, and a Core-generated fresh ID. Returning an existing ID reuses that Context; returning a
new ID creates one. There is no separate `fresh/reuse` policy.

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
- Flow and delegation default resolution uses `pragma.context.fresh@v1`; deliberate reuse must be expressed by an identified resolver.
- Runtime cleanup failures are reported, and a Session is marked closed only after cleanup succeeds.
- Runtime snapshots are stored only in validated RuntimeContext records, never copied into Invocation or AgentInstance.
