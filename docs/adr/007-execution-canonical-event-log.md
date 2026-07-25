# ADR 007: Execution Canonical Event Log

## Status

Accepted.

ADR 016 retains this canonical log while an Execution is active, then gzip-archives it after a
Mission projection has been committed. The archive is bounded diagnostic history rather than the
permanent Mission chat source.

## Decision

Each Execution owns one canonical, append-only event log. `{ executionId, sequence }` is the only
durable replay cursor and `sequence` is strictly monotonic within that Execution.

Concrete Runtimes continue to normalize native output into `ExpertAgentStreamEvent`. Core publishes
token, thinking, and tool deltas as `ExecutionOutputItem` values. These high-volume live deltas are
not durable and do not receive an Execution cursor. While an Execution is active, its in-process
live bus retains output long enough to replay it to late subscribers; the buffer is discarded when
the Execution completes and is not a recovery source.

Runtime-native child agents retain their native session identity in normalized event sources through
`sessionId` and `parentSessionId`. A child's separate turns use separate `runId` values while sharing
one `sessionId`. Lifecycle operations such as spawn, wait, list, send, resume, and interrupt are
normalized as `agent.command` events. Projections therefore group work by session without inferring
agent behavior from tool names or merging child output into its parent Invocation.

Core persists completed normalized `AgentMessage` values as `invocation.message.appended` events,
along with Invocation lifecycle, delegation, human-interaction, and other orchestration facts.
These semantic events share the Execution's monotonic cursor and form the only canonical log.
There is no second parsed-output store and live token output cannot be replayed.

Execution state, Invocation changes, and newly appended events may be submitted through one
idempotent `ExecutionStore.commit()` operation. File storage uses a recoverable transaction journal;
future server storage must provide equivalent database transaction, unique-event, and optimistic
version semantics.

Commit values must be JSON-safe because Execution state and events are cross-process durable
protocols. Once an Execution or Invocation reaches `succeeded`, `failed`, or `cancelled`, a later
commit may enrich that final state but cannot replace it with a different status.

## Consequences

- Audit and recovery consumers share one semantic event cursor; live transports consume a separate
  non-durable output subscription with active-execution replay.
- Repeated producer events are deduplicated by stable event id.
- Concurrent finalizers cannot overwrite an already finalized Execution or Invocation.
- `getMessageHistory()` can preserve thinking, tool calls, tool results, and provider signatures
  without retaining token deltas.
- File storage remains a local reference adapter; production storage should materialize indexed
  Output and Trace projections where necessary.
- Persisted `runtime.stream` events and independently persisted Output events remain unsupported.
  Recoverable Execution snapshot schemas follow the forward-only migration policy in ADR 019;
  canonical event formats require explicit read upcasters when their schema changes.
